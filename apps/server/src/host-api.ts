import type { WebServer, WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { OutboundState } from '@nekro-nxt/channel-runtime'
import type { AgentRevisionContent } from '@nekro-nxt/core'
import type { AgentId, ChannelId, ExtensionId, ExtensionRevisionId, JsonValue, MessagePart } from '@nekro-nxt/contracts'
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

const createAgentSchema = z
  .object({
    displayName: z.string().trim().min(1).max(80),
    persona: z
      .string()
      .max(64 * 1024)
      .default(''),
    model: z
      .object({
        provider: z.string().trim().min(1),
        model: z.string().trim().min(1),
        reasoningEffort: z.string().trim().min(1).optional(),
      })
      .strict(),
    capabilities: z
      .object({
        dynamicCreation: z.boolean().default(false),
        developmentShell: z.boolean().default(false),
        fullFileAccess: z.boolean().default(false),
      })
      .strict()
      .optional(),
  })
  .strict()

const messageBodySchema = z
  .object({
    parts: z
      .array(
        z.discriminatedUnion('type', [
          z.object({ type: z.literal('text'), text: z.string().trim().min(1) }).strict(),
          z.object({ type: z.literal('mention'), memberId: z.string().trim().min(1) }).strict(),
        ]),
      )
      .min(1),
    clientEventId: z.string().trim().min(1).optional(),
    senderMemberId: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine(
    (body) =>
      (body.parts as readonly MessagePart[]).every((part) =>
        part.type === 'text' ? [...part.text].length <= 64 * 1024 : part.type === 'mention' ? true : false,
      ),
    'Message text must not exceed 64 KiB.',
  )

const idParamSchema = z.string().trim().min(1)

const activationSchema = z
  .object({
    agentId: z.string().trim().min(1),
    revisionId: z.string().trim().min(1),
  })
  .strict()

const createConnectionSchema = z
  .object({
    appId: z.string().trim().min(1),
    credentialRef: z.string().trim().min(1),
  })
  .strict()

const saveFromDynamicSchema = z
  .object({
    agentId: z.string().trim().min(1),
    name: z.string().trim().min(1).max(80),
    displayName: z.string().trim().min(1).max(80),
    slug: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/),
    description: z.string().max(500).default(''),
  })
  .strict()

export interface SnapshotMessage {
  readonly id: string
  readonly channelId: ChannelId
  readonly role: 'member' | 'agent'
  readonly parts: readonly MessagePart[]
  readonly occurredAt: number
  readonly deliveryState?: OutboundState
}

export interface NekroHostApi {
  /** The actual listening port (OS-assigned when configured as 0). */
  readonly port: number
  dispose(): void
}

type SseEvent =
  | {
      readonly event: 'channel-fact'
      readonly data: { readonly channelId: ChannelId; readonly message: SnapshotMessage }
    }
  | { readonly event: 'extensions-changed'; readonly data: { readonly changed: true } }
  | { readonly event: 'status'; readonly data: { readonly ok: boolean; readonly message: string } }

const renderSse = (payload: SseEvent): string => `event: ${payload.event}\ndata: ${JSON.stringify(payload.data)}\n\n`

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
        resolve(JSON.parse(raw))
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
  writeJson(res, status, { error: { code, message } })

export const parseMessagePartsRequestBody = (input: unknown): z.output<typeof messageBodySchema> =>
  messageBodySchema.parse(input)

/** Build the authoritative projection snapshot from the assembled services only. */
export const buildSnapshotMessage = (runtime: NekroRuntime, channelId: ChannelId): readonly SnapshotMessage[] => {
  const out: SnapshotMessage[] = []
  for (const entry of runtime.repository.listChannelHistory(channelId, { limit: 100 })) {
    if (entry.source === 'channel-event') {
      out.push({
        id: entry.sourceId,
        channelId: entry.channelId,
        role: 'member',
        parts: entry.parts,
        occurredAt: entry.occurredAt,
      })
    } else if (entry.source === 'outbound-intent') {
      out.push({
        id: entry.sourceId,
        channelId: entry.channelId,
        role: 'agent',
        parts: entry.parts,
        occurredAt: entry.occurredAt,
        deliveryState: entry.state,
      })
    }
  }
  // History is newest-first for pagination; expose oldest-first for the Web.
  return out.toReversed()
}

/** Project persisted local Extensions and their Agent Activations for the Shell. */
const projectExtensions = (
  runtime: NekroRuntime,
): Array<{
  id: string
  slug: string
  displayName: string
  description: string
  revisionNumber: number
  revisionId: string
  activation: string
  agentId?: string
}> => {
  const activations = runtime.repository.listActiveActivations()
  return runtime.repository.listExtensionRevisions().flatMap((revision) => {
    const extension = runtime.repository.getExtension(revision.extensionId)
    if (!extension || extension.deletedAt !== undefined) return []
    const activation = activations.find((candidate) => candidate.extensionId === extension.id)
    const displayState =
      activation === undefined
        ? 'inactive'
        : activation.state === 'active'
          ? 'active'
          : activation.state === 'failed'
            ? 'failed'
            : 'waiting-safe-switch'
    return [
      {
        id: extension.id,
        slug: extension.slug,
        displayName: extension.displayName,
        description: extension.description,
        revisionNumber: revision.revisionNumber,
        revisionId: revision.id,
        activation: displayState,
        ...(activation === undefined ? {} : { agentId: activation.agentId }),
      },
    ]
  })
}

/** Running dynamic Packages owned by an intelligent-agent's active Session. */
const projectDynamicInventory = (
  runtime: NekroRuntime,
  agentId: string,
): Array<{ pluginId: string; packageId?: string; approvalRequestId?: string; status: string }> => {
  const episode = runtime.repository
    .listActiveEpisodesForAgent(agentId as never)
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
const resolveActiveSession = (runtime: NekroRuntime, agentId: string): string => {
  const episode = runtime.repository
    .listActiveEpisodesForAgent(agentId as never)
    .find((candidate) => candidate.dshSessionId !== undefined)
  if (!episode?.dshSessionId) {
    throw new Error('该智能体没有活动会话。')
  }
  return episode.dshSessionId
}

/**
 * Save the first currently-running dynamic Package owned by an intelligent-agent
 * as a persistent local Extension Revision. Persistence does NOT auto-activate
 * it for the Agent — Activation is a separate lifecycle action (M4).
 */
const saveActiveDynamicPackage = async (
  runtime: NekroRuntime,
  agentId: string,
  meta: { readonly name: string; readonly displayName: string; readonly slug: string; readonly description: string },
): Promise<{ readonly extension: { readonly id: string }; readonly revision: { readonly id: string } }> => {
  const episode = runtime.repository
    .listActiveEpisodesForAgent(agentId as never)
    .find((candidate) => candidate.dshSessionId !== undefined)
  if (!episode?.dshSessionId) {
    throw new Error('该智能体没有活动会话可保存的动态 Package。')
  }
  const inventory = runtime.host.dynamicInventory(episode.dshSessionId)
  const row = inventory.find((candidate) => candidate.currentPackageId !== undefined)
  if (!row?.currentPackageId) {
    throw new Error('该智能体的活动会话中没有正在运行的动态 Package。')
  }
  const inspection = runtime.host.inspectDynamicPackage(episode.dshSessionId, row.pluginId, row.currentPackageId)
  const captured = runtime.extensionService.captureDynamicPackage(agentId as never, {
    dshSessionId: episode.dshSessionId,
    dynamicPluginId: row.pluginId,
    dynamicPackageId: row.currentPackageId,
    name: meta.name,
    purpose: '从创造工作台保存的动态 Package。',
    ...(inspection.code.host === undefined ? {} : { hostCode: inspection.code.host }),
    ...(inspection.code.client === undefined ? {} : { clientCode: inspection.code.client }),
  })
  return await runtime.extensionService.saveDraftPackage({
    draftPackageId: captured.package.id,
    slug: meta.slug,
    displayName: meta.displayName,
    description: meta.description,
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

  const buildSnapshot = (): unknown => {
    // Enumerate channels durably from the Core repository so the snapshot
    // survives restart, then discover bound Agents via their Bindings.
    const channels = runtime.core.listChannelsByConnection(runtime.webConnectionId)
    const agentByChannel = new Map<string, AgentId>()
    for (const channel of channels) {
      const binding = runtime.core.listBindings(channel.id)[0]
      if (binding) agentByChannel.set(channel.id, binding.agentId)
    }
    const agentIds = new Set(agentByChannel.values())
    const agents = [...agentIds].flatMap((agentId) => {
      const commit = runtime.repository.getAgent(agentId)
      if (!commit) return []
      const ownedChannels = channels
        .filter((channel) => agentByChannel.get(channel.id) === agentId)
        .map((channel) => channel.id)
      return [
        {
          id: agentId,
          displayName: commit.revision.displayName,
          model: commit.revision.model,
          capabilities: commit.revision.capabilities,
          currentRevisionId: commit.revision.id,
          createdAt: commit.revision.createdAt,
          channels: ownedChannels,
        },
      ]
    })
    const channelProjection = channels.map((channel) => {
      const boundAgentId = agentByChannel.get(channel.id)
      return {
        id: channel.id,
        connectionId: channel.connectionId,
        platformChannelId: channel.platformChannelId,
        kind: channel.kind,
        ...(channel.displayName === undefined ? {} : { displayName: channel.displayName }),
        ...(boundAgentId === undefined ? {} : { boundAgentId }),
      }
    })
    const messages: SnapshotMessage[] = channels.flatMap((channel) => buildSnapshotMessage(runtime, channel.id))
    const connections = runtime.core.listConnections()
    return {
      agents,
      channels: channelProjection,
      messages,
      connections,
      extensions: projectExtensions(runtime),
      dynamic: [...agentIds].flatMap((agentId) =>
        projectDynamicInventory(runtime, agentId).map((plugin) => ({ agentId, ...plugin })),
      ),
    }
  }

  // GET /api/snapshot
  registerRoute({
    kind: 'exact',
    path: '/api/snapshot',
    handler: (_req, res) => {
      writeJson(res, 200, buildSnapshot())
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

      const unsubscribe = runtime.web.subscribe(({ request }) => {
        // Only push the settled delivered intent; the receipt stream is the
        // authoritative reply fact for the Web.
        const messages = buildSnapshotMessage(runtime, request.channelId)
        const last = messages.at(-1)
        if (last && last.role === 'agent') {
          res.write(renderSse({ event: 'channel-fact', data: { channelId: request.channelId, message: last } }))
        }
      })
      const heartbeat = setInterval(() => res.write(`: heartbeat\n\n`), 15_000)
      const onClose = (): void => {
        sseClients.delete(res)
        unsubscribe()
        clearInterval(heartbeat)
        res.end()
      }
      res.on('close', onClose)
      res.on('error', onClose)
    },
  })

  // POST /api/agents → closed-loop A primitive
  registerRoute({
    kind: 'exact',
    path: '/api/agents',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        writeError(res, 405, 'method-not-allowed', '只支持 POST。')
        return
      }
      let parsed: z.output<typeof createAgentSchema>
      try {
        parsed = createAgentSchema.parse(await readJsonBody(req))
      } catch (error) {
        writeError(res, 400, 'invalid-request', error instanceof Error ? error.message : String(error))
        return
      }
      const content: AgentRevisionContent = {
        displayName: parsed.displayName,
        persona: parsed.persona,
        model: {
          provider: parsed.model.provider,
          model: parsed.model.model,
          ...(parsed.model.reasoningEffort === undefined ? {} : { reasoningEffort: parsed.model.reasoningEffort }),
        },
        ...(parsed.capabilities === undefined ? {} : { capabilities: parsed.capabilities }),
      }
      const entity = runtime.createAgentWithWebChannel(content)
      writeJson(res, 201, {
        agentId: entity.agentId,
        channelId: entity.channelId,
        connectionId: entity.connectionId,
      })
    },
  })

  // POST /api/agents/:id/capabilities → create a new immutable AgentRevision
  // with updated capability grants (dynamicCreation / developmentShell / fullFileAccess).
  registerRoute({
    kind: 'prefix',
    path: '/api/agents',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const match = /^\/api\/agents\/([^/]+)\/capabilities$/.exec(url.pathname)
      if (!match) {
        writeError(res, 404, 'not-found', `未定义路由：${req.method} ${url.pathname}。`)
        return
      }
      if (req.method !== 'POST') {
        writeError(res, 405, 'method-not-allowed', '只支持 POST。')
        return
      }
      const agentId = idParamSchema.safeParse(match[1]!)
      if (!agentId.success) {
        writeError(res, 400, 'invalid-agent', '无效的智能体 ID。')
        return
      }
      const parsed = z
        .object({
          dynamicCreation: z.boolean().optional(),
          developmentShell: z.boolean().optional(),
          fullFileAccess: z.boolean().optional(),
        })
        .strict()
        .refine((value) => Object.values(value).some((v) => v !== undefined), '至少提供一个能力。')
        .parse(await readJsonBody(req))
      try {
        const commit = runtime.repository.getAgent(agentId.data as AgentId)
        if (!commit) {
          writeError(res, 404, 'not-found', '智能体不存在。')
          return
        }
        const revision = commit.revision
        const capabilities = {
          ...revision.capabilities,
          ...(parsed.dynamicCreation === undefined ? {} : { dynamicCreation: parsed.dynamicCreation }),
          ...(parsed.developmentShell === undefined ? {} : { developmentShell: parsed.developmentShell }),
          ...(parsed.fullFileAccess === undefined ? {} : { fullFileAccess: parsed.fullFileAccess }),
        }
        const updated = runtime.core.reviseAgent(agentId.data as AgentId, revision.id, {
          displayName: revision.displayName,
          persona: revision.persona,
          model: revision.model,
          capabilities,
        })
        writeJson(res, 200, {
          currentRevisionId: updated.revision.id,
          capabilities: updated.revision.capabilities,
        })
      } catch (error) {
        writeError(res, 400, 'capabilities-failed', error instanceof Error ? error.message : String(error))
      }
    },
  })

  // POST /api/channels/:id/messages → assemble inbound and acceptInbound it.
  registerRoute({
    kind: 'prefix',
    path: '/api/channels',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const match = /^\/api\/channels\/([^/]+)\/messages$/.exec(url.pathname)
      if (!match) {
        writeError(res, 404, 'not-found', `未定义路由：${req.method} ${url.pathname}。`)
        return
      }
      if (req.method !== 'POST') {
        writeError(res, 405, 'method-not-allowed', '只支持 POST。')
        return
      }
      const channelId = idParamSchema.safeParse(match[1]!)
      if (!channelId.success) {
        writeError(res, 400, 'invalid-channel', '无效的频道 ID。')
        return
      }
      let parsed: z.output<typeof messageBodySchema>
      try {
        parsed = messageBodySchema.parse(await readJsonBody(req))
      } catch (error) {
        writeError(res, 400, 'invalid-request', error instanceof Error ? error.message : String(error))
        return
      }
      try {
        const result = await runtime.web.postMessage({
          channelId: channelId.data as ChannelId,
          clientEventId: parsed.clientEventId ?? `http-${Date.now()}`,
          parts: parsed.parts as MessagePart[],
          ...(parsed.senderMemberId === undefined ? {} : { senderMemberId: parsed.senderMemberId as never }),
        })
        writeJson(res, 200, {
          channelEventId: result.channelEventId,
          inserted: result.inserted,
        })
      } catch (error) {
        writeError(res, 400, 'inbound-failed', error instanceof Error ? error.message : String(error))
      }
    },
  })

  // POST /api/connections → create a configured Connection (e.g. QQ 机器人账号).
  registerRoute({
    kind: 'exact',
    path: '/api/connections',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        writeError(res, 405, 'method-not-allowed', '只支持 POST。')
        return
      }
      let parsed: z.output<typeof createConnectionSchema>
      try {
        parsed = createConnectionSchema.parse(await readJsonBody(req))
      } catch (error) {
        writeError(res, 400, 'invalid-request', error instanceof Error ? error.message : String(error))
        return
      }
      try {
        // 真实凭据只以引用形式保存；配置与状态进入持久化 Connection 记录。
        const connection = runtime.core.createConnection({
          adapterKey: 'qq-openclaw',
          config: { appId: parsed.appId },
          credentialRefs: { clientSecret: parsed.credentialRef },
        })
        writeJson(res, 201, {
          connectionId: connection.id,
          adapterKey: connection.adapterKey,
          status: connection.status,
        })
      } catch (error) {
        writeError(res, 400, 'connection-failed', error instanceof Error ? error.message : String(error))
      }
    },
  })

  // POST /api/connections/:id/test → honest send/receive diagnostics. The Web
  // Connection is exercised for real; a QQ Connection without live credentials
  // reports needs-credentials (never a fake "通过").
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
      const connectionId = idParamSchema.safeParse(match[1]!)
      if (!connectionId.success) {
        writeError(res, 400, 'invalid-connection', '无效的连接 ID。')
        return
      }
      const directionSchema = z.object({ direction: z.enum(['send', 'receive']) }).strict()
      let parsed: z.output<typeof directionSchema>
      try {
        parsed = directionSchema.parse(await readJsonBody(req))
      } catch (error) {
        writeError(res, 400, 'invalid-request', error instanceof Error ? error.message : String(error))
        return
      }
      const connection = runtime.core.listConnections().find((candidate) => candidate.id === connectionId.data)
      if (!connection) {
        writeError(res, 404, 'not-found', '连接不存在。')
        return
      }
      if (connection.adapterKey !== 'web') {
        // QQ OpenClaw 需要平台 Client Secret + 测试群；没有真实凭据不做假成功。
        writeJson(res, 200, {
          status: 'needs-credentials',
          message: '已配置该连接；真实收发测试需在 QQ 平台提供 Client Secret 与一个专用测试群。',
        })
        return
      }
      const channel = runtime.core.listChannelsByConnection(connection.id)[0]
      if (!channel) {
        writeJson(res, 200, { status: 'needs-channel', message: 'Web 连接还没有绑定频道，无法测试。' })
        return
      }
      if (parsed.direction === 'send') {
        const result = await runtime.web.postMessage({
          channelId: channel.id,
          clientEventId: `test-send-${Date.now()}`,
          parts: [{ type: 'text', text: '连接诊断测试消息。' }],
        })
        writeJson(res, 200, { status: 'sent', channelEventId: result.channelEventId })
      } else {
        writeJson(res, 200, { status: 'ok', channel: channel.id })
      }
    },
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
        /^\/api\/dynamic\/([^/]+)\/(approve|decline|invoke|get-client-code|report-render-failure|run-host-half|settle-user-run)$/.exec(
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
      const agentId = idParamSchema.safeParse(match[1]!)
      const action = match[2]!
      if (!agentId.success) {
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
        dshSessionId = resolveActiveSession(runtime, agentId.data)
      } catch (error) {
        writeError(res, 400, 'no-session', error instanceof Error ? error.message : String(error))
        return
      }
      if (action === 'approve' || action === 'decline') {
        const parsed = z
          .object({ requestId: z.string().trim().min(1), pluginRunId: z.string().trim().optional() })
          .strict()
          .parse(body)
        try {
          const resolution =
            action === 'approve'
              ? { ok: true, ...(parsed.pluginRunId === undefined ? {} : { pluginRunId: parsed.pluginRunId }) }
              : { ok: false, reason: 'user-declined' }
          const ack = await runtime.host.resolveDynamicRunRequest(dshSessionId, parsed.requestId, resolution as never)
          writeJson(res, 200, { accepted: ack.accepted })
        } catch (error) {
          writeError(res, 400, 'dynamic-operation-failed', error instanceof Error ? error.message : String(error))
        }
        return
      }
      if (action === 'invoke') {
        const parsed = z
          .object({
            pluginId: z.string().trim().min(1),
            pluginRunId: z.string().trim().min(1),
            method: z.string().min(1),
            args: z.unknown().optional(),
          })
          .strict()
          .parse(body)
        try {
          const result = await runtime.host.invokeDynamicHost(
            dshSessionId,
            parsed.pluginId,
            parsed.pluginRunId,
            parsed.method,
            parsed.args as JsonValue | undefined,
          )
          writeJson(res, 200, { ok: result.ok, ...(result.ok ? { value: result.value } : { message: result.message }) })
        } catch (error) {
          writeError(res, 400, 'dynamic-invoke-failed', error instanceof Error ? error.message : String(error))
        }
        return
      }
      if (action === 'run-host-half') {
        const parsed = z
          .object({
            pluginId: z.string().trim().min(1),
            packageId: z.string().trim().min(1),
            mode: z.enum(['run', 'update']),
            requestId: z.string().nullable().optional(),
            approveFutureVersions: z.boolean().optional().default(false),
          })
          .strict()
          .parse(body)
        try {
          const result = await runtime.host.runDynamicHostHalf(
            dshSessionId,
            parsed.pluginId,
            parsed.packageId,
            parsed.mode,
            parsed.requestId ?? null,
            parsed.approveFutureVersions,
          )
          writeJson(res, 200, result)
        } catch (error) {
          writeError(res, 400, 'dynamic-host-half-failed', error instanceof Error ? error.message : String(error))
        }
        return
      }
      if (action === 'settle-user-run') {
        const parsed = z
          .object({
            pluginId: z.string().trim().min(1),
            resolution: z.unknown(),
          })
          .strict()
          .parse(body)
        try {
          const result = await runtime.host.settleDynamicUserRun(
            dshSessionId,
            parsed.pluginId,
            parsed.resolution as never,
          )
          writeJson(res, 200, result)
        } catch (error) {
          writeError(res, 400, 'dynamic-settle-failed', error instanceof Error ? error.message : String(error))
        }
        return
      }
      if (action === 'get-client-code') {
        const parsed = z
          .object({ pluginId: z.string().trim().min(1), pluginRunId: z.string().trim().min(1) })
          .strict()
          .parse(body)
        try {
          const client = runtime.host.getDynamicClientCode(dshSessionId, parsed.pluginId, parsed.pluginRunId)
          writeJson(res, 200, {
            pluginId: client.pluginId,
            pluginRunId: client.pluginRunId,
            code: client.code,
          })
        } catch (error) {
          writeError(res, 400, 'dynamic-client-code-failed', error instanceof Error ? error.message : String(error))
        }
        return
      }
      if (action === 'report-render-failure') {
        const parsed = z
          .object({
            pluginId: z.string().trim().min(1),
            pluginRunId: z.string().trim().min(1),
            failure: z.unknown().optional(),
          })
          .strict()
          .parse(body)
        try {
          await runtime.host.reportDynamicRenderFailure(
            dshSessionId,
            parsed.pluginId,
            parsed.pluginRunId,
            parsed.failure as never,
          )
          writeJson(res, 200, { ok: true })
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
      let parsed: z.output<typeof saveFromDynamicSchema>
      try {
        parsed = saveFromDynamicSchema.parse(await readJsonBody(req))
      } catch (error) {
        writeError(res, 400, 'invalid-request', error instanceof Error ? error.message : String(error))
        return
      }
      try {
        const saved = await saveActiveDynamicPackage(runtime, parsed.agentId, {
          name: parsed.name,
          displayName: parsed.displayName,
          slug: parsed.slug,
          description: parsed.description,
        })
        writeJson(res, 200, {
          extensionId: saved.extension.id,
          revisionId: saved.revision.id,
          activation: 'inactive',
        })
      } catch (error) {
        writeError(res, 400, 'save-failed', error instanceof Error ? error.message : String(error))
      }
    },
  })

  // POST/DELETE /api/extensions/:id/activation → AgentActivation lifecycle (M4).
  registerRoute({
    kind: 'prefix',
    path: '/api/extensions',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const match = /^\/api\/extensions\/([^/]+)\/(activation|revisions)$/.exec(url.pathname)
      if (!match) {
        writeError(res, 404, 'not-found', `未定义路由：${req.method} ${url.pathname}。`)
        return
      }
      const extensionId = idParamSchema.safeParse(match[1]!)
      if (!extensionId.success) {
        writeError(res, 400, 'invalid-extension', '无效的扩展 ID。')
        return
      }
      const action = match[2]!
      if (action !== 'activation') {
        writeError(res, 501, 'not-implemented', '扩展保存流程尚未通过此端点开放。')
        return
      }
      if (req.method === 'POST') {
        // Activate a saved Revision for an intelligent-agent.
        let parsed: z.output<typeof activationSchema>
        try {
          parsed = activationSchema.parse(await readJsonBody(req))
        } catch (error) {
          writeError(res, 400, 'invalid-request', error instanceof Error ? error.message : String(error))
          return
        }
        try {
          const activation = await runtime.activation.activate({
            agentId: parsed.agentId as AgentId,
            extensionId: extensionId.data as ExtensionId,
            revisionId: parsed.revisionId as ExtensionRevisionId,
          })
          writeJson(res, 200, { activation: { id: activation.id, state: activation.state } })
          broadcastExtensionsChanged()
        } catch (error) {
          writeError(res, 400, 'activation-failed', error instanceof Error ? error.message : String(error))
        }
        return
      }
      if (req.method === 'DELETE') {
        // Disable the current Activation of this Extension (any Agent).
        try {
          const activation = runtime.repository
            .listActiveActivations()
            .find((candidate) => candidate.extensionId === (extensionId.data as ExtensionId))
          if (!activation) {
            writeError(res, 404, 'not-active', '该扩展当前没有已启用的 Activation。')
            return
          }
          await runtime.activation.disable(activation.id)
          writeJson(res, 200, { disabled: true })
          broadcastExtensionsChanged()
        } catch (error) {
          writeError(res, 400, 'disable-failed', error instanceof Error ? error.message : String(error))
        }
        return
      }
      writeError(res, 405, 'method-not-allowed', '只支持 POST/DELETE。')
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
      for (const disposer of disposers.splice(0)) disposer()
    },
  }
}
