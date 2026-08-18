import type { WebServer, WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { AgentRevisionContent } from '@nekro-nxt/core'
import {
  AgentIdSchema,
  AssetIdSchema,
  ChannelIdSchema,
  ConnectionIdSchema,
  ExtensionIdSchema,
  DshCredentialsChangedSseDataSchema,
  DshSettingsChangedSseDataSchema,
  HostApiErrorSchema,
  HostApiContracts,
  HostSseEventSchema,
  parseJsonValue,
  type AgentId,
  type ChannelId,
  type HostApiContract,
  type HostSnapshotMessage,
  type HostSseEvent,
} from '@nekro-nxt/contracts'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import type { NekroRuntime } from './bootstrap.js'

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

const renderSse = (payload: HostSseEvent): string => {
  const parsed = HostSseEventSchema.parse(payload)
  return `event: ${parsed.event}\ndata: ${JSON.stringify(parsed.data)}\n\n`
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

/** Build the authoritative projection snapshot from the assembled services only. */
export const buildSnapshotMessage = (
  runtime: NekroRuntime,
  channelId: ChannelId,
  options: {
    readonly limit?: number
    readonly before?: { readonly occurredAt: number; readonly sourceId: string }
  } = {},
): readonly HostSnapshotMessage[] => {
  const out: HostSnapshotMessage[] = []
  for (const entry of runtime.repository.listChannelHistory(channelId, options)) {
    const parts = entry.parts.map((part) => {
      if (part.type !== 'mention') return part
      const displayName = runtime.repository.getChannelMember(part.memberId)?.displayName
      return { ...part, ...(displayName === undefined ? {} : { displayName }) }
    })
    if (entry.source === 'channel-event') {
      const sender =
        entry.senderMemberId === undefined ? undefined : runtime.repository.getChannelMember(entry.senderMemberId)
      out.push({
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
      })
    } else if (entry.source === 'outbound-intent') {
      out.push({
        id: entry.sourceId,
        channelId: entry.channelId,
        role: 'agent',
        parts,
        occurredAt: entry.occurredAt,
        deliveryState: entry.state,
      })
    }
  }
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
const projectDynamicInventory = (
  runtime: NekroRuntime,
  agentId: AgentId,
): Array<{ pluginId: string; packageId?: string; approvalRequestId?: string; status: string }> => {
  const episode = runtime.repository
    .listActiveEpisodesForAgent(agentId)
    .find((candidate) => candidate.dshSessionId !== undefined)
  if (!episode?.dshSessionId) return []
  try {
    return runtime.host.dynamicInventory(episode.dshSessionId).flatMap((row) => {
      const status = row.activeRun
        ? 'running'
        : row.latestRun?.status === 'awaiting-approval'
          ? 'awaiting-approval'
          : 'stopped'
      return [
        {
          pluginId: row.pluginId,
          ...(row.currentPackageId === undefined ? {} : { packageId: row.currentPackageId }),
          ...(row.latestRun?.approvalRequestId === undefined
            ? {}
            : { approvalRequestId: row.latestRun.approvalRequestId }),
          status,
        },
      ]
    })
  } catch {
    return []
  }
}

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

  // Active SSE clients, so a single domain change (e.g. an AgentActivation
  // transition) can be broadcast for live projection refresh on all open tabs.
  const sseClients = new Set<ServerResponse>()
  const broadcastExtensionsChanged = (): void => {
    const frame = renderSse({ event: 'extensions-changed', data: { changed: true } })
    for (const client of sseClients) {
      try {
        client.write(frame)
      } catch {
        // Connection already closed; the next close handler removes it.
      }
    }
  }
  const broadcast = (event: HostSseEvent): void => {
    const frame = renderSse(event)
    for (const client of sseClients) {
      try {
        client.write(frame)
      } catch {
        // Connection already closed; the next close handler removes it.
      }
    }
  }
  disposers.push(
    runtime.channels.subscribeFacts((fact) => {
      broadcast({ event: 'channel-fact', data: fact })
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
    const agents = agentCommits.map((commit) => {
      const agentId = commit.definition.id
      const ownedChannels = channels
        .filter((channel) => bindingsByChannel.get(channel.id)?.some((binding) => binding.agentId === agentId))
        .map((channel) => channel.id)
      return {
        id: agentId,
        displayName: commit.revision.displayName,
        persona: commit.revision.persona,
        model: commit.revision.model,
        capabilities: commit.revision.capabilities,
        currentRevisionId: commit.revision.id,
        runtimeStatus: runtime.host.runtimeStatus(commit.definition.id),
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
      dynamic: [...agentIds].flatMap((agentId) =>
        projectDynamicInventory(runtime, agentId).map((plugin) => ({ agentId, ...plugin })),
      ),
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
    path: '/api/bindings',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        writeError(res, 405, 'method-not-allowed', '只支持 POST。')
        return
      }
      try {
        const parsed = HostApiContracts.createBinding.parseRequest(await readJsonBody(req))
        const { agentId, channelId } = parsed
        if (!runtime.repository.getAgent(agentId)) throw new Error('智能体不存在。')
        if (!runtime.repository.getChannel(channelId)) throw new Error('频道不存在。')
        const binding = await runtime.channels.replaceBinding({
          agentId,
          channelId,
          triggerPolicy: parsed.triggerPolicy,
        })
        writeJson(res, 201, HostApiContracts.createBinding.parseResponse(binding))
      } catch (error) {
        writeError(res, 400, 'binding-failed', error instanceof Error ? error.message : String(error))
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

  // GET /api/events (SSE) — subscribe to channel facts / agent replies.
  registerRoute({
    kind: 'exact',
    path: '/api/events',
    handler: (_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      res.write(renderSse({ event: 'status', data: { ok: true, message: '已连接' } }))
      sseClients.add(res)

      const heartbeat = setInterval(() => res.write(`: heartbeat\n\n`), 15_000)
      const onClose = (): void => {
        sseClients.delete(res)
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
      const messageMatch = /^\/api\/channels\/([^/]+)\/messages$/.exec(url.pathname)
      const nameMatch = /^\/api\/channels\/([^/]+)\/display-name$/.exec(url.pathname)
      const assetMatch = /^\/api\/channels\/([^/]+)\/assets\/([^/]+)$/.exec(url.pathname)
      const rawChannelId = messageMatch?.[1] ?? nameMatch?.[1] ?? assetMatch?.[1]
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
            limit: Number(url.searchParams.get('limit') ?? 40),
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
        if (channel?.kind !== 'web') {
          writeError(res, 400, 'external-channel-read-only', '外部平台频道暂不支持从网页主动发言。')
          return
        }
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
      } catch (error) {
        writeError(res, 400, 'inbound-failed', error instanceof Error ? error.message : String(error))
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
    const frame = renderSse({ event: 'status', data: { ok: true, message: '连接状态已更新' } })
    for (const client of sseClients) {
      try {
        client.write(frame)
      } catch {
        // Closed clients are removed by their close handler.
      }
    }
  })
  const unsubscribeRuntimeStatus = runtime.host.subscribeRuntimeStatus(() => {
    const frame = renderSse({ event: 'status', data: { ok: true, message: '智能体运行状态已更新' } })
    for (const client of sseClients) {
      try {
        client.write(frame)
      } catch {
        // Closed clients are removed by their close handler.
      }
    }
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
      unsubscribeConnectionChanges()
      unsubscribeRuntimeStatus()
      unsubscribeDshSettings()
      unsubscribeDshCredentials()
      for (const disposer of disposers.splice(0)) disposer()
    },
  }
}
