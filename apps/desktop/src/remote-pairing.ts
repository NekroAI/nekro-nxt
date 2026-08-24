import {
  InstanceDescriptorSchema,
  ManagementChallengeResponseSchema,
  ManagementDeviceEnrollmentResponseSchema,
  ManagementSessionResponseSchema,
  parseJsonValue,
  managementPairProofMessage,
  type InstanceDescriptor,
} from '@nekro-nxt/contracts'
import { X509Certificate, createHash, createHmac, randomBytes } from 'node:crypto'
import { request as httpsRequest } from 'node:https'
import { connect as tlsConnect } from 'node:tls'
import { normalizeRemoteOrigin } from './instance-profiles.js'

const MAX_RESPONSE_BYTES = 256 * 1_024

export interface PairRemoteResult {
  readonly origin: string
  readonly descriptor: InstanceDescriptor
  readonly spkiSha256: string
  readonly deviceId: string
  readonly deviceSecret: string
}

export interface RemoteInspection {
  readonly origin: string
  readonly descriptor: InstanceDescriptor
  readonly spkiSha256: string
}

export interface EnrollRemoteInput {
  readonly inspection: RemoteInspection
  readonly managementKey: string
  readonly deviceLabel: string
  readonly clientReleaseId: string
}

const spkiFromCertificate = (certificate: string | Buffer): string => {
  const parsed = new X509Certificate(certificate)
  return createHash('sha256')
    .update(parsed.publicKey.export({ type: 'spki', format: 'der' }))
    .digest('base64url')
}

export const observeRemoteSpki = async (origin: string): Promise<string> => {
  const url = new URL(origin)
  return new Promise<string>((resolve, reject) => {
    const socket = tlsConnect(
      {
        host: url.hostname,
        port: Number(url.port),
        servername: url.hostname,
        rejectUnauthorized: false,
        timeout: 8_000,
      },
      () => {
        const certificate = socket.getPeerCertificate(true)
        if (!certificate.raw) {
          socket.destroy()
          reject(new Error('服务器没有提供 TLS 证书。'))
          return
        }
        const spki = spkiFromCertificate(certificate.raw)
        socket.end()
        resolve(spki)
      },
    )
    socket.once('timeout', () => socket.destroy(new Error('连接服务器超时。')))
    socket.once('error', reject)
  })
}

const requestJsonResponse = async (
  origin: string,
  pathname: string,
  method: 'GET' | 'POST' | 'DELETE',
  body?: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
): Promise<{ readonly value: unknown; readonly setCookies: readonly string[] }> => {
  const url = new URL(pathname, origin)
  const encoded = body === undefined ? undefined : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        method,
        rejectUnauthorized: false,
        headers:
          encoded === undefined
            ? { accept: 'application/json', ...extraHeaders }
            : {
                accept: 'application/json',
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(encoded),
                ...extraHeaders,
              },
      },
      (response) => {
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (raw: Buffer) => {
          size += raw.length
          if (size > MAX_RESPONSE_BYTES) {
            response.destroy(new Error('服务器响应过大。'))
            return
          }
          chunks.push(raw)
        })
        response.on('end', () => {
          try {
            const value = parseJsonValue(JSON.parse(Buffer.concat(chunks).toString('utf8')))
            if ((response.statusCode ?? 500) >= 400) {
              const message =
                typeof value === 'object' && value !== null && 'error' in value
                  ? JSON.stringify(value['error'])
                  : `HTTP ${response.statusCode ?? 500}`
              reject(new Error(message))
              return
            }
            resolve({ value, setCookies: response.headers['set-cookie'] ?? [] })
          } catch (error) {
            reject(new Error('服务器返回了无法识别的响应。', { cause: error }))
          }
        })
      },
    )
    request.once('error', reject)
    request.setTimeout(10_000, () => request.destroy(new Error('连接服务器超时。')))
    if (encoded !== undefined) request.end(encoded)
    else request.end()
  })
}

const requestJson = async (
  origin: string,
  pathname: string,
  method: 'GET' | 'POST' | 'DELETE',
  body?: unknown,
  extraHeaders?: Readonly<Record<string, string>>,
): Promise<unknown> => (await requestJsonResponse(origin, pathname, method, body, extraHeaders)).value

export const inspectRemoteInstance = async (address: string): Promise<RemoteInspection> => {
  const origin = normalizeRemoteOrigin(address)
  const spkiSha256 = await observeRemoteSpki(origin)
  const descriptor = InstanceDescriptorSchema.parse(await requestJson(origin, '/.well-known/nekro-nxt', 'GET'))
  if (descriptor.managementProtocol !== 1 || descriptor.desktopChromeProtocol !== 1) {
    throw new Error('服务实例版本与当前 Desktop 不兼容。')
  }
  return { origin, descriptor, spkiSha256 }
}

export const enrollRemoteDevice = async (input: EnrollRemoteInput): Promise<PairRemoteResult> => {
  if (input.managementKey.length < 32) throw new Error('管理密钥至少需要 32 个字符。')
  const { origin, descriptor, spkiSha256 } = input.inspection
  const challenge = ManagementChallengeResponseSchema.parse(
    await requestJson(origin, '/api/management/pairing/challenge', 'POST', {}),
  )
  if (challenge.instanceId !== descriptor.instanceId || challenge.spkiSha256 !== spkiSha256) {
    throw new Error('服务器身份验证失败。')
  }
  const clientNonce = randomBytes(32).toString('base64url')
  const proof = createHmac('sha256', input.managementKey)
    .update(
      managementPairProofMessage({
        challengeId: challenge.challengeId,
        serverNonce: challenge.serverNonce,
        clientNonce,
        instanceId: challenge.instanceId,
        spkiSha256,
      }),
    )
    .digest('base64url')
  const enrollment = ManagementDeviceEnrollmentResponseSchema.parse(
    await requestJson(origin, '/api/management/devices/enroll', 'POST', {
      challengeId: challenge.challengeId,
      clientNonce,
      proof,
      label: input.deviceLabel,
      clientReleaseId: input.clientReleaseId,
    }),
  )
  return { origin, descriptor, spkiSha256, deviceId: enrollment.deviceId, deviceSecret: enrollment.deviceSecret }
}

export const revokeRemoteDevice = async (paired: PairRemoteResult): Promise<void> => {
  if ((await observeRemoteSpki(paired.origin)) !== paired.spkiSha256) {
    throw new Error('服务器证书已经变化，无法撤销新设备。')
  }
  const sessionResponse = await requestJsonResponse(paired.origin, '/api/management/session', 'POST', {
    deviceId: paired.deviceId,
    deviceSecret: paired.deviceSecret,
  })
  const sessionState = ManagementSessionResponseSchema.parse(sessionResponse.value)
  const cookie = sessionResponse.setCookies
    .map((value) => value.split(';', 1)[0])
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join('; ')
  if (cookie.length === 0) throw new Error('服务器没有建立可撤销的设备会话。')
  await requestJson(
    paired.origin,
    `/api/management/devices/${encodeURIComponent(paired.deviceId)}`,
    'DELETE',
    undefined,
    { cookie, origin: paired.origin, 'x-nxt-csrf': sessionState.csrfToken },
  )
}

export const certificateSpki = spkiFromCertificate
