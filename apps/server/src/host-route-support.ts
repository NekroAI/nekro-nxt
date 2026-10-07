import { extensionManifestSchema } from '@nekro-nxt/extension-runtime'
import type { HostApiResponse, DshPluginPackageIdSchema, EpisodeIdSchema } from '@nekro-nxt/contracts'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { isAdminConsoleOutbound, type ChannelFact, type ChannelHistoryEntry } from '@nekro-nxt/channel-runtime'
import {
  ChannelEventIdSchema,
  DshNxtHostUiSchema,
  ExtensionIdSchema,
  type ExtensionRevisionIdSchema,
  HostApiContracts,
  HostApiErrorSchema,
  HostPageContributionSchema,
  OutboundIntentIdSchema,
  parseJsonValue,
  type AgentId,
  type ChannelId,
  type HostApiContract,
  type HostConnectionEvent,
  type HostSnapshotMessage,
  type HostSseEvent,
} from '@nekro-nxt/contracts'
import type { ConnectionEventRecord, ImageUnderstandingPolicy } from '@nekro-nxt/core'
import { strFromU8, strToU8, zipSync } from 'fflate'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { z } from 'zod'
import type { NekroRuntime } from './bootstrap.js'
import type { ExtensionImportStaging } from './extension-import-staging.js'
import type { WorkspaceProjections } from './workspace-projections.js'
import { unzipTransferArchive } from '@nekro-nxt/extension-format'

export {
  assertSafeArchivePath,
  assertZipHasNoLinksOrDuplicates,
  extensionTransferManifestSchema,
  parseExtensionImport,
  unzipTransferArchive,
  type ParsedExtensionImport,
} from '@nekro-nxt/extension-format'
export interface HostRouteContext {
  readonly readCursor: () => HostApiResponse<'snapshot'>['cursor']
  readonly runtime: NekroRuntime
  readonly registerRoute: (route: WebRoute) => void
  readonly broadcast: (event: HostSseEvent) => void
  readonly broadcastExtensionsChanged: () => void
  readonly projections: WorkspaceProjections
  readonly extensionImports: ExtensionImportStaging
}
export const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024

