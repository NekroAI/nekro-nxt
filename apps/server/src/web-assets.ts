/**
 * Static delivery for the Web build output: content types, cache validators and
 * on-demand compression in front of the upstream static helper, which sets no
 * cache or encoding headers. Anything this module cannot serve safely (missing
 * file, directory, entry HTML, unknown extension) is declined so the helper
 * keeps its original behavior.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createReadStream } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { brotliCompress, constants as zlibConstants, gzip } from 'node:zlib'

const brotliAsync = promisify(brotliCompress)
const gzipAsync = promisify(gzip)

type Encoding = 'br' | 'gzip'

interface AssetType {
  readonly mime: string
  readonly compressible: boolean
}

const TYPES: Readonly<Record<string, AssetType>> = {
  '.js': { mime: 'text/javascript; charset=utf-8', compressible: true },
  '.mjs': { mime: 'text/javascript; charset=utf-8', compressible: true },
  '.css': { mime: 'text/css; charset=utf-8', compressible: true },
  '.html': { mime: 'text/html; charset=utf-8', compressible: true },
  '.json': { mime: 'application/json', compressible: true },
  '.webmanifest': { mime: 'application/manifest+json', compressible: true },
  '.svg': { mime: 'image/svg+xml', compressible: true },
  '.txt': { mime: 'text/plain; charset=utf-8', compressible: true },
  '.map': { mime: 'application/json', compressible: true },
  '.wasm': { mime: 'application/wasm', compressible: true },
  '.png': { mime: 'image/png', compressible: false },
  '.jpg': { mime: 'image/jpeg', compressible: false },
  '.webp': { mime: 'image/webp', compressible: false },
  '.ico': { mime: 'image/x-icon', compressible: false },
  '.woff2': { mime: 'font/woff2', compressible: false },
}

/** Below this size the encoding header and CPU cost outweigh the saving. */
const MIN_COMPRESS_BYTES = 1024
/** Compressed copies kept in memory; the least recently used are dropped past this. */
const COMPRESSED_CACHE_LIMIT_BYTES = 64 * 1024 * 1024
const IMMUTABLE = 'public, max-age=31536000, immutable'

/** Pick the preferred encoding the client accepts; an explicit q=0 refuses it. */
const negotiateEncoding = (acceptEncoding: string | string[] | undefined): Encoding | undefined => {
  const header = Array.isArray(acceptEncoding) ? acceptEncoding.join(',') : acceptEncoding
  if (header === undefined) return undefined
  const accepted = new Set<string>()
  for (const part of header.split(',')) {
    const [token = '', ...params] = part.trim().toLowerCase().split(';')
    const quality = params.map((param) => /^\s*q\s*=\s*([\d.]+)\s*$/.exec(param)?.[1]).find((q) => q !== undefined)
    if (quality !== undefined && Number(quality) === 0) continue
    accepted.add(token.trim())
  }
  if (accepted.has('br')) return 'br'
  if (accepted.has('gzip')) return 'gzip'
  return undefined
}

const compress = (encoding: Encoding, data: Buffer): Promise<Buffer> =>
  encoding === 'br'
    ? // Quality 5 keeps first-request latency low; the result is cached afterwards.
      brotliAsync(data, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } })
    : gzipAsync(data, { level: 6 })

/** True when If-None-Match lists the current validator (weak comparison, as for GET). */
const matchesEtag = (header: string | string[] | undefined, etag: string): boolean => {
  const value = Array.isArray(header) ? header.join(',') : header
  if (value === undefined) return false
  const strip = (tag: string): string => tag.trim().replace(/^W\//, '')
  const current = strip(etag)
  return value.split(',').some((tag) => strip(tag) === '*' || strip(tag) === current)
}

/** Send an HTML document, compressed per Accept-Encoding; the entry page is small, so it is compressed each time. */
export const sendHtml = async (request: IncomingMessage, response: ServerResponse, html: string): Promise<void> => {
  const encoding = negotiateEncoding(request.headers['accept-encoding'])
  const raw = Buffer.from(html, 'utf8')
  const body = encoding === undefined ? raw : await compress(encoding, raw)
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-cache',
    vary: 'accept-encoding',
    'content-length': body.length,
    ...(encoding === undefined ? {} : { 'content-encoding': encoding }),
  })
  response.end(request.method === 'HEAD' ? undefined : body)
}

