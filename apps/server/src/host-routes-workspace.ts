import {
  AgentIdSchema,
  AssetIdSchema,
  ChannelIdSchema,
  ExtensionIdSchema,
  HostApiContracts,
  type AgentId,
  type ChannelId,
  type ExtensionId,
} from '@nekro-nxt/contracts'
import type { AgentRevisionContent } from '@nekro-nxt/core'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { z } from 'zod'
import { commitExtensionConfigWithSecrets, maskExtensionSecrets } from './extension-secret-config.js'
import {
  activationManifest,
  assembleChannelRuntime,
  assembleChannelRuntimeContext,
  assembleChannelRuntimeInput,
  assembleChannelToolCall,
} from './host-queries.js'
import {
  assertAuxiliaryImageModel,
  buildSnapshotMessage,
  readJsonBody,
  writeContractJson,
  writeError,
  writeJson,
  type HostRouteContext,
} from './host-route-support.js'
/**
 * How long an enable or disable request waits for its result. Switching waits for the agent's safe gap, which lasts
 * as long as its current reply; past this window the request answers `pending` and finishes in the background.
 */
export const ACTIVATION_RESPONSE_GRACE_MS = 800

/**
 * Resolves with the operation's result when it settles within `graceMs` (a failure in that window rejects), otherwise
 * with `settled: false` and the still-running operation.
 */
const settleWithin = async <T>(
  operation: Promise<T>,
  graceMs: number,
): Promise<
  { readonly settled: true; readonly value: T } | { readonly settled: false; readonly result: Promise<T> }
