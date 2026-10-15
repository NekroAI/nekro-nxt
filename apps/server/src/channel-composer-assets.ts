import { AssetIdSchema, CHANNEL_COMPOSER_MAX_BYTES, type ChannelId, type HostApiRequest } from '@nekro-nxt/contracts'
import type { IncomingMessage } from 'node:http'
import sharp from 'sharp'
import type { NekroRuntime } from './bootstrap.js'

const DRAFT_ASSET_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000
const COMPOSER_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

const hasPathOrControlChar = (value: string): boolean =>
  [...value].some((char) => {
    const code = char.codePointAt(0) ?? 0
    return char === '/' || char === '\\' || code <= 0x1f || code === 0x7f
  })

export const expireComposerAssets = (runtime: NekroRuntime, channelId: ChannelId): void =>
  runtime.repository.expireBrowserAssets(Date.now() - DRAFT_ASSET_LIFETIME_MS, channelId)

/** Reads a bounded upload without destroying the response socket when the limit is exceeded. */
export const readComposerBytes = (req: IncomingMessage): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = []
    let size = 0
    let rejected = false
    const fail = () => {
      rejected = true
      chunks.length = 0
      reject(new Error('附件不能超过 64 MiB。'))
    }
    if (Number(req.headers['content-length']) > CHANNEL_COMPOSER_MAX_BYTES) fail()
    req.on('data', (chunk: Uint8Array) => {
      if (rejected) return
      size += chunk.byteLength
      if (size > CHANNEL_COMPOSER_MAX_BYTES) fail()
      else chunks.push(chunk)
    })
    req.on('end', () => {
      if (!rejected) resolve(Buffer.concat(chunks))
    })
    req.on('error', reject)
    req.on('aborted', () => reject(new Error('附件上传已中断。')))
  })

export async function uploadComposerAsset(runtime: NekroRuntime, channelId: ChannelId, req: IncomingMessage) {
  const channel = runtime.repository.getChannel(channelId)
  if (!channel) throw new Error('频道不存在。')
  const nameHeader = req.headers['x-file-name']
  const fileName =
    nameHeader === undefined
      ? '附件'
      : decodeURIComponent(Array.isArray(nameHeader) ? (nameHeader[0] ?? '') : nameHeader).trim()
  if (!fileName || fileName.length > 255 || hasPathOrControlChar(fileName))
    throw new Error('附件名称无效，请使用不含路径的文件名。')
  const bytes = await readComposerBytes(req)
  // Canonical MIME comes from file bytes. Client MIME and file extensions cannot turn arbitrary data into an image.
  const { asset } = await runtime.assetService.prepare({ bytes })
  const partType = COMPOSER_IMAGE_TYPES.has(asset.mediaType) ? ('image' as const) : ('file' as const)
  if (partType === 'image') {
    try {
      const metadata = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata()
      if (!metadata.width || !metadata.height) throw new Error('Missing dimensions')
    } catch {
      throw new Error('图片无法读取，请重新选择文件。')
    }
  }
  if (channel.kind !== 'internal') {
    const outbound = runtime.connectionCapabilities(channel.connectionId)?.outbound
    if (outbound?.[partType === 'image' ? 'images' : 'files'] !== true)
      throw new Error(`当前频道连接不支持${partType === 'image' ? '图片' : '文件'}发送。`)
  }
  expireComposerAssets(runtime, channelId)
  runtime.repository.grantAssetAccess({
    assetId: asset.id,
    channelId,
    source: 'browser-composer',
    grantedAt: Date.now(),
  })
  return { assetId: asset.id, mediaType: asset.mediaType, byteSize: asset.byteSize, fileName, partType }
}

export const validateComposerAssets = (
  runtime: NekroRuntime,
  channelId: ChannelId,
  parts: HostApiRequest<'sendChannelMessage'>['parts'],
): void => {
  expireComposerAssets(runtime, channelId)
  const channel = runtime.repository.getChannel(channelId)
  if (!channel) throw new Error('频道不存在。')
  let total = 0
  for (const part of parts) {
    if (part.type !== 'image' && part.type !== 'file') continue
    const assetId = AssetIdSchema.safeParse(part.assetId)
    if (!assetId.success || !runtime.repository.canAccessAsset(assetId.data, channelId))
      throw new Error('附件已过期或不属于当前频道，请重新添加。')
    const asset = runtime.repository.getAssetById(assetId.data)
    if (!asset) throw new Error('附件不存在，请重新添加。')
    if (part.type === 'image' && !COMPOSER_IMAGE_TYPES.has(asset.mediaType)) throw new Error('这个附件不是支持的图片。')
    total += asset.byteSize
    if (total > CHANNEL_COMPOSER_MAX_BYTES) throw new Error('附件总大小不能超过 64 MiB。')
    if (
      channel.kind !== 'internal' &&
      runtime.connectionCapabilities(channel.connectionId)?.outbound[part.type === 'image' ? 'images' : 'files'] !==
        true
    )
      throw new Error(`当前频道连接不支持${part.type === 'image' ? '图片' : '文件'}发送。`)
  }
}
