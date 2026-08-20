import {
  runtimePhaseToState,
  type AgentRuntimeState,
  type AgentSummary,
  type ChannelRuntimeView,
  type ChannelSummary,
  type ConnectionSummary,
  type ConversationMessage,
  type DeliveryState,
  type ModelSummary,
  type ProductHostError,
} from './product-store.js'
import type { AdapterConnectionDescriptor, AdapterConfigurationProperty } from '@nekro-nxt/adapter-sdk'
import {
  HostApiContracts,
  HostApiErrorSchema,
  ChannelFactSseDataSchema,
  ChannelRuntimeSseDataSchema,
  HostSseStatusDataSchema,
  buildHostApiContractPath,
  type ChannelFactSseData,
  type ChannelRuntimeSseData,
  type HostApiContract,
  type HostApiContractParams,
  type HostApiContractRequest,
  type HostApiRequest,
  type HostApiResponse,
} from '@nekro-nxt/contracts'
import { providerDisplayName } from './provider-labels.js'
import type { ProductHostPort, ProductSnapshot } from './product-port.js'

/**
 * Real Host port for the Web product: consumes the NekroNxt domain API exposed
 * by `apps/server` through the DSH WebServer seam (design docs/08). The shell
 * snapshot is `GET /api/snapshot`. Live messages and work-trajectory updates
 * arrive as payloads on the single `GET /api/events` stream; REST remains the
 * first-load, paging, and reconnect-resync path. Mutations go through `execute`.
 *
 * The `ProductHostPort` contract is synchronous (`getSnapshot`), so this class
 * keeps the latest fetched projection as a cached snapshot. Transient network
 * failures while reading degrade to the last good snapshot. Mutations reject
 * with the Server's user-facing error so the initiating UI can show the real
 * outcome instead of presenting a false success.
 */

/** Delivery states from the domain Outbox, mapped to the UI 文案 vocabulary. */
const deliveryStateToUi = (state: string | undefined): DeliveryState | undefined => {
  switch (state) {
    case 'planned':
    case 'sending':
      return '发送中'
    case 'sent':
      return '已发送'
    case 'partially-sent':
      return '部分发送'
    case 'failed':
      return '失败'
    case 'unknown':
      return '结果未知'
    case undefined:
      return undefined
    default:
      return undefined
  }
}

const agentStateRank = (state: AgentRuntimeState): number => {
  if (state === '不可用') return 4
  if (state === '使用工具') return 3
  if (state === '思考中') return 2
  if (state === '等待输入') return 1
  return 0
}

const worstAgentState = (states: readonly AgentRuntimeState[]): AgentRuntimeState =>
  states.reduce<AgentRuntimeState>(
    (current, state) => (agentStateRank(state) > agentStateRank(current) ? state : current),
    '空闲',
  )

const sseEventData = (event: unknown): string | undefined => {
  if (event instanceof MessageEvent && typeof event.data === 'string') return event.data
  if (event && typeof event === 'object' && 'data' in event && typeof event.data === 'string') return event.data
  return undefined
}

const formatTime = (occurredAt: number): string =>
  new Date(occurredAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })

const visibleText = (text: string): string =>
  text
    .replaceAll('[QQ 消息不包含可处理内容]', '该 QQ 消息包含暂不支持显示的内容。')
    .replace(/<faceType=\d+,faceId="[^"]*",ext="[^"]*">/gu, '[QQ 表情]')

export const renderConversationBody = (
  parts: readonly {
    type: string
    text?: string | undefined
    memberId?: string | undefined
    displayName?: string | undefined
    assetId?: string | undefined
    alt?: string | undefined
    name?: string | undefined
  }[],
  mentionedConnectionAccount = false,
): string =>
  [
    ...(mentionedConnectionAccount ? ['@机器人账号'] : []),
    ...parts.map((part) => {
      if (part.type === 'text') return visibleText(part.text ?? '')
      if (part.type === 'mention') return `@${nonEmptyLabel(part.displayName, '群成员')}`
      if (part.type === 'image' || part.type === 'file' || part.type === 'audio') return ''
      if (part.type === 'quote') return '[引用消息]'
      return '[暂不支持显示的消息内容]'
    }),
  ]
    .filter((token) => token.trim().length > 0)
    .join(' ')

const emptySnapshot = (): ProductSnapshot => ({
  host: { status: 'initializing', error: null, lastSuccessfulAt: null },
  connectionAdapters: [],
  capabilityAvailability: {
    subagents: { available: true },
    webSearch: {
      provider: 'deepseek-official',
      available: false,
      credentialConfigured: false,
      credentialReference: 'DEEPSEEK_API_KEY',
      maxUsesPerCall: 2,
      maxResultsPerCall: 5,
      timeoutMs: 60_000,
    },
  },
  models: [],
  agents: [],
  channels: [],
  messages: [],
  channelRuntimes: {},
  connections: [],
  extensions: [],
  approvals: [],
  dynamic: [],
  diagnosticNote: '正在连接 NekroNxt 服务…',
  workTreeOrder: { agentIds: [], channelIdsByAgent: {}, unboundChannelIds: [] },
})

type SnapshotJson = HostApiResponse<'snapshot'>
type SnapshotMessageJson = SnapshotJson['messages'][number]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isStringRecord = (value: unknown): value is Record<string, string> =>
  isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string')

const isTriggerPolicy = (value: unknown): value is 'always' | 'mentioned-or-replied' | 'command' | 'observe-only' =>
  value === 'always' || value === 'mentioned-or-replied' || value === 'command' || value === 'observe-only'

