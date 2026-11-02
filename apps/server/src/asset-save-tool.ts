import { defineTool } from '@deepseek-ai/dsh-tools'
import { AssetIdSchema, type ChannelId } from '@nekro-nxt/contracts'
import type { AssetService } from '@nekro-nxt/core'
import { constants } from 'node:fs'
import { copyFile, mkdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { AssetAccessRepository } from './session-image-context.js'

/** Where pictures and files go when the agent names no path. */
const DEFAULT_DIRECTORY = 'attachments'
/** Every Asset fits; the Asset Service caps uploads at the same size. */
export const ASSET_SAVE_MAX_BYTES = 128 * 1024 * 1024

const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/mp4': '.m4a',
  'audio/amr': '.amr',
  'audio/silk': '.silk',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'video/x-matroska': '.mkv',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'application/json': '.json',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'text/csv': '.csv',
}

const isInside = (root: string, target: string): boolean => {
  const relative = path.relative(root, target)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

const errorCode = (error: unknown): unknown => (error instanceof Error && 'code' in error ? error.code : undefined)

/**
 * Copies a channel Asset into the agent's workspace without replacing anything there: a taken name gets `-2`, `-3`, …
 * The destination must stay inside the workspace after symlinks are resolved.
 */
export const saveAssetToWorkspace = async (input: {
  readonly channelId: ChannelId
  readonly assetId: string
  readonly path?: string | undefined
  readonly workspace: string
  readonly assets: Pick<AssetAccessRepository, 'getAssetById' | 'canAccessAsset'>
  readonly assetService: Pick<AssetService, 'blobPath'>
}): Promise<{ readonly path: string; readonly byteSize: number; readonly mediaType: string }> => {
  const parsed = AssetIdSchema.safeParse(input.assetId)
  const asset = parsed.success ? input.assets.getAssetById(parsed.data) : undefined
  if (asset === undefined || !input.assets.canAccessAsset(asset.id, input.channelId)) {
    throw new Error(`当前频道里找不到资源 ${input.assetId}。`)
  }
  if (asset.byteSize > ASSET_SAVE_MAX_BYTES) {
    throw new Error(
      `文件有 ${Math.ceil(asset.byteSize / 1024 / 1024)} MB，最多 ${ASSET_SAVE_MAX_BYTES / 1024 / 1024} MB。`,
    )
  }
  const root = await realpath(input.workspace)
  const defaultName = `${asset.id}${EXTENSIONS[asset.mediaType.split(';')[0]!.trim()] ?? ''}`
  const requested = input.path?.trim() ? input.path.trim() : `${DEFAULT_DIRECTORY}/`
  let target = path.resolve(root, requested)
  const directoryRequested =
    requested.endsWith('/') ||
    requested.endsWith(path.sep) ||
    (await stat(target).then(
      (info) => info.isDirectory(),
      () => false,
    ))
  if (directoryRequested) target = path.join(target, defaultName)
  if (!isInside(root, target)) throw new Error('path 只能指向你工作区里的位置。')
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  const directory = await realpath(path.dirname(target))
  if (directory !== root && !isInside(root, directory)) throw new Error('path 只能指向你工作区里的位置。')
  const extension = path.extname(target)
  const stem = path.basename(target, extension)
  for (let attempt = 1; attempt <= 1000; attempt += 1) {
    const candidate = path.join(directory, attempt === 1 ? `${stem}${extension}` : `${stem}-${attempt}${extension}`)
    try {
      await copyFile(input.assetService.blobPath(asset), candidate, constants.COPYFILE_EXCL)
      return {
        path: path.relative(root, candidate).split(path.sep).join('/'),
        byteSize: asset.byteSize,
        mediaType: asset.mediaType,
      }
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error
    }
  }
  throw new Error('这个位置的同名文件太多了，请换一个 path。')
}

/** Lets an agent with a workspace process channel files with its own commands (附加功能 F6). */
export const assetSaveToWorkspaceTool = (
  channelId: ChannelId,
  assets: Pick<AssetAccessRepository, 'getAssetById' | 'canAccessAsset'>,
  assetService: Pick<AssetService, 'blobPath'>,
  workspace: string,
) =>
  defineTool({
    name: 'asset_save_to_workspace',
    description: [
      '把当前频道里的图片、语音、视频或文件存进你的工作区，返回保存后的路径（相对工作区），之后可以在命令里直接处理它。',
      `不写 path 时存到 ${DEFAULT_DIRECTORY}/，以资源编号命名；path 以 / 结尾或是已有目录时存进那个目录。`,
      '同名文件已经存在时自动改名，不会覆盖。',
    ].join(''),
    parameters: {
      assetId: { type: 'string', required: true, description: '当前频道消息里出现过的资源编号。' },
      path: { type: 'string', description: '工作区里的保存位置，相对工作区；可以是文件名或目录。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          byteSize: { type: 'integer', required: true },
          mediaType: { type: 'string', required: true },
        },
      },
      render: (_arguments, value) => [
        { type: 'text', text: `已保存到工作区 ${value.path}（${value.byteSize} bytes，${value.mediaType}）。` },
      ],
    },
    execute: (args) =>
      saveAssetToWorkspace({ channelId, assetId: args.assetId, path: args.path, workspace, assets, assetService }),
  })
