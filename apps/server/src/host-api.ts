import type { WebServer, WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { isAdminConsoleOutbound, type ChannelFact, type ChannelHistoryEntry } from '@nekro-nxt/channel-runtime'
import type { AgentRevisionContent } from '@nekro-nxt/core'
import {
  AgentIdSchema,
  AssetIdSchema,
  ChannelEventIdSchema,
  ChannelIdSchema,
  ConnectionIdSchema,
  ExtensionIdSchema,
  OutboundIntentIdSchema,
  DshCredentialsChangedSseDataSchema,
  DshSettingsChangedSseDataSchema,
  HostApiErrorSchema,
  HostApiContracts,
  parseJsonValue,
  type AgentId,
  type ChannelId,
  type HostApiContract,
  type HostSnapshotMessage,
  type ChannelRuntimeProjection,
  type HostSseEvent,
} from '@nekro-nxt/contracts'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import type { NekroRuntime } from './bootstrap.js'
import { normalizeSessionEvents } from './channel-runtime-events.js'
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

const readJsonBody = (req: IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = []
    req.on('data', (chunk: Uint8Array) => chunks.push(chunk))
    req.on('end', () => {
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

const assembleChannelRuntime = (runtime: NekroRuntime, channelId: ChannelId): ChannelRuntimeProjection => {
  if (!runtime.repository.getChannel(channelId)) {
    throw new Error(`Unknown Channel: ${channelId}`)
  }
  const binding = runtime.core.listBindings(channelId)[0]
  if (!binding) return emptyChannelRuntimeProjection(channelId)
  const episode = runtime.repository.getActiveEpisode(channelId, binding.agentId)
  const pendingInjectCount = episode === undefined ? 0 : runtime.repository.listRecoverableAdmissions(episode.id).length
  const live = episode?.dshSessionId === undefined ? undefined : runtime.host.tryLiveSession(episode.dshSessionId)
  const occupancy =
    episode?.dshSessionId === undefined ? undefined : runtime.host.sessionOccupancy(episode.dshSessionId)
  return projectChannelRuntime({
    channelId,
    agentId: binding.agentId,
    ...(episode === undefined ? {} : { episodeId: episode.id }),
    sessionStatus: live?.status ?? 'missing',
    pendingInjectCount,
    ...(occupancy === undefined ? {} : { occupancy }),
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

const writeError = (res: ServerResponse, status: number, code: string, message: string): void =>
  writeJson(res, status, HostApiErrorSchema.parse({ error: { code, message } }))

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
      channelId: event.channelId,
      occurredAt: event.receivedAt,
      ...(event.senderMemberId === undefined ? {} : { senderMemberId: event.senderMemberId }),
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
  return runtime.repository.listExtensions().map((extension) => ({
    id: extension.id,
    slug: extension.slug,
    displayName: extension.displayName,
    description: extension.description,
    ...(extension.createdByAgentId === undefined ? {} : { createdByAgentId: extension.createdByAgentId }),
    revisions: runtime.repository.listExtensionRevisions(extension.id).map((revision) => ({
      id: revision.id,
      revisionNumber: revision.revisionNumber,
      createdAt: revision.createdAt,
    })),
    activations: activations
      .filter((activation) => activation.extensionId === extension.id)
      .map((activation) => ({
        agentId: activation.agentId,
        extensionRevisionId: activation.extensionRevisionId,
        config: activation.config,
        activatedAt: activation.activatedAt,
      })),
  }))
}

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
const resolveActiveSession = (runtime: NekroRuntime, agentId: AgentId): string => {
  const episode = runtime.repository
    .listActiveEpisodesForAgent(agentId)
    .find((candidate) => candidate.dshSessionId !== undefined)
  if (!episode?.dshSessionId) {
    throw new Error('该智能体没有活动会话。')
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
): Promise<{ readonly extension: { readonly id: string }; readonly revision: { readonly id: string } }> => {
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
  return runtime.extensionService.saveDynamicPackage({
    snapshot: {
      name: inspection.name,
      purpose: inspection.purpose,
      ...(inspection.code.host === undefined ? {} : { hostCode: inspection.code.host }),
      ...(inspection.code.client === undefined ? {} : { clientCode: inspection.code.client }),
    },
    slug: input.slug,
    displayName: input.displayName,
    description: input.description,
    createdByAgentId: input.agentId,
  })
}

export const createNekroHostApi = (webServer: WebServer, runtime: NekroRuntime): NekroHostApi => {
  const disposers: Array<() => void> = []

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
    const agents = agentCommits.map((commit) => {
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
        model: commit.revision.model,
        capabilities: commit.revision.capabilities,
        currentRevisionId: commit.revision.id,
        runtimeStatus: runtimePhase === 'thinking' || runtimePhase === 'using-tool' ? 'running' : 'idle',
        runtimePhase,
        createdAt: commit.revision.createdAt,
        channels: ownedChannels,
      }
    })
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
          boundAt: binding.boundAt,
        })),
      }
    })
    // Message history is loaded per Channel through its cursor endpoint. Keeping
    // it out of the global snapshot prevents every navigation from rereading
    // every Channel's history.
    const messages: HostSnapshotMessage[] = []
    const connections = runtime.core.listConnections().map((connection) => {
      const config = z
        .object({ appId: z.string().optional(), proactiveSend: z.boolean().optional() })
        .passthrough()
        .safeParse(connection.config)
      const diagnostic = runtime.connectionDiagnostic(connection.id)
      return {
        id: connection.id,
        adapterKey: connection.adapterKey,
        ...(connection.alias === undefined ? {} : { alias: connection.alias }),
        appId: config.success ? (config.data.appId ?? '') : '',
        proactiveSend: config.success && config.data.proactiveSend === true,
        credentialConfigured: connection.adapterKey === 'web' ? true : (diagnostic?.credentialConfigured ?? false),
        channelCount: runtime.core.listChannelsByConnection(connection.id).length,
        knownChannels: runtime.core.listChannelsByConnection(connection.id).map((channel) => ({
          id: channel.id,
          name: channel.displayName ?? channel.platformChannelId,
          kind: channel.kind,
        })),
        ...(diagnostic === undefined
          ? {}
          : {
              gateway: diagnostic.gateway,
              ...(diagnostic.lastInbound === undefined ? {} : { lastInbound: diagnostic.lastInbound }),
              ...(diagnostic.receiveTest === undefined ? {} : { receiveTest: diagnostic.receiveTest }),
              ...(diagnostic.sendTest === undefined ? {} : { sendTest: diagnostic.sendTest }),
            }),
      }
    })
    const webSearch = await runtime.host.getWebSearchCapabilityStatus()
    return HostApiContracts.snapshot.parseResponse({
      models: await runtime.host.listAvailableLlmModels(),
      capabilityAvailability: {
        subagents: { available: true },
        webSearch,
      },
      connectionAdapters: runtime.listConnectionAdapters(),
      agents,
      channels: channelProjection,
      messages,
      connections,
      extensions: projectExtensions(runtime),
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
          plugins: runtime.host.listDshPluginSupport(),
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
          await runtime.host.testLlmProvider(parsed.provider, parsed.model),
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
      const content: AgentRevisionContent = {
        displayName: parsed.displayName,
        persona: parsed.persona,
        model: {
          provider: parsed.model.provider,
          model: parsed.model.model,
          ...(parsed.model.reasoningEffort === undefined ? {} : { reasoningEffort: parsed.model.reasoningEffort }),
        },
        capabilities: defaultCapabilities,
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
          const updated = runtime.core.reviseAgent(agentId, revision.id, {
            displayName: parsed.displayName,
            persona: parsed.persona,
            model: {
              provider: parsed.model.provider,
              model: parsed.model.model,
              ...(parsed.model.reasoningEffort === undefined ? {} : { reasoningEffort: parsed.model.reasoningEffort }),
            },
            capabilities: revision.capabilities,
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
          model: revision.model,
          capabilities,
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
      const assetMatch = /^\/api\/channels\/([^/]+)\/assets\/([^/]+)$/.exec(url.pathname)
      const rawChannelId = messageMatch?.[1] ?? nameMatch?.[1] ?? runtimeMatch?.[1] ?? assetMatch?.[1]
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
        const messages = hasMore ? page.slice(0, params.limit) : page
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
        const connectionConfig = z
          .object({ proactiveSend: z.boolean().optional() })
          .passthrough()
          .safeParse(connection?.config)
        if (connection?.adapterKey !== 'web' && connectionConfig.data?.proactiveSend !== true) {
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
      if (connection.adapterKey === 'qq-openclaw') {
        writeContractJson(
          res,
          200,
          HostApiContracts.testConnection,
          await runtime.testConnection(connection.id, parsed.direction, parsed.channelId),
        )
        return
      }
      const channel = runtime.core.listChannelsByConnection(connection.id)[0]
      if (!channel) {
        writeContractJson(res, 200, HostApiContracts.testConnection, {
          status: 'needs-channel',
          message: 'Web 连接还没有绑定频道，无法测试。',
        })
        return
      }
      if (parsed.direction === 'send') {
        const result = await runtime.web.postMessage({
          channelId: channel.id,
          clientEventId: `test-send-${Date.now()}`,
          parts: [{ type: 'text', text: '连接诊断测试消息。' }],
        })
        writeContractJson(res, 200, HostApiContracts.testConnection, {
          status: 'sent',
          channelId: channel.id,
          platformMessageId: result.channelEventId,
        })
      } else {
        writeContractJson(res, 200, HostApiContracts.testConnection, {
          status: 'received',
          channelId: channel.id,
          platformMessageId: channel.id,
        })
      }
    },
  })

  const unsubscribeConnectionChanges = runtime.subscribeConnectionChanges(() => {
    broadcast({ event: 'status', data: { ok: true, message: '连接状态已更新' } })
  })
  const unsubscribeRuntimeStatus = runtime.host.subscribeRuntimeStatus(() => {
    broadcast({ event: 'status', data: { ok: true, message: '智能体运行状态已更新' } })
  })
  const unsubscribeChannelRuntime = runtime.host.subscribeChannelRuntime((channelId) => {
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
        /^\/api\/dynamic\/([^/]+)\/(inventory|approve|decline|invoke|get-client-code|report-render-failure|run-host-half|settle-user-run)$/.exec(
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
        dshSessionId = resolveActiveSession(runtime, agentId)
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
              pluginRunId: client.pluginRunId,
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
        } catch (error) {
          writeError(res, 400, 'dynamic-render-failure', error instanceof Error ? error.message : String(error))
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
      unsubscribeConnectionChanges()
      unsubscribeRuntimeStatus()
      unsubscribeChannelRuntime()
      unsubscribeDshSettings()
      unsubscribeDshCredentials()
      for (const disposer of disposers.splice(0)) disposer()
    },
  }
}
