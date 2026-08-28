import type { WebServer, WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { isAdminConsoleOutbound, type ChannelFact, type ChannelHistoryEntry } from '@nekro-nxt/channel-runtime'
import type { AgentRevisionContent, ImageUnderstandingPolicy } from '@nekro-nxt/core'
import {
  AgentIdSchema,
  AssetIdSchema,
  ChannelEventIdSchema,
  ChannelIdSchema,
  ConnectionIdSchema,
  DshPluginEntryIdSchema,
  DshPluginPackageIdSchema,
  ExtensionIdSchema,
  ExtensionRevisionIdSchema,
  EpisodeIdSchema,
  OutboundIntentIdSchema,
  DshCredentialsChangedSseDataSchema,
  DshNxtHostUiSchema,
  DshSettingsChangedSseDataSchema,
  HostApiErrorSchema,
  HostApiContracts,
  HostPageContributionSchema,
  HostUiPageInstanceIdSchema,
  JsonValueSchema,
  parseJsonValue,
  type AgentId,
  type ChannelId,
  type HostApiContract,
  type HostUiPermission,
  type HostSnapshotMessage,
  type ChannelRuntimeProjection,
  type HostSseEvent,
} from '@nekro-nxt/contracts'
import { hostUiPermissionDigest, scopeHostUiCss, validateHostUiSvg } from '@nekro-nxt/extension-runtime'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import type { NekroRuntime } from './bootstrap.js'
import { PRODUCT_VERSION } from './product-version.js'
import { DEEPSEEK_HARNESS_VERSION } from './dsh-version.js'
import { normalizeSessionEvents } from './channel-runtime-events.js'
import { performHostUiNetworkRequest } from './host-ui-network.js'
import {
  emptyChannelRuntimeProjection,
  projectChannelRuntime,
  worstChannelRuntimePhase,
} from './channel-runtime-projection.js'
import {
  HostSseHub,
  parseLastEventId,
  renderSse,
  SSE_FACT_COALESCE_MS,
  SSE_FACT_FRAME_BUDGET,
  SSE_RUNTIME_FRAME_BUDGET,
} from './sse-hub.js'

/**
 * The NekroNxt domain API, wired directly onto the DSH WebServer seam. It is
 * the REST/SSE surface the Web product consumes — no database handle and no
 * DSH Context ever crosses the wire: every endpoint goes through the assembled
 * CoreService/ChannelRuntime services (design docs/08). Request/response shapes
 * are locked here with zod; docs/08 reproduces the exact JSON as the Web-side
 * contract.
 */

export interface NekroHostApi {
  /** The actual listening port (OS-assigned when configured as 0). */
  readonly port: number
  dispose(): void
}

const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024
const HOST_UI_PRODUCT_MUTATIONS = new Set([
  'agents.create',
  'agents.revise',
  'agents.capabilities',
  'channels.create',
  'channels.rename',
  'channels.bind',
  'channels.unbind',
  'connections.create',
  'connections.rename',
])

const readJsonBody = (req: IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const declaredLength = Number(req.headers['content-length'])
    if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BODY_BYTES) {
      req.resume()
      reject(new Error(`JSON 请求体超过 ${MAX_JSON_BODY_BYTES} 字节限制。`))
      return
    }
    const chunks: Uint8Array[] = []
    let bytes = 0
    let exceeded = false
    req.on('data', (chunk: Uint8Array) => {
      if (exceeded) return
      bytes += chunk.byteLength
      if (bytes > MAX_JSON_BODY_BYTES) {
        exceeded = true
        chunks.length = 0
        reject(new Error(`JSON 请求体超过 ${MAX_JSON_BODY_BYTES} 字节限制。`))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (exceeded) return
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw.length === 0) {
        resolve(undefined)
        return
      }
      try {
        resolve(parseJsonValue(JSON.parse(raw)))
      } catch (error) {
        reject(new Error(`Malformed JSON body: ${error instanceof Error ? error.message : String(error)}`))
      }
    })
    req.on('error', reject)
  })