const nonEmptyLabel = (value: string | undefined, fallback: string): string => value?.trim() || fallback

const projectAdapterProperty = (
  property: SnapshotJson['connectionAdapters'][number]['configSchema']['properties'][string],
): AdapterConfigurationProperty => {
  if (property.type === 'boolean') {
    return {
      type: property.type,
      title: property.title,
      ...(property.description === undefined ? {} : { description: property.description }),
      ...(property.default === undefined ? {} : { default: property.default }),
    }
  }
  if (property.type === 'number') {
    return {
      type: property.type,
      title: property.title,
      ...(property.description === undefined ? {} : { description: property.description }),
      ...(property.default === undefined ? {} : { default: property.default }),
    }
  }
  return {
    type: property.type,
    title: property.title,
    ...(property.description === undefined ? {} : { description: property.description }),
    ...(property.default === undefined ? {} : { default: property.default }),
  }
}

const projectAdapterDescriptor = (
  descriptor: SnapshotJson['connectionAdapters'][number],
): AdapterConnectionDescriptor => ({
  key: descriptor.key,
  displayName: descriptor.displayName,
  description: descriptor.description,
  userCreatable: descriptor.userCreatable,
  configSchema: {
    schemaVersion: descriptor.configSchema.schemaVersion,
    type: 'object',
    required: descriptor.configSchema.required,
    properties: Object.fromEntries(
      Object.entries(descriptor.configSchema.properties).map(([key, property]) => [
        key,
        projectAdapterProperty(property),
      ]),
    ),
  },
})

const qqChannelLabel = (platformChannelId: string, kind: 'group' | 'direct' = 'group'): string => {
  const suffix = platformChannelId.trim().match(/([\p{L}\p{N}]{4})$/u)?.[1]
  const type = kind === 'group' ? '群聊' : '私聊'
  return suffix ? `QQ ${type}（尾号 ${suffix}）` : `未命名 QQ ${type}`
}

const projectConversationMessage = (
  message: SnapshotMessageJson,
  channels: readonly ChannelSummary[],
  agents: readonly AgentSummary[],
): ConversationMessage => {
  const delivery = deliveryStateToUi(message.deliveryState)
  const sourceChannel = channels.find((channel) => channel.id === message.channelId)
  const sourceAgent = agents.find((agent) => agent.id === sourceChannel?.agentId)
  const resources = message.parts.flatMap((part) => {
    if (part.type !== 'image' && part.type !== 'file' && part.type !== 'audio') return []
    const kind = part.type
    const fallback = kind === 'image' ? '图片' : kind === 'audio' ? '语音' : '文件'
    const label = part.type === 'image' ? part.alt : part.type === 'file' ? part.name : undefined
    return [
      {
        assetId: part.assetId,
        kind,
        name: nonEmptyLabel(label, fallback),
        url: `/api/channels/${encodeURIComponent(message.channelId)}/assets/${encodeURIComponent(part.assetId)}`,
      },
    ]
  })
  return {
    id: message.id,
    channelId: message.channelId,
    role: message.role === 'agent' ? 'agent' : 'member',
    author:
      message.role === 'agent'
        ? (sourceAgent?.name ?? '智能体')
        : message.sender !== undefined
          ? nonEmptyLabel(message.sender.displayName, '群成员')
          : sourceChannel?.kind === 'web'
            ? '你'
            : '群成员',
    body: renderConversationBody(message.parts, message.mentionedConnectionAccount),
    time: formatTime(message.occurredAt),
    occurredAt: message.occurredAt,
    resources,
    ...(delivery === undefined ? {} : { delivery }),
  }
}

/**
 * Project the authoritative Server projection onto the Shell's `ProductSnapshot`
 * shape. Business facts are not copied into a second store — the Shell only
 * re-shapes them for display (design docs/08 §2.3).
 */
