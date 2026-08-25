import {
  InstanceDescriptorSchema,
  InstanceDescriptorWireSchema,
  InsecureHttpManagementChallengeResponseSchema,
  ManagementChallengeResponseSchema,
  ManagementDeviceEnrollmentResponseSchema,
  ManagementSessionResponseSchema,
  insecureHttpManagementPairProofMessage,
  parseJsonValue,
  managementPairProofMessage,
  type InstanceDescriptor,
  type InstanceDescriptorWire,
} from '@nekro-nxt/contracts'
import { X509Certificate, createHash, createHmac, randomBytes } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { InstanceOperationError } from './instance-operation-error.js'
import { normalizeRemoteOrigin, remoteTransportForOrigin } from './instance-profiles.js'

const MAX_RESPONSE_BYTES = 256 * 1_024

export const parseRemoteDescriptor = (
  value: unknown,
  expectedTransport: InstanceDescriptor['transport'],
): InstanceDescriptor => {
  let wire: InstanceDescriptorWire
  try {
    wire = InstanceDescriptorWireSchema.parse(value)
  } catch {
    throw new InstanceOperationError('operation-failed', '该地址没有返回可识别的 NekroNXT 实例描述。')
  }
  if (wire.descriptorVersion !== 1 || wire.desktopChromeProtocol !== 1) {
    throw new InstanceOperationError('incompatible-instance', '服务实例版本与当前 Desktop 不兼容。')
  }
  const supportedProtocol =
    wire.transport === 'loopback-http' || wire.transport === 'auto-tls-pinned-v1'
      ? 1
      : wire.transport === 'explicit-http-v1'
        ? 2
        : undefined
  if (supportedProtocol === undefined || wire.managementProtocol !== supportedProtocol) {
    throw new InstanceOperationError('incompatible-instance', '服务实例版本与当前 Desktop 不兼容。')
  }
  if (wire.transport !== expectedTransport) {
    throw new InstanceOperationError('transport-mismatch', '服务器声明的传输方式与地址不一致。')
  }
  return InstanceDescriptorSchema.parse({
    format: wire.format,
    descriptorVersion: wire.descriptorVersion,
    instanceId: wire.instanceId,
    releaseId: wire.releaseId,
    productVersion: wire.productVersion,
    managementProtocol: wire.managementProtocol,
    desktopChromeProtocol: wire.desktopChromeProtocol,
    transport: wire.transport,
  })
}

export interface PairRemoteResult {
  readonly origin: string
  readonly descriptor: InstanceDescriptor
  readonly spkiSha256?: string
  readonly deviceId?: string
  readonly deviceSecret?: string
}

export interface RemoteInspection {
  readonly origin: string
  readonly descriptor: InstanceDescriptor
  readonly spkiSha256?: string
}

export interface EnrollRemoteInput {
  readonly inspection: RemoteInspection
  readonly managementKey?: string
  readonly deviceLabel: string
  readonly clientReleaseId: string
}

const spkiFromCertificate = (certificate: string | Buffer): string => {
  const parsed = new X509Certificate(certificate)
  return createHash('sha256')
    .update(parsed.publicKey.export({ type: 'spki', format: 'der' }))
    .digest('base64url')
}

const remoteTlsSocket = async (origin: string, expectedSpkiSha256?: string) => {
  const url = new URL(origin)
  const host = url.hostname.replace(/^\[|\]$/gu, '')
  return new Promise<ReturnType<typeof tlsConnect>>((resolve, reject) => {
    const socket = tlsConnect(
      {
        host,
        port: Number(url.port || '443'),
        ...(isIP(host) === 0 ? { servername: host } : {}),
        rejectUnauthorized: false,
        timeout: 8_000,
      },
      () => {
        const certificate = socket.getPeerCertificate(true)
        if (!certificate.raw) {
          socket.destroy()
          reject(new InstanceOperationError('tls-identity-changed', '服务器没有提供可验证的 TLS 证书。'))
          return
        }
        const spki = spkiFromCertificate(certificate.raw)
        if (expectedSpkiSha256 !== undefined && spki !== expectedSpkiSha256) {
          socket.destroy()
          reject(new InstanceOperationError('tls-identity-changed', '服务器 TLS 身份已经变化，请重新认证。'))
          return
        }
        socket.setTimeout(0)
        resolve(socket)
      },
    )
    socket.once('timeout', () =>
      socket.destroy(new InstanceOperationError('unreachable', '连接服务器超时，请检查地址和网络状态。')),
    )
    socket.once('error', reject)
  })
}

