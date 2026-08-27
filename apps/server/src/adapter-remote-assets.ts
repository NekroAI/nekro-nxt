import type { AdapterAssetHost } from '@nekro-nxt/adapter-sdk'
import { lookup } from 'node:dns/promises'
import { request } from 'node:https'
import { isIP } from 'node:net'

const REMOTE_TIMEOUT_MS = 30_000

const privateIpv4 = (address: string): boolean => {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true
  return (
    parts[0] === 0 ||
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && (parts[1] ?? 0) >= 16 && (parts[1] ?? 0) <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 100 && (parts[1] ?? 0) >= 64 && (parts[1] ?? 0) <= 127) ||
    (parts[0] ?? 0) >= 224
  )
}

const privateIp = (address: string): boolean => {
  const family = isIP(address)
  if (family === 4) return privateIpv4(address)
  if (family !== 6) return true
  const normalized = address.toLowerCase()
  if (normalized.startsWith('::ffff:')) return privateIpv4(normalized.slice('::ffff:'.length))
  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb') ||
    normalized.startsWith('ff') ||
    normalized.startsWith('2001:db8:')
  )
}

const safeFilename = (header: string | string[] | undefined): string | undefined => {
  const value = Array.isArray(header) ? header[0] : header
  if (!value) return undefined
  const encoded = /filename\*=UTF-8''([^;]+)/iu.exec(value)?.[1]
  const plain = /filename="?([^";]+)"?/iu.exec(value)?.[1]
  let candidate = encoded ?? plain
  if (!candidate) return undefined
  try {
    candidate = decodeURIComponent(candidate)
  } catch {
    // Keep the literal header value when percent-decoding fails.
  }
  const basename = candidate
    .split(/[\\/]/u)
    .at(-1)
    ?.split('')
    .filter((character) => {
      const code = character.charCodeAt(0)
      return code > 31 && code !== 127
    })
    .join('')
    .trim()
  if (!basename) return undefined
  const bytes = Buffer.from(basename)
  return bytes.byteLength <= 256 ? basename : bytes.subarray(0, 256).toString('utf8').replace(/�+$/u, '')
}

export const fetchAdapterRemoteBytes: AdapterAssetHost['fetchRemoteBytes'] = async ({ url, maxBytes }) => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('Remote Asset maxBytes must be positive.')
  const target = new URL(url)
  if (target.protocol !== 'https:' || target.username || target.password) {
    throw new Error('远程资源必须使用不含用户凭据的 HTTPS 地址。')
  }
  const hostname = target.hostname.startsWith('[') ? target.hostname.slice(1, -1) : target.hostname
  const literalFamily = isIP(hostname)
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await lookup(hostname, { all: true, verbatim: true })
  if (addresses.length === 0 || addresses.some(({ address }) => privateIp(address))) {
    throw new Error('远程资源地址解析到了不允许的网络。')
  }
  const selected = addresses[0]!
  return new Promise((resolve, reject) => {
    const req = request(
      target,
      {
        method: 'GET',
        headers: { Accept: '*/*' },
        ...(literalFamily ? {} : { servername: hostname }),
        lookup: (_hostname, _options, callback) => callback(null, selected.address, selected.family),
      },
      (response) => {
        const status = response.statusCode ?? 0
        if (status >= 300 && status < 400) {
          response.resume()
          reject(new Error('远程资源重定向已被拒绝。'))
          return
        }
        if (status < 200 || status >= 300) {
          response.resume()
          reject(new Error(`远程资源返回 HTTP ${status}。`))
          return
        }
        const declaredLength = Number(response.headers['content-length'])
        if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
          response.resume()
          reject(new Error('远程资源超过允许的大小。'))
          return
        }
        const chunks: Buffer[] = []
        let total = 0
        response.on('data', (chunk: Buffer) => {
          total += chunk.byteLength
          if (total > maxBytes) {
            response.destroy(new Error('远程资源超过允许的大小。'))
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => {
          const declaredMediaType = response.headers['content-type']?.split(';', 1)[0]?.trim()
          const filename = safeFilename(response.headers['content-disposition'])
          resolve({
            bytes: new Uint8Array(Buffer.concat(chunks)),
            ...(declaredMediaType ? { declaredMediaType } : {}),
            ...(filename ? { filename } : {}),
          })
        })
        response.on('error', reject)
      },
    )
    req.setTimeout(REMOTE_TIMEOUT_MS, () => req.destroy(new Error('远程资源读取超时。')))
    req.on('error', reject)
    req.end()
  })
}