const projectSnapshot = (json: SnapshotJson, successfulAt: number): ProductSnapshot => {
  const models: ModelSummary[] = (json.models ?? []).map((model) => ({
    provider: model['provider'],
    providerName: providerDisplayName(model.provider, model.providerName),
    id: model.id,
    name: nonEmptyLabel(model.name, '未命名模型'),
    ...(model.description === undefined ? {} : { description: model.description }),
  }))
  const agents: AgentSummary[] = json.agents.map((agent) => ({
    id: agent.id,
    name: nonEmptyLabel(agent.displayName, '未命名智能体'),
    description: '',
    state: runtimePhaseToState(agent.runtimePhase, agent.runtimeStatus),
    model:
      models.find((model) => model['provider'] === agent.model['provider'] && model.id === agent.model['model'])
        ?.name ?? '未命名模型',
    modelRef: {
      provider: agent.model['provider'],
      model: agent.model['model'],
      ...(agent.model['reasoningEffort'] === undefined ? {} : { reasoningEffort: agent.model['reasoningEffort'] }),
    },
    persona: agent.persona ?? '',
    ...(agent.currentRevisionId === undefined ? {} : { currentRevisionId: agent.currentRevisionId }),
    channels: [...agent.channels],
    extensionCount: json.extensions.filter((extension) =>
      extension.activations.some((activation) => activation.agentId === agent.id),
    ).length,
    capabilities: { ...agent.capabilities },
  }))
  const connectionNameById = new Map(
    json.connections.map((connection) => [
      connection.id,
      connection.adapterKey === 'web'
        ? '网页聊天'
        : nonEmptyLabel(
            json.connectionAdapters.find((adapter) => adapter.key === connection.adapterKey)?.displayName,
            '未命名连接',
          ),
    ]),
  )
  const channels: ChannelSummary[] = json.channels.map((channel) => ({
    id: channel.id,
    connectionId: channel.connectionId,
    name: nonEmptyLabel(
      channel.displayName,
      channel.kind === 'web'
        ? '未命名 Web 频道'
        : qqChannelLabel(channel.platformChannelId, channel.kind === 'group' ? 'group' : 'direct'),
    ),
    kind: channel.kind === 'group' ? 'qq-group' : channel.kind === 'direct' ? 'qq-direct' : 'web',
    connectionName: connectionNameById.get(channel.connectionId) ?? '未命名连接',
    agentId: channel.boundAgentId ?? '',
    runtimePhase: runtimePhaseToState(channel.runtimePhase),
    trigger:
      channel.bindings[0]?.triggerPolicy === 'mentioned-or-replied'
        ? '被提及或回复时'
        : channel.bindings[0]?.triggerPolicy === 'observe-only'
          ? '仅观察'
          : channel.bindings[0]?.triggerPolicy === 'command'
            ? '收到命令时'
            : '始终响应',
    bindings: channel.bindings.map((binding) => ({
      id: `${binding.channelId}:${binding.agentId}:${binding.boundAt}`,
      agentId: binding.agentId,
      triggerPolicy: binding.triggerPolicy,
    })),
    unread: 0,
  }))
  const messages: ConversationMessage[] = json.messages.map((message) =>
    projectConversationMessage(message, channels, agents),
  )
  const testLabel = (
    result: { readonly status: string; readonly message?: string | undefined } | undefined,
  ): string => {
    if (!result) return '未测试'
    if (result.status === 'received' || result.status === 'sent') return '通过'
    return result.message ?? result.status
  }
  const connections: ConnectionSummary[] = json.connections.map((connection) => {
    const adapterName =
      connection.adapterKey === 'web'
        ? '网页聊天'
        : nonEmptyLabel(
            json.connectionAdapters.find((adapter) => adapter.key === connection.adapterKey)?.displayName,
            '未命名连接平台',
          )
    const gatewayState = connection.gateway?.state ?? (connection.adapterKey === 'web' ? 'connected' : 'disconnected')
    return {
      id: connection.id,
      name:
        connection.adapterKey === 'web'
          ? '网页聊天'
          : connection.adapterKey === 'qq-openclaw'
            ? 'QQ 机器人账号'
            : adapterName,
      adapter: adapterName,
      adapterKey: connection.adapterKey,
      state:
        gatewayState === 'connected'
          ? '已连接'
          : gatewayState === 'failed'
            ? '异常'
            : connection.credentialConfigured
              ? '已配置'
              : '已断开',
      appId: connection.appId ?? '',
      credentialConfigured: connection.credentialConfigured ?? false,
      gatewayState,
      lastError: connection.gateway?.lastError ?? '',
      proactiveSend: connection.proactiveSend ?? false,
      channels: connection.channelCount ?? 0,
      knownChannels: (connection.knownChannels ?? []).map((channel) => ({
        ...channel,
        name:
          channel.kind === 'group' && /^(?:group|guild):/u.test(channel.name)
            ? qqChannelLabel(channel.name)
            : channel.kind !== 'group' && /^(?:private|c2c):/u.test(channel.name)
              ? qqChannelLabel(channel.name, 'direct')
              : nonEmptyLabel(channel.name, channel.kind === 'group' ? '未命名 QQ 群聊' : '未命名频道'),
      })),
      lastEvent:
        connection.lastInbound === undefined
          ? '尚无入站消息'
          : new Date(connection.lastInbound.receivedAt).toLocaleString('zh-CN'),
      receiveTest: testLabel(connection.receiveTest),
      sendTest: testLabel(connection.sendTest),
    }
  })
  const extensionsLocal = json.extensions.map((extension) => {
    const targetAgentId = extension.createdByAgentId
    const activation =
      targetAgentId === undefined
        ? undefined
        : extension.activations.find((candidate) => candidate.agentId === targetAgentId)
    const latestRevision = extension.revisions.at(-1)
    const targetAgent = targetAgentId
      ? nonEmptyLabel(json.agents.find((agent) => agent.id === targetAgentId)?.displayName, '未命名智能体')
      : ''
    return {
      id: extension.id,
      name: extension.displayName,
      description: extension.description,
      revision: latestRevision?.revisionNumber ?? 0,
      activation: activation === undefined ? ('未激活' as const) : ('已激活' as const),
      targetAgent,
      contributions: [],
      ...(latestRevision === undefined ? {} : { revisionId: latestRevision.id }),
      ...(targetAgentId === undefined ? {} : { agentId: targetAgentId }),
    }
  })
  return {
    host: { status: 'ready', error: null, lastSuccessfulAt: successfulAt },
    connectionAdapters: json.connectionAdapters.map(projectAdapterDescriptor),
    capabilityAvailability: json.capabilityAvailability,
    models,
    agents,
    channels,
    messages,
    channelRuntimes: {},
    connections,
    workTreeOrder: json.workTreeOrder,
    extensions: extensionsLocal,
    approvals: [],
    dynamic: json.dynamic.map((item) => ({
      agentId: item.agentId,
      pluginId: item.pluginId,
      ...(item.packageId === undefined ? {} : { packageId: item.packageId }),
      ...(item.approvalRequestId === undefined ? {} : { approvalRequestId: item.approvalRequestId }),
      status: item.status,
    })),
    diagnosticNote: `服务连接正常（${agents.length} 个智能体 · ${channels.length} 个频道 · ${extensionsLocal.length} 个本地扩展）。`,
  }
}