export const observeRemoteSpki = async (origin: string): Promise<string> => {
  const socket = await remoteTlsSocket(origin)
  try {
    const certificate = socket.getPeerCertificate(true)
    if (!certificate.raw) {
      throw new InstanceOperationError('tls-identity-changed', '服务器没有提供可验证的 TLS 证书。')
    }
    return spkiFromCertificate(certificate.raw)
  } finally {
    socket.end()
  }
}

interface JsonRequestOptions {
  readonly body?: unknown
  readonly extraHeaders?: Readonly<Record<string, string>>
  readonly expectedSpkiSha256?: string
}

const requestJsonResponse = async (
  origin: string,
  pathname: string,
  method: 'GET' | 'POST' | 'DELETE',
  options: JsonRequestOptions = {},
): Promise<{ readonly value: unknown; readonly setCookies: readonly string[] }> => {
  const url = new URL(pathname, origin)
  const encoded = options.body === undefined ? undefined : JSON.stringify(options.body)
  if (url.protocol === 'https:' && options.expectedSpkiSha256 === undefined) {
    throw new InstanceOperationError('tls-identity-changed', 'HTTPS 请求缺少服务器 TLS 身份。')
  }
  const socket = url.protocol === 'https:' ? await remoteTlsSocket(origin, options.expectedSpkiSha256) : undefined
  const pinnedAgent = socket === undefined ? undefined : new HttpsAgent({ keepAlive: false })
  if (pinnedAgent !== undefined && socket !== undefined) {
    pinnedAgent.createConnection = ((_options, callback) => {
      callback?.(null, socket)
      return socket
    }) satisfies typeof pinnedAgent.createConnection
  }
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        method,
        ...(pinnedAgent === undefined ? {} : { agent: pinnedAgent }),
        headers:
          encoded === undefined
            ? { accept: 'application/json', ...options.extraHeaders }
            : {
                accept: 'application/json',
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(encoded),
                ...options.extraHeaders,
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
              const problem =
                typeof value === 'object' &&
                value !== null &&
                'error' in value &&
                typeof value['error'] === 'object' &&
                value['error'] !== null
                  ? value['error']
                  : undefined
              const code =
                problem !== undefined && 'code' in problem && typeof problem['code'] === 'string'
                  ? problem['code']
                  : undefined
              if (code === 'management_key_invalid') {
                reject(new InstanceOperationError('management-key-rejected', '管理密钥不正确，请检查后重试。'))
                return
              }
              reject(new InstanceOperationError('operation-failed', '服务器拒绝了配对请求，请稍后重试。'))
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
    request.setTimeout(10_000, () =>
      request.destroy(new InstanceOperationError('unreachable', '连接服务器超时，请检查地址和网络状态。')),
    )
    if (encoded !== undefined) request.end(encoded)
    else request.end()
  })
}

const requestJson = async (
  origin: string,
  pathname: string,
  method: 'GET' | 'POST' | 'DELETE',
  options?: JsonRequestOptions,
): Promise<unknown> => (await requestJsonResponse(origin, pathname, method, options)).value

export const inspectRemoteInstance = async (address: string): Promise<RemoteInspection> => {
  const origin = normalizeRemoteOrigin(address)
  const secure = new URL(origin).protocol === 'https:'
  const spkiSha256 = secure ? await observeRemoteSpki(origin) : undefined
  const descriptor = parseRemoteDescriptor(
    await requestJson(origin, '/.well-known/nekro-nxt', 'GET', {
      ...(spkiSha256 === undefined ? {} : { expectedSpkiSha256: spkiSha256 }),
    }),
    secure ? 'auto-tls-pinned-v1' : remoteTransportForOrigin(origin),
  )
  return { origin, descriptor, ...(spkiSha256 === undefined ? {} : { spkiSha256 }) }
}

