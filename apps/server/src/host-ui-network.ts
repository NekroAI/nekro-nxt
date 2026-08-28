import { lookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { z } from 'zod'

const RequestSchema = z
  .object({
    url: z.string().url(),
    method: z.enum(['GET', 'POST']).default('GET'),
    headers: z.record(z.string(), z.string().max(4096)).default({}),
    body: z
      .string()
      .max(1024 * 1024)
      .optional(),
  })
  .strict()

const allowedHeader = (name: string): boolean =>
  ['accept', 'content-type', 'if-none-match'].includes(name.toLowerCase())

const urlHostname = (url: URL): string => url.hostname.toLowerCase().replace(/^\[|\]$/gu, '')

const isPrivateIpv4 = (value: string): boolean => {
  const octets = value.split('.').map(Number)
  const [first = -1, second = -1] = octets
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 100 && second >= 64 && second <= 127) ||
    first >= 224
  )
}

export const isPrivateNetworkAddress = (value: string): boolean => {
  const normalized = value.toLowerCase().split('%')[0] ?? ''
  const family = isIP(normalized)
  if (family === 4) return isPrivateIpv4(normalized)
  if (family !== 6) return true
  if (normalized === '::' || normalized === '::1') return true
  if (normalized.startsWith('fc') || normalized.startsWith('fd') || /^fe[89ab]/u.test(normalized)) return true
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(normalized)?.[1]
  return mapped ? isPrivateIpv4(mapped) : false
}

interface ResolvedPublicUrl {
  readonly address: string
  readonly family: 4 | 6
}

const resolvePublicUrl = async (url: URL, allowedOrigins: ReadonlySet<string>): Promise<ResolvedPublicUrl> => {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('network.request 只支持 HTTP(S)。')
  if (!allowedOrigins.has(url.origin)) throw new Error(`network.request 未获准访问 ${url.origin}。`)
  if (url.username || url.password) throw new Error('network.request URL 不允许包含凭据。')
  const hostname = urlHostname(url)
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error('network.request 不允许访问本机地址。')
  }
  const literalFamily = isIP(hostname)
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await lookup(hostname, { all: true, verbatim: true })
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateNetworkAddress(address))) {
    throw new Error('network.request 解析到了本机或私网地址。')
  }
  const selected = addresses[0]!
  if (selected.family !== 4 && selected.family !== 6) throw new Error('network.request 地址族无效。')
  return { address: selected.address, family: selected.family }
}

interface NetworkResponse {
  readonly status: number
  readonly headers: Headers
  readonly bytes: Uint8Array
}

const requestPinnedAddress = async (
  url: URL,
  resolved: ResolvedPublicUrl,
  method: 'GET' | 'POST',
  headers: Headers,
  body: string | undefined,
): Promise<NetworkResponse> =>
  new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? httpsRequest : httpRequest
    const request = transport(
      url,
      {
        method,
        headers: Object.fromEntries(headers.entries()),
        lookup: (_hostname, _options, callback) => callback(null, resolved.address, resolved.family),
        ...(url.protocol === 'https:' && !isIP(urlHostname(url)) ? { servername: urlHostname(url) } : {}),
      },
      (response) => {
        const responseHeaders = new Headers()
        for (const [name, value] of Object.entries(response.headers)) {
          if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : value)
        }
        const length = Number(response.headers['content-length'] ?? '0')
        if (Number.isFinite(length) && length > 1024 * 1024) {
          response.resume()
          reject(new Error('network.request 响应超过 1 MiB。'))
          return
        }
        const chunks: Buffer[] = []
        let total = 0
        response.on('data', (chunk: Buffer) => {
          total += chunk.byteLength
          if (total > 1024 * 1024) {
            response.destroy(new Error('network.request 响应超过 1 MiB。'))
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, headers: responseHeaders, bytes: Buffer.concat(chunks) })
        })
        response.on('error', reject)
      },
    )
    request.setTimeout(15_000, () => request.destroy(new Error('network.request 请求超时。')))
    request.on('error', reject)
    if (body !== undefined) request.write(body)
    request.end()
  })

export const performHostUiNetworkRequest = async (
  input: unknown,
  allowedOrigins: readonly string[],
  fetchImpl?: typeof fetch,
): Promise<{
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}> => {
  const request = RequestSchema.parse(input)
  const origins = new Set(allowedOrigins.map((origin) => new URL(origin).origin))
  let url = new URL(request.url)
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    if (!allowedHeader(name)) throw new Error(`network.request 不允许发送 ${name} 请求头。`)
    headers.set(name, value)
  }
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const resolved = await resolvePublicUrl(url, origins)
    const response = fetchImpl
      ? await fetchImpl(url, {
          method: request.method,
          headers,
          ...(request.body === undefined ? {} : { body: request.body }),
          redirect: 'manual',
          signal: AbortSignal.timeout(15_000),
        }).then(async (value) => ({
          status: value.status,
          headers: value.headers,
          bytes: new Uint8Array(await value.arrayBuffer()),
        }))
      : await requestPinnedAddress(url, resolved, request.method, headers, request.body)
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      if (!location) throw new Error('network.request 收到没有 Location 的重定向。')
      if (redirects === 5) throw new Error('network.request 重定向次数超过 5 次。')
      url = new URL(location, url)
      continue
    }
    const length = Number(response.headers.get('content-length') ?? '0')
    if (Number.isFinite(length) && length > 1024 * 1024) throw new Error('network.request 响应超过 1 MiB。')
    const bytes = response.bytes
    if (bytes.byteLength > 1024 * 1024) throw new Error('network.request 响应超过 1 MiB。')
    const projectedHeaders: Record<string, string> = {}
    for (const name of ['content-type', 'etag', 'last-modified']) {
      const value = response.headers.get(name)
      if (value !== null) projectedHeaders[name] = value
    }
    return { status: response.status, headers: projectedHeaders, body: new TextDecoder().decode(bytes) }
  }
  throw new Error('network.request 未完成。')
}