export class HttpProductHost implements ProductHostPort {
  #snapshot: ProductSnapshot = emptySnapshot()
  #hostSnapshot: SnapshotJson | undefined
  #listener: (() => void) | undefined
  readonly #loadedChannels = new Set<string>()
  readonly #loadedRuntimes = new Set<string>()
  readonly #messageRevision = new Map<string, number>()
  readonly #runtimeRevision = new Map<string, number>()
  readonly #reconciling = new Set<string>()

  getSnapshot(): ProductSnapshot {
    return this.#snapshot
  }

  subscribe(listener: () => void): () => void {
    if (this.#listener) throw new Error('HttpProductHost 已经订阅，不能再订阅。')
    this.#listener = listener
    void this.#refreshAndNotify()
    let source: EventSource | undefined
    try {
      source = new EventSource('/api/events')
      source.addEventListener('open', () => {
        void this.#refreshAndNotify()
      })
      source.addEventListener('channel-fact', (event) => {
        const rawData = sseEventData(event)
        if (rawData === undefined) {
          void this.#refreshAndNotify()
          return
        }
        let parsed: ReturnType<typeof ChannelFactSseDataSchema.safeParse>
        try {
          parsed = ChannelFactSseDataSchema.safeParse(JSON.parse(rawData))
        } catch {
          void this.#refreshAndNotify()
          return
        }
        if (!parsed.success) {
          void this.#refreshAndNotify()
          return
        }
        this.#applyChannelFact(parsed.data)
      })
      source.addEventListener('runtime', (event) => {
        const rawData = sseEventData(event)
        if (rawData === undefined) return
        try {
          const parsed = ChannelRuntimeSseDataSchema.safeParse(JSON.parse(rawData))
          if (parsed.success) this.#applyRuntimeFrame(parsed.data)
        } catch {
          // Ignore malformed runtime frames; do not refetch the global snapshot.
        }
      })
      source.addEventListener('extensions-changed', () => {
        void this.#refreshAndNotify()
      })
      source.addEventListener('status', (event) => {
        const rawData = sseEventData(event)
        if (rawData === undefined) {
          void this.#refreshAndNotify()
          return
        }
        try {
          const parsed = HostSseStatusDataSchema.safeParse(JSON.parse(rawData))
          if (parsed.success && parsed.data.replay === 'complete') return
          if (parsed.success && parsed.data.replay === 'expired') {
            void this.#reconcileLoaded()
            return
          }
        } catch {
          // Fall through to a snapshot refresh for unparseable status frames.
        }
        void this.#refreshAndNotify()
      })
      source.onerror = () => {
        this.#publishFailure({ code: 'sse', message: '与 NekroNxt Host 的实时连接已中断，正在尝试恢复。' })
      }
    } catch (cause) {
      this.#publishFailure({ code: 'sse', message: errorMessage(cause, '无法建立 NekroNxt Host 实时连接。') })
    }
    return () => {
      this.#listener = undefined
      source?.close()
    }
  }

  async execute(command: string, input?: Readonly<Record<string, unknown>>): Promise<unknown> {
    if (command === 'host.refresh') {
      const failure = await this.#refreshAndNotify()
      if (failure !== null) throw failure
      return null
    }
    if (command === 'agents.create') {
      const body = createAgentRequestBody(input)
      const result = await this.#call(HostApiContracts.createAgent, {}, body)
      await this.#refreshAndNotify()
      return result
    }
    if (command === 'agents.revise') {
      const agentId = typeof input?.['agentId'] === 'string' ? input['agentId'] : ''
      const expectedCurrentRevisionId =
        typeof input?.['expectedCurrentRevisionId'] === 'string' ? input['expectedCurrentRevisionId'] : ''
      const displayName = typeof input?.['displayName'] === 'string' ? input['displayName'] : ''
      const persona = typeof input?.['persona'] === 'string' ? input['persona'] : ''
      const model = isRecord(input?.['model']) ? input['model'] : {}
      if (
        !agentId.trim() ||
        !expectedCurrentRevisionId.trim() ||
        !displayName.trim() ||
        typeof model['provider'] !== 'string' ||
        !model['provider'].trim() ||
        typeof model['model'] !== 'string' ||
        !model['model'].trim()
      ) {
        throw new Error('智能体配置不完整，请刷新页面后重试。')
      }
      const result = await this.#call(
        HostApiContracts.reviseAgent,
        { agentId },
        {
          expectedCurrentRevisionId,
          displayName,
          persona,
          model: {
            provider: model['provider'],
            model: model['model'],
            ...(typeof model['reasoningEffort'] === 'string' ? { reasoningEffort: model['reasoningEffort'] } : {}),
          },
        },
      )
      await this.#refreshAndNotify()
      return result
    }
    if (command === 'channels.sendMessage') {
      const channelId = typeof input?.['channelId'] === 'string' ? input['channelId'] : ''
      const text = typeof input?.['body'] === 'string' ? input['body'] : ''
      if (!channelId.trim()) throw new Error('缺少目标频道，请刷新页面后重试。')
      if (!text.trim()) throw new Error('消息内容不能为空。')
      const result = await this.#call(
        HostApiContracts.sendChannelMessage,
        { channelId },
        {
          parts: [{ type: 'text', text }],
        },
      )
      await this.#refreshAndNotify()
      return result
    }
    if (command === 'channels.listMessages') {
      const channelId = typeof input?.['channelId'] === 'string' ? input['channelId'] : ''
      const mode = input?.['mode'] === 'older' || input?.['mode'] === 'latest' ? input['mode'] : 'initial'
      const limit = typeof input?.['limit'] === 'number' ? Math.min(Math.max(Math.trunc(input['limit']), 1), 100) : 40
      if (!channelId.trim()) throw new Error('缺少目标频道，请刷新页面后重试。')
      const beforeOccurredAt = typeof input?.['beforeOccurredAt'] === 'number' ? input['beforeOccurredAt'] : undefined
      const beforeSourceId = typeof input?.['beforeSourceId'] === 'string' ? input['beforeSourceId'] : undefined
      return await this.#loadChannelMessages(channelId, mode, limit, beforeOccurredAt, beforeSourceId)
    }
    if (command === 'channels.getRuntime') {
      const channelId = typeof input?.['channelId'] === 'string' ? input['channelId'] : ''
      if (!channelId.trim()) throw new Error('缺少目标频道，请刷新页面后重试。')
      return await this.#loadChannelRuntime(channelId)
    }
    if (command === 'channels.rename') {
      const channelId = typeof input?.['channelId'] === 'string' ? input['channelId'] : ''
      const displayName = typeof input?.['displayName'] === 'string' ? input['displayName'] : ''
      if (!channelId.trim()) throw new Error('缺少目标频道，请刷新页面后重试。')
      if (!displayName.trim()) throw new Error('请输入频道名称。')
      const result = await this.#call(
        HostApiContracts.renameChannel,
        { channelId },
        {
          displayName,
        },
      )
      await this.#refreshAndNotify()
      return result
    }
    if (command === 'agents.updateCapabilities') {
      const agentId = typeof input?.['agentId'] === 'string' ? input['agentId'] : ''
      if (!agentId.trim()) throw new Error('缺少智能体标识，请刷新页面后重试。')
      const body: Record<string, unknown> = {}
      if (typeof input?.['subagents'] === 'boolean') body['subagents'] = input['subagents']
      if (typeof input?.['fileTools'] === 'boolean') body['fileTools'] = input['fileTools']
      if (typeof input?.['webSearch'] === 'boolean') body['webSearch'] = input['webSearch']
      if (typeof input?.['dynamicCreation'] === 'boolean') body['dynamicCreation'] = input['dynamicCreation']
      if (typeof input?.['developmentShell'] === 'boolean') body['developmentShell'] = input['developmentShell']
      if (typeof input?.['unrestrictedFileAccess'] === 'boolean') {
        body['unrestrictedFileAccess'] = input['unrestrictedFileAccess']
      }
      if (Object.keys(body).length === 0) throw new Error('请选择至少一项要更新的智能体权限。')
      const result = await this.#call(HostApiContracts.updateAgentCapabilities, { agentId }, body)
      await this.#refreshAndNotify()
      return result
    }
    if (command === 'connections.create') {
      const adapterKey = typeof input?.['adapterKey'] === 'string' ? input['adapterKey'] : ''
      const configuration = isRecord(input?.['configuration'])
        ? HostApiContracts.createConnection.request.shape.configuration.parse(input['configuration'])
        : undefined
      const credentials = isStringRecord(input?.['credentials']) ? input['credentials'] : undefined
      if (!adapterKey.trim()) throw new Error('请选择连接平台。')
      if (configuration === undefined || credentials === undefined) throw new Error('连接配置格式无效，请重新填写。')
      const result = await this.#call(HostApiContracts.createConnection, {}, { adapterKey, configuration, credentials })
      await this.#refreshAndNotify()
      return result
    }
    if (command === 'channels.createWeb') {
      const displayName = typeof input?.['displayName'] === 'string' ? input['displayName'] : ''
      if (!displayName.trim()) throw new Error('请输入频道名称。')
      const result = await this.#call(HostApiContracts.createWebChannel, {}, { displayName: displayName.trim() })
      await this.#refreshAndNotify()
      return result
    }
    if (command === 'bindings.create') {
      const agentId = typeof input?.['agentId'] === 'string' ? input['agentId'] : ''
      const channelId = typeof input?.['channelId'] === 'string' ? input['channelId'] : ''
      const triggerPolicy = isTriggerPolicy(input?.['triggerPolicy']) ? input['triggerPolicy'] : undefined
      if (!agentId.trim()) throw new Error('缺少智能体标识，请刷新页面后重试。')
      if (!channelId.trim()) throw new Error('请选择要绑定的频道。')
      if (triggerPolicy === undefined) {
        throw new Error('频道触发策略无效，请重新选择。')
      }
      const result = await this.#call(HostApiContracts.createBinding, {}, { agentId, channelId, triggerPolicy })
      await this.#refreshAndNotify()
      return result
    }
    if (command === 'bindings.clear') {
      const channelId = typeof input?.['channelId'] === 'string' ? input['channelId'] : ''
      if (!channelId.trim()) throw new Error('请选择要解除绑定的频道。')
      const result = await this.#call(HostApiContracts.clearBinding, { channelId }, undefined)
      await this.#refreshAndNotify()
      return result
    }
    if (command === 'workTreeOrder.put') {
      const agentIds = Array.isArray(input?.['agentIds'])
        ? input['agentIds'].filter((id) => typeof id === 'string')
        : []
      const unboundChannelIds = Array.isArray(input?.['unboundChannelIds'])
        ? input['unboundChannelIds'].filter((id) => typeof id === 'string')
        : []
      const rawByAgent = isRecord(input?.['channelIdsByAgent']) ? input['channelIdsByAgent'] : {}
      const channelIdsByAgent: Record<string, string[]> = {}
      for (const [agentId, value] of Object.entries(rawByAgent)) {
        if (Array.isArray(value)) channelIdsByAgent[agentId] = value.filter((id) => typeof id === 'string')
      }
      const result = await this.#call(
        HostApiContracts.putWorkTreeOrder,
        {},
        { agentIds, channelIdsByAgent, unboundChannelIds },
      )
      await this.#refreshAndNotify()
      return result
    }
    if (command === 'connections.test') {
      const connectionId = typeof input?.['connectionId'] === 'string' ? input['connectionId'] : ''
      const direction =
        input?.['direction'] === 'receive' || input?.['direction'] === 'send' ? input['direction'] : undefined
      const channelId = typeof input?.['channelId'] === 'string' ? input['channelId'] : undefined
      if (!connectionId.trim()) throw new Error('缺少连接标识，请刷新页面后重试。')
      if (direction === undefined) throw new Error('连接测试方向无效，请重新选择。')
      const result = await this.#call(
        HostApiContracts.testConnection,
        { connectionId },
        {
          direction,
          ...(channelId === undefined ? {} : { channelId }),
        },
      )
      await this.#refreshAndNotify()
      return result
    }
    if (command === 'dynamic.approve' || command === 'dynamic.decline') {
      const agentId = typeof input?.['agentId'] === 'string' ? input['agentId'] : ''
      const requestId = typeof input?.['requestId'] === 'string' ? input['requestId'] : ''
      const pluginRunId = typeof input?.['pluginRunId'] === 'string' ? input['pluginRunId'] : ''
      if (!agentId.trim()) throw new Error('缺少智能体标识，请刷新页面后重试。')
      if (!requestId.trim()) throw new Error('缺少批准请求，请刷新页面后重试。')
      const result = await this.#call(
        command === 'dynamic.approve' ? HostApiContracts.dynamicApprove : HostApiContracts.dynamicDecline,
        { agentId },
        { requestId, ...(pluginRunId.trim() ? { pluginRunId } : {}) },
      )
      await this.#refreshAndNotify()
      return result
    }
    if (command === 'extensions.activate') {
      const extensionId = typeof input?.['extensionId'] === 'string' ? input['extensionId'] : ''
      const agentId = typeof input?.['agentId'] === 'string' ? input['agentId'] : ''
      const revisionId = typeof input?.['revisionId'] === 'string' ? input['revisionId'] : ''
      if (!extensionId.trim()) throw new Error('缺少本地扩展标识，请刷新页面后重试。')
      if (!agentId.trim()) throw new Error('此本地扩展缺少目标智能体，无法启用。')
      if (!revisionId.trim()) throw new Error('此本地扩展缺少可启用版本，请重新保存后重试。')
      const result = await this.#call(HostApiContracts.activateExtension, { agentId, extensionId }, { revisionId })
      await this.#refreshAndNotify()
      return result
    }
    if (command === 'extensions.deactivate') {
      const extensionId = typeof input?.['extensionId'] === 'string' ? input['extensionId'] : ''
      if (!extensionId.trim()) throw new Error('缺少本地扩展标识，请刷新页面后重试。')
      const agentId = typeof input?.['agentId'] === 'string' ? input['agentId'] : ''
      if (!agentId.trim()) throw new Error('此本地扩展缺少目标智能体，无法停用。')
      const result = await this.#call(HostApiContracts.deactivateExtension, { agentId, extensionId }, undefined)
      await this.#refreshAndNotify()
      return result
    }
    if (command === 'extensions.saveFromDynamic') {
      const agentId = typeof input?.['agentId'] === 'string' ? input['agentId'] : ''
      const name = typeof input?.['name'] === 'string' ? input['name'] : ''
      const slug = typeof input?.['slug'] === 'string' ? input['slug'] : ''
      const description = typeof input?.['description'] === 'string' ? input['description'] : ''
      if (!agentId.trim()) throw new Error('缺少智能体标识，请刷新页面后重试。')
      if (!name.trim()) throw new Error('请输入本地扩展名称。')
      if (!slug.trim()) throw new Error('缺少本地扩展标识，请重新生成后重试。')
      const dynamicPackage = this.#hostSnapshot?.dynamic.find(
        (item) => item.agentId === agentId && item.packageId !== undefined,
      )
      if (dynamicPackage?.packageId === undefined) throw new Error('该智能体当前没有可保存的动态包。')
      const result = await this.#call(
        HostApiContracts.saveExtensionFromDynamic,
        {},
        {
          agentId,
          episodeId: dynamicPackage.episodeId,
          pluginId: dynamicPackage.pluginId,
          packageId: dynamicPackage.packageId,
          name,
          displayName: name,
          slug,
          description: description.trim() || '从创造工作台保存的动态 Package。',
        },
      )
      await this.#refreshAndNotify()
      return result
    }
    throw new Error(`当前 Web Host 不支持操作“${command}”。`)
  }

  async #call<Contract extends HostApiContract, Output>(
    contract: Contract & { readonly parseResponse: (input: unknown) => Output },
    params: HostApiContractParams<Contract>,
    body: HostApiContractRequest<Contract>,
  ): Promise<Output> {
    return this.#observeRequest(() => callHostApi(contract, params, body))
  }

  async #loadChannelMessages(
    channelId: string,
    mode: 'initial' | 'older' | 'latest',
    limit: number,
    beforeOccurredAt?: number,
    beforeSourceId?: string,
  ): Promise<{ readonly messages: readonly ConversationMessage[]; readonly hasMore: boolean }> {
    this.#reconciling.add(channelId)
    try {
      const raw = await this.#call(
        HostApiContracts.listChannelMessages,
        {
          channelId,
          limit,
          ...(beforeOccurredAt === undefined ? {} : { beforeOccurredAt }),
          ...(beforeSourceId === undefined ? {} : { beforeSourceId }),
        },
        undefined,
      )
      const projected = raw.messages.map((message) =>
        projectConversationMessage(message, this.#snapshot.channels, this.#snapshot.agents),
      )
      const other = this.#snapshot.messages.filter((message) => message.channelId !== channelId)
      const current = this.#snapshot.messages.filter((message) => message.channelId === channelId)
      const combined =
        mode === 'older' ? [...projected, ...current] : mode === 'latest' ? [...current, ...projected] : projected
      const deduplicated = [...new Map(combined.map((message) => [message.id, message])).values()].sort(
        (left, right) => (left.occurredAt ?? 0) - (right.occurredAt ?? 0),
      )
      this.#loadedChannels.add(channelId)
      this.#messageRevision.delete(channelId)
      this.#snapshot = { ...this.#snapshot, messages: [...other, ...deduplicated] }
      this.#listener?.()
      return { messages: projected, hasMore: raw.hasMore }
    } finally {
      this.#reconciling.delete(channelId)
    }
  }

  async #loadChannelRuntime(channelId: string): Promise<ChannelRuntimeView> {
    this.#reconciling.add(`runtime:${channelId}`)
    try {
      const raw = await this.#call(HostApiContracts.getChannelRuntime, { channelId }, undefined)
      const view = this.#runtimeViewFromProjection(raw)
      this.#loadedRuntimes.add(channelId)
      this.#runtimeRevision.delete(channelId)
      this.#writeRuntimeView(view, { includeTurns: true })
      return view
    } finally {
      this.#reconciling.delete(`runtime:${channelId}`)
    }
  }

  #applyChannelFact(data: ChannelFactSseData): void {
    if (
      !this.#loadedChannels.has(data.channelId) &&
      !this.#snapshot.messages.some((message) => message.channelId === data.channelId)
    ) {
      return
    }
    this.#loadedChannels.add(data.channelId)
    if (this.#reconciling.has(data.channelId)) return
    const last = this.#messageRevision.get(data.channelId)
    if (last !== undefined && data.revision !== last + 1) {
      void this.#loadChannelMessages(data.channelId, 'latest', 40)
      return
    }
    const projected = data.items.map((item) =>
      projectConversationMessage(item.message, this.#snapshot.channels, this.#snapshot.agents),
    )
    const other = this.#snapshot.messages.filter((message) => message.channelId !== data.channelId)
    const current = this.#snapshot.messages.filter((message) => message.channelId === data.channelId)
    const combined = [...current, ...projected]
    const deduplicated = [...new Map(combined.map((message) => [message.id, message])).values()].sort(
      (left, right) => (left.occurredAt ?? 0) - (right.occurredAt ?? 0),
    )
    this.#messageRevision.set(data.channelId, data.revision)
    this.#snapshot = { ...this.#snapshot, messages: [...other, ...deduplicated] }
    this.#listener?.()
  }

  #applyRuntimeFrame(data: ChannelRuntimeSseData): void {
    const view = this.#runtimeViewFromProjection(data)
    this.#writeRuntimeView(view, { includeTurns: false })
    if (!this.#loadedRuntimes.has(data.channelId)) return
    if (this.#reconciling.has(`runtime:${data.channelId}`)) return
    const last = this.#runtimeRevision.get(data.channelId)
    if (data.truncated === true || (last !== undefined && data.revision !== last + 1)) {
      void this.#loadChannelRuntime(data.channelId)
      return
    }
    this.#runtimeRevision.set(data.channelId, data.revision)
    this.#writeRuntimeView(view, { includeTurns: true })
  }

  #runtimeViewFromProjection(
    raw: Pick<
      ChannelRuntimeSseData,
      'channelId' | 'agentId' | 'episodeId' | 'phase' | 'summary' | 'pendingInjectCount' | 'occupancy' | 'turns'
    >,
  ): ChannelRuntimeView {
    return {
      channelId: raw.channelId,
      ...(raw.agentId === undefined ? {} : { agentId: raw.agentId }),
      ...(raw.episodeId === undefined ? {} : { episodeId: raw.episodeId }),
      phase: runtimePhaseToState(raw.phase),
      summary: raw.summary,
      pendingInjectCount: raw.pendingInjectCount,
      ...(raw.occupancy === undefined ? {} : { occupancy: raw.occupancy }),
      turns: raw.turns,
    }
  }

  #writeRuntimeView(view: ChannelRuntimeView, options: { readonly includeTurns: boolean }): void {
    const channelId = view.channelId
    const nextRuntimes = { ...this.#snapshot.channelRuntimes }
    if (options.includeTurns) nextRuntimes[channelId] = view
    this.#snapshot = {
      ...this.#snapshot,
      channelRuntimes: nextRuntimes,
      channels: this.#snapshot.channels.map((channel) =>
        channel.id === channelId ? { ...channel, runtimePhase: view.phase } : channel,
      ),
      agents: this.#snapshot.agents.map((agent) => {
        if (agent.id !== view.agentId) return agent
        const phases = this.#snapshot.channels
          .filter((channel) => channel.agentId === agent.id)
          .map((channel) => (channel.id === channelId ? view.phase : channel.runtimePhase))
        return { ...agent, state: worstAgentState(phases) }
      }),
    }
    this.#listener?.()
  }

  async #reconcileLoaded(): Promise<void> {
    await this.#refreshAndNotify()
    await Promise.all([
      ...[...this.#loadedChannels].map((channelId) => this.#loadChannelMessages(channelId, 'latest', 40)),
      ...[...this.#loadedRuntimes].map((channelId) => this.#loadChannelRuntime(channelId)),
    ])
  }

  async #observeRequest<Result>(request: () => Promise<Result>): Promise<Result> {
    try {
      return await request()
    } catch (cause) {
      if (cause instanceof HostRequestError && cause.kind === 'network') {
        this.#publishFailure({ code: 'network', message: cause.message })
      }
      throw cause
    }
  }

  async #refreshAndNotify(): Promise<Error | null> {
    let json: SnapshotJson
    try {
      json = await callHostApi(HostApiContracts.snapshot, {}, undefined)
    } catch (cause) {
      const failure = cause instanceof Error ? cause : new Error(errorMessage(cause, '无法连接 NekroNxt Host。'))
      const code =
        cause instanceof HostRequestError
          ? cause.kind === 'network'
            ? 'network'
            : cause.kind === 'http'
              ? 'http'
              : 'invalid-snapshot'
          : 'invalid-snapshot'
      this.#publishFailure({ code, message: failure.message })
      return failure
    }
    const projected = projectSnapshot(json, Date.now())
    this.#hostSnapshot = json
    this.#snapshot = {
      ...projected,
      messages: this.#loadedChannels.size > 0 ? this.#snapshot.messages : projected.messages,
      channelRuntimes: this.#snapshot.channelRuntimes,
    }
    for (const message of this.#snapshot.messages) this.#loadedChannels.add(message.channelId)
    this.#listener?.()
    return null
  }

  #publishFailure(error: ProductHostError): void {
    const hasSnapshot = this.#snapshot.host.lastSuccessfulAt !== null
    this.#snapshot = {
      ...this.#snapshot,
      host: {
        status: hasSnapshot ? 'stale' : 'error',
        error,
        lastSuccessfulAt: this.#snapshot.host.lastSuccessfulAt,
      },
      diagnosticNote: hasSnapshot
        ? `Host 连接异常，当前显示上次成功数据：${error.message}`
        : `Host 初始化失败：${error.message}`,
    }
    this.#listener?.()
  }
}

