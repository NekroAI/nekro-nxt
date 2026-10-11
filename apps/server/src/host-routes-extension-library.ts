import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { Unzip, UnzipInflate } from 'fflate'
import sharp from 'sharp'
import {
  AssetIdSchema,
  EXTENSION_ASSET_LIBRARY_DEFAULT_QUOTA_BYTES,
  ExtensionIdSchema,
  type ExtensionId,
} from '@nekro-nxt/contracts'
import type { NxtLibraryAsset } from '@nekro-nxt/extension-sdk'
import { imageThumbnail } from './extension-image-info.js'
import { ExtensionLibrary, sqliteLibraryRegistry } from './extension-library.js'
import { writeError, writeJson, type HostRouteContext } from './host-route-support.js'

/** One picture; larger files are rarely stickers or illustrations and are skipped. */
export const LIBRARY_UPLOAD_MAX_IMAGE_BYTES = 20 * 1024 * 1024
/** One request; a large collection can be sent as several archives. */
const LIBRARY_UPLOAD_MAX_REQUEST_BYTES = 4 * 1024 * 1024 * 1024
const ACCEPTED_FORMATS = new Set(['png', 'jpeg', 'gif', 'webp'])
const THUMBNAIL_CACHE_LIMIT = 600

type Added = NxtLibraryAsset & { readonly name: string; readonly existed: boolean }
type Skipped = { readonly name: string; readonly reason: string }

const pictureFormat = async (bytes: Uint8Array): Promise<string | undefined> => {
  try {
    const metadata = await sharp(bytes, { limitInputPixels: false }).metadata()
    return metadata.format !== undefined && ACCEPTED_FORMATS.has(metadata.format) ? metadata.format : undefined
  } catch {
    return undefined
  }
}

const isZip = (name: string, head: Uint8Array): boolean =>
  /\.zip$/iu.test(name) || (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04)

const baseName = (entry: string): string => entry.split('/').at(-1) ?? entry

/**
 * Pictures and zip archives a page uploads into its extension's library (表情包与扩展素材能力 §4.2). Archives are
 * read as a stream, so a large collection never sits in memory at once.
 */
/** The library quota of an installed extension whose host layer declares one; throws otherwise. */
export const installedLibraryQuota =
  (
    repository: Pick<
      HostRouteContext['runtime']['repository'],
      'getHostInstallation' | 'getExtensionRevisionVerification'
    >,
  ) =>
  (extensionId: ExtensionId): number => {
    const installation = repository.getHostInstallation(extensionId)
    if (installation === undefined) throw new Error('这个扩展没有安装到本机。')
    const permissions = repository.getExtensionRevisionVerification(installation.extensionRevisionId)?.permissions
    const declared = permissions?.host?.assets?.library
    if (declared === undefined) throw new Error('这个扩展没有声明扩展资源库。')
    return declared.quotaBytes ?? EXTENSION_ASSET_LIBRARY_DEFAULT_QUOTA_BYTES
  }