export const enrollRemoteDevice = async (input: EnrollRemoteInput): Promise<PairRemoteResult> => {
  const { origin, descriptor, spkiSha256 } = input.inspection
  if (descriptor.transport === 'loopback-http') return { origin, descriptor }
  if (input.managementKey === undefined) {
    throw new InstanceOperationError('management-key-required', '此服务实例需要管理密钥。')
  }
  if (input.managementKey.length < 32) {
    throw new InstanceOperationError('management-key-rejected', '管理密钥至少需要 32 个字符。')
  }
  if (descriptor.transport === 'auto-tls-pinned-v1' && spkiSha256 === undefined) {
    throw new InstanceOperationError('operation-failed', '无法验证服务器 TLS 身份。')
  }
  const challengeValue = await requestJson(origin, '/api/management/pairing/challenge', 'POST', {
    body: {},
    ...(spkiSha256 === undefined ? {} : { expectedSpkiSha256: spkiSha256 }),
  })
  const challenge =
    descriptor.transport === 'explicit-http-v1'
      ? InsecureHttpManagementChallengeResponseSchema.parse(challengeValue)
      : ManagementChallengeResponseSchema.parse(challengeValue)
  if (
    challenge.instanceId !== descriptor.instanceId ||
    ('spkiSha256' in challenge && challenge.spkiSha256 !== spkiSha256)
  ) {
    throw new InstanceOperationError('instance-identity-changed', '服务器身份验证失败，请重新添加该实例。')
  }
  const clientNonce = randomBytes(32).toString('base64url')
  const proofMessage =
    'transportBinding' in challenge
      ? insecureHttpManagementPairProofMessage({
          challengeId: challenge.challengeId,
          serverNonce: challenge.serverNonce,
          clientNonce,
          instanceId: challenge.instanceId,
          transportBinding: challenge.transportBinding,
        })
      : managementPairProofMessage({
          challengeId: challenge.challengeId,
          serverNonce: challenge.serverNonce,
          clientNonce,
          instanceId: challenge.instanceId,
          spkiSha256: challenge.spkiSha256,
        })
  const proof = createHmac('sha256', input.managementKey).update(proofMessage).digest('base64url')
  const enrollment = ManagementDeviceEnrollmentResponseSchema.parse(
    await requestJson(origin, '/api/management/devices/enroll', 'POST', {
      ...(spkiSha256 === undefined ? {} : { expectedSpkiSha256: spkiSha256 }),
      body: {
        challengeId: challenge.challengeId,
        clientNonce,
        proof,
        label: input.deviceLabel,
        clientReleaseId: input.clientReleaseId,
      },
    }),
  )
  return {
    origin,
    descriptor,
    ...(spkiSha256 === undefined ? {} : { spkiSha256 }),
    deviceId: enrollment.deviceId,
    deviceSecret: enrollment.deviceSecret,
  }
}

export const revokeRemoteDevice = async (paired: PairRemoteResult): Promise<void> => {
  if (paired.deviceId === undefined || paired.deviceSecret === undefined) return
  if (paired.spkiSha256 !== undefined && (await observeRemoteSpki(paired.origin)) !== paired.spkiSha256) {
    throw new Error('服务器证书已经变化，无法撤销新设备。')
  }
  const sessionResponse = await requestJsonResponse(paired.origin, '/api/management/session', 'POST', {
    ...(paired.spkiSha256 === undefined ? {} : { expectedSpkiSha256: paired.spkiSha256 }),
    body: { deviceId: paired.deviceId, deviceSecret: paired.deviceSecret },
  })
  const sessionState = ManagementSessionResponseSchema.parse(sessionResponse.value)
  const cookie = sessionResponse.setCookies
    .map((value) => value.split(';', 1)[0])
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join('; ')
  if (cookie.length === 0) throw new Error('服务器没有建立可撤销的设备会话。')
  await requestJson(paired.origin, `/api/management/devices/${encodeURIComponent(paired.deviceId)}`, 'DELETE', {
    ...(paired.spkiSha256 === undefined ? {} : { expectedSpkiSha256: paired.spkiSha256 }),
    extraHeaders: { cookie, origin: paired.origin, 'x-nxt-csrf': sessionState.csrfToken },
  })
}

export const certificateSpki = spkiFromCertificate
