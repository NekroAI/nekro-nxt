import {
  InstanceDescriptorSchema,
  ManagementDeviceEnrollmentRequestSchema,
  ManagementDeviceEnrollmentResponseSchema,
  ManagementDeviceIdSchema,
  ManagementSessionRequestSchema,
  ManagementSessionResponseSchema,
  ServerInstanceIdSchema,
  managementPairProofMessage,
  parseJsonValue,
  type InstanceDescriptor,
  type ManagementDeviceId,
  type ServerInstanceId,
} from '@nekro-nxt/contracts'
import type { SqliteHostSecurityRepository } from '@nekro-nxt/storage-sqlite'
import { X509Certificate, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import type { ClientRequest, Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http'
import { createServer, type Server as HttpsServer } from 'node:https'
import { createServer as createNetServer, type Server as NetServer } from 'node:net'
import { z } from 'zod'
import { managementLoginPage } from './management-login-page.js'
import type { Duplex } from 'node:stream'
import path from 'node:path'
import { generate } from 'selfsigned'
import { VIEWER_HEADER } from './viewer.js'
import { monotonicFactory } from 'ulid'

const SESSION_COOKIE = 'nxt_session'
const CSRF_COOKIE = 'nxt_csrf'
/** A browser's device credential `<deviceId>.<secret>`; HttpOnly, so page and extension scripts cannot read it. */
const DEVICE_COOKIE = 'nxt_device'
const BROWSER_DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1_000
/** Last activity is written at most once a minute per device. */
const ACTIVITY_WRITE_INTERVAL_MS = 60_000
const CHALLENGE_TTL_MS = 60_000
const SESSION_TTL_MS = 12 * 60 * 60 * 1_000
const MAX_JSON_BYTES = 64 * 1_024
const MAX_PENDING_CHALLENGES = 256
const CHALLENGES_PER_ADDRESS_PER_MINUTE = 10
const CHALLENGE_RATE_WINDOW_MS = 60_000
const nextUlid = monotonicFactory()

interface ChallengeRecord {
  readonly serverNonce: string
  readonly expiresAt: number
}

interface SessionRecord {
  readonly deviceId: ManagementDeviceId
  readonly csrfToken: string
  readonly expiresAt: number
}

export const managementLoginRequestSchema = z
  .object({ managementKey: z.string().min(1).max(4096), acknowledgeInsecure: z.boolean().default(false) })
  .strict()

export interface ManagementEdgeOptions {
  readonly host: '127.0.0.1' | '0.0.0.0'
  readonly port: number
  readonly internalPort: number
  readonly dataRoot: string
  readonly managementKey: string
  readonly releaseId: string
  readonly productVersion: string
  readonly repository: SqliteHostSecurityRepository
  /** Trust `X-Forwarded-Proto` / `X-Forwarded-Host` from a reverse proxy that terminates HTTPS in front of plain HTTP. */
  readonly trustProxy?: boolean
  readonly now?: () => number
}

export interface ManagementEdgeHandle {
  readonly port: number
  readonly instanceId: ServerInstanceId
  readonly spkiSha256: string
  stop(): Promise<void>
}

const digest = (prefix: string, value: string): string =>
  createHash('sha256').update(prefix).update('\0').update(value).digest('base64url')

const safeEqual = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

const writeJson = (
  response: ServerResponse,
  status: number,
  body: unknown,
  headers?: Record<string, string | string[]>,
): void => {
  const encoded = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(encoded),
    ...headers,
  })
  response.end(encoded)
}

const writeProblem = (response: ServerResponse, status: number, code: string, message: string): void =>
  writeJson(response, status, { error: { code, message } })