> => {
  // Marks a late failure as handled; the caller still observes it through `result`.
  operation.catch(() => undefined)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<{ readonly settled: false; readonly result: Promise<T> }>((resolve) => {
    timer = setTimeout(() => resolve({ settled: false, result: operation }), graceMs)
  })
  try {
    return await Promise.race([operation.then((value) => ({ settled: true as const, value })), timeout])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The request still waiting for the agent's safe gap, or `undefined` when it has just settled. A pending request
 * refreshes every view once it finishes; its failure stays in the snapshot with the reason.
 */
const waitingTransition = (
  runtime: HostRouteContext['runtime'],
  agentId: AgentId,
  extensionId: ExtensionId,
  result: Promise<unknown>,
  settledLater: () => void,
) => {
  const transition = runtime.activation.getTransition(agentId, extensionId)
  if (transition?.state !== 'waiting') return undefined
  result.then(settledLater, (error: unknown) => {
    console.warn('[nekro-nxt] 扩展启用状态切换失败：', error instanceof Error ? error.message : String(error))
    settledLater()
  })
  return {
    agentId: transition.agentId,
    target: transition.target,
    ...(transition.extensionRevisionId === undefined ? {} : { extensionRevisionId: transition.extensionRevisionId }),
    state: transition.state,
    since: transition.since,
  }
}

export function registerWorkspaceRoutes({
  runtime,
  readCursor,
  registerRoute,
  broadcast,
  broadcastExtensionsChanged,
  projections,
}: HostRouteContext): () => void {
  const handleExtensionActivationRoute = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const match = /^\/api\/agents\/([^/]+)\/extensions\/([^/]+)\/activation(\/config)?$/.exec(url.pathname)
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
    if (match[3] === '/config') {
      if (req.method !== 'PUT') {
        writeError(res, 405, 'method-not-allowed', '智能体扩展配置只支持 PUT。')
        return
      }
      try {
        const input = HostApiContracts.updateExtensionActivationConfig.parseRequest(await readJsonBody(req))
        const current = runtime.repository.getActivation(params.agentId, params.extensionId)
        const manifest = activationManifest(runtime, current?.extensionRevisionId)
        const activation = await commitExtensionConfigWithSecrets({
          manifest,
          previous: current?.config,
          config: input.config,
          secrets: input.secrets,
          credentials: runtime.credentials,
          commit: (config) => runtime.activation.updateConfig(params.agentId, params.extensionId, config),
        })
        writeJson(
          res,
          200,
          HostApiContracts.updateExtensionActivationConfig.parseResponse(
            maskExtensionSecrets(manifest, activation.config),
          ),
        )
        broadcastExtensionsChanged()
      } catch (error) {
        writeError(res, 400, 'extension-config-invalid', error instanceof Error ? error.message : String(error))
      }
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
        const outcome = await settleWithin(
          runtime.activation.activate({
            agentId: params.agentId,
            extensionId: params.extensionId,
            revisionId: parsed.revisionId,
            ...(parsed.permissionApproval === undefined ? {} : { permissionApproval: parsed.permissionApproval }),
          }),
          ACTIVATION_RESPONSE_GRACE_MS,
        )
        const pending = outcome.settled
          ? undefined
          : waitingTransition(runtime, params.agentId, params.extensionId, outcome.result, broadcastExtensionsChanged)
        if (pending !== undefined) {
          writeJson(res, 200, HostApiContracts.activateExtension.parseResponse({ pending }))
          broadcastExtensionsChanged()
          return
        }
        const activation = outcome.settled ? outcome.value : await outcome.result
        writeJson(
          res,
          200,
          HostApiContracts.activateExtension.parseResponse({
            activation: {
              ...activation,
              ...maskExtensionSecrets(activationManifest(runtime, activation.extensionRevisionId), activation.config),
            },
          }),
        )
        broadcastExtensionsChanged()
      } catch (error) {
        // The failed request stays in the snapshot with its reason; refresh so every view shows it.
        broadcastExtensionsChanged()
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
        const outcome = await settleWithin(
          runtime.disableAgentExtension(params.agentId, params.extensionId),
          ACTIVATION_RESPONSE_GRACE_MS,
        )
        const pending = outcome.settled
          ? undefined
          : waitingTransition(runtime, params.agentId, params.extensionId, outcome.result, broadcastExtensionsChanged)
        if (!outcome.settled && pending === undefined) await outcome.result
        writeJson(
          res,
          200,
          HostApiContracts.deactivateExtension.parseResponse({
            disabled: true,
            ...(pending === undefined ? {} : { pending }),
          }),
        )
        broadcastExtensionsChanged()
      } catch (error) {
        broadcastExtensionsChanged()
        writeError(res, 400, 'disable-failed', error instanceof Error ? error.message : String(error))
      }
      return
    }
    writeError(res, 405, 'method-not-allowed', '只支持 POST/DELETE。')
  }
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
            ...(parsed.localAgentMessages === undefined ? {} : { localAgentMessages: parsed.localAgentMessages }),
            ...(parsed.activityTriggerOverrides === undefined
              ? {}
              : { activityTriggerOverrides: parsed.activityTriggerOverrides }),
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
              scheduledTasks: true,
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
      const entity = await runtime.createAgentWithInternalChannel(content)
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

  registerRoute({
    kind: 'prefix',
    path: '/api/agents',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (/^\/api\/agents\/[^/]+\/extensions\/[^/]+\/activation(?:\/config)?$/u.test(url.pathname)) {
        await handleExtensionActivationRoute(req, res)
        return
      }
      const revisionsMatch = /^\/api\/agents\/([^/]+)\/revisions(?:\/([^/]+)\/restore)?$/u.exec(url.pathname)
      if (revisionsMatch) {
        let agentId: AgentId
        try {
          agentId = AgentIdSchema.parse(decodeURIComponent(revisionsMatch[1] ?? ''))
        } catch {
          writeError(res, 400, 'invalid-agent', '无效的智能体 ID。')
          return
        }
        const restoreId = revisionsMatch[2]
        await projections.handleAgentRevisionRoute(
          req,
          res,
          agentId,
          restoreId === undefined ? undefined : decodeURIComponent(restoreId),
        )
        return
      }
      const presentationMatch = /^\/api\/agents\/([^/]+)\/(appearance|avatar)$/u.exec(url.pathname)
      if (presentationMatch) {
        let agentId: AgentId
        try {
          agentId = AgentIdSchema.parse(decodeURIComponent(presentationMatch[1] ?? ''))
        } catch {
          writeError(res, 400, 'invalid-agent', '无效的智能体 ID。')
          return
        }
        await projections.handleAgentRoute(
          req,
          res,
          agentId,
          presentationMatch[2] === 'avatar' ? 'avatar' : 'appearance',
        )
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
            deleteWorkspace: parsed.deleteWorkspace,
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
          ...(parsed.scheduledTasks === undefined ? {} : { scheduledTasks: parsed.scheduledTasks }),
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
          const parsed = HostApiContracts.createInternalChannel.parseRequest(await readJsonBody(req))
          const channel = runtime.core.createChannel({
            connectionId: runtime.internalConnectionId,
            platformChannelId: `internal-channel-${crypto.randomUUID()}`,
            kind: 'internal',
            displayName: parsed.displayName,
          })
          writeJson(
            res,
            201,
            HostApiContracts.createInternalChannel.parseResponse({
              channelId: channel.id,
              connectionId: channel.connectionId,
            }),
          )
        } catch (error) {
          writeError(res, 400, 'channel-create-failed', error instanceof Error ? error.message : String(error))
        }
        return
      }
      const projectionMatch = /^\/api\/channels\/([^/]+)\/(read|pending|stop)$/u.exec(url.pathname)
      if (projectionMatch) {
        let channelId: ChannelId
        try {
          channelId = ChannelIdSchema.parse(decodeURIComponent(projectionMatch[1] ?? ''))
        } catch {
          writeError(res, 400, 'invalid-channel', '无效的频道 ID。')
          return
        }
        const action = projectionMatch[2] === 'read' ? 'read' : projectionMatch[2] === 'pending' ? 'pending' : 'stop'
        await projections.handleChannelRoute(req, res, channelId, action)
        return
      }
      const messageMatch = /^\/api\/channels\/([^/]+)\/messages$/.exec(url.pathname)
      const nameMatch = /^\/api\/channels\/([^/]+)\/display-name$/.exec(url.pathname)
      const runtimeMatch = /^\/api\/channels\/([^/]+)\/runtime$/.exec(url.pathname)
      const toolCallMatch = /^\/api\/channels\/([^/]+)\/runtime\/tools\/([^/]+)$/.exec(url.pathname)
      const runtimeContextMatch = /^\/api\/channels\/([^/]+)\/runtime\/context$/.exec(url.pathname)
      const runtimeInputMatch = /^\/api\/channels\/([^/]+)\/runtime\/inputs\/([^/]+)$/.exec(url.pathname)
      const contextResetMatch = /^\/api\/channels\/([^/]+)\/context-reset$/.exec(url.pathname)
      const assetMatch = /^\/api\/channels\/([^/]+)\/assets\/([^/]+)$/.exec(url.pathname)
      const channelMatch = /^\/api\/channels\/([^/]+)$/.exec(url.pathname)
      const rawChannelId =
        messageMatch?.[1] ??
        nameMatch?.[1] ??
        runtimeMatch?.[1] ??
        toolCallMatch?.[1] ??
        runtimeContextMatch?.[1] ??
        runtimeInputMatch?.[1] ??
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
          writeContractJson(res, 200, HostApiContracts.getChannelRuntime, {
            ...assembleChannelRuntime(runtime, typedChannelId),
            cursor: readCursor(),
          })
        } catch (error) {
          writeError(res, 404, 'channel-runtime-missing', error instanceof Error ? error.message : String(error))
        }
        return
      }

      if (runtimeInputMatch) {
        if (req.method !== 'GET') {
          writeError(res, 405, 'method-not-allowed', '只支持 GET。')
          return
        }
        const messageId = decodeURIComponent(runtimeInputMatch[2] ?? '')
        writeContractJson(
          res,
          200,
          HostApiContracts.getChannelRuntimeInput,
          assembleChannelRuntimeInput(runtime, typedChannelId, messageId) ?? {
            messageId,
            available: false,
            truncated: false,
          },
        )
        return
      }

      if (runtimeContextMatch) {
        if (req.method !== 'GET') {
          writeError(res, 405, 'method-not-allowed', '只支持 GET。')
          return
        }
        writeContractJson(
          res,
          200,
          HostApiContracts.getChannelRuntimeContext,
          assembleChannelRuntimeContext(runtime, typedChannelId),
        )
        return
      }

      if (toolCallMatch) {
        if (req.method !== 'GET') {
          writeError(res, 405, 'method-not-allowed', '只支持 GET。')
          return
        }
        const callId = decodeURIComponent(toolCallMatch[2] ?? '')
        writeContractJson(
          res,
          200,
          HostApiContracts.getChannelToolCall,
          assembleChannelToolCall(runtime, typedChannelId, callId) ?? {
            callId,
            available: false,
            inputTruncated: false,
            resultTruncated: false,
          },
        )
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
        writeContractJson(res, 200, HostApiContracts.listChannelMessages, { messages, hasMore, cursor: readCursor() })
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
        if (channel.kind === 'internal') {
          const result = await runtime.internalChannel.postMessage({
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
        if (!connection || runtime.connectionCapabilities(connection.id)?.outbound.proactiveSend !== true) {
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
  return () => undefined
}