const readBinaryBody = (req: IncomingMessage, maxBytes: number): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = []
    let bytes = 0
    req.on('data', (chunk: Uint8Array) => {
      bytes += chunk.byteLength
      if (bytes > maxBytes) {
        reject(new Error(`请求体超过 ${maxBytes} 字节限制。`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })

const assembleChannelRuntime = (runtime: NekroRuntime, channelId: ChannelId): ChannelRuntimeProjection => {
  if (!runtime.repository.getChannel(channelId)) {
    throw new Error(`Unknown Channel: ${channelId}`)
  }
  const binding = runtime.core.listBindings(channelId)[0]
  if (!binding) return emptyChannelRuntimeProjection(channelId)
  const episode = runtime.repository.getActiveEpisode(channelId, binding.agentId)
  const pendingInjectCount = episode === undefined ? 0 : runtime.repository.listRecoverableAdmissions(episode.id).length
  const live = episode?.dshSessionId === undefined ? undefined : runtime.host.tryLiveSession(episode.dshSessionId)
  const metrics =
    episode?.dshSessionId === undefined ? undefined : runtime.host.sessionRuntimeMetrics(episode.dshSessionId)
  return projectChannelRuntime({
    channelId,
    agentId: binding.agentId,
    ...(episode === undefined ? {} : { episodeId: episode.id }),
    sessionStatus: live?.status ?? 'missing',
    pendingInjectCount,
    ...(metrics?.occupancy === undefined ? {} : { occupancy: metrics.occupancy }),
    ...(metrics?.performanceTotals === undefined ? {} : { performanceTotals: metrics.performanceTotals }),
    events: live === undefined ? [] : normalizeSessionEvents(live.events),
  })
}

const writeJson = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

const writeDownload = (res: ServerResponse, filename: string, body: Uint8Array): void => {
  res.writeHead(200, {
    'content-type': 'application/vnd.nekro-nxt.extension+zip',
    'content-length': String(body.byteLength),
    'content-disposition': `attachment; filename="${filename.replaceAll(/[^a-zA-Z0-9._-]/gu, '-')}"`,
    'cache-control': 'no-store',
  })
  res.end(body)
}

const extensionTransferManifestSchema = z
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

type ParsedExtensionImport = {
  readonly manifest: z.output<typeof extensionTransferManifestSchema>
  readonly revisionManifest: unknown
  readonly sources: { readonly host?: string; readonly client?: string }
  readonly resources: Readonly<Record<string, string>>
}

const assertSafeArchivePath = (name: string): void => {
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

const assertZipHasNoLinksOrDuplicates = (data: Uint8Array): void => {
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

const unzipTransferArchive = (data: Uint8Array): Record<string, Uint8Array> => {
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

const parseExtensionImport = (data: Uint8Array): ParsedExtensionImport => {
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
    if (createHash('sha256').update(content).digest('hex') !== descriptor.sha256) {
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

const dshPluginTransferManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('dsh-plugin-package'),
    package: z
      .object({
        name: z.string().min(1),
        version: z.string().min(1),
        packageDigest: z.string().regex(/^[a-f0-9]{64}$/u),
        lockfileDigest: z.string().regex(/^[a-f0-9]{64}$/u),
        integrity: z.string().optional(),
      })
      .strict(),
    entries: z.array(z.object({ entryKey: z.string(), moduleName: z.string() }).strict()),
    files: z
      .array(
        z
          .object({
            path: z.literal('package.tgz'),
            size: z.number().int().positive(),
            sha256: z.string().regex(/^[a-f0-9]{64}$/u),
          })
          .strict(),
      )
      .length(1),
  })
  .strict()

const parseDshPluginTransfer = (
  data: Uint8Array,
): {
  readonly tarball: Uint8Array
  readonly expected: {
    readonly packageName: string
    readonly packageVersion: string
    readonly packageDigest: string
    readonly lockfileDigest: string
    readonly integrity?: string
    readonly entries: readonly { readonly entryKey: string; readonly moduleName: string }[]
  }
} => {
  const files = unzipTransferArchive(data)
  const root = files['manifest.json']
  const tarball = files['package.tgz']
  if (!root || !tarball) throw new Error('DSH 插件导入包缺少 manifest.json 或 package.tgz。')
  if (Object.keys(files).some((name) => name !== 'manifest.json' && name !== 'package.tgz')) {
    throw new Error('DSH 插件导入包包含清单外文件。')
  }
  const manifest = dshPluginTransferManifestSchema.parse(JSON.parse(strFromU8(root)))
  const descriptor = manifest.files[0]!
  if (
    tarball.byteLength !== descriptor.size ||
    createHash('sha256').update(tarball).digest('hex') !== descriptor.sha256
  ) {
    throw new Error('DSH 插件导入包的 tgz 校验失败。')
  }
  return {
    tarball,
    expected: {
      packageName: manifest.package.name,
      packageVersion: manifest.package.version,
      packageDigest: manifest.package.packageDigest,
      lockfileDigest: manifest.package.lockfileDigest,
      ...(manifest.package.integrity === undefined ? {} : { integrity: manifest.package.integrity }),
      entries: manifest.entries,
    },
  }
}

const createExtensionRevisionExport = async (
  runtime: NekroRuntime,
  extensionId: z.output<typeof ExtensionIdSchema>,
  revisionId: z.output<typeof ExtensionRevisionIdSchema>,
): Promise<{ readonly filename: string; readonly body: Uint8Array }> => {
  const extension = runtime.repository.getExtension(extensionId)
  const revision = runtime.repository.getExtensionRevision(revisionId)
  if (!extension || !revision || revision.extensionId !== extension.id) {
    throw new Error('要导出的扩展版本不存在。')
  }
  const sourceDirectory = runtime.extensionService.revisionSourceDirectory(revision)
  const files: Record<string, Uint8Array> = {}
  for (const relative of ['manifest.json', 'source/host.ts', 'source/client.ts']) {
    try {
      files[`revision/${relative}`] = await readFile(path.join(sourceDirectory, relative))
    } catch (error) {
      if (relative === 'manifest.json') throw error
    }
  }
  const resourceManifest = z
    .object({
      clientCss: z
        .object({ path: z.string().startsWith('assets/'), sha256: z.string() })
        .strict()
        .optional(),
      contributions: z.array(z.unknown()).optional(),
    })
    .passthrough()
    .parse(JSON.parse(strFromU8(files['revision/manifest.json']!)))
  const resourcePaths = new Set<string>()
  if (resourceManifest.clientCss) resourcePaths.add(resourceManifest.clientCss.path)
  for (const contribution of resourceManifest.contributions ?? []) {
    const page = HostPageContributionSchema.safeParse(contribution)
    if (page.success && page.data.icon.kind === 'svg') resourcePaths.add(page.data.icon.path)
  }
  for (const resourcePath of resourcePaths) {
    files[`revision/${resourcePath}`] = await readFile(path.join(sourceDirectory, resourcePath))
  }
  const fileList = Object.entries(files).map(([filePath, content]) => ({
    path: filePath,
    size: content.byteLength,
    sha256: createHash('sha256').update(content).digest('hex'),
  }))
  files['manifest.json'] = strToU8(
    JSON.stringify(
      {
        schemaVersion: 1,
        kind: 'nekro-nxt-extension',
        extension: {
          id: extension.id,
          scope: extension.scope,
          slug: extension.slug,
          displayName: extension.displayName,
          description: extension.description,
          createdAt: extension.createdAt,
        },
        revision: {
          id: revision.id,
          revisionNumber: revision.revisionNumber,
          contentDigest: revision.contentDigest,
          payloadDigest: revision.payloadDigest,
          createdAt: revision.createdAt,
        },
        files: fileList,
        sourceVerification: runtime.repository.getExtensionRevisionVerification(revision.id) ?? null,
      },
      null,
      2,
    ) + '\n',
  )
  return {
    filename: `${extension.slug}-v${revision.revisionNumber}.nxt-extension`,
    body: zipSync(files, { level: 6 }),
  }
}

const createDshPluginExport = async (
  runtime: NekroRuntime,
  packageId: z.output<typeof DshPluginPackageIdSchema>,
): Promise<{ readonly filename: string; readonly body: Uint8Array }> => {
  const packageRecord = runtime.repository.getDshPluginPackage(packageId)
  if (!packageRecord) throw new Error('要导出的 DSH 插件不存在。')
  const tarball = await runtime.dshPluginInstaller.exportRootTarball(packageId)
  const manifest = {
    schemaVersion: 1,
    kind: 'dsh-plugin-package',
    package: {
      name: packageRecord.packageName,
      version: packageRecord.packageVersion,
      packageDigest: packageRecord.packageDigest,
      lockfileDigest: packageRecord.lockfileDigest,
      ...(packageRecord.integrity === undefined ? {} : { integrity: packageRecord.integrity }),
    },
    entries: runtime.repository
      .listDshPluginEntries(packageId)
      .map((entry) => ({ entryKey: entry.entryKey, moduleName: entry.moduleName })),
    files: [
      {
        path: 'package.tgz',
        size: tarball.byteLength,
        sha256: createHash('sha256').update(tarball).digest('hex'),
      },
    ],
  }
  const filename = `${packageRecord.packageName.replaceAll(/[^a-zA-Z0-9._-]/gu, '-')}-${packageRecord.packageVersion}.nxt-extension`
  return {
    filename,
    body: zipSync(
      { 'manifest.json': strToU8(JSON.stringify(manifest, null, 2) + '\n'), 'package.tgz': tarball },
      { level: 6 },
    ),
  }
}

const writeError = (res: ServerResponse, status: number, code: string, message: string): void =>
  writeJson(res, status, HostApiErrorSchema.parse({ error: { code, message } }))

const assertAuxiliaryImageModel = async (
  runtime: NekroRuntime,
  policy: ImageUnderstandingPolicy | undefined,
): Promise<void> => {
  if (policy?.textModel.mode !== 'auxiliary') return
  const auxiliary = policy.textModel
  const models = await runtime.host.listAvailableLlmModels()
  const selected = models.find(
    (model) => model.provider === auxiliary.model.provider && model.id === auxiliary.model.model,
  )
  if (!selected?.inputModalities?.includes('image')) {
    throw new Error('辅助图片理解模型必须明确声明支持图片输入。')
  }
}

const writeContractJson = <Contract extends HostApiContract>(
  res: ServerResponse,
  status: number,
  contract: Contract,
  body: unknown,
): void => writeJson(res, status, contract.parseResponse(body))

export const parseMessagePartsRequestBody = (
  input: unknown,
): ReturnType<typeof HostApiContracts.sendChannelMessage.parseRequest> =>
  HostApiContracts.sendChannelMessage.parseRequest(input)

const decorateMessageParts = (
  runtime: NekroRuntime,
  parts: ChannelHistoryEntry['parts'],
): HostSnapshotMessage['parts'] =>
  parts.map((part) => {
    if (part.type !== 'mention') return part
    const displayName = runtime.repository.getChannelMember(part.memberId)?.displayName
    return { ...part, ...(displayName === undefined ? {} : { displayName }) }
  })

export const projectHistoryEntry = (runtime: NekroRuntime, entry: ChannelHistoryEntry): HostSnapshotMessage => {
  const parts = decorateMessageParts(runtime, entry.parts)
  if (entry.source === 'channel-event') {
    const sender =
      entry.senderMemberId === undefined ? undefined : runtime.repository.getChannelMember(entry.senderMemberId)
    return {
      id: entry.sourceId,
      channelId: entry.channelId,
      role: 'member',
      parts,
      ...(entry.senderMemberId === undefined
        ? {}
        : {
            sender: {
              memberId: entry.senderMemberId,
              ...(sender?.displayName === undefined ? {} : { displayName: sender.displayName }),
            },
          }),
      ...(entry.facts?.['mentionedBot'] === true ? { mentionedConnectionAccount: true } : {}),
      ...(entry.activityType === undefined ? {} : { activityType: entry.activityType }),
      ...(entry.targetLogicalMessageId === undefined ? {} : { targetLogicalMessageId: entry.targetLogicalMessageId }),
      occurredAt: entry.occurredAt,
    }
  }
  return {
    id: entry.sourceId,
    channelId: entry.channelId,
    role: 'agent',
    parts,
    occurredAt: entry.occurredAt,
    deliveryState: entry.state,
    ...(isAdminConsoleOutbound(entry.sourceTurnId) ? { origin: 'admin-console' as const } : {}),
  }
}

export const projectChannelFact = (runtime: NekroRuntime, fact: ChannelFact): HostSnapshotMessage | undefined => {
  if (fact.kind === 'inbound') {
    const parsed = ChannelEventIdSchema.safeParse(fact.sourceId)
    if (!parsed.success) return undefined
    const event = runtime.repository.getChannelEvent(parsed.data)
    if (event === undefined) return undefined
    return projectHistoryEntry(runtime, {
      source: 'channel-event',
      sourceId: event.id,
      logicalMessageId: event.logicalMessageId,
      channelId: event.channelId,
      occurredAt: event.receivedAt,
      ...(event.senderMemberId === undefined ? {} : { senderMemberId: event.senderMemberId }),
      ...(event.activityType === undefined ? {} : { activityType: event.activityType }),
      ...(event.targetLogicalMessageId === undefined ? {} : { targetLogicalMessageId: event.targetLogicalMessageId }),
      parts: event.parts,
      ...(event.facts === undefined ? {} : { facts: event.facts }),
    })
  }
  const parsed = OutboundIntentIdSchema.safeParse(fact.sourceId)
  if (!parsed.success) return undefined
  try {
    const outbound = runtime.repository.getOutbound(parsed.data)
    return projectHistoryEntry(runtime, {
      source: 'outbound-intent',
      sourceId: outbound.intent.id,
      logicalMessageId: outbound.intent.logicalMessageId,
      channelId: fact.channelId,
      occurredAt: outbound.intent.createdAt,
      parts: outbound.intent.parts,
      state: outbound.intent.state,
      ...(outbound.intent.sourceTurnId === undefined ? {} : { sourceTurnId: outbound.intent.sourceTurnId }),
    })
  } catch {
    return undefined
  }
}

/** Build the authoritative projection snapshot from the assembled services only. */
export const buildSnapshotMessage = (
  runtime: NekroRuntime,
  channelId: ChannelId,
  options: {
    readonly limit?: number
    readonly before?: { readonly occurredAt: number; readonly sourceId: string }
  } = {},
): readonly HostSnapshotMessage[] => {
  const out = runtime.repository
    .listChannelHistory(channelId, options)
    .map((entry) => projectHistoryEntry(runtime, entry))
  // History is newest-first for pagination; expose oldest-first for the Web.
  return out.toReversed()
}

/** Project persisted local Extensions and their Agent Activations for the Shell. */
const projectExtensions = (runtime: NekroRuntime) => {
  const activations = runtime.repository.listActivations()
  return runtime.repository.listExtensions().map((extension) => {
    const installation = runtime.repository.getHostInstallation(extension.id)
    const hostClientDiagnostic = runtime.hostClientDiagnostic(extension.id)
    const latestRevision = runtime.repository.listExtensionRevisions(extension.id).at(-1)
    const hostUiPermission =
      latestRevision === undefined
        ? undefined
        : runtime.installation.getHostUiPermissionRequirement(extension.id, latestRevision.id)
    return {
      id: extension.id,
      scope: extension.scope,
      slug: extension.slug,
      displayName: extension.displayName,
      description: extension.description,
      ...(extension.createdByAgentId === undefined ? {} : { createdByAgentId: extension.createdByAgentId }),
      revisions: runtime.repository.listExtensionRevisions(extension.id).map((revision) => {
        const verification = runtime.repository.getExtensionRevisionVerification(revision.id)
        const permissionRequirement = runtime.installation.getHostUiPermissionRequirement(extension.id, revision.id)
        return {
          id: revision.id,
          revisionNumber: revision.revisionNumber,
          createdAt: revision.createdAt,
          scope: extension.scope,
          contributions:
            verification === undefined
              ? []
              : [
                  ...verification.toolInvocations.map(({ name }) => `工具：${name}`),
                  ...verification.rpcMethods.map((method) => `RPC：${method}`),
                  ...verification.renderedSlots.map((slot) => `界面：${slot}`),
                  ...(verification.adapter === undefined ? [] : [`适配器：${verification.adapter.key}`]),
                  ...(verification.renderedHostSlots ?? []).map(({ key }) => `界面：${key}`),
                  ...(verification.renderedPages ?? []).map(({ title }) => `页面：${title}`),
                ],
          ...(verification === undefined
            ? {}
            : {
                verification: {
                  verifiedAt: verification.verifiedAt,
                  dshVersion: verification.dshVersion,
                  contractVersion: verification.contractVersion,
                  hostBuilt: verification.hostBuild.built,
                  clientBuilt: verification.clientBuild.built,
                  buildKey: verification.hostBuild.buildKey,
                  toolInvocationCount: verification.toolInvocations.length,
                  rpcMethods: verification.rpcMethods,
                  renderedSlots: verification.renderedSlots,
                  ...(verification.renderedHostSlots === undefined
                    ? {}
                    : { renderedHostSlots: verification.renderedHostSlots }),
                  ...(verification.renderedPages === undefined ? {} : { renderedPages: verification.renderedPages }),
                  ...(verification.permissions === undefined ? {} : { permissions: verification.permissions }),
                  ...(permissionRequirement === undefined
                    ? {}
                    : {
                        permissionDigest: permissionRequirement.permissionDigest,
                        permissionApprovalRequired: permissionRequirement.approvalRequired,
                      }),
                  ...(verification.adapter === undefined ? {} : { adapter: verification.adapter }),
                },
              }),
        }
      }),
      activations: activations
        .filter((activation) => activation.extensionId === extension.id)
        .map((activation) => ({
          agentId: activation.agentId,
          extensionRevisionId: activation.extensionRevisionId,
          config: activation.config,
          activatedAt: activation.activatedAt,
          ...(runtime.activation.getDiagnostic(activation.agentId, extension.id) === undefined
            ? {}
            : { runtime: runtime.activation.getDiagnostic(activation.agentId, extension.id) }),
        })),
      ...(installation === undefined
        ? {}
        : {
            installation: {
              extensionRevisionId: installation.extensionRevisionId,
              installedAt: installation.installedAt,
              ...(runtime.installation.getDiagnostic(extension.id) === undefined
                ? {}
                : { runtime: runtime.installation.getDiagnostic(extension.id) }),
            },
          }),
      ...(hostUiPermission === undefined ? {} : { hostUiPermission }),
      ...(hostClientDiagnostic === undefined ? {} : { hostClientDiagnostic }),
      clientDiagnostics: activations
        .filter((activation) => activation.extensionId === extension.id)
        .flatMap((activation) => {
          const diagnostic = runtime.repository.getExtensionClientDiagnostic(activation.agentId, extension.id)
          if (!diagnostic) return []
          return [
            {
              agentId: diagnostic.agentId,
              revisionId: diagnostic.revisionId,
              status: diagnostic.status,
              ...(diagnostic.message === undefined ? {} : { message: diagnostic.message }),
              observedAt: diagnostic.observedAt,
            },
          ]
        }),
    }
  })
}

const projectDshPlugins = (runtime: NekroRuntime) => [
  ...runtime.host.listDshPlugins(),
  ...runtime.repository.listDshPluginPackages().map((packageRecord) => {
    const manifest =
      typeof packageRecord.manifest === 'object' &&
      packageRecord.manifest !== null &&
      !Array.isArray(packageRecord.manifest)
        ? packageRecord.manifest
        : {}
    const entries = runtime.repository.listDshPluginEntries(packageRecord.id).map((entry) => {
      const activations = runtime.repository.listDshPluginActivations(entry.id).map((activation) => {
        const diagnostic = runtime.repository.getDshPluginDiagnostic(entry.id, activation.targetKey)
        return {
          targetKey: activation.targetKey,
          target: activation.target,
          ...(activation.agentId === undefined ? {} : { agentId: activation.agentId }),
          activatedAt: activation.activatedAt,
          ...(diagnostic === undefined
            ? {}
            : {
                diagnostic: {
                  status: diagnostic.status,
                  phase: diagnostic.phase,
                  observedAt: diagnostic.observedAt,
                  ...(diagnostic.message === undefined ? {} : { message: diagnostic.message }),
                },
              }),
        }
      })
      return {
        id: entry.id,
        entryKey: entry.entryKey,
        moduleName: entry.moduleName,
        suggestedScope: entry.suggestedScope,
        ...(entry.selectedScope === undefined ? {} : { selectedScope: entry.selectedScope }),
        config: entry.config,
        activations,
      }
    })
    const failure = entries
      .flatMap((entry) => entry.activations)
      .map((activation) => activation.diagnostic)
      .find((diagnostic) => diagnostic !== undefined && diagnostic.status !== 'active')
    const hostUi = DshNxtHostUiSchema.safeParse(
      'nekroNxt' in manifest && typeof manifest['nekroNxt'] === 'object' && manifest['nekroNxt'] !== null
        ? Reflect.get(manifest['nekroNxt'], 'hostUi')
        : undefined,
    )
    return {
      packageName: packageRecord.packageName,
      packageVersion: packageRecord.packageVersion,
      origin: 'installed' as const,
      settingsNamespaces: [],
      packageId: packageRecord.id,
      installSource: packageRecord.source,
      installedAt: packageRecord.installedAt,
      clientUiDetected:
        'dsh' in manifest &&
        typeof manifest['dsh'] === 'object' &&
        manifest['dsh'] !== null &&
        'client' in manifest['dsh'],
      ...(hostUi.success ? { hostUi: hostUi.data } : {}),
      approvedBuilds: [...packageRecord.approvedBuilds],
      entries,
      ...(failure === undefined
        ? {}
        : { loadError: { code: failure.status, message: failure.message ?? 'DSH 插件加载失败。' } }),
    }
  }),
]

/** Running dynamic Packages owned by an intelligent-agent's active Session. */
const projectDynamicInventory = (runtime: NekroRuntime, agentId: AgentId) =>
  runtime.repository.listActiveEpisodesForAgent(agentId).flatMap((episode) => {
    if (!episode.dshSessionId) return []
    try {
      const policy = runtime.host.dynamicAuthoringPolicy(episode.dshSessionId)
      return runtime.host.dynamicInventory(episode.dshSessionId).map((row) => ({
        agentId,
        episodeId: episode.id,
        pluginId: row.pluginId,
        ...(row.currentPackageId === undefined ? {} : { packageId: row.currentPackageId }),
        ...(row.currentPackageId === undefined ? {} : { currentPackageId: row.currentPackageId }),
        ...(row.nextPackageId === undefined ? {} : { nextPackageId: row.nextPackageId }),
        ...(row.latestRun?.approvalRequestId === undefined
          ? {}
          : { approvalRequestId: row.latestRun.approvalRequestId }),
        status: row.activeRun ? 'running' : (row.latestRun?.status ?? 'stopped'),
        ...(row.activeRun === undefined
          ? {}
          : {
              activeRun: {
                pluginRunId: row.activeRun.pluginRunId,
                packageId: row.activeRun.packageId,
              },
            }),
        ...(row.latestRun === undefined
          ? {}
          : {
              latestRun: {
                pluginRunId: row.latestRun.pluginRunId,
                packageId: row.latestRun.packageId,
                status: row.latestRun.status,
              },
            }),
        packages: row.packages,
        policy: {
          turn: policy.turn,
          ...(policy.primaryPluginId === undefined ? {} : { primaryPluginId: policy.primaryPluginId }),
          consecutiveFailures: policy.consecutiveFailures,
          repeatedFingerprintCount: policy.repeatedFingerprintCount,
          ...(policy.lastErrorFingerprint === undefined ? {} : { lastErrorFingerprint: policy.lastErrorFingerprint }),
          ...(policy.blockedReason === undefined ? {} : { blockedReason: policy.blockedReason }),
        },
      }))
    } catch {
      return []
    }
  })

/** Resolve the dshSessionId of an intelligent-agent's active Episode, or throw. */
const resolveEpisodeSession = (
  runtime: NekroRuntime,
  agentId: AgentId,
  episodeId: z.output<typeof EpisodeIdSchema>,
): string => {
  const episode = runtime.repository.getEpisode(episodeId)
  if (episode?.agentId !== agentId || episode.status !== 'active' || episode.dshSessionId === undefined) {
    throw new Error('指定 Episode 不是该智能体的活动会话。')
  }
  return episode.dshSessionId
}

type DynamicRunResolution = Parameters<NekroRuntime['host']['settleDynamicUserRun']>[2]

const findDynamicPluginRunId = (runtime: NekroRuntime, dshSessionId: string, pluginRunId: string) => {
  for (const row of runtime.host.dynamicInventory(dshSessionId)) {
    if (row.activeRun?.pluginRunId === pluginRunId) return row.activeRun.pluginRunId
    if (row.latestRun?.pluginRunId === pluginRunId) return row.latestRun.pluginRunId
  }
  throw new Error('指定的动态运行不属于该智能体的活动会话。')
}

const normalizeDynamicResolution = (
  runtime: NekroRuntime,
  dshSessionId: string,
  input: ReturnType<typeof HostApiContracts.dynamicSettleUserRun.parseRequest>['resolution'],
): DynamicRunResolution => {
  if (input.ok) {
    return {
      ok: true,
      pluginRunId: findDynamicPluginRunId(runtime, dshSessionId, input.pluginRunId),
      ...(input.waitingFor === undefined ? {} : { waitingFor: input.waitingFor }),
    }
  }
  return {
    ok: false,
    reason: input.reason,
    ...(input.pluginRunId === undefined
      ? {}
      : { pluginRunId: findDynamicPluginRunId(runtime, dshSessionId, input.pluginRunId) }),
    ...(input.startedHere === undefined ? {} : { startedHere: input.startedHere }),
    ...(input.message === undefined ? {} : { message: input.message }),
    ...(input.stack === undefined ? {} : { stack: input.stack }),
  }
}

/**
 * Save the first currently-running dynamic Package owned by an intelligent-agent
 * as a persistent local Extension Revision. Persistence does NOT auto-activate
 * it for the Agent — Activation is a separate lifecycle action (M4).
 */
const saveActiveDynamicPackage = async (
  runtime: NekroRuntime,
  input: ReturnType<typeof HostApiContracts.saveExtensionFromDynamic.parseRequest>,
): Promise<{
  readonly extension: { readonly id: z.output<typeof ExtensionIdSchema> }
  readonly revision: { readonly id: z.output<typeof ExtensionRevisionIdSchema> }
}> => {
  const episode = runtime.repository.getEpisode(input.episodeId)
  if (episode?.agentId !== input.agentId || episode.status !== 'active' || episode.dshSessionId === undefined) {
    throw new Error('指定会话不是该智能体当前可保存动态 Package 的活动会话。')
  }
  const inventory = runtime.host.dynamicInventory(episode.dshSessionId)
  const row = inventory.find((candidate) => candidate.pluginId === input.pluginId)
  if (!row?.packages.some((candidate) => candidate.packageId === input.packageId)) {
    throw new Error('指定动态 Package 不属于该智能体的活动会话。')
  }
  if (
    row.currentPackageId !== input.packageId ||
    row.activeRun?.packageId !== input.packageId ||
    row.latestRun?.packageId !== input.packageId ||
    row.latestRun.status !== 'running'
  ) {
    throw new Error('只能保存当前已真实运行成功、且没有审批或版本切换中的精确 Package。')
  }
  const inspection = runtime.host.inspectDynamicPackage(episode.dshSessionId, input.pluginId, input.packageId)
  const verified = await runtime.host.verifyDynamicPackage(episode.dshSessionId, input.pluginId, input.packageId)
  const adapterVerification = 'scope' in verified && verified.scope === 'host-adapter' ? verified : undefined
  const scopedVerification =
    'scope' in verified && (verified.scope === 'host-adapter' || verified.scope === 'host-ui') ? verified : undefined
  const hasHostPages = verified.renderedPages.length > 0
  return runtime.extensionService.saveDynamicPackage({
    snapshot: {
      name: inspection.name,
      purpose: inspection.purpose,
      ...(inspection.code.host === undefined ? {} : { hostCode: inspection.code.host }),
      ...(inspection.code.client === undefined ? {} : { clientCode: inspection.code.client }),
      ...(hasHostPages ? { permissions: verified.permissions } : {}),
      contributions: verified.contributions,
    },
    slug: input.slug,
    displayName: input.displayName,
    description: input.description,
    ...(input.targetExtensionId === undefined ? {} : { extensionId: input.targetExtensionId }),
    createdByAgentId: input.agentId,
    verification: {
      dshVersion: '0.1.1-rc.2',
      contractVersion: hasHostPages
        ? 'nekro-nxt-extension-v3'
        : adapterVerification
          ? 'nekro-nxt-extension-v2'
          : 'nekro-nxt-extension-v1',
      ...(scopedVerification === undefined ? {} : { scope: scopedVerification.scope }),
      ...(adapterVerification === undefined ? {} : { adapter: adapterVerification.adapter }),
      origin: {
        episodeId: input.episodeId,
        pluginId: input.pluginId,
        packageId: input.packageId,
        pluginRunId: verified.pluginRunId,
      },
      toolInvocations: verified.toolInvocations,
      rpcMethods: verified.rpcMethods,
      renderedSlots: verified.renderedSlots,
      ...(verified.renderedHostSlots.length === 0 ? {} : { renderedHostSlots: verified.renderedHostSlots }),
      ...(hasHostPages ? { renderedPages: verified.renderedPages, permissions: verified.permissions } : {}),
    },
  })
}

export const createNekroHostApi = (
  webServer: WebServer,
  runtime: NekroRuntime,
  productMetadata: {
    readonly displayName: string
    readonly organizationName: string
    readonly version: string
    readonly releaseId: string
    readonly repositoryUrl: string
    readonly licenseSpdx: string | null
    readonly dshVersion: string
  } = {
    displayName: 'NekroNXT',
    organizationName: 'NekroAI',
    version: PRODUCT_VERSION,
    releaseId: `@nekro-nxt/server@${PRODUCT_VERSION}`,
    repositoryUrl: 'https://github.com/NekroAI/nekro-nxt',
    licenseSpdx: 'AGPL-3.0-only',
    dshVersion: DEEPSEEK_HARNESS_VERSION,
  },
): NekroHostApi => {
  const disposers: Array<() => void> = []
  const pendingExtensionImports = new Map<
    string,
    { readonly parsed: ParsedExtensionImport; readonly expiresAt: number }
  >()
  const pendingHostUiCredentials = new Map<
    string,
    {
      readonly ownerKey: string
      readonly adapterKey: string
      readonly credentials: Readonly<Record<string, string>>
      readonly expiresAt: number
    }
  >()
  const pruneExpiredHostUiCredentials = (now = Date.now()): void => {
    for (const [token, pending] of pendingHostUiCredentials) {
      if (pending.expiresAt <= now) pendingHostUiCredentials.delete(token)
    }
  }
  const pruneExpiredExtensionImports = (now = Date.now()): void => {
    for (const [token, pending] of pendingExtensionImports) {
      if (pending.expiresAt <= now) pendingExtensionImports.delete(token)
    }
  }

  const registerRoute = (route: WebRoute): void => {
    disposers.push(webServer.register(route))
  }

  // One global SSE hub: live clients plus a short in-memory replay window
  // keyed by Last-Event-ID. Domain facts stay in Channel / Session stores.
  const hub = new HostSseHub()
  const messageRevision = new Map<ChannelId, number>()
  const runtimeRevision = new Map<ChannelId, number>()
  const pendingFacts = new Map<ChannelId, ChannelFact[]>()
  let factTimer: ReturnType<typeof setTimeout> | undefined
  const nextRevision = (store: Map<ChannelId, number>, channelId: ChannelId): number => {
    const value = (store.get(channelId) ?? 0) + 1
    store.set(channelId, value)
    return value
  }
  const broadcast = (event: HostSseEvent): void => {
    hub.publish(event)
  }
  const broadcastExtensionsChanged = (): void => {
    broadcast({ event: 'extensions-changed', data: { changed: true } })
  }
  const dshPluginOperation = (
    operationId: string,
    kind: 'inspect' | 'install',
  ): {
    readonly progress: (
      phase: 'download' | 'dependencies' | 'build-scripts' | 'validation' | 'publish',
      message: string,
    ) => void
    readonly done: () => void
    readonly failed: (message: string) => void
  } => {
    let phase: 'download' | 'dependencies' | 'build-scripts' | 'validation' | 'publish' =
      kind === 'inspect' ? 'download' : 'publish'
    let message = kind === 'inspect' ? '正在检查 DSH 插件安装内容。' : '正在提交 DSH 插件安装。'
    const publish = (status: 'running' | 'done' | 'failed'): void =>
      broadcast({ event: 'dsh-plugin-operation', data: { operationId, kind, phase, status, message } })
    publish('running')
    return {
      progress: (nextPhase, nextMessage) => {
        phase = nextPhase
        message = nextMessage
        publish('running')
      },
      done: () => {
        message = kind === 'inspect' ? '安装内容检查完成。' : '插件已经安装并保持关闭。'
        publish('done')
      },
      failed: (failure) => {
        message = failure
        publish('failed')
      },
    }
  }
  disposers.push(
    runtime.host.subscribeDynamicApprovalRequests((event) => {
      broadcast({ event: 'dynamic-changed', data: { agentId: event.agentId } })
    }),
  )
  const flushPendingFacts = (): void => {
    factTimer = undefined
    const batches = [...pendingFacts.entries()]
    pendingFacts.clear()
    for (const [channelId, facts] of batches) {
      const itemsBySource = new Map<
        string,
        { kind: ChannelFact['kind']; sourceId: ChannelFact['sourceId']; message: HostSnapshotMessage }
      >()
      for (const fact of facts) {
        const message = projectChannelFact(runtime, fact)
        if (message === undefined) continue
        itemsBySource.set(fact.sourceId, { kind: fact.kind, sourceId: fact.sourceId, message })
      }
      const items = [...itemsBySource.values()]
      if (items.length === 0) continue
      const chunks: (typeof items)[] = []
      let chunk: typeof items = []
      for (const item of items) {
        const candidate = [...chunk, item]
        const candidateBytes = Buffer.byteLength(
          JSON.stringify({ channelId, revision: Number.MAX_SAFE_INTEGER, items: candidate }),
          'utf8',
        )
        if (chunk.length > 0 && candidateBytes > SSE_FACT_FRAME_BUDGET) {
          chunks.push(chunk)
          chunk = [item]
        } else {
          chunk = candidate
        }
      }
      if (chunk.length > 0) chunks.push(chunk)
      for (const batch of chunks) {
        broadcast({
          event: 'channel-fact',
          data: { channelId, revision: nextRevision(messageRevision, channelId), items: batch },
        })
      }
    }
  }
  disposers.push(
    runtime.channels.subscribeFacts((fact) => {
      const queued = pendingFacts.get(fact.channelId) ?? []
      queued.push(fact)
      pendingFacts.set(fact.channelId, queued)
      factTimer ??= setTimeout(flushPendingFacts, SSE_FACT_COALESCE_MS)
    }),
  )

  const buildSnapshot = async (): Promise<unknown> => {
    // Enumerate channels durably from the Core repository so the snapshot
    // survives restart, then discover bound Agents via their Bindings.
    const channels = runtime.core
      .listConnections()
      .flatMap((connection) => runtime.core.listChannelsByConnection(connection.id))
    const bindingsByChannel = new Map(channels.map((channel) => [channel.id, runtime.core.listBindings(channel.id)]))
    const agentCommits = runtime.core.listAgents()
    const agentIds = new Set(agentCommits.map((commit) => commit.definition.id))
    const runtimeByChannel = new Map(
      channels.map((channel) => [channel.id, assembleChannelRuntime(runtime, channel.id)] as const),
    )
    const agents = await Promise.all(
      agentCommits.map(async (commit) => {
        const agentId = commit.definition.id
        const ownedChannels = channels
          .filter((channel) => bindingsByChannel.get(channel.id)?.some((binding) => binding.agentId === agentId))
          .map((channel) => channel.id)
        const runtimePhase = worstChannelRuntimePhase(
          ownedChannels.map((channelId) => runtimeByChannel.get(channelId)?.phase ?? 'idle'),
        )
        return {
          id: agentId,
          displayName: commit.revision.displayName,
          persona: commit.revision.persona,
          personaDocument: commit.revision.personaDocument,
          model: commit.revision.model,
          capabilities: commit.revision.capabilities,
          imagePolicy: commit.revision.imagePolicy,
          dynamicClientApprovalPolicy: commit.revision.dynamicClientApprovalPolicy,
          imageDiagnostics: await runtime.host.getAgentImageDiagnostics(commit.revision),
          currentRevisionId: commit.revision.id,
          runtimeStatus: runtimePhase === 'thinking' || runtimePhase === 'using-tool' ? 'running' : 'idle',
          runtimePhase,
          createdAt: commit.revision.createdAt,
          channels: ownedChannels,
        }
      }),
    )
    const channelProjection = channels.map((channel) => {
      const bindings = bindingsByChannel.get(channel.id) ?? []
      const boundAgentId = bindings[0]?.agentId
      return {
        id: channel.id,
        connectionId: channel.connectionId,
        platformChannelId: channel.platformChannelId,
        kind: channel.kind,
        ...(channel.displayName === undefined ? {} : { displayName: channel.displayName }),
        ...(boundAgentId === undefined ? {} : { boundAgentId }),
        runtimePhase: runtimeByChannel.get(channel.id)?.phase ?? 'idle',
        bindings: bindings.map((binding) => ({
          channelId: binding.channelId,
          agentId: binding.agentId,
          triggerPolicy: binding.triggerPolicy,
          processingFeedback: binding.processingFeedback,
          eventTriggers: binding.eventTriggers,
          boundAt: binding.boundAt,
        })),
      }
    })
    // Message history is loaded per Channel through its cursor endpoint. Keeping
    // it out of the global snapshot prevents every navigation from rereading
    // every Channel's history.
    const messages: HostSnapshotMessage[] = []
    const connections = runtime.core.listConnections().map((connection) => {
      const diagnostic = runtime.connectionDiagnostic(connection.id)
      const adapterDiagnostic = runtime.adapterConnectionDiagnostic(connection.id)
      const lastInbound = runtime.lastInbound(connection.id)
      const tests = runtime.connectionTests(connection.id)
      const gateway =
        diagnostic?.gateway ??
        (adapterDiagnostic === undefined
          ? undefined
          : {
              state: adapterDiagnostic.status,
              ...(adapterDiagnostic.message === undefined ? {} : { lastError: adapterDiagnostic.message }),
            })
      return {
        id: connection.id,
        adapterKey: connection.adapterKey,
        ...(connection.alias === undefined ? {} : { alias: connection.alias }),
        status: {
          state: gateway?.state ?? 'stopped',
          credentialConfigured: adapterDiagnostic?.credentialConfigured ?? diagnostic?.credentialConfigured ?? false,
          proactiveSend: adapterDiagnostic?.proactiveSend ?? false,
          ...(adapterDiagnostic?.message === undefined ? {} : { message: adapterDiagnostic.message }),
          ...(adapterDiagnostic?.accountId === undefined ? {} : { accountId: adapterDiagnostic.accountId }),
          ...(adapterDiagnostic?.implementation === undefined
            ? {}
            : { implementation: adapterDiagnostic.implementation }),
          ...(adapterDiagnostic?.optionalCapabilities === undefined
            ? {}
            : { optionalCapabilities: adapterDiagnostic.optionalCapabilities }),
        },
        channelCount: runtime.core.listChannelsByConnection(connection.id).length,
        knownChannels: runtime.core.listChannelsByConnection(connection.id).map((channel) => ({
          id: channel.id,
          name: channel.displayName ?? channel.platformChannelId,
          kind: channel.kind,
        })),
        ...(lastInbound?.platformMessageId === undefined
          ? {}
          : { lastInbound: { ...lastInbound, platformMessageId: lastInbound.platformMessageId } }),
        ...(tests?.receive === undefined ? {} : { receiveTest: tests.receive }),
        ...(tests?.send === undefined ? {} : { sendTest: tests.send }),
      }
    })
    const webSearch = await runtime.host.getWebSearchCapabilityStatus()
    return HostApiContracts.snapshot.parseResponse({
      productMetadata,
      models: await runtime.host.listAvailableLlmModels(),
      capabilityAvailability: {
        subagents: { available: true },
        webSearch,
      },
      connectionAdapters: runtime.listConnectionAdapters(),
      notificationSettings: await runtime.notifications.getSettings(),
      agents,
      channels: channelProjection,
      messages,
      connections,
      extensions: projectExtensions(runtime),
      hostUi: {
        preferencesRevision: runtime.repository.getHostUiPreferencesRevision(),
        pages: runtime.repository.listHostUiPageEntries(),
      },
      workTreeOrder: runtime.repository.getWorkTreeOrder(),
      dynamic: [...agentIds].flatMap((agentId) => projectDynamicInventory(runtime, agentId)),
    })
  }

  // GET /api/snapshot
  registerRoute({
    kind: 'exact',
    path: '/api/snapshot',
    handler: async (_req, res) => {
      try {
        writeJson(res, 200, await buildSnapshot())
      } catch (error) {
        writeError(res, 500, 'snapshot-failed', error instanceof Error ? error.message : String(error))
      }
    },
  })

  registerRoute({
    kind: 'exact',
    path: '/api/client-notifications',
    handler: (req, res) => {
      if (req.method !== 'GET') {
        writeError(res, 405, 'method-not-allowed', '客户端通知只支持 GET。')
        return
      }
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const rawCursor = url.searchParams.get('cursor')
        const params = HostApiContracts.listClientNotifications.parseParams({
          ...(rawCursor === null ? {} : { cursor: Number(rawCursor) }),
        })
        writeContractJson(
          res,
          200,
          HostApiContracts.listClientNotifications,
          runtime.notifications.readClientNotifications(params.cursor),
        )
      } catch (error) {
        writeError(res, 400, 'client-notifications-failed', error instanceof Error ? error.message : String(error))
      }
    },
  })

  registerRoute({
    kind: 'exact',
    path: '/api/settings/notifications',
    handler: async (req, res) => {
      if (req.method !== 'PUT') {
        writeError(res, 405, 'method-not-allowed', '通知设置只支持 PUT。')
        return
      }
      try {
        const parsed = HostApiContracts.updateNotificationSettings.parseRequest(await readJsonBody(req))
        const settings = await runtime.notifications.updateSettings({
          ...(parsed.expectedRevision === undefined ? {} : { expectedRevision: parsed.expectedRevision }),
          system: parsed.system,
          bark: {
            enabled: parsed.bark.enabled,
            serverUrl: parsed.bark.serverUrl,
            ...(parsed.bark.deviceKey === undefined ? {} : { deviceKey: parsed.bark.deviceKey }),
            ...(parsed.bark.clearDeviceKey === undefined ? {} : { clearDeviceKey: parsed.bark.clearDeviceKey }),
          },
          events: parsed.events,
        })
        writeContractJson(res, 200, HostApiContracts.updateNotificationSettings, settings)
      } catch (error) {
        writeError(res, 400, 'notification-settings-failed', error instanceof Error ? error.message : String(error))
      }
    },
  })

  registerRoute({
    kind: 'exact',
    path: '/api/settings/notifications/test',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        writeError(res, 405, 'method-not-allowed', 'Bark 通知测试只支持 POST。')
        return
      }
      try {
        const parsed = HostApiContracts.testBarkNotification.parseRequest(await readJsonBody(req))
        await runtime.notifications.testBark({
          serverUrl: parsed.serverUrl,
          ...(parsed.deviceKey === undefined ? {} : { deviceKey: parsed.deviceKey }),
        })
        writeContractJson(res, 200, HostApiContracts.testBarkNotification, { sent: true })
      } catch (error) {
        writeError(res, 400, 'notification-test-failed', error instanceof Error ? error.message : String(error))
      }
    },
  })

  registerRoute({
    kind: 'exact',
    path: '/api/settings/notifications/test-system',
    handler: (req, res) => {
      if (req.method !== 'POST') {
        writeError(res, 405, 'method-not-allowed', '系统通知测试只支持 POST。')
        return
      }
      try {
        HostApiContracts.testSystemNotification.parseRequest(undefined)
        runtime.notifications.publishSystemTest()
        writeContractJson(res, 200, HostApiContracts.testSystemNotification, { published: true })
      } catch (error) {
        writeError(res, 400, 'system-notification-test-failed', error instanceof Error ? error.message : String(error))
      }
    },
  })

  // GET /api/platform-users — the paged directory intentionally stays out of
  // the global snapshot because installations can accumulate many identities.
  registerRoute({
    kind: 'exact',
    path: '/api/platform-users',
    handler: (req, res) => {
      if (req.method !== 'GET') {
        writeError(res, 405, 'method-not-allowed', '平台用户目录只支持 GET。')
        return
      }
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const rawLimit = url.searchParams.get('limit')
        const params = HostApiContracts.listPlatformUsers.parseParams({
          ...(url.searchParams.has('query') ? { query: url.searchParams.get('query') } : {}),
          ...(url.searchParams.has('adapterKey') ? { adapterKey: url.searchParams.get('adapterKey') } : {}),
          ...(url.searchParams.has('connectionId') ? { connectionId: url.searchParams.get('connectionId') } : {}),
          ...(url.searchParams.has('cursor') ? { cursor: url.searchParams.get('cursor') } : {}),
          ...(rawLimit === null ? {} : { limit: Number(rawLimit) }),
        })
        const adapters = new Map(runtime.listConnectionAdapters().map((adapter) => [adapter.key, adapter.displayName]))
        const adapterDisplayName = (adapterKey: string): string => adapters.get(adapterKey) ?? '已移除的适配器'
        const directoryLabel = (value: string | undefined): string | undefined => {
          const normalized = value?.trim()
          return normalized ? normalized.slice(0, 120) : undefined
        }
        const records = [...runtime.core.listPlatformUsers()].sort((left, right) =>
          left.identityId.localeCompare(right.identityId),
        )
        const adapterCounts = new Map<string, number>()
        const connectionCounts = new Map<
          string,
          {
            id: (typeof records)[number]['connection']['id']
            adapterKey: string
            displayName: string
            userCount: number
          }
        >()
        for (const record of records) {
          adapterCounts.set(record.connection.adapterKey, (adapterCounts.get(record.connection.adapterKey) ?? 0) + 1)
          const connectionDisplayName = record.connection.alias ?? adapterDisplayName(record.connection.adapterKey)
          const facet = connectionCounts.get(record.connection.id)
          connectionCounts.set(record.connection.id, {
            id: record.connection.id,
            adapterKey: record.connection.adapterKey,
            displayName: connectionDisplayName,
            userCount: (facet?.userCount ?? 0) + 1,
          })
        }
        const normalizedQuery = params.query?.toLocaleLowerCase()
        const matching = records.filter((record) => {
          if (params.adapterKey !== undefined && record.connection.adapterKey !== params.adapterKey) return false
          if (params.connectionId !== undefined && record.connection.id !== params.connectionId) return false
          if (normalizedQuery && !(record.displayName ?? '').toLocaleLowerCase().includes(normalizedQuery)) return false
          return true
        })
        const filtered = matching.filter(
          (record) => params.cursor === undefined || record.identityId.localeCompare(params.cursor) > 0,
        )
        const page = filtered.slice(0, params.limit)
        const items = page.map((record) => ({
          identityId: record.identityId,
          ...(directoryLabel(record.displayName) === undefined
            ? {}
            : { displayName: directoryLabel(record.displayName) }),
          adapter: {
            key: record.connection.adapterKey,
            displayName: adapterDisplayName(record.connection.adapterKey),
          },
          connection: {
            id: record.connection.id,
            displayName: record.connection.alias ?? adapterDisplayName(record.connection.adapterKey),
          },
          activeChannelCount: record.activeChannels.length,
          channelPreview: record.activeChannels.slice(0, 3).map((channel) => ({
            id: channel.id,
            ...(directoryLabel(channel.displayName) === undefined
              ? {}
              : { displayName: directoryLabel(channel.displayName) }),
            kind: channel.kind,
          })),
          historicalOnly: record.historicalOnly,
        }))
        writeContractJson(res, 200, HostApiContracts.listPlatformUsers, {
          total: matching.length,
          items,
          facets: {
            adapters: [...adapterCounts.entries()]
              .map(([key, userCount]) => ({ key, displayName: adapterDisplayName(key), userCount }))
              .sort((left, right) => left.displayName.localeCompare(right.displayName, 'zh-CN')),
            connections: [...connectionCounts.values()].sort((left, right) =>
              left.displayName.localeCompare(right.displayName, 'zh-CN'),
            ),
          },
          ...(filtered.length > params.limit && page.at(-1) !== undefined
            ? { nextCursor: page.at(-1)?.identityId }
            : {}),
        })
      } catch (error) {
        writeError(res, 400, 'invalid-platform-user-query', error instanceof Error ? error.message : String(error))
      }
    },
  })

  registerRoute({
    kind: 'prefix',
    path: '/api/host-ui',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname === '/api/host-ui/page-preferences') {
        if (req.method !== 'PUT') {
          writeError(res, 405, 'method-not-allowed', '页面入口偏好只支持 PUT。')
          return
        }
        try {
          const input = HostApiContracts.updateHostUiPagePreferences.parseRequest(await readJsonBody(req))
          const revision = runtime.repository.updateHostUiPagePreferences({ ...input, now: Date.now() })
          writeContractJson(res, 200, HostApiContracts.updateHostUiPagePreferences, { revision })
          broadcastExtensionsChanged()
        } catch (error) {
          writeError(res, 409, 'host-ui-preference-conflict', error instanceof Error ? error.message : String(error))
        }
        return
      }
      const pageMatch = /^\/api\/host-ui\/pages\/([^/]+)\/(call|diagnostic)$/u.exec(url.pathname)
      if (!pageMatch) {
        writeError(res, 404, 'not-found', `未定义路由：${req.method} ${url.pathname}。`)
        return
      }
      const page = runtime.repository
        .listHostUiPageEntries()
        .find(({ pageInstanceId }) => pageInstanceId === decodeURIComponent(pageMatch[1] ?? ''))
      if (!page) {
        writeError(res, 404, 'host-ui-page-missing', '页面入口不存在或已撤销。')
        return
      }
      if (req.method !== 'POST') {
        writeError(res, 405, 'method-not-allowed', '页面 Runtime 端点只支持 POST。')
        return
      }
      if (pageMatch[2] === 'call') {
        try {
          HostApiContracts.callHostUiPage.parseParams({ pageInstanceId: page.pageInstanceId })
          const input = HostApiContracts.callHostUiPage.parseRequest(await readJsonBody(req))
          const ownerKey =
            page.owner.kind === 'extension' ? `extension:${page.owner.extensionId}` : `dsh:${page.owner.entryId}`
          const grant = runtime.repository.getHostUiPermissionGrant(ownerKey)
          const artifactDigest =
            page.owner.kind === 'extension'
              ? runtime.repository.getExtensionRevision(page.owner.revisionId)?.payloadDigest
              : page.owner.artifactDigest
          if (!grant || grant.artifactDigest !== artifactDigest) throw new Error('页面权限批准已失效。')
          const permissionByMethod: ReadonlyMap<string, HostUiPermission> = new Map([
            ['agents.list', 'agents.read'],
            ['agents.create', 'agents.manage'],
            ['agents.revise', 'agents.manage'],
            ['agents.capabilities', 'agents.manage'],
            ['channels.list', 'channels.read'],
            ['channels.create', 'channels.manage'],
            ['channels.rename', 'channels.manage'],
            ['channels.bind', 'channels.manage'],
            ['channels.unbind', 'channels.manage'],
            ['connections.list', 'connections.read'],
            ['connections.create', 'connections.manage'],
            ['connections.rename', 'connections.manage'],
            ['connections.test', 'connections.manage'],
            ['credentials.write', 'credentials.write'],
            ['extensions.list', 'extensions.read'],
            ['dsh-plugins.list', 'dsh-plugins.read'],
            ['runtime.list', 'runtime.read'],
            ['messages.list', 'messages.read'],
            ['messages.send', 'messages.send'],
            ['assets.get', 'assets.read'],
            ['notifications.publish', 'notifications.publish'],
            ['network.request', 'network.request'],
          ])
          const topicPermission: ReadonlyMap<string, HostUiPermission> = new Map([
            ['agents', 'agents.read'],
            ['channels', 'channels.read'],
            ['connections', 'connections.read'],
            ['extensions', 'extensions.read'],
            ['dsh-plugins', 'dsh-plugins.read'],
            ['runtime', 'runtime.read'],
            ['messages', 'messages.read'],
          ])
          const eventRequest =
            input.method === 'events.subscribe'
              ? z
                  .object({
                    topic: z.enum([
                      'agents',
                      'channels',
                      'connections',
                      'extensions',
                      'dsh-plugins',
                      'runtime',
                      'messages',
                    ]),
                  })
                  .strict()
                  .parse(input.input)
              : undefined
          const requiredPermission =
            eventRequest === undefined ? permissionByMethod.get(input.method) : topicPermission.get(eventRequest.topic)
          let value
          if (requiredPermission) {
            if (!grant?.declaration.permissions.includes(requiredPermission)) {
              throw new Error(`页面未获得 ${requiredPermission} 权限。`)
            }
            if (input.method === 'agents.list') {
              value = runtime.core.listAgents().map((agent) => ({
                id: agent.definition.id,
                displayName: agent.revision.displayName,
                currentRevisionId: agent.revision.id,
              }))
            } else if (input.method === 'agents.create') {
              const parsed = HostApiContracts.createAgent.parseRequest(input.input)
              const capabilities =
                parsed.capabilities ??
                ({
                  subagents: true,
                  fileTools: false,
                  webSearch: (await runtime.host.getWebSearchCapabilityStatus()).available,
                  dynamicCreation: false,
                  developmentShell: false,
                  unrestrictedFileAccess: false,
                } as const)
              await assertAuxiliaryImageModel(runtime, parsed.imagePolicy)
              const entity = await runtime.createAgentWithWebChannel({
                displayName: parsed.displayName,
                persona: parsed.persona,
                ...(parsed.personaDocument === undefined ? {} : { personaDocument: parsed.personaDocument }),
                model: parsed.model,
                capabilities,
                ...(parsed.imagePolicy === undefined ? {} : { imagePolicy: parsed.imagePolicy }),
                ...(parsed.dynamicClientApprovalPolicy === undefined
                  ? {}
                  : { dynamicClientApprovalPolicy: parsed.dynamicClientApprovalPolicy }),
              })
              value = { agentId: entity.agentId, channelId: entity.channelId, connectionId: entity.connectionId }
            } else if (input.method === 'agents.revise') {
              const request = z.object({ agentId: AgentIdSchema, revision: z.unknown() }).strict().parse(input.input)
              const parsed = HostApiContracts.reviseAgent.parseRequest(request.revision)
              const current = runtime.repository.getAgent(request.agentId)
              if (!current || current.revision.id !== parsed.expectedCurrentRevisionId) {
                throw new Error('智能体配置已更新。')
              }
              await assertAuxiliaryImageModel(runtime, parsed.imagePolicy)
              const updated = runtime.core.reviseAgent(request.agentId, current.revision.id, {
                displayName: parsed.displayName,
                persona: parsed.persona,
                ...(parsed.personaDocument === undefined ? {} : { personaDocument: parsed.personaDocument }),
                model: parsed.model,
                capabilities: current.revision.capabilities,
                imagePolicy: parsed.imagePolicy ?? current.revision.imagePolicy,
                dynamicClientApprovalPolicy:
                  parsed.dynamicClientApprovalPolicy ?? current.revision.dynamicClientApprovalPolicy,
              })
              value = { currentRevisionId: updated.revision.id }
            } else if (input.method === 'agents.capabilities') {
              const request = z
                .object({ agentId: AgentIdSchema, capabilities: z.unknown() })
                .strict()
                .parse(input.input)
              const parsed = HostApiContracts.updateAgentCapabilities.parseRequest(request.capabilities)
              const current = runtime.repository.getAgent(request.agentId)
              if (!current) throw new Error('智能体不存在。')
              const capabilities = {
                ...current.revision.capabilities,
                ...(parsed.subagents === undefined ? {} : { subagents: parsed.subagents }),
                ...(parsed.fileTools === undefined ? {} : { fileTools: parsed.fileTools }),
                ...(parsed.webSearch === undefined ? {} : { webSearch: parsed.webSearch }),
                ...(parsed.dynamicCreation === undefined ? {} : { dynamicCreation: parsed.dynamicCreation }),
                ...(parsed.developmentShell === undefined ? {} : { developmentShell: parsed.developmentShell }),
                ...(parsed.unrestrictedFileAccess === undefined
                  ? {}
                  : { unrestrictedFileAccess: parsed.unrestrictedFileAccess }),
              }
              const updated = runtime.core.reviseAgent(request.agentId, current.revision.id, {
                displayName: current.revision.displayName,
                persona: current.revision.persona,
                personaDocument: current.revision.personaDocument,
                model: current.revision.model,
                capabilities,
                imagePolicy: current.revision.imagePolicy,
                dynamicClientApprovalPolicy: current.revision.dynamicClientApprovalPolicy,
              })
              value = { currentRevisionId: updated.revision.id, capabilities: updated.revision.capabilities }
            } else if (input.method === 'connections.list') {
              value = runtime.core.listConnections().map((connection) => ({
                id: connection.id,
                adapterKey: connection.adapterKey,
                ...(connection.alias === undefined ? {} : { alias: connection.alias }),
              }))
            } else if (input.method === 'credentials.write') {
              pruneExpiredHostUiCredentials()
              const request = z
                .object({
                  adapterKey: z.string().trim().min(1).max(120),
                  values: z.record(
                    z.string(),
                    z
                      .string()
                      .min(1)
                      .max(16 * 1024),
                  ),
                })
                .strict()
                .parse(input.input)
              const descriptor = runtime.adapters.get(request.adapterKey)?.descriptor
              if (!descriptor?.userCreatable) throw new Error('这个 Adapter 不能创建用户连接。')
              for (const key of Object.keys(request.values)) {
                if (descriptor.configSchema.properties[key]?.type !== 'credential-reference') {
                  throw new Error(`连接凭据包含未知字段：${key}`)
                }
              }
              const token = randomUUID()
              pendingHostUiCredentials.set(token, {
                ownerKey,
                adapterKey: request.adapterKey,
                credentials: request.values,
                expiresAt: Date.now() + 5 * 60_000,
              })
              value = { token, fields: Object.keys(request.values) }
            } else if (input.method === 'connections.create') {
              pruneExpiredHostUiCredentials()
              const request = z
                .object({
                  adapterKey: z.string().trim().min(1).max(120),
                  alias: z.string().trim().max(80).optional(),
                  configuration: z.record(z.string(), JsonValueSchema).default({}),
                  credentialToken: z.string().uuid().optional(),
                })
                .strict()
                .parse(input.input)
              const pending = request.credentialToken
                ? pendingHostUiCredentials.get(request.credentialToken)
                : undefined
              if (request.credentialToken && !pending) throw new Error('连接凭据提交不存在或已经使用。')
              if (
                pending &&
                (pending.ownerKey !== ownerKey ||
                  pending.adapterKey !== request.adapterKey ||
                  pending.expiresAt < Date.now())
              ) {
                pendingHostUiCredentials.delete(request.credentialToken!)
                throw new Error('连接凭据提交已失效。')
              }
              const connection = await runtime.createConnection({
                adapterKey: request.adapterKey,
                ...(request.alias === undefined ? {} : { alias: request.alias }),
                configuration: request.configuration,
                credentials: pending?.credentials ?? {},
              })
              if (request.credentialToken) pendingHostUiCredentials.delete(request.credentialToken)
              value = { connectionId: connection.id, adapterKey: connection.adapterKey }
            } else if (input.method === 'connections.rename') {
              const request = z
                .object({ connectionId: ConnectionIdSchema, alias: z.string().trim().max(80).optional() })
                .strict()
                .parse(input.input)
              const connection = runtime.updateConnectionAlias(request.connectionId, request.alias)
              value = {
                connectionId: connection.id,
                ...(connection.alias === undefined ? {} : { alias: connection.alias }),
              }
            } else if (input.method === 'connections.test') {
              const request = z
                .object({
                  connectionId: ConnectionIdSchema,
                  direction: z.enum(['send', 'receive']),
                  channelId: ChannelIdSchema.optional(),
                })
                .strict()
                .parse(input.input)
              value = await runtime.testConnection(request.connectionId, request.direction, request.channelId)
            } else if (input.method === 'channels.list') {
              value = runtime.core.listConnections().flatMap((connection) =>
                runtime.core.listChannelsByConnection(connection.id).map((channel) => ({
                  id: channel.id,
                  connectionId: connection.id,
                  kind: channel.kind,
                  ...(channel.displayName === undefined ? {} : { displayName: channel.displayName }),
                })),
              )
            } else if (input.method === 'channels.create') {
              const parsed = HostApiContracts.createWebChannel.parseRequest(input.input)
              const channel = runtime.core.createChannel({
                connectionId: runtime.webConnectionId,
                platformChannelId: `host-ui-${randomUUID()}`,
                kind: 'web',
                displayName: parsed.displayName,
              })
              value = { channelId: channel.id, connectionId: channel.connectionId }
            } else if (input.method === 'channels.rename') {
              const request = z
                .object({ channelId: ChannelIdSchema, displayName: z.string() })
                .strict()
                .parse(input.input)
              const parsed = HostApiContracts.renameChannel.parseRequest({ displayName: request.displayName })
              const channel = runtime.core.updateChannelDisplayName(request.channelId, parsed.displayName)
              value = { channelId: channel.id, displayName: channel.displayName }
            } else if (input.method === 'channels.bind') {
              const parsed = HostApiContracts.createBinding.parseRequest(input.input)
              value = await runtime.channels.replaceBinding({
                channelId: parsed.channelId,
                agentId: parsed.agentId,
                triggerPolicy: parsed.triggerPolicy,
                ...(parsed.processingFeedback === undefined ? {} : { processingFeedback: parsed.processingFeedback }),
                ...(parsed.eventTriggers === undefined ? {} : { eventTriggers: parsed.eventTriggers }),
              })
            } else if (input.method === 'channels.unbind') {
              const request = z.object({ channelId: ChannelIdSchema }).strict().parse(input.input)
              await runtime.channels.clearBinding(request.channelId)
              value = { channelId: request.channelId, cleared: true }
            } else if (input.method === 'extensions.list') {
              value = runtime.repository.listExtensions().map((extension) => ({
                id: extension.id,
                scope: extension.scope,
                displayName: extension.displayName,
                description: extension.description,
              }))
            } else if (input.method === 'dsh-plugins.list') {
              value = projectDshPlugins(runtime)
            } else if (input.method === 'runtime.list') {
              value = runtime.repository.listRecoverableEpisodes().map((episode) => ({
                id: episode.id,
                agentId: episode.agentId,
                channelId: episode.channelId,
                status: episode.status,
              }))
            } else if (input.method === 'messages.list') {
              const request = z
                .object({ channelId: ChannelIdSchema, limit: z.number().int().min(1).max(100).default(50) })
                .strict()
                .parse(input.input)
              value = buildSnapshotMessage(runtime, request.channelId, { limit: request.limit })
            } else if (input.method === 'messages.send') {
              const request = z.object({ channelId: ChannelIdSchema, message: z.unknown() }).strict().parse(input.input)
              const message = HostApiContracts.sendChannelMessage.parseRequest(request.message)
              const channel = runtime.repository.getChannel(request.channelId)
              if (!channel) throw new Error('频道不存在。')
              if (channel.kind === 'web') {
                value = await runtime.web.postMessage({
                  channelId: request.channelId,
                  clientEventId: message.clientEventId ?? `host-ui-${Date.now()}`,
                  parts: message.parts,
                  ...(message.senderMemberId === undefined ? {} : { senderMemberId: message.senderMemberId }),
                })
              } else {
                if (!runtime.repository.getBinding(request.channelId)) throw new Error('频道尚未绑定智能体。')
                const connection = runtime.repository.getConnection(channel.connectionId)
                if (!connection || runtime.connectionCapabilities(connection.id)?.proactiveSend !== true) {
                  throw new Error('这个连接不允许主动发言。')
                }
                await runtime.channels.sendAdminConsoleMessage({
                  channelId: request.channelId,
                  parts: message.parts,
                  ...(message.clientEventId === undefined ? {} : { clientRequestId: message.clientEventId }),
                })
                value = { inserted: true }
              }
            } else if (input.method === 'assets.get') {
              const request = z
                .object({ channelId: ChannelIdSchema, assetId: AssetIdSchema })
                .strict()
                .parse(input.input)
              if (!runtime.repository.canAccessAsset(request.assetId, request.channelId)) {
                throw new Error('当前频道无法访问该资源。')
              }
              const asset = runtime.repository.getAssetById(request.assetId)
              if (!asset) throw new Error('资源不存在。')
              value = {
                assetId: asset.id,
                mediaType: asset.mediaType,
                byteSize: asset.byteSize,
                url: `/api/channels/${encodeURIComponent(request.channelId)}/assets/${encodeURIComponent(request.assetId)}`,
              }
            } else if (input.method === 'notifications.publish') {
              const request = z
                .object({ title: z.string(), body: z.string(), route: z.string().optional() })
                .strict()
                .parse(input.input)
              runtime.notifications.publishExtensionNotification({
                owner: ownerKey,
                title: request.title,
                body: request.body,
                ...(request.route === undefined ? {} : { route: request.route }),
              })
              value = { published: true }
            } else if (input.method === 'network.request') {
              value = await performHostUiNetworkRequest(input.input, grant.declaration.networkOrigins)
            } else {
              value = { subscribed: true, topic: eventRequest?.topic }
            }
            value = JsonValueSchema.parse(JSON.parse(JSON.stringify(value)))
          } else if (input.method === 'state.get' || input.method === 'state.set' || input.method === 'state.delete') {
            const settingKey = `host-ui-state:${createHash('sha256').update(ownerKey).digest('hex')}`
            const current = runtime.repository.getSystemSetting(settingKey)
            const document = z.record(z.string(), JsonValueSchema).parse(current?.value ?? {})
            if (input.method === 'state.get') {
              const request = z
                .object({ key: z.string().trim().min(1).max(120) })
                .strict()
                .parse(input.input)
              value = { revision: current?.revision ?? 0, value: document[request.key] ?? null }
            } else {
              const request = z
                .object({
                  key: z.string().trim().min(1).max(120),
                  expectedRevision: z.number().int().nonnegative(),
                  value: JsonValueSchema.optional(),
                })
                .strict()
                .parse(input.input)
              if ((current?.revision ?? 0) !== request.expectedRevision) throw new Error('扩展状态已更新。')
              const next = { ...document }
              if (input.method === 'state.delete') delete next[request.key]
              else next[request.key] = request.value ?? null
              if (Object.keys(next).length > 128 || JSON.stringify(next).length > 64 * 1024) {
                throw new Error('扩展状态超过 128 项或 64 KiB。')
              }
              const saved = runtime.repository.putSystemSetting(settingKey, next, current?.revision, Date.now())
              value = { revision: saved.revision }
            }
          } else {
            if (page.owner.kind !== 'extension') throw new Error('DSH 页面没有注册自定义 Host RPC。')
            value = await runtime.installation.callHostUi(page.owner.extensionId, input.method, input.input)
          }
          writeContractJson(res, 200, HostApiContracts.callHostUiPage, { value })
          if (HOST_UI_PRODUCT_MUTATIONS.has(input.method)) {
            broadcast({ event: 'status', data: { ok: true, message: '扩展页面已更新产品数据' } })
          }
        } catch (error) {
          runtime.repository.upsertHostUiDiagnostic({
            pageInstanceId: page.pageInstanceId,
            status: 'rpc-failed',
            message: error instanceof Error ? error.message : String(error),
            observedAt: Date.now(),
          })
          writeError(res, 400, 'host-ui-call-failed', error instanceof Error ? error.message : String(error))
        }
        return
      }
      try {
        const input = HostApiContracts.reportHostUiPageDiagnostic.parseRequest(await readJsonBody(req))
        runtime.repository.upsertHostUiDiagnostic({
          pageInstanceId: page.pageInstanceId,
          status: input.status,
          ...(input.message === undefined ? {} : { message: input.message }),
          observedAt: Date.now(),
        })
        writeContractJson(res, 200, HostApiContracts.reportHostUiPageDiagnostic, { recorded: true })
        broadcastExtensionsChanged()
      } catch (error) {
        writeError(res, 400, 'host-ui-diagnostic-failed', error instanceof Error ? error.message : String(error))
      }
    },
  })

  // Persistent Extension Client artifact, Activation RPC, and diagnostics.
  registerRoute({
    kind: 'prefix',
    path: '/api/extensions',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const deleteMatch = /^\/api\/extensions\/([^/]+)$/u.exec(url.pathname)
      if (deleteMatch) {
        if (req.method !== 'DELETE') {
          writeError(res, 405, 'method-not-allowed', '删除本地扩展只支持 DELETE。')
          return
        }
        try {
          const extensionId = ExtensionIdSchema.parse(decodeURIComponent(deleteMatch[1] ?? ''))
          HostApiContracts.deleteLocalExtension.parseRequest(undefined)
          await runtime.deleteLocalExtension(extensionId)
          broadcastExtensionsChanged()
          writeContractJson(res, 200, HostApiContracts.deleteLocalExtension, { deleted: true })
        } catch (error) {
          writeError(res, 400, 'extension-delete-failed', error instanceof Error ? error.message : String(error))
        }
        return
      }
      if (url.pathname === '/api/extensions/imports/inspect') {
        if (req.method !== 'POST') {
          writeError(res, 405, 'method-not-allowed', '检查扩展导入包只支持 POST。')
          return
        }
        try {
          pruneExpiredExtensionImports()
          const parsed = parseExtensionImport(await readBinaryBody(req, 16 * 1024 * 1024))
          const existingRevision = runtime.repository.getExtensionRevision(parsed.manifest.revision.id)
          if (
            existingRevision &&
            (existingRevision.extensionId !== parsed.manifest.extension.id ||
              existingRevision.contentDigest !== parsed.manifest.revision.contentDigest ||
              existingRevision.payloadDigest !== parsed.manifest.revision.payloadDigest)
          ) {
            throw new Error('相同 Extension/Revision 身份已存在，但内容不同；不会覆盖本地版本。')
          }
          const token = randomUUID()
          pendingExtensionImports.set(token, { parsed, expiresAt: Date.now() + 10 * 60_000 })
          const slugOwner = runtime.repository.getExtensionBySlug(parsed.manifest.extension.slug)
          writeContractJson(res, 200, HostApiContracts.inspectExtensionImport, {
            token,
            extensionId: parsed.manifest.extension.id,
            revisionId: parsed.manifest.revision.id,
            slug: parsed.manifest.extension.slug,
            displayName: parsed.manifest.extension.displayName,
            scope: parsed.manifest.extension.scope,
            idempotent: existingRevision !== undefined,
            slugConflict: slugOwner !== undefined && slugOwner.id !== parsed.manifest.extension.id,
          })
        } catch (error) {
          writeError(
            res,
            400,
            'extension-import-inspect-failed',
            error instanceof Error ? error.message : String(error),
          )
        }
        return
      }
      const importCommitMatch = /^\/api\/extensions\/imports\/([^/]+)\/commit$/u.exec(url.pathname)
      if (importCommitMatch) {
        if (req.method !== 'POST') {
          writeError(res, 405, 'method-not-allowed', '提交扩展导入只支持 POST。')
          return
        }
        try {
          pruneExpiredExtensionImports()
          const token = decodeURIComponent(importCommitMatch[1] ?? '')
          const params = HostApiContracts.commitExtensionImport.parseParams({ token })
          const input = HostApiContracts.commitExtensionImport.parseRequest(await readJsonBody(req))
          const pending = pendingExtensionImports.get(params.token)
          if (!pending) throw new Error('扩展导入检查已失效，请重新选择文件。')
          const result = await runtime.extensionService.importRevision({
            extension: pending.parsed.manifest.extension,
            revision: pending.parsed.manifest.revision,
            manifest: pending.parsed.revisionManifest,
            sources: pending.parsed.sources,
            resources: pending.parsed.resources,
            dshVersion: DEEPSEEK_HARNESS_VERSION,
            ...(input.localSlug === undefined ? {} : { localSlug: input.localSlug }),
          })
          pendingExtensionImports.delete(params.token)
          broadcastExtensionsChanged()
          writeContractJson(res, 200, HostApiContracts.commitExtensionImport, {
            extensionId: result.extension.id,
            revisionId: result.revision.id,
            idempotent: result.idempotent,
          })
        } catch (error) {
          writeError(res, 400, 'extension-import-commit-failed', error instanceof Error ? error.message : String(error))
        }
        return
      }
      const exportMatch = /^\/api\/extensions\/([^/]+)\/revisions\/([^/]+)\/export$/u.exec(url.pathname)
      if (exportMatch) {
        if (req.method !== 'GET') {
          writeError(res, 405, 'method-not-allowed', '导出扩展版本只支持 GET。')
          return
        }
        try {
          const extensionId = ExtensionIdSchema.parse(decodeURIComponent(exportMatch[1] ?? ''))
          const revisionId = ExtensionRevisionIdSchema.parse(decodeURIComponent(exportMatch[2] ?? ''))
          const exported = await createExtensionRevisionExport(runtime, extensionId, revisionId)
          writeDownload(res, exported.filename, exported.body)
        } catch (error) {
          writeError(res, 400, 'extension-export-failed', error instanceof Error ? error.message : String(error))
        }
        return
      }
      const installationMatch = /^\/api\/extensions\/([^/]+)\/installation$/u.exec(url.pathname)
      if (installationMatch) {
        let extensionId: z.output<typeof ExtensionIdSchema>
        try {
          extensionId = ExtensionIdSchema.parse(decodeURIComponent(installationMatch[1] ?? ''))
        } catch {
          writeError(res, 400, 'invalid-extension', '无效的扩展 ID。')
          return
        }
        if (req.method === 'PUT') {
          try {
            const params = HostApiContracts.installHostExtension.parseParams({ extensionId })
            const parsed = HostApiContracts.installHostExtension.parseRequest(await readJsonBody(req))
            const installation = await runtime.installHostExtension({
              extensionId: params.extensionId,
              revisionId: parsed.revisionId,
              ...(parsed.permissionApproval === undefined ? {} : { permissionApproval: parsed.permissionApproval }),
            })
            writeContractJson(res, 200, HostApiContracts.installHostExtension, { installation })
            broadcastExtensionsChanged()
          } catch (error) {
            writeError(res, 400, 'installation-failed', error instanceof Error ? error.message : String(error))
          }
          return
        }
        if (req.method === 'DELETE') {
          try {
            const params = HostApiContracts.uninstallHostExtension.parseParams({ extensionId })
            HostApiContracts.uninstallHostExtension.parseRequest(undefined)
            await runtime.uninstallHostExtension(params.extensionId)
            writeContractJson(res, 200, HostApiContracts.uninstallHostExtension, { uninstalled: true })
            broadcastExtensionsChanged()
          } catch (error) {
            writeError(res, 400, 'uninstall-failed', error instanceof Error ? error.message : String(error))
          }
          return
        }
        writeError(res, 405, 'method-not-allowed', '本机扩展安装只支持 PUT/DELETE。')
        return
      }
      const hostUiClientMatch =
        /^\/api\/extensions\/([^/]+)\/revisions\/([^/]+)\/host-ui\/client\/([a-f0-9]{64})\.(mjs|css)$/u.exec(
          url.pathname,
        )
      if (hostUiClientMatch) {
        if (req.method !== 'GET') {
          writeError(res, 405, 'method-not-allowed', '页面 Client Artifact 只支持 GET。')
          return
        }
        try {
          const extensionId = ExtensionIdSchema.parse(decodeURIComponent(hostUiClientMatch[1] ?? ''))
          const revisionId = ExtensionRevisionIdSchema.parse(decodeURIComponent(hostUiClientMatch[2] ?? ''))
          const installation = runtime.repository.getHostInstallation(extensionId)
          if (installation?.extensionRevisionId !== revisionId) throw new Error('该扩展版本未安装到本机。')
          const revision = runtime.repository.getExtensionRevision(revisionId)
          if (!revision || revision.extensionId !== extensionId) throw new Error('找不到页面扩展版本。')
          const artifact = await runtime.extensionService.buildRevision(revision)
          if (!artifact.clientEntry || artifact.buildKey !== hostUiClientMatch[3]) {
            throw new Error('页面 Client buildKey 已过期。')
          }
          const css = hostUiClientMatch[4] === 'css'
          const source = css
            ? artifact.clientCssEntry
              ? await readFile(artifact.clientCssEntry, 'utf8')
              : ''
            : await readFile(artifact.clientEntry, 'utf8')
          res.writeHead(200, {
            'content-type': css ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
            'cache-control': 'private, no-cache',
          })
          res.end(css ? scopeHostUiCss(source, artifact.buildKey) : source)
        } catch (error) {
          writeError(res, 409, 'host-ui-client-unavailable', error instanceof Error ? error.message : String(error))
        }
        return
      }
      const hostUiAssetMatch =
        /^\/api\/extensions\/([^/]+)\/revisions\/([^/]+)\/host-ui\/assets\/([a-f0-9]{64})\.svg$/u.exec(url.pathname)
      if (hostUiAssetMatch) {
        if (req.method !== 'GET') {
          writeError(res, 405, 'method-not-allowed', '页面图标只支持 GET。')
          return
        }
        try {
          const extensionId = ExtensionIdSchema.parse(decodeURIComponent(hostUiAssetMatch[1] ?? ''))
          const revisionId = ExtensionRevisionIdSchema.parse(decodeURIComponent(hostUiAssetMatch[2] ?? ''))
          const installation = runtime.repository.getHostInstallation(extensionId)
          if (installation?.extensionRevisionId !== revisionId) throw new Error('该扩展版本未安装到本机。')
          const revision = runtime.repository.getExtensionRevision(revisionId)
          if (!revision || revision.extensionId !== extensionId) throw new Error('找不到页面扩展版本。')
          const sourceDirectory = runtime.extensionService.revisionSourceDirectory(revision)
          const manifest = z
            .object({ contributions: z.array(z.unknown()) })
            .passthrough()
            .parse(JSON.parse(await readFile(path.join(sourceDirectory, 'manifest.json'), 'utf8')))
          const page = manifest.contributions
            .map((candidate) => HostPageContributionSchema.safeParse(candidate))
            .find(
              (candidate) =>
                candidate.success &&
                candidate.data.icon.kind === 'svg' &&
                candidate.data.icon.sha256 === hostUiAssetMatch[3],
            )
          if (!page?.success || page.data.icon.kind !== 'svg') throw new Error('页面图标不存在。')
          const source = await readFile(path.join(sourceDirectory, page.data.icon.path), 'utf8')
          if (createHash('sha256').update(source).digest('hex') !== page.data.icon.sha256) {
            throw new Error('页面图标摘要不一致。')
          }
          validateHostUiSvg(source)
          res.writeHead(200, {
            'content-type': 'image/svg+xml; charset=utf-8',
            'cache-control': 'private, max-age=31536000, immutable',
          })
          res.end(source)
        } catch (error) {
          writeError(res, 409, 'host-ui-icon-unavailable', error instanceof Error ? error.message : String(error))
        }
        return
      }
      const match =
        /^\/api\/extensions\/([^/]+)\/revisions\/([^/]+)\/(call|client-diagnostic|host-client-diagnostic|client\/([a-f0-9]{64})\.mjs)$/u.exec(
          url.pathname,
        )
      if (!match) {
        writeError(res, 404, 'not-found', `未定义路由：${req.method} ${url.pathname}。`)
        return
      }
      let extensionId: z.output<typeof ExtensionIdSchema>
      let revisionId: z.output<typeof ExtensionRevisionIdSchema>
      try {
        extensionId = ExtensionIdSchema.parse(decodeURIComponent(match[1] ?? ''))
        revisionId = ExtensionRevisionIdSchema.parse(decodeURIComponent(match[2] ?? ''))
      } catch {
        writeError(res, 400, 'invalid-extension-client-target', '无效的扩展或 Revision ID。')
        return
      }
      const revision = runtime.repository.getExtensionRevision(revisionId)
      if (!revision || revision.extensionId !== extensionId) {
        writeError(res, 404, 'extension-revision-missing', '找不到指定的扩展 Revision。')
        return
      }
      const action = match[3]
      if (action?.startsWith('client/')) {
        if (req.method !== 'GET') {
          writeError(res, 405, 'method-not-allowed', 'Client Artifact 只支持 GET。')
          return
        }
        const verification = runtime.repository.getExtensionRevisionVerification(revisionId)
        if (verification?.scope === 'host-adapter') {
          const installation = runtime.repository.getHostInstallation(extensionId)
          if (installation?.extensionRevisionId !== revisionId) {
            writeError(res, 409, 'stale-client-build', '该 Revision 不是当前安装到本机的版本。')
            return
          }
        } else {
          let agentId: AgentId
          try {
            agentId = AgentIdSchema.parse(url.searchParams.get('agentId'))
          } catch {
            writeError(res, 400, 'invalid-agent', 'Client Artifact 缺少有效的智能体 ID。')
            return
          }
          const activation = runtime.repository.getActivation(agentId, extensionId)
          if (activation?.extensionRevisionId !== revisionId) {
            writeError(res, 409, 'stale-client-build', '该 Revision 不是此智能体当前启用的版本。')
            return
          }
        }
        try {
          const artifact = await runtime.extensionService.buildRevision(revision)
          if (!artifact.clientEntry || artifact.buildKey !== match[4]) {
            throw new Error('Client buildKey 已过期或该 Revision 没有 Client Artifact。')
          }
          const source = await readFile(artifact.clientEntry, 'utf8')
          res.writeHead(200, {
            'content-type': 'text/javascript; charset=utf-8',
            'cache-control': 'private, no-cache',
          })
          res.end(source)
        } catch (error) {
          writeError(res, 409, 'client-artifact-unavailable', error instanceof Error ? error.message : String(error))
        }
        return
      }
      if (req.method !== 'POST') {
        writeError(res, 405, 'method-not-allowed', '只支持 POST。')
        return
      }
      if (action === 'call') {
        try {
          const parsed = HostApiContracts.extensionClientCall.parseRequest(await readJsonBody(req))
          const activation = runtime.repository.getActivation(parsed.agentId, extensionId)
          if (activation?.extensionRevisionId !== revisionId) throw new Error('该 Revision 不是当前 Activation。')
          const value = await runtime.host.invokeExtensionActivation(
            parsed.agentId,
            revisionId,
            parsed.method,
            parsed.input,
          )
          writeJson(res, 200, HostApiContracts.extensionClientCall.parseResponse({ value }))
        } catch (error) {
          writeError(res, 400, 'extension-client-call-failed', error instanceof Error ? error.message : String(error))
        }
        return
      }
      if (action === 'client-diagnostic') {
        try {
          const parsed = HostApiContracts.extensionClientDiagnostic.parseRequest(await readJsonBody(req))
          const activation = runtime.repository.getActivation(parsed.agentId, extensionId)
          if (activation?.extensionRevisionId !== revisionId) throw new Error('该 Revision 不是当前 Activation。')
          runtime.repository.upsertExtensionClientDiagnostic({
            agentId: parsed.agentId,
            extensionId,
            revisionId,
            status: parsed.status,
            ...(parsed.message === undefined ? {} : { message: parsed.message }),
            observedAt: Date.now(),
          })
          writeJson(res, 200, HostApiContracts.extensionClientDiagnostic.parseResponse({ accepted: true }))
          broadcastExtensionsChanged()
        } catch (error) {
          writeError(
            res,
            400,
            'extension-client-diagnostic-failed',
            error instanceof Error ? error.message : String(error),
          )
        }
        return
      }
      if (action === 'host-client-diagnostic') {
        try {
          const parsed = HostApiContracts.hostExtensionClientDiagnostic.parseRequest(await readJsonBody(req))
          const installation = runtime.repository.getHostInstallation(extensionId)
          if (installation?.extensionRevisionId !== revisionId) {
            throw new Error('该 Revision 不是当前安装到本机的版本。')
          }
          runtime.recordHostClientDiagnostic(extensionId, {
            revisionId,
            status: parsed.status,
            ...(parsed.message === undefined ? {} : { message: parsed.message }),
          })
          writeContractJson(res, 200, HostApiContracts.hostExtensionClientDiagnostic, { accepted: true })
          broadcastExtensionsChanged()
        } catch (error) {
          writeError(res, 400, 'host-client-diagnostic-failed', error instanceof Error ? error.message : String(error))
        }
        return
      }
    },
  })

  registerRoute({
    kind: 'prefix',
    path: '/api/bindings',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname === '/api/bindings') {
        if (req.method !== 'POST') {
          writeError(res, 405, 'method-not-allowed', '只支持 POST。')
          return
        }
        try {
          const parsed = HostApiContracts.createBinding.parseRequest(await readJsonBody(req))
          const { agentId, channelId } = parsed
          if (!runtime.repository.getAgent(agentId)) throw new Error('智能体不存在。')
          if (!runtime.repository.getChannel(channelId)) throw new Error('频道不存在。')
          const current = runtime.repository.getBinding(channelId)
          const kind = current === undefined ? 'bind' : 'replace'
          const operationId = `bop_${Date.now()}`
          const emit = (step: string, status: 'running' | 'skipped' | 'done' | 'failed', message: string): void => {
            broadcast({
              event: 'binding-change',
              data: { operationId, channelId, kind, step, status, message },
            })
          }
          emit(
            kind === 'replace' ? 'stop-agent' : 'bind',
            'running',
            kind === 'replace' ? '正在停止当前工作。' : '正在绑定频道。',
          )
          const binding = await runtime.channels.replaceBinding({
            agentId,
            channelId,
            triggerPolicy: parsed.triggerPolicy,
            ...(parsed.processingFeedback === undefined ? {} : { processingFeedback: parsed.processingFeedback }),
            ...(parsed.eventTriggers === undefined ? {} : { eventTriggers: parsed.eventTriggers }),
          })
          emit('write-binding', 'done', kind === 'replace' ? '已改由新智能体响应。' : '频道已绑定。')
          writeJson(res, 201, HostApiContracts.createBinding.parseResponse(binding))
        } catch (error) {
          writeError(res, 400, 'binding-failed', error instanceof Error ? error.message : String(error))
        }
        return
      }
      const match = /^\/api\/bindings\/([^/]+)$/.exec(url.pathname)
      if (!match?.[1] || req.method !== 'DELETE') {
        writeError(res, 404, 'not-found', `未定义路由：${req.method} ${url.pathname}。`)
        return
      }
      try {
        const { channelId } = HostApiContracts.clearBinding.parseParams({
          channelId: decodeURIComponent(match[1]),
        })
        if (!runtime.repository.getChannel(channelId)) throw new Error('频道不存在。')
        const operationId = `bop_${Date.now()}`
        const emit = (step: string, status: 'running' | 'skipped' | 'done' | 'failed', message: string): void => {
          broadcast({
            event: 'binding-change',
            data: { operationId, channelId, kind: 'clear', step, status, message },
          })
        }
        const current = runtime.repository.getBinding(channelId)
        const episode =
          current === undefined ? undefined : runtime.repository.getActiveEpisode(channelId, current.agentId)
        emit(
          'stop-agent',
          episode?.dshSessionId === undefined ? 'skipped' : 'running',
          episode?.dshSessionId === undefined ? '当前没有正在进行的工作。' : '正在停止当前工作。',
        )
        await runtime.channels.clearBinding(channelId)
        emit('clear-binding', 'done', '已解除绑定。')
        writeJson(res, 200, HostApiContracts.clearBinding.parseResponse({ channelId, cleared: true }))
      } catch (error) {
        writeError(res, 400, 'binding-failed', error instanceof Error ? error.message : String(error))
      }
    },
  })

  registerRoute({
    kind: 'exact',
    path: '/api/work-tree-order',
    handler: async (req, res) => {
      if (req.method !== 'PUT') {
        writeError(res, 405, 'method-not-allowed', '只支持 PUT。')
        return
      }
      try {
        const parsed = HostApiContracts.putWorkTreeOrder.parseRequest(await readJsonBody(req))
        const knownAgents = new Set(runtime.core.listAgents().map((commit) => commit.definition.id))
        const knownChannels = new Set(
          runtime.core
            .listConnections()
            .flatMap((connection) => runtime.core.listChannelsByConnection(connection.id).map((channel) => channel.id)),
        )
        const agentIds = [...parsed.agentIds.filter((id) => knownAgents.has(id))]
        for (const id of knownAgents) if (!agentIds.includes(id)) agentIds.push(id)
        const channelIdsByAgent: Record<string, typeof parsed.unboundChannelIds> = {}
        for (const [rawAgentId, channelIds] of Object.entries(parsed.channelIdsByAgent)) {
          const parsedAgentId = AgentIdSchema.safeParse(rawAgentId)
          if (!parsedAgentId.success || !knownAgents.has(parsedAgentId.data)) continue
          channelIdsByAgent[parsedAgentId.data] = channelIds.filter((id) => knownChannels.has(id))
        }
        const unboundChannelIds = parsed.unboundChannelIds.filter((id) => knownChannels.has(id))
        const saved = runtime.repository.putWorkTreeOrder({ agentIds, channelIdsByAgent, unboundChannelIds })
        writeJson(res, 200, HostApiContracts.putWorkTreeOrder.parseResponse(saved))
      } catch (error) {
        writeError(res, 400, 'work-tree-order-failed', error instanceof Error ? error.message : String(error))
      }
    },
  })

  // Generic DSH capability/configuration plane. The live DSH services remain authoritative.
  registerRoute({
    kind: 'exact',
    path: '/api/dsh/plugins',
    handler: (req, res) => {
      if (req.method !== 'GET') {
        writeError(res, 405, 'method-not-allowed', '只支持 GET。')
        return
      }
      try {
        HostApiContracts.dshPlugins.parseParams({})
        HostApiContracts.dshPlugins.parseRequest(undefined)
        writeContractJson(res, 200, HostApiContracts.dshPlugins, {
          plugins: projectDshPlugins(runtime),
        })
      } catch (error) {
        writeError(res, 500, 'dsh-plugins-failed', error instanceof Error ? error.message : String(error))
      }
    },
  })

  registerRoute({
    kind: 'exact',
    path: '/api/dsh/settings',
    handler: (req, res) => {
      if (req.method !== 'GET') {
        writeError(res, 405, 'method-not-allowed', '只支持 GET。')
        return
      }
      try {
        HostApiContracts.dshSettings.parseParams({})
        HostApiContracts.dshSettings.parseRequest(undefined)
        writeContractJson(res, 200, HostApiContracts.dshSettings, {
          namespaces: runtime.host.listDshSettings(),
        })
      } catch (error) {
        writeError(res, 500, 'dsh-settings-failed', error instanceof Error ? error.message : String(error))
      }
    },
  })

  registerRoute({
    kind: 'exact',
    path: '/api/dsh/plugin-installs/inspect',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        writeError(res, 405, 'method-not-allowed', '只支持 POST。')
        return
      }
      try {
        const input = HostApiContracts.inspectDshPluginInstall.parseRequest(await readJsonBody(req))
        const operationId = input.operationId ?? randomUUID()
        const operation = dshPluginOperation(operationId, 'inspect')
        try {
          const inspection = await runtime.dshPluginInstaller.inspectRegistry(input.spec, operation.progress)
          operation.done()
          writeContractJson(res, 200, HostApiContracts.inspectDshPluginInstall, { ...inspection, operationId })
        } catch (error) {
          operation.failed(error instanceof Error ? error.message : String(error))
          throw error
        }
      } catch (error) {
        writeError(res, 400, 'dsh-plugin-inspect-failed', error instanceof Error ? error.message : String(error))
      }
    },
  })

  registerRoute({
    kind: 'exact',
    path: '/api/dsh/plugin-installs/inspect-tarball',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        writeError(res, 405, 'method-not-allowed', '只支持 POST。')
        return
      }
      try {
        const requestedOperationId = req.headers['x-operation-id']
        const operationId =
          typeof requestedOperationId === 'string' && z.string().uuid().safeParse(requestedOperationId).success
            ? requestedOperationId
            : randomUUID()
        const operation = dshPluginOperation(operationId, 'inspect')
        const content = await readBinaryBody(req, 64 * 1024 * 1024)
        try {
          const isNxtArchive = content[0] === 0x50 && content[1] === 0x4b
          const imported = isNxtArchive ? parseDshPluginTransfer(content) : undefined
          const inspection = imported
            ? await runtime.dshPluginInstaller.inspectImportedTarball(
                imported.tarball,
                imported.expected,
                operation.progress,
              )
            : await runtime.dshPluginInstaller.inspectTarball(content, operation.progress)
          operation.done()
          writeJson(res, 200, HostApiContracts.inspectDshPluginInstall.parseResponse({ ...inspection, operationId }))
        } catch (error) {
          operation.failed(error instanceof Error ? error.message : String(error))
          throw error
        }
      } catch (error) {
        writeError(res, 400, 'dsh-plugin-inspect-failed', error instanceof Error ? error.message : String(error))
      }
    },
  })

  registerRoute({
    kind: 'exact',
    path: '/api/dsh/plugin-installs',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        writeError(res, 405, 'method-not-allowed', '只支持 POST。')
        return
      }
      try {
        const input = HostApiContracts.commitDshPluginInstall.parseRequest(await readJsonBody(req))
        const operationId = input.operationId ?? randomUUID()
        const operation = dshPluginOperation(operationId, 'install')
        try {
          const installed = await runtime.dshPluginInstaller.commit(
            input.token,
            input.approvedBuilds,
            operation.progress,
          )
          operation.done()
          broadcast({ event: 'dsh-plugins-changed', data: { changed: true } })
          writeContractJson(res, 200, HostApiContracts.commitDshPluginInstall, {
            packageId: installed.id,
            operationId,
          })
        } catch (error) {
          operation.failed(error instanceof Error ? error.message : String(error))
          throw error
        }
      } catch (error) {
        writeError(res, 400, 'dsh-plugin-install-failed', error instanceof Error ? error.message : String(error))
      }
    },
  })

  registerRoute({
    kind: 'prefix',
    path: '/api/dsh/plugin-entries',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const hostUiClientMatch =
        /^\/api\/dsh\/plugin-entries\/([^/]+)\/host-ui\/client\/([a-f0-9]{64})\.(mjs|css)$/u.exec(url.pathname)
      if (hostUiClientMatch) {
        if (req.method !== 'GET') {
          writeError(res, 405, 'method-not-allowed', 'DSH 页面 Client 只支持 GET。')
          return
        }
        try {
          const entryId = DshPluginEntryIdSchema.parse(decodeURIComponent(hostUiClientMatch[1] ?? ''))
          const activation = runtime.repository
            .listDshPluginActivations(entryId)
            .find((candidate) => candidate.target === 'host')
          if (!activation) throw new Error('对应 DSH Host 入口未启用。')
          const client = await runtime.dshPluginInstaller.readHostUiClient(entryId)
          if (client.packageDigest !== hostUiClientMatch[2]) throw new Error('DSH 页面 Client 摘要已过期。')
          const css = hostUiClientMatch[3] === 'css'
          res.writeHead(200, {
            'content-type': css ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
            'cache-control': 'private, no-cache',
          })
          res.end(css ? scopeHostUiCss(client.css ?? '', client.packageDigest) : client.source)
        } catch (error) {
          writeError(res, 409, 'dsh-host-ui-client-unavailable', error instanceof Error ? error.message : String(error))
        }
        return
      }
      const hostUiAssetMatch = /^\/api\/dsh\/plugin-entries\/([^/]+)\/host-ui\/assets\/([a-f0-9]{64})\.svg$/u.exec(
        url.pathname,
      )
      if (hostUiAssetMatch) {
        if (req.method !== 'GET') {
          writeError(res, 405, 'method-not-allowed', 'DSH 页面图标只支持 GET。')
          return
        }
        try {
          const entryId = DshPluginEntryIdSchema.parse(decodeURIComponent(hostUiAssetMatch[1] ?? ''))
          const activation = runtime.repository
            .listDshPluginActivations(entryId)
            .find((candidate) => candidate.target === 'host')
          if (!activation) throw new Error('对应 DSH Host 入口未启用。')
          const source = await runtime.dshPluginInstaller.readHostUiSvg(entryId, hostUiAssetMatch[2] ?? '')
          res.writeHead(200, {
            'content-type': 'image/svg+xml; charset=utf-8',
            'cache-control': 'private, max-age=31536000, immutable',
          })
          res.end(source)
        } catch (error) {
          writeError(res, 409, 'dsh-host-ui-icon-unavailable', error instanceof Error ? error.message : String(error))
        }
        return
      }
      const activationMatch = /^\/api\/dsh\/plugin-entries\/([^/]+)\/activation$/u.exec(url.pathname)
      const configMatch = /^\/api\/dsh\/plugin-entries\/([^/]+)\/config\/inspect$/u.exec(url.pathname)
      const encodedEntryId = activationMatch?.[1] ?? configMatch?.[1]
      if (!encodedEntryId) {
        writeError(res, 404, 'not-found', `未定义路由：${req.method} ${url.pathname}。`)
        return
      }
      try {
        const entryId = DshPluginEntryIdSchema.parse(decodeURIComponent(encodedEntryId))
        if (configMatch) {
          if (req.method !== 'POST') {
            writeError(res, 405, 'method-not-allowed', '检查 DSH 插件配置只支持 POST。')
            return
          }
          HostApiContracts.inspectDshPluginEntryConfig.parseRequest(undefined)
          writeContractJson(
            res,
            200,
            HostApiContracts.inspectDshPluginEntryConfig,
            await runtime.host.inspectInstalledDshPluginConfig(entryId),
          )
          return
        }
        if (req.method === 'PUT') {
          const input = HostApiContracts.activateDshPluginEntry.parseRequest(await readJsonBody(req))
          const entry = runtime.repository.getDshPluginEntry(entryId)
          const packageRecord = entry ? runtime.repository.getDshPluginPackage(entry.packageId) : undefined
          const manifest = packageRecord?.manifest
          const nekroNxt =
            typeof manifest === 'object' && manifest !== null && !Array.isArray(manifest)
              ? manifest['nekroNxt']
              : undefined
          const metadata = DshNxtHostUiSchema.safeParse(
            typeof nekroNxt === 'object' && nekroNxt !== null && !Array.isArray(nekroNxt)
              ? nekroNxt['hostUi']
              : undefined,
          )
          const permissionDigest = metadata.success ? hostUiPermissionDigest(metadata.data.permissions) : undefined
          if (metadata.success && metadata.data.entryKey === entry?.entryKey && input.target === 'host') {
            const grant = runtime.repository.getHostUiPermissionGrant(`dsh:${entryId}`)
            const approved =
              grant?.artifactDigest === packageRecord?.packageDigest && grant?.permissionDigest === permissionDigest
            if (!approved && input.permissionApproval?.permissionDigest !== permissionDigest) {
              throw new Error(`permission-approval-required:${permissionDigest}`)
            }
          }
          const activation = await runtime.host.activateInstalledDshPlugin({
            entryId,
            target: input.target,
            config: input.config,
            ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
            ...(input.target === 'host' &&
            metadata.success &&
            metadata.data.entryKey === entry?.entryKey &&
            packageRecord &&
            permissionDigest
              ? {
                  hostUi: {
                    grant: {
                      ownerKey: `dsh:${entryId}`,
                      artifactDigest: packageRecord.packageDigest,
                      permissionDigest,
                      declaration: metadata.data.permissions,
                      approvedAt: Date.now(),
                    },
                    artifactDigest: packageRecord.packageDigest,
                    pages: metadata.data.pages,
                    clientBuildKey: packageRecord.packageDigest,
                    now: Date.now(),
                    nextPageInstanceId: () =>
                      HostUiPageInstanceIdSchema.parse(`hup_${randomUUID().replaceAll('-', '')}`),
                  },
                }
              : {}),
          })
          broadcast({ event: 'dsh-plugins-changed', data: { changed: true } })
          broadcastExtensionsChanged()
          writeContractJson(res, 200, HostApiContracts.activateDshPluginEntry, {
            targetKey: activation.targetKey,
          })
          return
        }
        if (req.method === 'DELETE') {
          const input = HostApiContracts.deactivateDshPluginEntry.parseRequest(await readJsonBody(req))
          await runtime.host.disableInstalledDshPlugin(entryId, input.targetKey)
          broadcast({ event: 'dsh-plugins-changed', data: { changed: true } })
          broadcastExtensionsChanged()
          writeContractJson(res, 200, HostApiContracts.deactivateDshPluginEntry, { disabled: true })
          return
        }
        writeError(res, 405, 'method-not-allowed', '只支持 PUT 或 DELETE。')
      } catch (error) {
        writeError(res, 400, 'dsh-plugin-activation-failed', error instanceof Error ? error.message : String(error))
      }
    },
  })

  registerRoute({
    kind: 'prefix',
    path: '/api/dsh/plugin-installs',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const exportMatch = /^\/api\/dsh\/plugin-installs\/([^/]+)\/export$/u.exec(url.pathname)
      if (exportMatch) {
        if (req.method !== 'GET') {
          writeError(res, 405, 'method-not-allowed', '导出 DSH 插件只支持 GET。')
          return
        }
        try {
          const packageId = DshPluginPackageIdSchema.parse(decodeURIComponent(exportMatch[1] ?? ''))
          const exported = await createDshPluginExport(runtime, packageId)
          writeDownload(res, exported.filename, exported.body)
        } catch (error) {
          writeError(res, 400, 'dsh-plugin-export-failed', error instanceof Error ? error.message : String(error))
        }
        return
      }
      const match = /^\/api\/dsh\/plugin-installs\/([^/]+)$/u.exec(url.pathname)
      if (!match?.[1]) {
        writeError(res, 404, 'not-found', `未定义路由：${req.method} ${url.pathname}。`)
        return
      }
      if (req.method !== 'DELETE') {
        writeError(res, 405, 'method-not-allowed', '只支持 DELETE。')
        return
      }
      try {
        const packageId = DshPluginPackageIdSchema.parse(decodeURIComponent(match[1]))
        HostApiContracts.removeDshPluginPackage.parseRequest(undefined)
        await runtime.removeDshPluginPackage(packageId)
        broadcast({ event: 'dsh-plugins-changed', data: { changed: true } })
        writeContractJson(res, 200, HostApiContracts.removeDshPluginPackage, { removed: true })
      } catch (error) {
        writeError(res, 400, 'dsh-plugin-remove-failed', error instanceof Error ? error.message : String(error))
      }
    },
  })

  registerRoute({
    kind: 'prefix',
    path: '/api/dsh/settings',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const match = /^\/api\/dsh\/settings\/([^/]+)\/mutate$/u.exec(url.pathname)
      if (!match) {
        writeError(res, 404, 'not-found', `未定义路由：${req.method} ${url.pathname}。`)
        return
      }
      if (req.method !== 'POST') {
        writeError(res, 405, 'method-not-allowed', '只支持 POST。')
        return
      }
      try {
        const encodedNamespace = match[1]
        if (encodedNamespace === undefined) {
          writeError(res, 404, 'not-found', `未定义路由：${req.method} ${url.pathname}。`)
          return
        }
        const params = HostApiContracts.dshSettingsMutate.parseParams({
          namespace: decodeURIComponent(encodedNamespace),
        })
        const input = HostApiContracts.dshSettingsMutate.parseRequest(await readJsonBody(req))
        writeContractJson(
          res,
          200,
          HostApiContracts.dshSettingsMutate,
          await runtime.host.mutateDshSettings(params.namespace, input.expectedRevision, input.ops),
        )
      } catch (error) {
        const conflict = error instanceof Error && 'code' in error && error.code === 'SETTINGS_CONFLICT'
        writeError(
          res,
          conflict ? 409 : 400,
          conflict ? 'dsh-settings-conflict' : 'dsh-settings-rejected',
          error instanceof Error ? error.message : String(error),
        )
      }
    },
  })

  registerRoute({
    kind: 'exact',
    path: '/api/dsh/credentials/describe',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        writeError(res, 405, 'method-not-allowed', '只支持 POST。')
        return
      }
      try {
        HostApiContracts.dshCredentialsDescribe.parseParams({})
        const input = HostApiContracts.dshCredentialsDescribe.parseRequest(await readJsonBody(req))
        writeContractJson(res, 200, HostApiContracts.dshCredentialsDescribe, {
          credentials: await runtime.host.describeDshCredentials(input.refs),
        })
      } catch (error) {
        writeError(res, 400, 'dsh-credentials-rejected', error instanceof Error ? error.message : String(error))
      }
    },
  })

  registerRoute({
    kind: 'prefix',
    path: '/api/dsh/credentials',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const match = /^\/api\/dsh\/credentials\/([^/]+)$/u.exec(url.pathname)
      if (!match) {
        writeError(res, 404, 'not-found', `未定义路由：${req.method} ${url.pathname}。`)
        return
      }
      try {
        const encodedRef = match[1]
        if (encodedRef === undefined) {
          writeError(res, 404, 'not-found', `未定义路由：${req.method} ${url.pathname}。`)
          return
        }
        const ref = decodeURIComponent(encodedRef)
        if (req.method === 'PUT') {
          const params = HostApiContracts.dshCredentialSet.parseParams({ ref })
          const input = HostApiContracts.dshCredentialSet.parseRequest(await readJsonBody(req))
          writeContractJson(
            res,
            200,
            HostApiContracts.dshCredentialSet,
            await runtime.host.setDshCredential(params.ref, input.value),
          )
          return
        }
        if (req.method === 'DELETE') {
          const params = HostApiContracts.dshCredentialUnset.parseParams({ ref })
          HostApiContracts.dshCredentialUnset.parseRequest(undefined)
          writeContractJson(
            res,
            200,
            HostApiContracts.dshCredentialUnset,
            await runtime.host.unsetDshCredential(params.ref),
          )
          return
        }
        writeError(res, 405, 'method-not-allowed', '只支持 PUT/DELETE。')
      } catch (error) {
        writeError(res, 400, 'dsh-credentials-rejected', error instanceof Error ? error.message : String(error))
      }
    },
  })

  // DSH-owned provider/settings/credentials plane. Secrets are accepted write-only and never returned.
  registerRoute({
    kind: 'exact',
    path: '/api/llm/providers',
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        writeError(res, 405, 'method-not-allowed', '只支持 GET。')
        return
      }
      try {
        HostApiContracts.llmProviders.parseParams({})
        HostApiContracts.llmProviders.parseRequest(undefined)
        writeContractJson(res, 200, HostApiContracts.llmProviders, await runtime.host.getLlmProviderSettings())
      } catch (error) {
        writeError(res, 500, 'llm-settings-failed', error instanceof Error ? error.message : String(error))
      }
    },
  })

  registerRoute({
    kind: 'exact',
    path: '/api/llm/discover-models',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        writeError(res, 405, 'method-not-allowed', '只支持 POST。')
        return
      }
      try {
        HostApiContracts.llmDiscoverModels.parseParams({})
        const parsed = HostApiContracts.llmDiscoverModels.parseRequest(await readJsonBody(req))
        writeContractJson(res, 200, HostApiContracts.llmDiscoverModels, {
          models: await runtime.host.discoverLlmProviderModels({
            ...(parsed.provider === undefined ? {} : { provider: parsed.provider }),
            ...(parsed.settingsNs === undefined ? {} : { settingsNs: parsed.settingsNs }),
            ...(parsed.baseURL === undefined ? {} : { baseURL: parsed.baseURL }),
            ...(parsed.api === undefined ? {} : { api: parsed.api }),
            ...(parsed.apiKey === undefined ? {} : { apiKey: parsed.apiKey }),
          }),
        })
      } catch (error) {
        writeError(res, 400, 'model-discovery-failed', error instanceof Error ? error.message : String(error))
      }
    },
  })

  registerRoute({
    kind: 'exact',
    path: '/api/llm/test-provider',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        writeError(res, 405, 'method-not-allowed', '只支持 POST。')
        return
      }
      try {
        HostApiContracts.llmTestProvider.parseParams({})
        const parsed = HostApiContracts.llmTestProvider.parseRequest(await readJsonBody(req))
        writeContractJson(
          res,
          200,
          HostApiContracts.llmTestProvider,
          await runtime.host.testLlmProvider({
            provider: parsed.provider,
            model: parsed.model,
            ...(parsed.settingsNs === undefined ? {} : { settingsNs: parsed.settingsNs }),
            ...(parsed.apiKey === undefined ? {} : { apiKey: parsed.apiKey }),
            ...(parsed.baseURL === undefined ? {} : { baseURL: parsed.baseURL }),
            ...(parsed.api === undefined ? {} : { api: parsed.api }),
            ...(parsed.models === undefined
              ? {}
              : {
                  models: parsed.models.map((entry) => ({
                    id: entry.id,
                    ...(entry.name === undefined ? {} : { name: entry.name }),
                    ...(entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow }),
                    ...(entry.maxTokens === undefined ? {} : { maxTokens: entry.maxTokens }),
                  })),
                }),
          }),
        )
      } catch (error) {
        writeError(res, 400, 'llm-provider-test-failed', error instanceof Error ? error.message : String(error))
      }
    },
  })

  registerRoute({
    kind: 'prefix',
    path: '/api/llm/providers',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const match = /^\/api\/llm\/providers\/([^/]+)$/.exec(url.pathname)
      if (!match) {
        writeError(res, 404, 'not-found', `未定义路由：${req.method} ${url.pathname}。`)
        return
      }
      if (req.method !== 'POST') {
        writeError(res, 405, 'method-not-allowed', '只支持 POST。')
        return
      }
      try {
        const encodedProvider = match[1]
        if (encodedProvider === undefined) {
          writeError(res, 404, 'not-found', `未定义路由：${req.method} ${url.pathname}。`)
          return
        }
        const params = HostApiContracts.llmSaveProvider.parseParams({ provider: decodeURIComponent(encodedProvider) })
        const parsed = HostApiContracts.llmSaveProvider.parseRequest(await readJsonBody(req))
        writeContractJson(
          res,
          200,
          HostApiContracts.llmSaveProvider,
          await runtime.host.saveLlmProvider({
            provider: params.provider,
            expectedRevision: parsed.expectedRevision,
            ...(parsed.apiKey === undefined ? {} : { apiKey: parsed.apiKey }),
            ...(parsed.displayName === undefined ? {} : { displayName: parsed.displayName }),
            ...(parsed.baseURL === undefined ? {} : { baseURL: parsed.baseURL }),
            ...(parsed.api === undefined ? {} : { api: parsed.api }),
            ...(parsed.models === undefined
              ? {}
              : {
                  models: parsed.models.map((model) => ({
                    id: model.id,
                    ...(model.name === undefined ? {} : { name: model.name }),
                    ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
                    ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
                  })),
                }),
          }),
        )
      } catch (error) {
        const code = error instanceof Error && 'code' in error && error.code === 'SETTINGS_CONFLICT' ? 409 : 400
        writeError(res, code, 'llm-provider-save-failed', error instanceof Error ? error.message : String(error))
      }
    },
  })

  // GET /api/events (SSE) — live data plane for messages and work trajectory.
  registerRoute({
    kind: 'exact',
    path: '/api/events',
    handler: (req, res) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      hub.add(res)
      const replay = hub.replaySince(parseLastEventId(req.headers['last-event-id']))
      for (const frame of replay.frames) hub.write(res, frame)
      hub.write(res, renderSse({ event: 'status', data: { ok: true, message: '已连接', replay: replay.status } }))

      const heartbeat = setInterval(() => hub.write(res, `: heartbeat\n\n`), 15_000)
      const onClose = (): void => {
        hub.remove(res)
        clearInterval(heartbeat)
        res.end()
      }
      res.on('close', onClose)
      res.on('error', onClose)
    },
  })

  const handleExtensionActivationRoute = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const match = /^\/api\/agents\/([^/]+)\/extensions\/([^/]+)\/activation$/.exec(url.pathname)
    if (!match) {
      writeError(res, 404, 'not-found', `未定义路由：${req.method} ${url.pathname}。`)
      return
    }
    const encodedAgentId = match[1]
    const encodedExtensionId = match[2]
    if (encodedAgentId === undefined || encodedExtensionId === undefined) {
      writeError(res, 404, 'not-found', `未定义路由：${req.method} ${url.pathname}。`)
      return
    }
    let params: z.output<typeof HostApiContracts.activateExtension.params>
    try {
      const agentId = AgentIdSchema.parse(decodeURIComponent(encodedAgentId))
      const extensionId = ExtensionIdSchema.parse(decodeURIComponent(encodedExtensionId))
      params = HostApiContracts.activateExtension.params.parse({ agentId, extensionId })
    } catch {
      writeError(res, 400, 'invalid-activation-target', '无效的智能体或扩展 ID。')
      return
    }
    if (req.method === 'POST') {
      let parsed: ReturnType<typeof HostApiContracts.activateExtension.parseRequest>
      try {
        parsed = HostApiContracts.activateExtension.parseRequest(await readJsonBody(req))
      } catch (error) {
        writeError(res, 400, 'invalid-request', error instanceof Error ? error.message : String(error))
        return
      }
      try {
        const activation = await runtime.activation.activate({
          agentId: params.agentId,
          extensionId: params.extensionId,
          revisionId: parsed.revisionId,
        })
        writeJson(res, 200, HostApiContracts.activateExtension.parseResponse({ activation }))
        broadcastExtensionsChanged()
      } catch (error) {
        writeError(res, 400, 'activation-failed', error instanceof Error ? error.message : String(error))
      }
      return
    }
    if (req.method === 'DELETE') {
      try {
        if (!runtime.repository.getActivation(params.agentId, params.extensionId)) {
          writeError(res, 404, 'not-active', '该扩展当前没有已启用的 Activation。')
          return
        }
        HostApiContracts.deactivateExtension.parseRequest(undefined)
        await runtime.activation.disable(params.agentId, params.extensionId)
        writeJson(res, 200, HostApiContracts.deactivateExtension.parseResponse({ disabled: true }))
        broadcastExtensionsChanged()
      } catch (error) {
        writeError(res, 400, 'disable-failed', error instanceof Error ? error.message : String(error))
      }
      return
    }
    writeError(res, 405, 'method-not-allowed', '只支持 POST/DELETE。')
  }

  // POST /api/agents → closed-loop A primitive
  registerRoute({
    kind: 'exact',
    path: '/api/agents',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        writeError(res, 405, 'method-not-allowed', '只支持 POST。')
        return
      }
      let parsed: ReturnType<typeof HostApiContracts.createAgent.parseRequest>
      try {
        parsed = HostApiContracts.createAgent.parseRequest(await readJsonBody(req))
      } catch (error) {
        writeError(res, 400, 'invalid-request', error instanceof Error ? error.message : String(error))
        return
      }
      const defaultCapabilities =
        parsed.capabilities === undefined
          ? {
              subagents: true,
              fileTools: false,
              webSearch: (await runtime.host.getWebSearchCapabilityStatus()).available,
              dynamicCreation: false,
              developmentShell: false,
              unrestrictedFileAccess: false,
            }
          : parsed.capabilities
      await assertAuxiliaryImageModel(runtime, parsed.imagePolicy)
      const content: AgentRevisionContent = {
        displayName: parsed.displayName,
        persona: parsed.persona,
        ...(parsed.personaDocument === undefined ? {} : { personaDocument: parsed.personaDocument }),
        model: {
          provider: parsed.model.provider,
          model: parsed.model.model,
          ...(parsed.model.reasoningEffort === undefined ? {} : { reasoningEffort: parsed.model.reasoningEffort }),
        },
        capabilities: defaultCapabilities,
        ...(parsed.imagePolicy === undefined ? {} : { imagePolicy: parsed.imagePolicy }),
        ...(parsed.dynamicClientApprovalPolicy === undefined
          ? {}
          : { dynamicClientApprovalPolicy: parsed.dynamicClientApprovalPolicy }),
      }
      const entity = await runtime.createAgentWithWebChannel(content)
      writeJson(
        res,
        201,
        HostApiContracts.createAgent.parseResponse({
          agentId: entity.agentId,
          channelId: entity.channelId,
          connectionId: entity.connectionId,
        }),
      )
    },
  })

  // POST /api/agents/:id/{capabilities,revision} → create a new immutable AgentRevision.
  registerRoute({
    kind: 'prefix',
    path: '/api/agents',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (/^\/api\/agents\/[^/]+\/extensions\/[^/]+\/activation$/u.test(url.pathname)) {
        await handleExtensionActivationRoute(req, res)
        return
      }
      const deleteMatch = /^\/api\/agents\/([^/]+)$/.exec(url.pathname)
      if (deleteMatch) {
        if (req.method !== 'DELETE') {
          writeError(res, 405, 'method-not-allowed', '删除智能体只支持 DELETE。')
          return
        }
        let agentId: AgentId
        try {
          agentId = AgentIdSchema.parse(decodeURIComponent(deleteMatch[1] ?? ''))
        } catch {
          writeError(res, 400, 'invalid-agent', '无效的智能体 ID。')
          return
        }
        try {
          const parsed = HostApiContracts.deleteAgent.parseRequest(await readJsonBody(req))
          const current = runtime.repository.getAgent(agentId)
          if (!current) {
            writeError(res, 404, 'not-found', '智能体不存在或已被删除。')
            return
          }
          if (parsed.expectedCurrentRevisionId !== current.revision.id) {
            writeError(res, 409, 'revision-conflict', '智能体配置已在其他位置更新，请刷新后重试。')
            return
          }
          if (parsed.confirmationName !== current.revision.displayName) {
            writeError(res, 400, 'confirmation-mismatch', '输入的智能体名称不匹配。')
            return
          }
          const { unboundChannelIds, deletedChannelIds } = await runtime.deleteAgent(agentId, {
            deleteAutoCreatedBuiltInChannels: parsed.deleteAutoCreatedBuiltInChannels,
          })
          writeContractJson(res, 200, HostApiContracts.deleteAgent, {
            agentId,
            deleted: true,
            unboundChannelIds,
            deletedChannelIds,
          })
          broadcastExtensionsChanged()
        } catch (error) {
          writeError(res, 400, 'agent-delete-failed', error instanceof Error ? error.message : String(error))
        }
        return
      }
      const match = /^\/api\/agents\/([^/]+)\/(capabilities|revision)$/.exec(url.pathname)
      if (!match) {
        writeError(res, 404, 'not-found', `未定义路由：${req.method} ${url.pathname}。`)
        return
      }
      if (req.method !== 'POST') {
        writeError(res, 405, 'method-not-allowed', '只支持 POST。')
        return
      }
      const encodedAgentId = match[1]
      if (encodedAgentId === undefined) {
        writeError(res, 404, 'not-found', `未定义路由：${req.method} ${url.pathname}。`)
        return
      }
      const action = match[2]
      if (action === undefined) {
        writeError(res, 404, 'not-found', `未定义路由：${req.method} ${url.pathname}。`)
        return
      }
      let agentId: AgentId
      try {
        agentId = AgentIdSchema.parse(decodeURIComponent(encodedAgentId))
      } catch {
        writeError(res, 400, 'invalid-agent', '无效的智能体 ID。')
        return
      }
      try {
        const commit = runtime.repository.getAgent(agentId)
        if (!commit) {
          writeError(res, 404, 'not-found', '智能体不存在。')
          return
        }
        const revision = commit.revision
        if (action === 'revision') {
          const parsed = HostApiContracts.reviseAgent.parseRequest(await readJsonBody(req))
          if (parsed.expectedCurrentRevisionId !== revision.id) {
            writeError(res, 409, 'revision-conflict', '智能体配置已在其他位置更新，请刷新后重试。')
            return
          }
          await assertAuxiliaryImageModel(runtime, parsed.imagePolicy)
          const updated = runtime.core.reviseAgent(agentId, revision.id, {
            displayName: parsed.displayName,
            persona: parsed.persona,
            ...(parsed.personaDocument === undefined ? {} : { personaDocument: parsed.personaDocument }),
            model: {
              provider: parsed.model.provider,
              model: parsed.model.model,
              ...(parsed.model.reasoningEffort === undefined ? {} : { reasoningEffort: parsed.model.reasoningEffort }),
            },
            capabilities: revision.capabilities,
            imagePolicy: parsed.imagePolicy ?? revision.imagePolicy,
            dynamicClientApprovalPolicy: parsed.dynamicClientApprovalPolicy ?? revision.dynamicClientApprovalPolicy,
          })
          writeJson(res, 200, HostApiContracts.reviseAgent.parseResponse({ currentRevisionId: updated.revision.id }))
          return
        }
        if (action !== 'capabilities') {
          writeError(res, 404, 'not-found', `未定义路由：${req.method} ${url.pathname}。`)
          return
        }
        const parsed = HostApiContracts.updateAgentCapabilities.parseRequest(await readJsonBody(req))
        const capabilities = {
          ...revision.capabilities,
          ...(parsed.subagents === undefined ? {} : { subagents: parsed.subagents }),
          ...(parsed.fileTools === undefined ? {} : { fileTools: parsed.fileTools }),
          ...(parsed.webSearch === undefined ? {} : { webSearch: parsed.webSearch }),
          ...(parsed.dynamicCreation === undefined ? {} : { dynamicCreation: parsed.dynamicCreation }),
          ...(parsed.developmentShell === undefined ? {} : { developmentShell: parsed.developmentShell }),
          ...(parsed.unrestrictedFileAccess === undefined
            ? {}
            : { unrestrictedFileAccess: parsed.unrestrictedFileAccess }),
        }
        const updated = runtime.core.reviseAgent(agentId, revision.id, {
          displayName: revision.displayName,
          persona: revision.persona,
          personaDocument: revision.personaDocument,
          model: revision.model,
          capabilities,
          imagePolicy: revision.imagePolicy,
          dynamicClientApprovalPolicy: revision.dynamicClientApprovalPolicy,
        })
        writeJson(
          res,
          200,
          HostApiContracts.updateAgentCapabilities.parseResponse({
            currentRevisionId: updated.revision.id,
            capabilities: updated.revision.capabilities,
          }),
        )
      } catch (error) {
        writeError(res, 400, 'revision-failed', error instanceof Error ? error.message : String(error))
      }
    },
  })

  // Channel history, local display name, controlled Assets, and Web inbound.
  registerRoute({
    kind: 'prefix',
    path: '/api/channels',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname === '/api/channels') {
        if (req.method !== 'POST') {
          writeError(res, 405, 'method-not-allowed', '只支持 POST。')
          return
        }
        try {
          const parsed = HostApiContracts.createWebChannel.parseRequest(await readJsonBody(req))
          const channel = runtime.core.createChannel({
            connectionId: runtime.webConnectionId,
            platformChannelId: `web-channel-${crypto.randomUUID()}`,
            kind: 'web',
            displayName: parsed.displayName,
          })
          writeJson(
            res,
            201,
            HostApiContracts.createWebChannel.parseResponse({
              channelId: channel.id,
              connectionId: channel.connectionId,
            }),
          )
        } catch (error) {
          writeError(res, 400, 'channel-create-failed', error instanceof Error ? error.message : String(error))
        }
        return
      }
      const messageMatch = /^\/api\/channels\/([^/]+)\/messages$/.exec(url.pathname)
      const nameMatch = /^\/api\/channels\/([^/]+)\/display-name$/.exec(url.pathname)
      const runtimeMatch = /^\/api\/channels\/([^/]+)\/runtime$/.exec(url.pathname)
      const contextResetMatch = /^\/api\/channels\/([^/]+)\/context-reset$/.exec(url.pathname)
      const assetMatch = /^\/api\/channels\/([^/]+)\/assets\/([^/]+)$/.exec(url.pathname)
      const channelMatch = /^\/api\/channels\/([^/]+)$/.exec(url.pathname)
      const rawChannelId =
        messageMatch?.[1] ??
        nameMatch?.[1] ??
        runtimeMatch?.[1] ??
        contextResetMatch?.[1] ??
        assetMatch?.[1] ??
        channelMatch?.[1]
      if (!rawChannelId) {
        writeError(res, 404, 'not-found', `未定义路由：${req.method} ${url.pathname}。`)
        return
      }

      let typedChannelId: ChannelId
      try {
        typedChannelId = ChannelIdSchema.parse(decodeURIComponent(rawChannelId))
      } catch {
        writeError(res, 400, 'invalid-channel', '无效的频道 ID。')
        return
      }

      if (channelMatch) {
        if (req.method !== 'DELETE') {
          writeError(res, 405, 'method-not-allowed', '删除频道只支持 DELETE。')
          return
        }
        try {
          const parsed = HostApiContracts.deleteChannel.parseRequest(await readJsonBody(req))
          const channel = runtime.repository.getChannel(typedChannelId)
          if (!channel) {
            writeError(res, 404, 'not-found', '频道不存在或已被删除。')
            return
          }
          const actualBoundAgentId = runtime.repository.getBinding(typedChannelId)?.agentId ?? null
          if (parsed.expectedBoundAgentId !== actualBoundAgentId) {
            writeError(res, 409, 'binding-conflict', '频道绑定已发生变化，请刷新后重试。')
            return
          }
          await runtime.channels.deleteChannel(typedChannelId)
          writeContractJson(res, 200, HostApiContracts.deleteChannel, { channelId: typedChannelId, deleted: true })
        } catch (error) {
          writeError(res, 400, 'channel-delete-failed', error instanceof Error ? error.message : String(error))
        }
        return
      }

      if (runtimeMatch) {
        if (req.method !== 'GET') {
          writeError(res, 405, 'method-not-allowed', '只支持 GET。')
          return
        }
        try {
          writeContractJson(
            res,
            200,
            HostApiContracts.getChannelRuntime,
            assembleChannelRuntime(runtime, typedChannelId),
          )
        } catch (error) {
          writeError(res, 404, 'channel-runtime-missing', error instanceof Error ? error.message : String(error))
        }
        return
      }

      if (contextResetMatch) {
        if (req.method !== 'POST') {
          writeError(res, 405, 'method-not-allowed', '上下文操作只支持 POST。')
          return
        }
        try {
          const parsed = HostApiContracts.resetChannelContext.parseRequest(await readJsonBody(req))
          const binding = runtime.repository.getBinding(typedChannelId)
          if (!binding) {
            writeError(res, 409, 'channel-unbound', '频道尚未绑定智能体，无法重置上下文。')
            return
          }
          const episode = runtime.repository.getActiveEpisode(typedChannelId, binding.agentId)
          if (!episode) {
            writeError(res, 409, 'episode-missing', '频道当前没有可重置的上下文。')
            return
          }
          if (parsed.expectedEpisodeId !== episode.id) {
            writeError(res, 409, 'episode-conflict', '频道上下文已发生变化，请刷新后重试。')
            return
          }
          const result = await runtime.channels.resetEpisode(episode.id, parsed.mode)
          writeContractJson(res, 200, HostApiContracts.resetChannelContext, {
            mode: result.mode,
            closedEpisodeId: result.closedEpisode.id,
            ...(result.nextEpisode === undefined ? {} : { nextEpisodeId: result.nextEpisode.id }),
          })
        } catch (error) {
          writeError(res, 400, 'context-reset-failed', error instanceof Error ? error.message : String(error))
        }
        return
      }

      if (assetMatch) {
        if (req.method !== 'GET') {
          writeError(res, 405, 'method-not-allowed', '只支持 GET。')
          return
        }
        const encodedAssetId = assetMatch[2]
        if (encodedAssetId === undefined) {
          writeError(res, 404, 'not-found', `未定义路由：${req.method} ${url.pathname}。`)
          return
        }
        let assetId: ReturnType<typeof AssetIdSchema.parse>
        try {
          assetId = AssetIdSchema.parse(decodeURIComponent(encodedAssetId))
        } catch {
          writeError(res, 400, 'invalid-asset', '无效的资源 ID。')
          return
        }
        if (!runtime.repository.canAccessAsset(assetId, typedChannelId)) {
          writeError(res, 404, 'asset-not-found', '当前频道无法访问此资源。')
          return
        }
        const asset = runtime.repository.getAssetById(assetId)
        if (!asset) {
          writeError(res, 404, 'asset-not-found', '资源尚不可用。')
          return
        }
        try {
          const bytes = await readFile(runtime.assetService.blobPath(asset))
          res.writeHead(200, {
            'content-type': asset.mediaType,
            'content-length': String(bytes.byteLength),
            'cache-control': 'private, max-age=31536000, immutable',
            'x-content-type-options': 'nosniff',
          })
          res.end(bytes)
        } catch (error) {
          writeError(res, 500, 'asset-read-failed', error instanceof Error ? error.message : String(error))
        }
        return
      }

      if (nameMatch) {
        if (req.method !== 'POST') {
          writeError(res, 405, 'method-not-allowed', '只支持 POST。')
          return
        }
        try {
          HostApiContracts.renameChannel.parseParams({ channelId: typedChannelId })
          const body = HostApiContracts.renameChannel.parseRequest(await readJsonBody(req))
          const updated = runtime.core.updateChannelDisplayName(typedChannelId, body.displayName)
          writeContractJson(res, 200, HostApiContracts.renameChannel, {
            channelId: updated.id,
            displayName: updated.displayName,
          })
        } catch (error) {
          writeError(res, 400, 'channel-name-failed', error instanceof Error ? error.message : String(error))
        }
        return
      }

      if (req.method === 'GET') {
        let params: ReturnType<typeof HostApiContracts.listChannelMessages.parseParams>
        try {
          const beforeOccurredAt = url.searchParams.get('beforeOccurredAt')
          const beforeSourceId = url.searchParams.get('beforeSourceId')
          params = HostApiContracts.listChannelMessages.parseParams({
            channelId: typedChannelId,
            limit: Number(url.searchParams.get('limit') ?? 16),
            ...(beforeOccurredAt === null ? {} : { beforeOccurredAt: Number(beforeOccurredAt) }),
            ...(beforeSourceId === null ? {} : { beforeSourceId }),
          })
        } catch (error) {
          writeError(res, 400, 'invalid-history-query', error instanceof Error ? error.message : String(error))
          return
        }
        const before =
          params.beforeOccurredAt === undefined || params.beforeSourceId === undefined
            ? undefined
            : { occurredAt: params.beforeOccurredAt, sourceId: params.beforeSourceId }
        const page = buildSnapshotMessage(runtime, typedChannelId, {
          limit: params.limit + 1,
          ...(before === undefined ? {} : { before }),
        })
        const hasMore = page.length > params.limit
        // buildSnapshotMessage exposes oldest-first. The extra row is therefore
        // the oldest candidate, not the newest message at the end of the page.
        const messages = hasMore ? page.slice(-params.limit) : page
        writeContractJson(res, 200, HostApiContracts.listChannelMessages, { messages, hasMore })
        return
      }
      if (req.method !== 'POST') {
        writeError(res, 405, 'method-not-allowed', '只支持 GET 或 POST。')
        return
      }
      let parsed: ReturnType<typeof HostApiContracts.sendChannelMessage.parseRequest>
      try {
        parsed = HostApiContracts.sendChannelMessage.parseRequest(await readJsonBody(req))
      } catch (error) {
        writeError(res, 400, 'invalid-request', error instanceof Error ? error.message : String(error))
        return
      }
      try {
        const channel = runtime.repository.getChannel(typedChannelId)
        if (!channel) {
          writeError(res, 404, 'not-found', '频道不存在。')
          return
        }
        if (channel.kind === 'web') {
          const result = await runtime.web.postMessage({
            channelId: typedChannelId,
            clientEventId: parsed.clientEventId ?? `http-${Date.now()}`,
            parts: parsed.parts,
            ...(parsed.senderMemberId === undefined ? {} : { senderMemberId: parsed.senderMemberId }),
          })
          writeJson(
            res,
            200,
            HostApiContracts.sendChannelMessage.parseResponse({
              channelEventId: result.channelEventId,
              inserted: result.inserted,
            }),
          )
          return
        }
        const binding = runtime.repository.getBinding(typedChannelId)
        if (!binding) {
          writeError(res, 400, 'unbound-channel', '这个频道尚未绑定智能体，无法确定由谁的机器人账号发言。')
          return
        }
        const connection = runtime.repository.getConnection(channel.connectionId)
        if (!connection || runtime.connectionCapabilities(connection.id)?.proactiveSend !== true) {
          writeError(res, 400, 'proactive-send-disabled', '这个平台连接不允许主动发言。请在连接配置中打开主动发送。')
          return
        }
        await runtime.channels.sendAdminConsoleMessage({
          channelId: typedChannelId,
          parts: parsed.parts,
          ...(parsed.clientEventId === undefined ? {} : { clientRequestId: parsed.clientEventId }),
        })
        writeJson(
          res,
          200,
          HostApiContracts.sendChannelMessage.parseResponse({
            inserted: true,
          }),
        )
      } catch (error) {
        writeError(res, 400, 'send-failed', error instanceof Error ? error.message : String(error))
      }
    },
  })

  // POST /api/connections → create through the selected user-creatable Adapter contribution.
  registerRoute({
    kind: 'exact',
    path: '/api/connections',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        writeError(res, 405, 'method-not-allowed', '只支持 POST。')
        return
      }
      let parsed: ReturnType<typeof HostApiContracts.createConnection.parseRequest>
      try {
        parsed = HostApiContracts.createConnection.parseRequest(await readJsonBody(req))
      } catch (error) {
        writeError(res, 400, 'invalid-request', error instanceof Error ? error.message : String(error))
        return
      }
      try {
        // Secret 由 Host 按 Adapter schema 写入凭据存储；Core 只接收不可猜测引用。
        const connection = await runtime.createConnection(parsed)
        writeJson(
          res,
          201,
          HostApiContracts.createConnection.parseResponse({
            connectionId: connection.id,
            adapterKey: connection.adapterKey,
          }),
        )
      } catch (error) {
        writeError(res, 400, 'connection-failed', error instanceof Error ? error.message : String(error))
      }
    },
  })

  // POST /api/connections/:id/test → honest send/receive diagnostics.
  registerRoute({
    kind: 'prefix',
    path: '/api/connections',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const aliasMatch = /^\/api\/connections\/([^/]+)\/alias$/.exec(url.pathname)
      if (aliasMatch) {
        if (req.method !== 'POST') {
          writeError(res, 405, 'method-not-allowed', '只支持 POST。')
          return
        }
        const encodedConnectionId = aliasMatch[1]
        if (encodedConnectionId === undefined) {
          writeError(res, 404, 'not-found', `未定义路由：${req.method} ${url.pathname}。`)
          return
        }
        let connectionId: ReturnType<typeof ConnectionIdSchema.parse>
        try {
          connectionId = ConnectionIdSchema.parse(decodeURIComponent(encodedConnectionId))
        } catch {
          writeError(res, 400, 'invalid-connection', '无效的连接 ID。')
          return
        }
        try {
          const params = HostApiContracts.updateConnectionAlias.parseParams({ connectionId })
          const body = HostApiContracts.updateConnectionAlias.parseRequest(await readJsonBody(req))
          const updated = runtime.updateConnectionAlias(params.connectionId, body.alias)
          writeContractJson(res, 200, HostApiContracts.updateConnectionAlias, {
            connectionId: updated.id,
            ...(updated.alias === undefined ? {} : { alias: updated.alias }),
          })
        } catch (error) {
          writeError(res, 400, 'connection-alias-failed', error instanceof Error ? error.message : String(error))
        }
        return
      }
      const match = /^\/api\/connections\/([^/]+)\/test$/.exec(url.pathname)
      if (!match) {
        writeError(res, 404, 'not-found', `未定义路由：${req.method} ${url.pathname}。`)
        return
      }
      if (req.method !== 'POST') {
        writeError(res, 405, 'method-not-allowed', '只支持 POST。')
        return
      }
      const encodedConnectionId = match[1]
      if (encodedConnectionId === undefined) {
        writeError(res, 404, 'not-found', `未定义路由：${req.method} ${url.pathname}。`)
        return
      }
      let connectionId: ReturnType<typeof ConnectionIdSchema.parse>
      try {
        connectionId = ConnectionIdSchema.parse(decodeURIComponent(encodedConnectionId))
      } catch {
        writeError(res, 400, 'invalid-connection', '无效的连接 ID。')
        return
      }
      let parsed: ReturnType<typeof HostApiContracts.testConnection.parseRequest>
      try {
        parsed = HostApiContracts.testConnection.parseRequest(await readJsonBody(req))
      } catch (error) {
        writeError(res, 400, 'invalid-request', error instanceof Error ? error.message : String(error))
        return
      }
      const connection = runtime.core.listConnections().find((candidate) => candidate.id === connectionId)
      if (!connection) {
        writeError(res, 404, 'not-found', '连接不存在。')
        return
      }
      writeContractJson(
        res,
        200,
        HostApiContracts.testConnection,
        await runtime.testConnection(connection.id, parsed.direction, parsed.channelId),
      )
    },
  })

  const unsubscribeConnectionChanges = runtime.subscribeConnectionChanges(() => {
    broadcast({ event: 'status', data: { ok: true, message: '连接状态已更新' } })
  })
  const unsubscribeRuntimeStatus = runtime.host.subscribeRuntimeStatus(() => {
    broadcast({ event: 'status', data: { ok: true, message: '智能体运行状态已更新' } })
  })
  const unsubscribeChannelRuntime = runtime.host.subscribeChannelRuntime((channelId) => {
    if (!runtime.repository.getChannel(channelId)) return
    const projection = assembleChannelRuntime(runtime, channelId)
    const revision = nextRevision(runtimeRevision, channelId)
    const data = { ...projection, revision }
    broadcast({
      event: 'runtime',
      data:
        Buffer.byteLength(JSON.stringify(data), 'utf8') > SSE_RUNTIME_FRAME_BUDGET
          ? { ...projection, turns: [], revision, truncated: true }
          : data,
    })
  })
  const unsubscribeDshSettings = runtime.host.onDshSettingsChanged((namespace, revision) => {
    broadcast({
      event: 'dsh-settings-changed',
      data: DshSettingsChangedSseDataSchema.parse({ namespace, revision }),
    })
  })
  const unsubscribeDshCredentials = runtime.host.onDshCredentialChanged((ref) => {
    broadcast({
      event: 'dsh-credentials-changed',
      data: DshCredentialsChangedSseDataSchema.parse({ ref }),
    })
  })

  // POST /api/dynamic/:agentId/{approve|decline|invoke|report-render-failure} →
  // browser dynamic client circuit (creator workbench): resolve approvals and
  // invoke Host halves against the Agent's live Session.
  registerRoute({
    kind: 'prefix',
    path: '/api/dynamic',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const match =
        /^\/api\/dynamic\/([^/]+)\/(inventory|approve|decline|invoke|get-client-code|report-render-failure|report-guard-failure|report-client-verification|run-host-half|settle-user-run)$/.exec(
          url.pathname,
        )
      if (!match) {
        writeError(res, 404, 'not-found', `未定义路由：${req.method} ${url.pathname}。`)
        return
      }
      if (req.method !== 'POST') {
        writeError(res, 405, 'method-not-allowed', '只支持 POST。')
        return
      }
      const encodedAgentId = match[1]
      const action = match[2]
      if (encodedAgentId === undefined || action === undefined) {
        writeError(res, 404, 'not-found', `未定义路由：${req.method} ${url.pathname}。`)
        return
      }
      let agentId: AgentId
      try {
        agentId = AgentIdSchema.parse(decodeURIComponent(encodedAgentId))
      } catch {
        writeError(res, 400, 'invalid-agent', '无效的智能体 ID。')
        return
      }
      let body: unknown
      try {
        body = await readJsonBody(req)
      } catch (error) {
        writeError(res, 400, 'invalid-request', error instanceof Error ? error.message : String(error))
        return
      }
      let dshSessionId: string
      try {
        const episodeId = EpisodeIdSchema.parse(
          typeof body === 'object' && body !== null && !Array.isArray(body)
            ? Reflect.get(body, 'episodeId')
            : undefined,
        )
        dshSessionId = resolveEpisodeSession(runtime, agentId, episodeId)
      } catch (error) {
        writeError(res, 400, 'no-session', error instanceof Error ? error.message : String(error))
        return
      }
      if (action === 'inventory') {
        HostApiContracts.dynamicInventory.parseRequest(body)
        writeJson(
          res,
          200,
          HostApiContracts.dynamicInventory.parseResponse({ rows: runtime.host.dynamicInventory(dshSessionId) }),
        )
        return
      }
      if (action === 'approve' || action === 'decline') {
        const contract = action === 'approve' ? HostApiContracts.dynamicApprove : HostApiContracts.dynamicDecline
        const parsed = contract.parseRequest(body)
        try {
          const pending = runtime.host
            .dynamicInventory(dshSessionId)
            .find((row) => row.latestRun?.approvalRequestId === parsed.requestId)?.latestRun
          if (action === 'approve' && pending === undefined) {
            throw new Error('指定批准请求不属于该智能体的活动会话。')
          }
          if (parsed.pluginRunId !== undefined && pending?.pluginRunId !== parsed.pluginRunId) {
            throw new Error('批准请求与动态运行不匹配。')
          }
          let resolution: DynamicRunResolution
          if (action === 'approve') {
            if (pending === undefined) throw new Error('指定批准请求不属于该智能体的活动会话。')
            resolution = { ok: true, pluginRunId: pending.pluginRunId }
          } else {
            resolution = { ok: false, reason: 'rejected' }
          }
          const ack = await runtime.host.resolveDynamicRunRequest(dshSessionId, parsed.requestId, resolution)
          writeJson(res, 200, contract.parseResponse({ accepted: ack.accepted }))
          broadcast({ event: 'dynamic-changed', data: { agentId } })
        } catch (error) {
          writeError(res, 400, 'dynamic-operation-failed', error instanceof Error ? error.message : String(error))
        }
        return
      }
      if (action === 'invoke') {
        const parsed = HostApiContracts.dynamicInvoke.parseRequest(body)
        try {
          const result = await runtime.host.invokeDynamicHost(
            dshSessionId,
            parsed.pluginId,
            parsed.pluginRunId,
            parsed.method,
            parsed.args,
          )
          writeJson(
            res,
            200,
            HostApiContracts.dynamicInvoke.parseResponse({
              ok: result.ok,
              ...(result.ok ? { value: result.value } : { message: result.message }),
            }),
          )
        } catch (error) {
          writeError(res, 400, 'dynamic-invoke-failed', error instanceof Error ? error.message : String(error))
        }
        return
      }
      if (action === 'run-host-half') {
        const parsed = HostApiContracts.dynamicRunHostHalf.parseRequest(body)
        try {
          const result = await runtime.host.runDynamicHostHalf(
            dshSessionId,
            parsed.pluginId,
            parsed.packageId,
            parsed.mode,
            parsed.requestId ?? null,
            parsed.approveFutureVersions,
          )
          writeJson(res, 200, HostApiContracts.dynamicRunHostHalf.parseResponse(result))
          broadcast({ event: 'dynamic-changed', data: { agentId } })
        } catch (error) {
          writeError(res, 400, 'dynamic-host-half-failed', error instanceof Error ? error.message : String(error))
        }
        return
      }
      if (action === 'settle-user-run') {
        const parsed = HostApiContracts.dynamicSettleUserRun.parseRequest(body)
        try {
          const result = await runtime.host.settleDynamicUserRun(
            dshSessionId,
            parsed.pluginId,
            normalizeDynamicResolution(runtime, dshSessionId, parsed.resolution),
          )
          writeJson(res, 200, HostApiContracts.dynamicSettleUserRun.parseResponse(result))
          broadcast({ event: 'dynamic-changed', data: { agentId } })
        } catch (error) {
          writeError(res, 400, 'dynamic-settle-failed', error instanceof Error ? error.message : String(error))
        }
        return
      }
      if (action === 'get-client-code') {
        const parsed = HostApiContracts.dynamicGetClientCode.parseRequest(body)
        try {
          const client = runtime.host.getDynamicClientCode(dshSessionId, parsed.pluginId, parsed.pluginRunId)
          writeJson(
            res,
            200,
            HostApiContracts.dynamicGetClientCode.parseResponse({
              pluginId: client.pluginId,
              packageId: client.packageId,
              pluginRunId: client.pluginRunId,
              name: client.name,
              code: client.code,
            }),
          )
        } catch (error) {
          writeError(res, 400, 'dynamic-client-code-failed', error instanceof Error ? error.message : String(error))
        }
        return
      }
      if (action === 'report-render-failure') {
        const parsed = HostApiContracts.dynamicReportRenderFailure.parseRequest(body)
        try {
          await runtime.host.reportDynamicRenderFailure(dshSessionId, parsed.pluginId, parsed.pluginRunId, {
            slot: parsed.failure.slot,
            message: parsed.failure.message,
            abdicated: parsed.failure.abdicated,
            ...(parsed.failure.stack === undefined ? {} : { stack: parsed.failure.stack }),
          })
          writeJson(res, 200, HostApiContracts.dynamicReportRenderFailure.parseResponse({ ok: true }))
          broadcast({ event: 'dynamic-changed', data: { agentId } })
        } catch (error) {
          writeError(res, 400, 'dynamic-render-failure', error instanceof Error ? error.message : String(error))
        }
        return
      }
      if (action === 'report-client-verification') {
        const parsed = HostApiContracts.dynamicReportClientVerification.parseRequest(body)
        try {
          runtime.host.recordDynamicClientVerification(
            dshSessionId,
            parsed.pluginId,
            parsed.packageId,
            parsed.pluginRunId,
            parsed.renderedSlots,
            parsed.renderedHostSlots,
            parsed.renderedPages,
            parsed.permissions,
          )
          writeJson(res, 200, HostApiContracts.dynamicReportClientVerification.parseResponse({ ok: true }))
        } catch (error) {
          writeError(res, 400, 'dynamic-client-verification', error instanceof Error ? error.message : String(error))
        }
        return
      }
      if (action === 'report-guard-failure') {
        const parsed = HostApiContracts.dynamicReportGuardFailure.parseRequest(body)
        try {
          await runtime.host.reportDynamicGuardFailure(dshSessionId, parsed.pluginId, parsed.pluginRunId, {
            message: parsed.message,
            ...(parsed.stack === undefined ? {} : { stack: parsed.stack }),
          })
          writeJson(res, 200, HostApiContracts.dynamicReportGuardFailure.parseResponse({ ok: true }))
        } catch (error) {
          writeError(res, 400, 'dynamic-guard-failure', error instanceof Error ? error.message : String(error))
        }
        return
      }
      writeError(res, 501, 'not-implemented', '该动态操作尚未开放。')
    },
  })

  // POST /api/extensions/save-from-dynamic → save a running dynamic Package as a
  // persistent local Extension Revision (M4: 保存不自动启用).
  registerRoute({
    kind: 'exact',
    path: '/api/extensions/save-from-dynamic',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        writeError(res, 405, 'method-not-allowed', '只支持 POST。')
        return
      }
      let parsed: ReturnType<typeof HostApiContracts.saveExtensionFromDynamic.parseRequest>
      try {
        parsed = HostApiContracts.saveExtensionFromDynamic.parseRequest(await readJsonBody(req))
      } catch (error) {
        writeError(res, 400, 'invalid-request', error instanceof Error ? error.message : String(error))
        return
      }
      try {
        const saved = await saveActiveDynamicPackage(runtime, parsed)
        writeJson(
          res,
          200,
          HostApiContracts.saveExtensionFromDynamic.parseResponse({
            extensionId: saved.extension.id,
            revisionId: saved.revision.id,
            activation: 'inactive',
            ...(runtime.repository.getExtensionRevisionVerification(saved.revision.id)?.scope === 'host-adapter'
              ? { installation: 'uninstalled' as const }
              : {}),
          }),
        )
      } catch (error) {
        writeError(res, 400, 'save-failed', error instanceof Error ? error.message : String(error))
      }
    },
  })

  // Catch-all under /api: slice-2 endpoints (QQ Connection, Extension save &
  // capability changes) return 501 this round.
  registerRoute({
    kind: 'prefix',
    path: '/api',
    handler: (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      writeError(res, 501, 'not-implemented', `API 端点 ${req.method} ${url.pathname} 尚未实现。`)
    },
  })

  return {
    get port() {
      return webServer.port
    },
    dispose() {
      if (factTimer !== undefined) clearTimeout(factTimer)
      pendingFacts.clear()
      pendingExtensionImports.clear()
      pendingHostUiCredentials.clear()
      unsubscribeConnectionChanges()
      unsubscribeRuntimeStatus()
      unsubscribeChannelRuntime()
      unsubscribeDshSettings()
      unsubscribeDshCredentials()
      for (const disposer of disposers.splice(0)) disposer()
    },
  }
}