const readJson = (request: IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = []
    let size = 0
    request.on('data', (chunk: Uint8Array) => {
      size += chunk.length
      if (size > MAX_JSON_BYTES) {
        reject(new Error('请求正文过大。'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8').trim()
        resolve(text.length === 0 ? undefined : parseJsonValue(JSON.parse(text)))
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
    request.on('error', reject)
  })

const parseCookies = (request: IncomingMessage): ReadonlyMap<string, string> => {
  const cookies = new Map<string, string>()
  for (const item of (request.headers.cookie ?? '').split(';')) {
    const separator = item.indexOf('=')
    if (separator < 1) continue
    cookies.set(item.slice(0, separator).trim(), item.slice(separator + 1).trim())
  }
  return cookies
}

/**
 * `Secure` only over HTTPS, or browsers drop the cookie on plain HTTP. `Lax` keeps a login across links opened from
 * elsewhere; mutations stay protected by the same-origin and CSRF checks.
 */
const cookie = (
  name: string,
  value: string,
  maxAgeSeconds: number,
  options: { readonly httpOnly: boolean; readonly secure: boolean },
): string =>
  `${name}=${value}; Path=/; Max-Age=${maxAgeSeconds}; ${options.httpOnly ? 'HttpOnly; ' : ''}${options.secure ? 'Secure; ' : ''}SameSite=Lax`

/** Health and the brand icon the login page shows are the only anonymous pages passed to the product server. */
const publicProxyPath = (pathname: string): boolean =>
  pathname === '/health/live' ||
  pathname === '/health/ready' ||
  pathname === '/favicon.svg' ||
  pathname === '/brand/mark.svg'

/** A short device name from the browser's User-Agent, e.g. 「浏览器 · Chrome · macOS」. */
export const browserDeviceLabel = (userAgent: string | undefined): string => {
  const agent = userAgent ?? ''
  const browser = /Edg\//u.test(agent)
    ? 'Edge'
    : /Firefox\//u.test(agent)
      ? 'Firefox'
      : /Chrome\//u.test(agent)
        ? 'Chrome'
        : /Safari\//u.test(agent)
          ? 'Safari'
          : undefined
  const system = /iPhone|iPad/u.test(agent)
    ? 'iOS'
    : /Android/u.test(agent)
      ? 'Android'
      : /Mac OS X|Macintosh/u.test(agent)
        ? 'macOS'
        : /Windows/u.test(agent)
          ? 'Windows'
          : /Linux/u.test(agent)
            ? 'Linux'
            : undefined
  return ['浏览器', browser, system].filter((part) => part !== undefined).join(' · ')
}

/** Relative path inside this site to return to after login; anything else falls back to the root. */
const safeNext = (value: string | null): string =>
  value !== null && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/login') ? value : '/'

const wantsPage = (request: IncomingMessage, pathname: string): boolean =>
  (request.method === 'GET' || request.method === 'HEAD') &&
  !pathname.startsWith('/api/') &&
  (request.headers.accept ?? '').includes('text/html')

const methodIsSafe = (method: string | undefined): boolean =>
  method === 'GET' || method === 'HEAD' || method === 'OPTIONS'

const loadOrCreateCertificate = async (
  dataRoot: string,
  instanceId: ServerInstanceId,
): Promise<{ readonly key: string; readonly cert: string; readonly spkiSha256: string }> => {
  const tlsRoot = path.join(dataRoot, 'host', 'tls')
  const keyPath = path.join(tlsRoot, 'server-key.pem')
  const certPath = path.join(tlsRoot, 'server-cert.pem')
  await mkdir(tlsRoot, { recursive: true, mode: 0o700 })
  let key: string
  let cert: string
  try {
    ;[key, cert] = await Promise.all([readFile(keyPath, 'utf8'), readFile(certPath, 'utf8')])
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    if (code !== 'ENOENT') throw error
    const generated = await generate([{ name: 'commonName', value: `NekroNxt ${instanceId}` }], {
      keyType: 'ec',
      curve: 'P-256',
      algorithm: 'sha256',
      notAfterDate: new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1_000),
      extensions: [
        { name: 'basicConstraints', cA: false, critical: true },
        { name: 'keyUsage', digitalSignature: true, keyAgreement: true, critical: true },
        { name: 'extKeyUsage', serverAuth: true },
        {
          name: 'subjectAltName',
          altNames: [
            { type: 2, value: 'localhost' },
            { type: 7, ip: '127.0.0.1' },
            { type: 7, ip: '::1' },
          ],
        },
      ],
    })
    key = generated.private
    cert = generated.cert
    const suffix = randomBytes(8).toString('hex')
    const temporaryKey = `${keyPath}.${suffix}.tmp`
    const temporaryCert = `${certPath}.${suffix}.tmp`
    await writeFile(temporaryKey, key, { mode: 0o600, flag: 'wx' })
    await writeFile(temporaryCert, cert, { mode: 0o600, flag: 'wx' })
    await rename(temporaryKey, keyPath)
    await rename(temporaryCert, certPath)
  }
  await Promise.all([chmod(keyPath, 0o600), chmod(certPath, 0o600)])
  const certificate = new X509Certificate(cert)
  const publicKey = certificate.publicKey.export({ type: 'spki', format: 'der' })
  return { key, cert, spkiSha256: createHash('sha256').update(publicKey).digest('base64url') }
}

export const initializeServerIdentity = (
  repository: SqliteHostSecurityRepository,
  managementKey: string | undefined,
  now: number,
): ServerInstanceId => {
  const keyDigest = digest(
    managementKey === undefined ? 'nxt-management-key-unconfigured-v1' : 'nxt-management-key-v1',
    managementKey ?? '',
  )
  const current = repository.getMetadata()
  if (current !== undefined) {
    if (!safeEqual(current.managementKeyDigest, keyDigest)) {
      repository.revokeAllDevices(now)
      repository.putMetadata({ ...current, managementKeyDigest: keyDigest, updatedAt: now })
    }
    return current.instanceId
  }
  const instanceId = ServerInstanceIdSchema.parse(`nxt_instance_${nextUlid()}`)
  repository.putMetadata({ instanceId, managementKeyDigest: keyDigest, createdAt: now, updatedAt: now })
  return instanceId
}

export const startManagementEdge = async (options: ManagementEdgeOptions): Promise<ManagementEdgeHandle> => {
  const now = options.now ?? Date.now
  const instanceId = initializeServerIdentity(options.repository, options.managementKey, now())
  const certificate = await loadOrCreateCertificate(options.dataRoot, instanceId)
  const descriptor: InstanceDescriptor = InstanceDescriptorSchema.parse({
    format: 'nxt.instance-descriptor',
    descriptorVersion: 1,
    instanceId,
    releaseId: options.releaseId,
    productVersion: options.productVersion,
    managementProtocol: 1,
    desktopChromeProtocol: 1,
    transport: 'auto-tls-pinned-v1',
  })
  const challenges = new Map<string, ChallengeRecord>()
  const sessions = new Map<string, SessionRecord>()
  const challengeRequests = new Map<string, number[]>()
  const lastActivityWrite = new Map<ManagementDeviceId, number>()
  const upstreamRequests = new Set<ClientRequest>()
  const sockets = new Set<Duplex>()
  let stopping = false
  let stopPromise: Promise<void> | undefined

  /** Pairing challenges and browser logins share one per-address budget of attempts per minute. */
  const allowAttempt = (address: string): boolean => {
    cleanExpired()
    const recent = challengeRequests.get(address) ?? []
    if (recent.length >= CHALLENGES_PER_ADDRESS_PER_MINUTE) return false
    challengeRequests.set(address, [...recent, now()])
    return true
  }

  const cleanExpired = (): void => {
    const timestamp = now()
    for (const [id, challenge] of challenges) if (challenge.expiresAt <= timestamp) challenges.delete(id)
    for (const [id, session] of sessions) if (session.expiresAt <= timestamp) sessions.delete(id)
    for (const [address, requests] of challengeRequests) {
      const retained = requests.filter((requestedAt) => requestedAt > timestamp - CHALLENGE_RATE_WINDOW_MS)
      if (retained.length === 0) challengeRequests.delete(address)
      else challengeRequests.set(address, retained)
    }
  }

  const header = (request: IncomingMessage, name: string): string | undefined => {
    const value = request.headers[name]
    const first = Array.isArray(value) ? value[0] : value
    return first?.split(',')[0]?.trim() || undefined
  }

  /** HTTPS on this socket, or a trusted reverse proxy that terminated HTTPS in front of it. */
  const secureRequest = (request: IncomingMessage): boolean =>
    ('encrypted' in request.socket && request.socket.encrypted === true) ||
    (options.trustProxy === true && header(request, 'x-forwarded-proto') === 'https')

  const publicHost = (request: IncomingMessage): string | undefined =>
    (options.trustProxy === true ? header(request, 'x-forwarded-host') : undefined) ?? request.headers.host

  const touchActivity = (deviceId: ManagementDeviceId): void => {
    const timestamp = now()
    if (timestamp - (lastActivityWrite.get(deviceId) ?? 0) < ACTIVITY_WRITE_INTERVAL_MS) return
    lastActivityWrite.set(deviceId, timestamp)
    options.repository.touchDevice(deviceId, timestamp)
  }

  const openSession = (
    request: IncomingMessage,
    deviceId: ManagementDeviceId,
  ): { readonly token: string; readonly session: SessionRecord; readonly cookies: readonly string[] } => {
    const token = randomBytes(32).toString('base64url')
    const csrfToken = randomBytes(24).toString('base64url')
    const session = { deviceId, csrfToken, expiresAt: now() + SESSION_TTL_MS }
    sessions.set(token, session)
    touchActivity(deviceId)
    const secure = secureRequest(request)
    return {
      token,
      session,
      cookies: [
        cookie(SESSION_COOKIE, token, SESSION_TTL_MS / 1_000, { httpOnly: true, secure }),
        cookie(CSRF_COOKIE, csrfToken, SESSION_TTL_MS / 1_000, { httpOnly: false, secure }),
      ],
    }
  }

  const deviceFromCookie = (request: IncomingMessage): ManagementDeviceId | undefined => {
    const value = parseCookies(request).get(DEVICE_COOKIE)
    const separator = value?.indexOf('.') ?? -1
    if (value === undefined || separator < 1) return undefined
    const deviceId = ManagementDeviceIdSchema.safeParse(value.slice(0, separator))
    if (!deviceId.success) return undefined
    const device = options.repository.getActiveDevice(deviceId.data)
    return device !== undefined &&
      safeEqual(device.secretDigest, digest('nxt-device-secret-v1', value.slice(separator + 1)))
      ? device.id
      : undefined
  }

  /**
   * The request's live session; a browser whose session expired but still carries its device cookie gets a new one,
   * with the cookies queued on `response`.
   */
  const authenticatedSession = (
    request: IncomingMessage,
    response?: ServerResponse,
  ): { readonly token: string; readonly session: SessionRecord } | undefined => {
    cleanExpired()
    const token = parseCookies(request).get(SESSION_COOKIE)
    const session = token === undefined ? undefined : sessions.get(token)
    if (token !== undefined && session !== undefined && options.repository.getActiveDevice(session.deviceId)) {
      touchActivity(session.deviceId)
      return { token, session }
    }
    const deviceId = response === undefined ? undefined : deviceFromCookie(request)
    if (deviceId === undefined || response === undefined) return undefined
    const opened = openSession(request, deviceId)
    response.setHeader('set-cookie', [...opened.cookies])
    return opened
  }

  const validateMutation = (request: IncomingMessage, session: SessionRecord): boolean => {
    if (methodIsSafe(request.method)) return true
    const host = publicHost(request)
    const origin = request.headers.origin
    if (host === undefined || origin !== `${secureRequest(request) ? 'https' : 'http'}://${host}`) return false
    const cookieToken = parseCookies(request).get(CSRF_COOKIE)
    const headerToken = request.headers['x-nxt-csrf']
    return (
      typeof headerToken === 'string' && cookieToken === session.csrfToken && safeEqual(headerToken, session.csrfToken)
    )
  }

  const proxy = (request: IncomingMessage, response: ServerResponse, viewer: string | undefined): void => {
    if (stopping) {
      writeProblem(response, 503, 'server_stopping', '服务实例正在关闭。')
      return
    }
    const upstream = httpRequest(
      {
        host: '127.0.0.1',
        port: options.internalPort,
        method: request.method,
        path: request.url,
        headers: {
          ...Object.fromEntries(Object.entries(request.headers).filter(([name]) => name !== VIEWER_HEADER)),
          host: `127.0.0.1:${options.internalPort}`,
          'x-forwarded-proto': secureRequest(request) ? 'https' : 'http',
          // The edge is the only place that knows the paired device; clients cannot claim another viewer.
          ...(viewer === undefined ? {} : { [VIEWER_HEADER]: viewer }),
        },
      },
      (upstreamResponse) => {
        // Keep a session the edge just renewed from the device cookie alongside the product server's own cookies.
        const renewed = response.getHeader('set-cookie')
        const upstreamCookies = upstreamResponse.headers['set-cookie'] ?? []
        response.writeHead(upstreamResponse.statusCode ?? 502, {
          ...upstreamResponse.headers,
          ...(Array.isArray(renewed) ? { 'set-cookie': [...renewed, ...upstreamCookies] } : {}),
        })
        upstreamResponse.once('aborted', () => response.destroy(new Error('上游响应提前中断。')))
        upstreamResponse.once('error', (error) => response.destroy(error))
        upstreamResponse.pipe(response)
      },
    )
    upstreamRequests.add(upstream)
    const detach = (): void => {
      upstreamRequests.delete(upstream)
      request.off('aborted', abortUpstream)
      response.off('close', abortUpstream)
    }
    const abortUpstream = (): void => {
      if (!upstream.destroyed) upstream.destroy(new Error('下游连接已经关闭。'))
    }
    request.once('aborted', abortUpstream)
    response.once('close', abortUpstream)
    upstream.once('close', detach)
    upstream.on('error', () => {
      if (response.headersSent) response.destroy()
      else writeProblem(response, 502, 'upstream_unavailable', '服务实例正在启动，请稍后重试。')
    })
    request.pipe(upstream)
  }

  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://edge.invalid')
      if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/.well-known/nekro-nxt') {
        writeJson(response, 200, descriptor)
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/management/pairing/challenge') {
        cleanExpired()
        const address = request.socket.remoteAddress ?? 'unknown'
        const recent = challengeRequests.get(address) ?? []
        if (challenges.size >= MAX_PENDING_CHALLENGES || recent.length >= CHALLENGES_PER_ADDRESS_PER_MINUTE) {
          writeProblem(response, 429, 'pairing_rate_limited', '配对请求过于频繁，请稍后重试。')
          return
        }
        challengeRequests.set(address, [...recent, now()])
        const challengeId = randomBytes(24).toString('base64url')
        const serverNonce = randomBytes(32).toString('base64url')
        const expiresAt = now() + CHALLENGE_TTL_MS
        challenges.set(challengeId, { serverNonce, expiresAt })
        writeJson(response, 200, {
          challengeId,
          serverNonce,
          instanceId,
          spkiSha256: certificate.spkiSha256,
          expiresAt,
        })
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/management/devices/enroll') {
        const input = ManagementDeviceEnrollmentRequestSchema.parse(await readJson(request))
        const challenge = challenges.get(input.challengeId)
        challenges.delete(input.challengeId)
        if (challenge === undefined || challenge.expiresAt <= now()) {
          writeProblem(response, 401, 'challenge_invalid', '配对挑战已失效，请重新连接。')
          return
        }
        const message = managementPairProofMessage({
          challengeId: input.challengeId,
          serverNonce: challenge.serverNonce,
          clientNonce: input.clientNonce,
          instanceId,
          spkiSha256: certificate.spkiSha256,
        })
        const expected = createHmac('sha256', options.managementKey).update(message).digest('base64url')
        if (!safeEqual(expected, input.proof)) {
          writeProblem(response, 401, 'management_key_invalid', '管理密钥不正确。')
          return
        }
        const deviceId = ManagementDeviceIdSchema.parse(`nxt_device_${nextUlid()}`)
        const deviceSecret = randomBytes(32).toString('base64url')
        options.repository.putDevice({
          id: deviceId,
          label: input.label,
          secretDigest: digest('nxt-device-secret-v1', deviceSecret),
          createdAt: now(),
        })
        writeJson(response, 201, ManagementDeviceEnrollmentResponseSchema.parse({ deviceId, deviceSecret }))
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/management/session') {
        cleanExpired()
        const input = ManagementSessionRequestSchema.parse(await readJson(request))
        const device = options.repository.getActiveDevice(input.deviceId)
        if (
          device === undefined ||
          !safeEqual(device.secretDigest, digest('nxt-device-secret-v1', input.deviceSecret))
        ) {
          writeProblem(response, 401, 'device_credential_invalid', '设备会话已经失效，请重新认证。')
          return
        }
        const opened = openSession(request, device.id)
        writeJson(
          response,
          200,
          ManagementSessionResponseSchema.parse({
            authenticated: true,
            deviceId: device.id,
            csrfToken: opened.session.csrfToken,
          }),
          { 'set-cookie': [...opened.cookies] },
        )
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/management/login') {
        if (!allowAttempt(request.socket.remoteAddress ?? 'unknown')) {
          writeProblem(response, 429, 'login_rate_limited', '登录尝试过于频繁，请一分钟后再试。')
          return
        }
        const input = managementLoginRequestSchema.parse(await readJson(request))
        const secure = secureRequest(request)
        if (!secure && !input.acknowledgeInsecure) {
          writeProblem(response, 400, 'insecure_not_acknowledged', '当前连接未加密，请先确认了解风险。')
          return
        }
        if (!safeEqual(digest('nxt-login-key', input.managementKey), digest('nxt-login-key', options.managementKey))) {
          writeProblem(response, 401, 'management_key_invalid', '管理密钥不正确。')
          return
        }
        const deviceId = ManagementDeviceIdSchema.parse(`nxt_device_${nextUlid()}`)
        const deviceSecret = randomBytes(32).toString('base64url')
        options.repository.putDevice({
          id: deviceId,
          label: browserDeviceLabel(request.headers['user-agent']),
          secretDigest: digest('nxt-device-secret-v1', deviceSecret),
          createdAt: now(),
        })
        const opened = openSession(request, deviceId)
        writeJson(
          response,
          200,
          { authenticated: true, deviceId },
          {
            'set-cookie': [
              cookie(DEVICE_COOKIE, `${deviceId}.${deviceSecret}`, BROWSER_DEVICE_TTL_MS / 1_000, {
                httpOnly: true,
                secure,
              }),
              ...opened.cookies,
            ],
          },
        )
        return
      }
      if (request.method === 'GET' && url.pathname === '/login') {
        const next = safeNext(url.searchParams.get('next'))
        if (authenticatedSession(request, response) !== undefined) {
          response.writeHead(302, { location: next, 'cache-control': 'no-store' })
          response.end()
          return
        }
        const page = managementLoginPage({ secure: secureRequest(request), next })
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': Buffer.byteLength(page),
          'x-frame-options': 'DENY',
          'content-security-policy':
            "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'",
        })
        response.end(page)
        return
      }

      const authenticated = authenticatedSession(request, response)
      if (request.method === 'GET' && url.pathname === '/api/management/session') {
        if (authenticated === undefined) {
          writeProblem(response, 401, 'authentication_required', '请先建立设备会话。')
          return
        }
        writeJson(response, 200, {
          authenticated: true,
          deviceId: authenticated.session.deviceId,
          csrfToken: authenticated.session.csrfToken,
        })
        return
      }
      if (authenticated === undefined && !publicProxyPath(url.pathname)) {
        if (wantsPage(request, url.pathname)) {
          response.writeHead(302, {
            location: `/login?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`,
            'cache-control': 'no-store',
          })
          response.end()
          return
        }
        writeProblem(response, 401, 'authentication_required', '请先登录。')
        return
      }
      if (authenticated !== undefined && !validateMutation(request, authenticated.session)) {
        writeProblem(response, 403, 'request_origin_invalid', '请求来源验证失败。')
        return
      }
      if (request.method === 'DELETE' && url.pathname === '/api/management/session') {
        const session = authenticated!.session
        sessions.delete(authenticated!.token)
        // A browser logs out for good: its device is revoked with the session. Desktop keeps its paired device.
        const browserDevice = deviceFromCookie(request)
        if (browserDevice !== undefined && browserDevice === session.deviceId) {
          options.repository.revokeDevice(browserDevice, now())
          for (const [token, other] of sessions) if (other.deviceId === browserDevice) sessions.delete(token)
        }
        const secure = secureRequest(request)
        writeJson(
          response,
          200,
          { authenticated: false },
          {
            'set-cookie': [
              cookie(SESSION_COOKIE, '', 0, { httpOnly: true, secure }),
              cookie(CSRF_COOKIE, '', 0, { httpOnly: false, secure }),
              ...(browserDevice === undefined ? [] : [cookie(DEVICE_COOKIE, '', 0, { httpOnly: true, secure })]),
            ],
          },
        )
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/management/devices') {
        writeJson(response, 200, {
          devices: options.repository.listDevices().map((device) => ({
            id: device.id,
            label: device.label,
            current: device.id === authenticated!.session.deviceId,
            createdAt: device.createdAt,
            ...(device.lastUsedAt === undefined ? {} : { lastUsedAt: device.lastUsedAt }),
            ...(device.revokedAt === undefined ? {} : { revokedAt: device.revokedAt }),
          })),
        })
        return
      }
      const revokeMatch = /^\/api\/management\/devices\/([^/]+)$/u.exec(url.pathname)
      if (request.method === 'DELETE' && revokeMatch?.[1] !== undefined) {
        const deviceId = ManagementDeviceIdSchema.parse(decodeURIComponent(revokeMatch[1]))
        const revoked = options.repository.revokeDevice(deviceId, now())
        for (const [token, session] of sessions) if (session.deviceId === deviceId) sessions.delete(token)
        writeJson(response, revoked ? 200 : 404, { revoked })
        return
      }
      proxy(request, response, authenticated === undefined ? undefined : `device:${authenticated.session.deviceId}`)
    })().catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined)
        return
      }
      const message = error instanceof Error ? error.message : '请求格式无效。'
      writeProblem(response, 400, 'invalid_request', message)
    })
  }

  const tlsServer: HttpsServer = createServer({ key: certificate.key, cert: certificate.cert }, handle)
  const plainServer: HttpServer = createHttpServer(handle)
  /**
   * One port serves both: a TLS ClientHello always starts with record type 0x16, plain HTTP never does. Desktop and
   * `https://` keep the pinned certificate; `http://` works for browsers on a LAN or behind a reverse proxy.
   */
  const listener: NetServer = createNetServer((socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.once('data', (chunk: Buffer) => {
      socket.pause()
      socket.unshift(chunk)
      ;(chunk[0] === 0x16 ? tlsServer : plainServer).emit('connection', socket)
      process.nextTick(() => socket.resume())
    })
  })

  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject)
    listener.listen(options.port, options.host, () => {
      listener.off('error', reject)
      resolve()
    })
  })
  const address = listener.address()
  if (address === null || typeof address === 'string') throw new Error('安全入口未获得有效监听端口。')
  return {
    port: address.port,
    instanceId,
    spkiSha256: certificate.spkiSha256,
    stop: () => {
      if (stopPromise) return stopPromise
      stopping = true
      stopPromise = (async () => {
        for (const upstream of upstreamRequests) upstream.destroy(new Error('Management Edge 正在关闭。'))
        tlsServer.closeIdleConnections()
        plainServer.closeIdleConnections()
        const closed = new Promise<void>((resolve, reject) =>
          listener.close((error) => (error ? reject(error) : resolve())),
        )
        const timeout = setTimeout(() => {
          for (const socket of sockets) socket.destroy()
          tlsServer.closeAllConnections()
          plainServer.closeAllConnections()
        }, 5_000)
        timeout.unref()
        try {
          await closed
        } finally {
          clearTimeout(timeout)
          for (const socket of sockets) socket.destroy()
          sockets.clear()
          upstreamRequests.clear()
        }
      })()
      return stopPromise
    },
  }
}
