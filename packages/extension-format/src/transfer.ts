import { ExtensionIdSchema, ExtensionRevisionIdSchema, parseJsonValue } from '@nekro-nxt/contracts'
import { strFromU8, unzipSync } from 'fflate'
import { z } from 'zod'
import { materializeImportedRevision, sha256Hex, type MaterializedExtensionRevision } from './revision.js'

/**
 * `.nxt-extension` 传输包：根目录 `manifest.json` 描述扩展身份、Revision 摘要与文件清单，`revision/` 下是清单、
 * 源码与资源。解析只做结构与完整性校验；清单与内容摘要由 `verifyExtensionPackage` 进一步校验。
 */
export const extensionTransferManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('nekro-nxt-extension'),
    extension: z
      .object({
        id: ExtensionIdSchema,
        scope: z.enum(['agent', 'host-adapter', 'host-ui']),
        slug: z.string().trim().min(3).max(64),
        displayName: z.string().trim().min(1).max(80),
        description: z.string().max(500),
        createdAt: z.number().int().safe().nonnegative(),
      })
      .strict(),
    revision: z
      .object({
        id: ExtensionRevisionIdSchema,
        revisionNumber: z.number().int().positive(),
        contentDigest: z.string().regex(/^[a-f0-9]{64}$/u),
        payloadDigest: z.string().regex(/^[a-f0-9]{64}$/u),
        createdAt: z.number().int().safe().nonnegative(),
      })
      .strict(),
    files: z
      .array(
        z
          .object({
            path: z.string().min(1).max(200),
            size: z
              .number()
              .int()
              .nonnegative()
              .max(4 * 1024 * 1024),
            sha256: z.string().regex(/^[a-f0-9]{64}$/u),
          })
          .strict(),
      )
      .min(1)
      .max(16),
    sourceVerification: z.unknown().nullable(),
  })
  .strict()

export type ParsedExtensionImport = {
  readonly manifest: z.output<typeof extensionTransferManifestSchema>
  readonly revisionManifest: unknown
  readonly sources: { readonly host?: string; readonly client?: string }
  readonly resources: Readonly<Record<string, string>>
}

export const assertSafeArchivePath = (name: string): void => {
  if (
    !name ||
    name.includes('\\') ||
    name.startsWith('/') ||
    /^[A-Za-z]:/u.test(name) ||
    name.split('/').some((segment) => segment === '..' || segment === '')
  ) {
    throw new Error(`导入包包含不安全路径：${name}`)
  }
}

export const assertZipHasNoLinksOrDuplicates = (data: Uint8Array): void => {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let eocdOffset = -1
  const minimumOffset = Math.max(0, data.byteLength - 22 - 65_535)
  for (let offset = data.byteLength - 22; offset >= minimumOffset; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      eocdOffset = offset
      break
    }
  }
  if (eocdOffset < 0) throw new Error('导入包缺少有效 ZIP 中央目录。')
  const disk = view.getUint16(eocdOffset + 4, true)
  const centralDisk = view.getUint16(eocdOffset + 6, true)
  const diskEntries = view.getUint16(eocdOffset + 8, true)
  const totalEntries = view.getUint16(eocdOffset + 10, true)
  const centralSize = view.getUint32(eocdOffset + 12, true)
  const centralOffset = view.getUint32(eocdOffset + 16, true)
  const commentLength = view.getUint16(eocdOffset + 20, true)
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    diskEntries !== totalEntries ||
    totalEntries === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff ||
    eocdOffset + 22 + commentLength !== data.byteLength ||
    centralOffset + centralSize > eocdOffset
  ) {
    throw new Error('导入包使用了不支持的分卷、ZIP64 或损坏的中央目录。')
  }
  const names = new Set<string>()
  let offset = centralOffset
  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > eocdOffset || view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error('导入包 ZIP 中央目录条目损坏。')
    }
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    if (offset + 46 + nameLength + extraLength + commentLength > eocdOffset) {
      throw new Error('导入包 ZIP 中央目录条目越界。')
    }
    const name = strFromU8(data.subarray(offset + 46, offset + 46 + nameLength))
    assertSafeArchivePath(name)
    if (names.has(name)) throw new Error(`导入包包含重复文件：${name}`)
    names.add(name)
    const madeBy = view.getUint16(offset + 4, true) >>> 8
    const unixMode = view.getUint32(offset + 38, true) >>> 16
    if (madeBy === 3 && (unixMode & 0xf000) === 0xa000) throw new Error(`导入包不得包含符号链接：${name}`)
    offset += 46 + nameLength + extraLength + commentLength
  }
  if (names.size === 0 || offset !== centralOffset + centralSize) throw new Error('导入包 ZIP 中央目录大小不一致。')
}

