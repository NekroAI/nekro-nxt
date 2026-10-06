import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { isPrivateNetworkAddress, normalizeUrlHostname, pinnedLookup } from './network-common.js'

export type ExtensionEgressPolicy =
  | { readonly mode: 'domains'; readonly domains: readonly string[] }
  | { readonly mode: 'config'; readonly hosts: readonly string[] }
  | { readonly mode: 'unrestricted' }

export interface ExtensionEgressOptions {
  readonly policy: ExtensionEgressPolicy
  readonly timeoutMs?: number
  readonly maxResponseBytes?: number
  readonly maxRedirects?: number
  readonly resolve?: (hostname: string) => Promise<Array<{ readonly address: string; readonly family: 4 | 6 }>>
  /** Test seam: classifies resolved addresses; defaults to the shared private-network check. */
  readonly isPrivateAddress?: (address: string) => boolean
}

export interface ExtensionFetchInit {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string
  readonly bodyBase64?: string
}

export interface ExtensionFetchResponse {
  readonly url: string
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly contentType: string
  readonly text?: string
  readonly base64?: string
}

export class ExtensionEgressError extends Error {
  constructor(
    readonly code:
      | 'policy-denied'
      | 'private-address'
      | 'timeout'
      | 'response-too-large'
      | 'too-many-redirects'
      | 'invalid-request'
      | 'invalid-url'
      | 'invalid-protocol'
      | 'invalid-request-header'
      | 'dns-error'
      | 'request-error',
    message: string,
  ) {
    super(message)
    this.name = 'ExtensionEgressError'
  }
}

interface ResolvedAddress {
  readonly address: string
  readonly family: 4 | 6
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024 // 8 MiB
const DEFAULT_MAX_REDIRECTS = 5

const FORBIDDEN_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'keep-alive',
])

const matchesDomain = (pattern: string, targetHostname: string): boolean => {
  const normalPattern = pattern.toLowerCase()
  const normalHostname = targetHostname.toLowerCase()

  if (!normalPattern.startsWith('*.')) {
    return normalPattern === normalHostname
  }

  const suffix = normalPattern.slice(2)
  if (!suffix.includes('.')) {
    return false
  }

  if (normalHostname.endsWith(`.${suffix}`)) {
    return true
  }

  return false
}

const isPolicyMatch = (policy: ExtensionEgressPolicy, hostname: string, configHost?: string): boolean => {
  if (policy.mode === 'unrestricted') {
    return true
  }

  if (policy.mode === 'domains') {
    return policy.domains.some((domain) => matchesDomain(domain, hostname))
  }

  if (policy.mode === 'config' && configHost) {
    return policy.hosts.some((host) => host === configHost)
  }

  return false
}

const isPrivateNetworkAllowed = (policy: ExtensionEgressPolicy, _hostname: string, configHost?: string): boolean => {
  if (policy.mode !== 'config') {
    return false
  }

  if (configHost && policy.hosts.some((host) => host === configHost)) {
    return true
  }

  return false
}