export const HOST_UI_PRODUCT_MUTATIONS = new Set([
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

export const readJsonBody = (req: IncomingMessage): Promise<unknown> =>
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

export const readBinaryBody = (req: IncomingMessage, maxBytes: number): Promise<Uint8Array> =>
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

export const writeJson = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

export const writeDownload = (res: ServerResponse, filename: string, body: Uint8Array): void => {
  res.writeHead(200, {
    'content-type': 'application/vnd.nekro-nxt.extension+zip',
    'content-length': String(body.byteLength),
    'content-disposition': `attachment; filename="${filename.replaceAll(/[^a-zA-Z0-9._-]/gu, '-')}"`,
    'cache-control': 'no-store',
  })
  res.end(body)
}

export const dshPluginTransferManifestSchema = z
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

export const parseDshPluginTransfer = (
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

export const createExtensionRevisionExport = async (
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
  const resourceManifest = extensionManifestSchema.parse(JSON.parse(strFromU8(files['revision/manifest.json']!)))
  const resourcePaths = new Set<string>()
  if ('clientCss' in resourceManifest && resourceManifest.clientCss) resourcePaths.add(resourceManifest.clientCss.path)
  for (const contribution of 'contributions' in resourceManifest ? resourceManifest.contributions : []) {
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

export const createDshPluginExport = async (
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

export const writeError = (res: ServerResponse, status: number, code: string, message: string): void =>
  writeJson(res, status, HostApiErrorSchema.parse({ error: { code, message } }))

export const assertAuxiliaryImageModel = async (
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

export const writeContractJson = <Contract extends HostApiContract>(
  res: ServerResponse,
  status: number,
  contract: Contract,
  body: unknown,
): void => writeJson(res, status, contract.parseResponse(body))

export const parseMessagePartsRequestBody = (
  input: unknown,
): ReturnType<typeof HostApiContracts.sendChannelMessage.parseRequest> =>
  HostApiContracts.sendChannelMessage.parseRequest(input)

export const decorateMessageParts = (
  runtime: NekroRuntime,
  parts: ChannelHistoryEntry['parts'],
): HostSnapshotMessage['parts'] =>
  parts.map((part) => {
    if (part.type !== 'mention') return part
    const displayName = runtime.repository.getChannelMember(part.memberId)?.displayName
    return { ...part, ...(displayName === undefined ? {} : { displayName }) }
  })

const scheduledTaskFact = (
  facts: Extract<ChannelHistoryEntry, { source: 'channel-event' }>['facts'],
): HostSnapshotMessage['scheduledTask'] => {
  const job = facts?.['extensionJob']
  if (job === null || job === undefined || typeof job !== 'object' || Array.isArray(job)) return undefined
  const label = job['label']
  if (typeof label !== 'string') return undefined
  const extensionName = job['extensionName']
  const note = job['note']
  return {
    label,
    ...(typeof extensionName === 'string' ? { extensionName } : {}),
    ...(typeof note === 'string' ? { note } : {}),
  }
}

/** The responding agent's stored hook decision, only when it changed something or reported a problem. */
const inboundHookFact = (
  runtime: NekroRuntime,
  entry: Extract<ChannelHistoryEntry, { source: 'channel-event' }>,
): HostSnapshotMessage['inboundHook'] => {
  const agentId = runtime.repository.getBinding(entry.channelId)?.agentId
  if (agentId === undefined) return undefined
  const decision = runtime.repository.getInboundHookDecision(entry.sourceId, agentId)
  if (decision === undefined) return undefined
  const name = (extensionId: string) =>
    runtime.repository.getExtension(ExtensionIdSchema.parse(extensionId))?.displayName ?? '已删除的扩展'
  const problems = Array.isArray(decision.diagnostics)
    ? decision.diagnostics.flatMap((item) =>
        item !== null &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        typeof item['extensionId'] === 'string' &&
        typeof item['message'] === 'string'
          ? [`${name(item['extensionId'])}：${item['message']}`]
          : [],
      )
    : []
  if (decision.trigger === 'default' && !decision.hidden && decision.annotation === null && problems.length === 0) {
    return undefined
  }
  return {
    trigger: decision.trigger,
    hidden: decision.hidden,
    ...(decision.annotation === null ? {} : { annotation: decision.annotation }),
    extensions: decision.decidedBy.map(name),
    ...(problems.length === 0 ? {} : { problems }),
  }
}

export const projectHistoryEntry = (runtime: NekroRuntime, entry: ChannelHistoryEntry): HostSnapshotMessage => {
  const parts = decorateMessageParts(runtime, entry.parts)
  if (entry.source === 'channel-event') {
    const sender =
      entry.senderMemberId === undefined ? undefined : runtime.repository.getChannelMember(entry.senderMemberId)
    const scheduledTask = scheduledTaskFact(entry.facts)
    const inboundHook = scheduledTask === undefined ? inboundHookFact(runtime, entry) : undefined
    return {
      id: entry.sourceId,
      channelId: entry.channelId,
      role: entry.activityKey === undefined && scheduledTask === undefined ? 'member' : 'system',
      ...(scheduledTask === undefined ? {} : { scheduledTask }),
      ...(inboundHook === undefined ? {} : { inboundHook }),
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
      ...(entry.activityKey === undefined ? {} : { activityKey: entry.activityKey }),
      ...(entry.targetLogicalMessageId === undefined ? {} : { targetLogicalMessageId: entry.targetLogicalMessageId }),
      occurredAt: entry.occurredAt,
    }
  }
  const resolution = runtime.repository.projections.getLatestOutboundResolution(
    OutboundIntentIdSchema.parse(entry.sourceId),
  )
  return {
    id: entry.sourceId,
    channelId: entry.channelId,
    role: 'agent',
    parts,
    occurredAt: entry.occurredAt,
    deliveryState: entry.state,
    ...(resolution === undefined
      ? {}
      : { deliveryResolution: { action: resolution.action, resolvedAt: resolution.createdAt } }),
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
      ...(event.activityKey === undefined ? {} : { activityKey: event.activityKey }),
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

export const projectConnectionEvent = (runtime: NekroRuntime, event: ConnectionEventRecord): HostConnectionEvent => {
  const actor =
    event.actorIdentityId === undefined ? undefined : runtime.repository.getPlatformIdentity(event.actorIdentityId)
  const subject =
    event.subjectIdentityId === undefined ? undefined : runtime.repository.getPlatformIdentity(event.subjectIdentityId)
  return {
    id: event.id,
    connectionId: event.connectionId,
    activityKey: event.activityKey,
    summary: event.summary,
    ...(actor === undefined
      ? {}
      : {
          actor: {
            identityId: actor.id,
            ...(actor.displayName === undefined ? {} : { displayName: actor.displayName }),
          },
        }),
    ...(subject === undefined
      ? {}
      : {
          subject: {
            identityId: subject.id,
            ...(subject.displayName === undefined ? {} : { displayName: subject.displayName }),
          },
        }),
    occurredAt: event.sourceTimestamp,
  }
}

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

export const projectDshPlugins = (runtime: NekroRuntime) => [
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

export const resolveEpisodeSession = (
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

export type DynamicRunResolution = Parameters<NekroRuntime['host']['settleDynamicUserRun']>[2]

export const findDynamicPluginRunId = (runtime: NekroRuntime, dshSessionId: string, pluginRunId: string) => {
  for (const row of runtime.host.dynamicInventory(dshSessionId)) {
    if (row.activeRun?.pluginRunId === pluginRunId) return row.activeRun.pluginRunId
    if (row.latestRun?.pluginRunId === pluginRunId) return row.latestRun.pluginRunId
  }
  throw new Error('指定的动态运行不属于该智能体的活动会话。')
}

export const normalizeDynamicResolution = (
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
