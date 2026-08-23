import {
  InstanceDescriptorSchema,
  ManagementChallengeResponseSchema,
  ManagementDeviceEnrollmentResponseSchema,
  parseJsonValue,
  managementPairProofMessage,
  type InstanceDescriptor,
} from '@nekro-nxt/contracts'
import { X509Certificate, createHash, createHmac, randomBytes } from 'node:crypto'
import { request as httpsRequest } from 'node:https'
import { connect as tlsConnect } from 'node:tls'
import { normalizeRemoteOrigin } from './instance-profiles.js'

const MAX_RESPONSE_BYTES = 256 * 1_024

export interface PairRemoteInput {
  readonly address: string
  readonly managementKey: string
  readonly deviceLabel: string
  readonly clientReleaseId: string
}

export interface PairRemoteResult {
  readonly origin: string
  readonly descriptor: InstanceDescriptor
  readonly spkiSha256: string
  readonly deviceId: string
  readonly deviceSecret: string
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

const requestJson = async (
  origin: string,
  pathname: string,
  method: 'GET' | 'POST',
  body?: unknown,
): Promise<unknown> => {
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
            ? { accept: 'application/json' }
            : {
                accept: 'application/json',
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(encoded),
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
            resolve(value)
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

export const pairRemoteInstance = async (input: PairRemoteInput): Promise<PairRemoteResult> => {
  if (input.managementKey.length < 32) throw new Error('管理密钥至少需要 32 个字符。')
  const origin = normalizeRemoteOrigin(input.address)
  const spkiSha256 = await observeRemoteSpki(origin)
  const descriptor = InstanceDescriptorSchema.parse(await requestJson(origin, '/.well-known/nekro-nxt', 'GET'))
  if (descriptor.managementProtocol !== 1 || descriptor.desktopChromeProtocol !== 1) {
    throw new Error('服务实例版本与当前 Desktop 不兼容。')
  }
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

export const certificateSpki = spkiFromCertificate