export type WebAssetHandler = (request: IncomingMessage, response: ServerResponse, pathname: string) => Promise<boolean>

/**
 * Build the handler for one dist directory. It resolves to false for requests it
 * leaves to the upstream helper, and to true once a response has been written.
 */
export const createWebAssetHandler = (distRoot: string, distIndex: string): WebAssetHandler => {
  // Insertion order doubles as recency: hits re-insert, eviction takes the first key.
  const cache = new Map<string, { readonly promise: Promise<Buffer>; bytes: number }>()
  let cachedBytes = 0

  const compressed = (key: string, file: string, encoding: Encoding): Promise<Buffer> => {
    const hit = cache.get(key)
    if (hit !== undefined) {
      cache.delete(key)
      cache.set(key, hit)
      return hit.promise
    }
    const entry = { promise: readFile(file).then((data) => compress(encoding, data)), bytes: 0 }
    cache.set(key, entry)
    entry.promise.then(
      (data) => {
        entry.bytes = data.length
        cachedBytes += data.length
        for (const [oldKey, old] of cache) {
          if (cachedBytes <= COMPRESSED_CACHE_LIMIT_BYTES || oldKey === key) break
          cache.delete(oldKey)
          cachedBytes -= old.bytes
        }
      },
      () => {
        if (cache.get(key) === entry) cache.delete(key)
      },
    )
    return entry.promise
  }

  return async (request, response, pathname) => {
    if ((request.method !== 'GET' && request.method !== 'HEAD') || pathname.includes('\0')) return false
    const lexical = path.resolve(path.normalize(path.join(distRoot, pathname)))
    if (!lexical.startsWith(distRoot + path.sep)) return false
    let file: string
    let root: string
    let size: number
    let mtimeMs: number
    try {
      ;[file, root] = await Promise.all([realpath(lexical), realpath(distRoot)])
      // A symlink inside dist must not lead outside it.
      if (!file.startsWith(root + path.sep)) return false
      if (file === (await realpath(distIndex))) return false
      const info = await stat(file)
      if (!info.isFile()) return false
      ;({ size, mtimeMs } = info)
    } catch {
      return false
    }
    const type = TYPES[path.extname(file).toLowerCase()]
    if (type === undefined) return false

    const hashed = path.relative(root, file).split(path.sep)[0] === 'assets'
    const etag = `W/"${size.toString(16)}-${Math.trunc(mtimeMs).toString(16)}"`
    const headers: Record<string, string | number> = {
      'content-type': type.mime,
      'x-content-type-options': 'nosniff',
      'cache-control': hashed ? IMMUTABLE : 'no-cache',
      etag,
    }
    const encoding =
      type.compressible && size > MIN_COMPRESS_BYTES ? negotiateEncoding(request.headers['accept-encoding']) : undefined
    if (type.compressible) headers['vary'] = 'accept-encoding'

    if (matchesEtag(request.headers['if-none-match'], etag)) {
      // A 304 carries the validators and cache policy but no representation headers.
      const notModified = { ...headers }
      delete notModified['content-type']
      response.writeHead(304, notModified)
      response.end()
      return true
    }

    if (encoding === undefined) {
      response.writeHead(200, { ...headers, 'content-length': size })
      if (request.method === 'HEAD') {
        response.end()
        return true
      }
      await pipeline(createReadStream(file), response)
      return true
    }

    // The encoding is part of the key, so each client capability gets its own copy.
    const body = await compressed(`${file}|${Math.trunc(mtimeMs)}|${size}|${encoding}`, file, encoding)
    response.writeHead(200, { ...headers, 'content-encoding': encoding, 'content-length': body.length })
    response.end(request.method === 'HEAD' ? undefined : body)
    return true
  }
}