const createAgentRequestBody = (input?: Readonly<Record<string, unknown>>): HostApiRequest<'createAgent'> => {
  const displayName = typeof input?.['displayName'] === 'string' ? input['displayName'] : ''
  const model = isRecord(input?.['model']) ? input['model'] : undefined
  const provider = typeof model?.['provider'] === 'string' ? model['provider'].trim() : ''
  const modelId = typeof model?.['model'] === 'string' ? model['model'].trim() : ''
  const persona = typeof input?.['persona'] === 'string' ? input['persona'] : ''
  const rawCapabilities = isRecord(input?.['capabilities']) ? input['capabilities'] : {}
  if (!displayName.trim()) throw new Error('请输入智能体名称。')
  if (!provider || !modelId) throw new Error('请选择当前可用的模型。')
  return {
    displayName: displayName.trim(),
    persona,
    model: { provider, model: modelId },
    capabilities: {
      subagents: rawCapabilities['subagents'] === true,
      fileTools: rawCapabilities['fileTools'] === true,
      webSearch: rawCapabilities['webSearch'] === true,
      dynamicCreation: rawCapabilities['dynamicCreation'] === true,
      developmentShell: rawCapabilities['developmentShell'] === true,
      unrestrictedFileAccess: rawCapabilities['unrestrictedFileAccess'] === true,
    },
  }
}