export function registerExtensionLibraryRoutes({
  registerRoute,
  repository,
  assetService,
  libraryQuota,
}: {
  readonly registerRoute: HostRouteContext['registerRoute']
  readonly repository: Pick<
    HostRouteContext['runtime']['repository'],
    'extensionLibrary' | 'getAssetById' | 'canAccessAsset' | 'grantAssetAccess'
  >
  readonly assetService: HostRouteContext['runtime']['assetService']
  readonly libraryQuota: (extensionId: ExtensionId) => number
}): () => void {
  const library = new ExtensionLibrary({
    registry: sqliteLibraryRegistry(repository.extensionLibrary),
    assets: repository,
    assetService,
    now: () => Date.now(),
  })
  const thumbnails = new Map<string, Buffer>()

  const importPicture = async (
    extensionId: ExtensionId,
    quota: number,
    name: string,
    bytes: Uint8Array,
    added: Added[],
    skipped: Skipped[],
  ): Promise<void> => {
    if (bytes.byteLength > LIBRARY_UPLOAD_MAX_IMAGE_BYTES) {
      skipped.push({ name, reason: `超过 ${LIBRARY_UPLOAD_MAX_IMAGE_BYTES / 1024 / 1024} MB` })
      return
    }
    if ((await pictureFormat(bytes)) === undefined) {
      skipped.push({ name, reason: '不是 PNG、JPEG、GIF 或 WebP 图片' })
      return
    }
    try {
      added.push({ ...(await library.import(extensionId, bytes, quota)), name })
    } catch (error) {
      skipped.push({ name, reason: error instanceof Error ? error.message : String(error) })
    }
  }

  const readArchive = async (
    stream: AsyncIterable<Buffer>,
    first: Buffer,
    onPicture: (name: string, bytes: Uint8Array) => Promise<void>,
    skipped: Skipped[],
  ): Promise<void> => {
    const pending: Promise<void>[] = []
    let failure: Error | undefined
    const unzip = new Unzip((file) => {
      const name = file.name
      if (name.endsWith('/') || baseName(name).startsWith('.') || name.startsWith('__MACOSX/')) return
      // Judged by content, not the extension: collections exported from other programs often have odd names.
      if (file.originalSize !== undefined && file.originalSize > LIBRARY_UPLOAD_MAX_IMAGE_BYTES) {
        skipped.push({ name, reason: `超过 ${LIBRARY_UPLOAD_MAX_IMAGE_BYTES / 1024 / 1024} MB` })
        return
      }
      const chunks: Uint8Array[] = []
      let size = 0
      file.ondata = (error, chunk, final) => {
        if (error) {
          skipped.push({ name, reason: '压缩包中的文件损坏' })
          return
        }
        size += chunk.byteLength
        if (size > LIBRARY_UPLOAD_MAX_IMAGE_BYTES) {
          file.terminate()
          skipped.push({ name, reason: `超过 ${LIBRARY_UPLOAD_MAX_IMAGE_BYTES / 1024 / 1024} MB` })
          return
        }
        chunks.push(chunk)
        if (final) pending.push(onPicture(name, Buffer.concat(chunks)))
      }
      try {
        file.start()
      } catch {
        skipped.push({ name, reason: '不支持这种压缩方式' })
      }
    })
    unzip.register(UnzipInflate)
    const push = (chunk: Uint8Array, final: boolean) => {
      try {
        unzip.push(chunk, final)
      } catch (error) {
        failure ??= error instanceof Error ? error : new Error(String(error))
      }
    }
    let total = first.byteLength
    push(first, false)
    for await (const chunk of stream) {
      total += chunk.byteLength
      if (total > LIBRARY_UPLOAD_MAX_REQUEST_BYTES) throw new Error('单次上传超过 4 GB，请分成多个压缩包。')
      push(chunk, false)
      // Pictures are imported one batch at a time so a fast upload cannot pile up memory.
      while (pending.length > 8) await pending.shift()
      if (failure !== undefined) break
    }
    push(new Uint8Array(0), true)
    for (const task of pending) await task
    if (failure !== undefined) throw new Error(`压缩包无法读取：${failure.message}`)
  }

  const upload = async (req: IncomingMessage, res: ServerResponse, extensionId: ExtensionId): Promise<void> => {
    const quota = libraryQuota(extensionId)
    const name = decodeURIComponent(String(req.headers['x-nekro-file-name'] ?? 'upload')).slice(0, 255) || 'upload'
    const added: Added[] = []
    const skipped: Skipped[] = []
    const iterator = (req as AsyncIterable<Buffer>)[Symbol.asyncIterator]()
    const head = await iterator.next()
    const first = head.done ? Buffer.alloc(0) : head.value
    if (isZip(name, first)) {
      await readArchive(
        { [Symbol.asyncIterator]: () => iterator },
        first,
        (entry, bytes) => importPicture(extensionId, quota, entry, bytes, added, skipped),
        skipped,
      )
    } else {
      const chunks = [first]
      let size = first.byteLength
      for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
        size += next.value.byteLength
        if (size > LIBRARY_UPLOAD_MAX_IMAGE_BYTES) {
          skipped.push({ name, reason: `超过 ${LIBRARY_UPLOAD_MAX_IMAGE_BYTES / 1024 / 1024} MB` })
          writeJson(res, 200, { added, skipped })
          req.resume()
          return
        }
        chunks.push(next.value)
      }
      await importPicture(extensionId, quota, name, Buffer.concat(chunks), added, skipped)
    }
    writeJson(res, 200, { added, skipped })
  }

  const serve = async (
    res: ServerResponse,
    extensionId: ExtensionId,
    encodedAssetId: string,
    thumbnail: boolean,
  ): Promise<void> => {
    const assetId = AssetIdSchema.parse(decodeURIComponent(encodedAssetId))
    libraryQuota(extensionId)
    if (library.get(extensionId, assetId) === undefined) {
      writeError(res, 404, 'library-asset-not-found', '扩展资源库里没有这张图片。')
      return
    }
    const asset = repository.getAssetById(assetId)
    if (asset === undefined) {
      writeError(res, 404, 'library-asset-not-found', '资源尚不可用。')
      return
    }
    let body: Buffer
    let type = asset.mediaType
    if (thumbnail) {
      const cached = thumbnails.get(asset.contentDigest)
      body = cached ?? (await imageThumbnail(assetService.blobPath(asset)))
      if (cached === undefined) {
        if (thumbnails.size >= THUMBNAIL_CACHE_LIMIT) thumbnails.delete(thumbnails.keys().next().value!)
        thumbnails.set(asset.contentDigest, body)
      }
      type = 'image/webp'
    } else {
      body = await readFile(assetService.blobPath(asset))
    }
    res.writeHead(200, {
      'content-type': type,
      'content-length': String(body.byteLength),
      'cache-control': 'private, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    })
    res.end(body)
  }

  registerRoute({
    kind: 'prefix',
    path: '/api/extension-library',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const match = /^\/api\/extension-library\/([^/]+)\/assets(?:\/([^/]+))?$/u.exec(url.pathname)
      if (!match) {
        writeError(res, 404, 'not-found', `Unknown route: ${req.method} ${url.pathname}`)
        return
      }
      try {
        const extensionId = ExtensionIdSchema.parse(decodeURIComponent(match[1] ?? ''))
        if (match[2] === undefined && req.method === 'POST') {
          await upload(req, res, extensionId)
          return
        }
        if (match[2] !== undefined && req.method === 'GET') {
          await serve(res, extensionId, match[2], url.searchParams.get('thumbnail') === '1')
          return
        }
        writeError(res, 405, 'method-not-allowed', 'Method not allowed.')
      } catch (error) {
        if (!res.headersSent) {
          writeError(res, 400, 'library-request-failed', error instanceof Error ? error.message : String(error))
        }
      }
    },
  })
  return () => thumbnails.clear()
}
