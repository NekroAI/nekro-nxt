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
import { request as httpRequest } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer, type Server as HttpsServer } from 'node:https'
import path from 'node:path'
import { generate } from 'selfsigned'
import { monotonicFactory } from 'ulid'

const SESSION_COOKIE = 'nxt_session'
const CSRF_COOKIE = 'nxt_csrf'
const CHALLENGE_TTL_MS = 60_000
const SESSION_TTL_MS = 12 * 60 * 60 * 1_000
const MAX_JSON_BYTES = 64 * 1_024
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

export interface ManagementEdgeOptions {
  readonly host: '127.0.0.1' | '0.0.0.0'
  readonly port: number
  readonly internalPort: number
  readonly dataRoot: string
  readonly managementKey: string
  readonly releaseId: string
  readonly productVersion: string
  readonly repository: SqliteHostSecurityRepository
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

const sessionCookie = (value: string, maxAgeSeconds: number): string =>
  `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Strict`

const csrfCookie = (value: string, maxAgeSeconds: number): string =>
  `${CSRF_COOKIE}=${value}; Path=/; Max-Age=${maxAgeSeconds}; Secure; SameSite=Strict`

const expiredCookie = (name: string, httpOnly: boolean): string =>
  `${name}=; Path=/; Max-Age=0; ${httpOnly ? 'HttpOnly; ' : ''}Secure; SameSite=Strict`

const publicProxyPath = (pathname: string): boolean => pathname === '/health/live' || pathname === '/health/ready'

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

  const cleanExpired = (): void => {
    const timestamp = now()
    for (const [id, challenge] of challenges) if (challenge.expiresAt <= timestamp) challenges.delete(id)
    for (const [id, session] of sessions) if (session.expiresAt <= timestamp) sessions.delete(id)
  }

  const authenticatedSession = (
    request: IncomingMessage,
  ): { readonly token: string; readonly session: SessionRecord } | undefined => {
    cleanExpired()
    const token = parseCookies(request).get(SESSION_COOKIE)
    if (token === undefined) return undefined
    const session = sessions.get(token)
    if (session === undefined || options.repository.getActiveDevice(session.deviceId) === undefined) return undefined
    return { token, session }
  }

  const validateMutation = (request: IncomingMessage, session: SessionRecord): boolean => {
    if (methodIsSafe(request.method)) return true
    const host = request.headers.host
    const origin = request.headers.origin
    if (host === undefined || origin !== `https://${host}`) return false
    const cookieToken = parseCookies(request).get(CSRF_COOKIE)
    const headerToken = request.headers['x-nxt-csrf']
    return (
      typeof headerToken === 'string' && cookieToken === session.csrfToken && safeEqual(headerToken, session.csrfToken)
    )
  }

  const proxy = (request: IncomingMessage, response: ServerResponse): void => {
    const upstream = httpRequest(
      {
        host: '127.0.0.1',
        port: options.internalPort,
        method: request.method,
        path: request.url,
        headers: { ...request.headers, host: `127.0.0.1:${options.internalPort}`, 'x-forwarded-proto': 'https' },
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
        upstreamResponse.pipe(response)
      },
    )
    upstream.on('error', () => writeProblem(response, 502, 'upstream_unavailable', '服务实例正在启动，请稍后重试。'))
    request.pipe(upstream)
  }

  const server: HttpsServer = createServer({ key: certificate.key, cert: certificate.cert }, (request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', `https://${request.headers.host ?? 'localhost'}`)
      if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/.well-known/nekro-nxt') {
        writeJson(response, 200, descriptor)
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/management/pairing/challenge') {
        cleanExpired()
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
        const token = randomBytes(32).toString('base64url')
        const csrfToken = randomBytes(24).toString('base64url')
        const expiresAt = now() + SESSION_TTL_MS
        sessions.set(token, { deviceId: device.id, csrfToken, expiresAt })
        options.repository.touchDevice(device.id, now())
        writeJson(
          response,
          200,
          ManagementSessionResponseSchema.parse({ authenticated: true, deviceId: device.id, csrfToken }),
          {
            'set-cookie': [sessionCookie(token, SESSION_TTL_MS / 1_000), csrfCookie(csrfToken, SESSION_TTL_MS / 1_000)],
          },
        )
        return
      }

      const authenticated = authenticatedSession(request)
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
        writeProblem(response, 401, 'authentication_required', '请先建立设备会话。')
        return
      }
      if (authenticated !== undefined && !validateMutation(request, authenticated.session)) {
        writeProblem(response, 403, 'request_origin_invalid', '请求来源验证失败。')
        return
      }
      if (request.method === 'DELETE' && url.pathname === '/api/management/session') {
        sessions.delete(authenticated!.token)
        writeJson(
          response,
          200,
          { authenticated: false },
          {
            'set-cookie': [expiredCookie(SESSION_COOKIE, true), expiredCookie(CSRF_COOKIE, false)],
          },
        )
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/management/devices') {
        writeJson(response, 200, {
          devices: options.repository.listDevices().map((device) => ({
            id: device.id,
            label: device.label,
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
      proxy(request, response)
    })().catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined)
        return
      }
      const message = error instanceof Error ? error.message : '请求格式无效。'
      writeProblem(response, 400, 'invalid_request', message)
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('安全入口未获得有效监听端口。')
  return {
    port: address.port,
    instanceId,
    spkiSha256: certificate.spkiSha256,
    stop: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  }
}