const errorMessage = (cause: unknown, fallback: string): string =>
  cause instanceof Error && cause.message.trim() ? cause.message : fallback

class HostRequestError extends Error {
  constructor(
    readonly kind: 'network' | 'http' | 'invalid-response',
    message: string,
  ) {
    super(message)
    this.name = 'HostRequestError'
  }
}

const callHostApi = async <Contract extends HostApiContract, Output>(
  contract: Contract & { readonly parseResponse: (input: unknown) => Output },
  params: HostApiContractParams<Contract>,
  body: HostApiContractRequest<Contract>,
): Promise<Output> => {
  const path = buildHostApiContractPath(contract, params)
  const requestBody = contract.parseRequest(body)
  let response: Response
  try {
    response = await fetch(path, {
      method: contract.method,
      headers: {
        accept: 'application/json',
        ...(requestBody === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(requestBody === undefined ? {} : { body: JSON.stringify(requestBody) }),
    })
  } catch (cause) {
    throw new HostRequestError('network', errorMessage(cause, '无法连接 NekroNxt Host。'))
  }
  const json: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const parsedError = HostApiErrorSchema.safeParse(json)
    throw new HostRequestError(
      'http',
      parsedError.success ? parsedError.data.error.message : `服务请求失败：${response.status}`,
    )
  }
  try {
    const parseResponse: (input: unknown) => Output = contract.parseResponse
    return parseResponse(json)
  } catch (cause) {
    throw new HostRequestError(
      'invalid-response',
      `NekroNxt Host 返回的数据格式无效：${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }
}
