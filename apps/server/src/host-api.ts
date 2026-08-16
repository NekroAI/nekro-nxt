import type { WebServer, WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { OutboundState } from '@nekro-nxt/channel-runtime'
import type { AgentRevisionContent } from '@nekro-nxt/core'
import type { AgentId, ChannelId, ExtensionId, ExtensionRevisionId, MessagePart } from '@nekro-nxt/contracts'
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