export const unzipTransferArchive = (data: Uint8Array): Record<string, Uint8Array> => {
  if (data.byteLength === 0 || data.byteLength > 16 * 1024 * 1024) throw new Error('导入包必须大于 0 且不超过 16 MiB。')
  assertZipHasNoLinksOrDuplicates(data)
  let fileCount = 0
  let expandedBytes = 0
  return unzipSync(data, {
    filter: (file) => {
      assertSafeArchivePath(file.name)
      fileCount += 1
      expandedBytes += file.originalSize
      if (fileCount > 64) throw new Error('导入包文件数超过 64 个。')
      if (file.originalSize > 4 * 1024 * 1024) throw new Error(`导入包单文件超过 4 MiB：${file.name}`)
      if (expandedBytes > 32 * 1024 * 1024) throw new Error('导入包解压后超过 32 MiB。')
      return true
    },
  })
}

export const parseExtensionImport = (data: Uint8Array): ParsedExtensionImport => {
  const files = unzipTransferArchive(data)
  const root = files['manifest.json']
  if (!root) throw new Error('导入包缺少根 manifest.json。')
  const manifest = extensionTransferManifestSchema.parse(JSON.parse(strFromU8(root)))
  const expected = new Set(['manifest.json', ...manifest.files.map((file) => file.path)])
  for (const name of Object.keys(files)) if (!expected.has(name)) throw new Error(`导入包包含清单外文件：${name}`)
  for (const descriptor of manifest.files) {
    const content = files[descriptor.path]
    if (!content) throw new Error(`导入包缺少文件：${descriptor.path}`)
    if (content.byteLength !== descriptor.size) throw new Error(`导入包文件大小不一致：${descriptor.path}`)
    if (sha256Hex(content) !== descriptor.sha256) {
      throw new Error(`导入包文件校验和不一致：${descriptor.path}`)
    }
  }
  const revisionManifest = files['revision/manifest.json']
  if (!revisionManifest) throw new Error('导入包缺少 Revision Manifest。')
  const host = files['revision/source/host.ts']
  const client = files['revision/source/client.ts']
  if (!host && !client) throw new Error('导入包没有可构建源码。')
  return {
    manifest,
    revisionManifest: parseJsonValue(JSON.parse(strFromU8(revisionManifest))),
    sources: {
      ...(host === undefined ? {} : { host: strFromU8(host) }),
      ...(client === undefined ? {} : { client: strFromU8(client) }),
    },
    resources: Object.fromEntries(
      Object.entries(files)
        .filter(([filePath]) => filePath.startsWith('revision/assets/'))
        .map(([filePath, content]) => [filePath.slice('revision/'.length), strFromU8(content)]),
    ),
  }
}

export interface VerifiedExtensionPackage {
  readonly transfer: ParsedExtensionImport['manifest']
  readonly revision: MaterializedExtensionRevision
}

/**
 * 与 NekroNXT 导入相同的完整校验：包结构、文件摘要、清单、源码与资源，以及清单身份、类型和内容摘要与传输清单
 * 一致。社区发布前执行它，保证发布出去的包能被 NekroNXT 安装。
 */
export const verifyExtensionPackage = (data: Uint8Array): VerifiedExtensionPackage => {
  const parsed = parseExtensionImport(data)
  const revision = materializeImportedRevision({
    manifest: parsed.revisionManifest,
    sources: parsed.sources,
    resources: parsed.resources,
  })
  assertRevisionMatchesTransfer(parsed.manifest, revision)
  return { transfer: parsed.manifest, revision }
}

export const assertRevisionMatchesTransfer = (
  transfer: {
    readonly extension: { readonly id: string; readonly scope: string }
    readonly revision: { readonly id: string; readonly contentDigest: string; readonly payloadDigest: string }
  },
  revision: MaterializedExtensionRevision,
): void => {
  if (
    revision.manifest.extensionId !== transfer.extension.id ||
    revision.manifest.revisionId !== transfer.revision.id
  ) {
    throw new Error('导入扩展的 Manifest 身份与传输清单不一致。')
  }
  if (revision.scope !== transfer.extension.scope) throw new Error('导入扩展的 scope 与 Manifest 不一致。')
  if (
    revision.contentDigest !== transfer.revision.contentDigest ||
    revision.payloadDigest !== transfer.revision.payloadDigest
  ) {
    throw new Error('导入扩展的内容摘要不一致。')
  }
}