const createNetworkRequest = async (
  url: URL,
  resolved: ResolvedAddress,
  method: string,
  headers: Headers,
  body: Buffer | undefined,
  timeoutMs: number,
  maxResponseBytes: number,
): Promise<{ status: number; headers: Headers; bytes: Uint8Array }> =>
  new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? httpsRequest : httpRequest
    const request = transport(
      url,
      {
        method,
        headers: Object.fromEntries(headers.entries()),
        lookup: pinnedLookup(resolved),
        ...(url.protocol === 'https:' && !isIP(normalizeUrlHostname(url))
          ? { servername: normalizeUrlHostname(url) }
          : {}),
      },
      (response) => {
        const responseHeaders = new Headers()
        for (const [name, value] of Object.entries(response.headers)) {
          if (value !== undefined && name.toLowerCase() !== 'set-cookie') {
            responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : value)
          }
        }

        const length = Number(response.headers['content-length'] ?? '0')
        if (Number.isFinite(length) && length > maxResponseBytes) {
          response.resume()
          reject(new ExtensionEgressError('response-too-large', `响应超过 ${maxResponseBytes} 字节。`))
          return
        }

        const chunks: Buffer[] = []
        let total = 0
        response.on('data', (chunk: Buffer) => {
          total += chunk.byteLength
          if (total > maxResponseBytes) {
            response.destroy(new ExtensionEgressError('response-too-large', `响应超过 ${maxResponseBytes} 字节。`))
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
    request.setTimeout(timeoutMs, () =>
      request.destroy(new ExtensionEgressError('timeout', `请求在 ${timeoutMs}ms 内无响应。`)),
    )
    request.on('error', (error) => {
      if (error instanceof ExtensionEgressError) {
        reject(error)
      } else {
        reject(
          new ExtensionEgressError(
            'request-error',
            `网络请求失败：${error instanceof Error ? error.message : String(error)}`,
          ),
        )
      }
    })
    if (body !== undefined) request.write(body)
    request.end()
  })

export const createExtensionEgress = (options: ExtensionEgressOptions) => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  const resolve = options.resolve ?? ((hostname: string) => dnsLookup(hostname, { all: true, verbatim: true }))
  const isPrivateAddress = options.isPrivateAddress ?? isPrivateNetworkAddress

  return {
    fetch: async (urlString: string, init?: ExtensionFetchInit): Promise<ExtensionFetchResponse> => {
      let url: URL
      try {
        url = new URL(urlString)
      } catch {
        throw new ExtensionEgressError('invalid-url', `无效的 URL：${urlString}`)
      }

      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new ExtensionEgressError('invalid-protocol', `仅支持 HTTP/HTTPS 协议，当前：${url.protocol}`)
      }

      if (url.username || url.password) {
        throw new ExtensionEgressError('invalid-request', `URL 不允许包含用户名或密码。`)
      }

      const method = (init?.method ?? 'GET').toUpperCase()
      const headers = new Headers()

      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method)) {
        throw new ExtensionEgressError('invalid-request', `不支持的 HTTP 方法：${method}`)
      }

      if (init?.headers) {
        for (const [name, value] of Object.entries(init.headers)) {
          const lowerName = name.toLowerCase()
          if (FORBIDDEN_HEADERS.has(lowerName)) {
            throw new ExtensionEgressError('invalid-request-header', `不允许发送 ${name} 请求头。`)
          }
          headers.set(name, value)
        }
      }

      if (!headers.has('user-agent')) {
        headers.set('user-agent', 'NekroNXT-Extension')
      }

      let body: Buffer | undefined
      if (init?.body !== undefined && init?.bodyBase64 !== undefined) {
        throw new ExtensionEgressError('invalid-request', `body 和 bodyBase64 不能同时指定。`)
      }
      if (init?.body !== undefined) {
        body = Buffer.from(init.body, 'utf8')
      } else if (init?.bodyBase64 !== undefined) {
        if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(init.bodyBase64)) {
          throw new ExtensionEgressError('invalid-request', `无效的 base64 编码。`)
        }
        body = Buffer.from(init.bodyBase64, 'base64')
      }
      let currentMethod = method

      for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
        // Every hop is checked again: a redirect must not escape the declared policy or reach a private address.
        const hostname = normalizeUrlHostname(url)
        let isLocalHostname = false
        if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
          isLocalHostname = true
        }

        const configHost =
          options.policy.mode === 'config'
            ? options.policy.hosts.find((h) => h === `${hostname}${url.port ? `:${url.port}` : ''}`)
            : undefined
        const canAccessPrivate = isPrivateNetworkAllowed(options.policy, hostname, configHost)

        if (!isPolicyMatch(options.policy, hostname, configHost)) {
          const suggestion =
            options.policy.mode === 'domains'
              ? `请在 Manifest permissions.capabilities.network.domains 中声明 ${hostname}`
              : `该地址不是用户在配置中填写的服务地址`
          throw new ExtensionEgressError('policy-denied', `访问被拒：未授权访问 ${hostname}。${suggestion}`)
        }

        let addresses: ResolvedAddress[] = []
        if (isIP(hostname)) {
          const family = isIP(hostname)
          if (family === 4 || family === 6) {
            addresses = [{ address: hostname, family }]
          }
        } else {
          try {
            const resolved = await resolve(hostname)
            addresses = resolved.map((item: unknown) => {
              if (typeof item === 'object' && item !== null && 'address' in item && 'family' in item) {
                const itemRecord = item as Record<string, unknown>
                const address = String(itemRecord['address'])
                const familyNum = Number(itemRecord['family'])
                if (familyNum === 4 || familyNum === 6) {
                  return {
                    address,
                    family: familyNum,
                  }
                }
              }
              throw new Error('Invalid DNS resolution result')
            })
          } catch (error) {
            throw new ExtensionEgressError(
              'dns-error',
              `DNS 解析失败：${error instanceof Error ? error.message : String(error)}`,
            )
          }
        }

        if (addresses.length === 0) {
          throw new ExtensionEgressError('dns-error', `无法解析主机名 ${hostname}。`)
        }

        for (const addr of addresses) {
          if (isLocalHostname || isPrivateAddress(addr.address)) {
            if (!canAccessPrivate) {
              throw new ExtensionEgressError(
                'private-address',
                `访问被拒：不允许访问本机或私网地址 ${hostname}。需要访问内网服务时，请使用 config 网络模式并让用户在配置中填写该地址。`,
              )
            }
          }
        }

        const selected = addresses[0]!
        if (selected.family !== 4 && selected.family !== 6) {
          throw new ExtensionEgressError('invalid-request', `无效的地址族：${String(selected.family)}`)
        }

        const response = await createNetworkRequest(
          url,
          selected,
          currentMethod,
          headers,
          body,
          timeoutMs,
          maxResponseBytes,
        )

        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location')
          if (!location) {
            throw new ExtensionEgressError(
              'request-error',
              `收到重定向（状态码 ${response.status}）但没有 Location 头。`,
            )
          }

          if (redirectCount >= maxRedirects) {
            throw new ExtensionEgressError('too-many-redirects', `重定向次数超过 ${maxRedirects}。`)
          }

          let next: URL
          try {
            next = new URL(location, url)
          } catch {
            throw new ExtensionEgressError('request-error', `无效的重定向 URL：${location}`)
          }
          if (next.protocol !== 'http:' && next.protocol !== 'https:') {
            throw new ExtensionEgressError('invalid-protocol', `重定向到了不支持的协议：${next.protocol}`)
          }
          // Credentials an extension attached for one service must not follow a redirect to another origin.
          if (next.origin !== url.origin) {
            headers.delete('authorization')
            headers.delete('cookie')
          }
          if (
            response.status === 303 ||
            ((response.status === 301 || response.status === 302) && currentMethod === 'POST')
          ) {
            currentMethod = currentMethod === 'HEAD' ? 'HEAD' : 'GET'
            body = undefined
            headers.delete('content-type')
          }
          url = next
          continue
        }

        const contentLength = Number(response.headers.get('content-length') ?? '0')
        if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
          throw new ExtensionEgressError('response-too-large', `响应超过 ${maxResponseBytes} 字节。`)
        }

        if (response.bytes.byteLength > maxResponseBytes) {
          throw new ExtensionEgressError('response-too-large', `实际响应超过 ${maxResponseBytes} 字节。`)
        }

        const contentType = response.headers.get('content-type') ?? 'application/octet-stream'
        const isTextContent =
          contentType.includes('text/') ||
          contentType.includes('application/json') ||
          contentType.includes('application/xml') ||
          contentType.includes('application/javascript')

        const resultData: {
          url: string
          status: number
          headers: Record<string, string>
          contentType: string
          text?: string
          base64?: string
        } = {
          url: url.toString(),
          status: response.status,
          headers: Object.fromEntries(Array.from(response.headers.entries()).map(([k, v]) => [k.toLowerCase(), v])),
          contentType,
        }

        if (isTextContent) {
          resultData.text = new TextDecoder().decode(response.bytes)
        } else {
          resultData.base64 = Buffer.from(response.bytes).toString('base64')
        }

        return resultData
      }

      throw new ExtensionEgressError('too-many-redirects', `未能完成请求：重定向过多。`)
    },
  }
}
