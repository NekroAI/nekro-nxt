import type {
  AgentSummary,
  ChannelSummary,
  ConnectionSummary,
  ConversationMessage,
  DeliveryState,
  ModelSummary,
  ProductHostError,
} from './product-store.js'
import type { AdapterConnectionDescriptor } from '@nekro-nxt/adapter-sdk'
import { providerDisplayName } from './provider-labels.js'
import type { ProductHostPort, ProductSnapshot } from './product-port.js'

/**
 * Real Host port for the Web product: consumes the NekroNxt domain API exposed
 * by `apps/server` through the DSH WebServer seam (design docs/08). All read
 * traffic is one authoritative projection (`GET /api/snapshot`), live updates
 * ride a single SSE stream (`GET /api/events`), and every mutating product
 * action is a POST through `execute`.
 *
 * The `ProductHostPort` contract is synchronous (`getSnapshot`), so this class
 * keeps the latest fetched projection as a cached snapshot; `subscribe` starts
 * the SSE stream and refreshes the cache on each event. Transient network
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

const formatTime = (occurredAt: number): string =>
  new Date(occurredAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })

const visibleText = (text: string): string =>
  text
    .replaceAll('[QQ 消息不包含可处理内容]', '该 QQ 消息包含暂不支持显示的内容。')
    .replace(/<faceType=\d+,faceId="[^"]*",ext="[^"]*">/gu, '[QQ 表情]')

export const renderConversationBody = (
  parts: readonly {
    type: string
    text?: string
    memberId?: string
    displayName?: string
    assetId?: string
    alt?: string
    name?: string
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
  models: [],
  agents: [],
  channels: [],
  messages: [],
  connections: [],
  extensions: [],
  approvals: [],
  dynamic: [],
  diagnosticNote: '正在连接 NekroNxt 服务…',
})

interface SnapshotAgentJson {
  readonly id: string
  readonly displayName: string
  readonly persona?: string
  readonly currentRevisionId?: string
  readonly runtimeStatus?: 'idle' | 'running'
  readonly model: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
  readonly capabilities: {
    readonly dynamicCreation: boolean
    readonly developmentShell: boolean
    readonly fullFileAccess: boolean
  }
  readonly channels: readonly string[]
}

interface SnapshotModelJson {
  readonly provider: string
  readonly providerName: string
  readonly id: string
  readonly name: string
  readonly description?: string
}

interface SnapshotChannelJson {
  readonly id: string
  readonly connectionId: string
  readonly platformChannelId: string
  readonly kind: string
  readonly displayName?: string
  readonly boundAgentId?: string
  readonly bindings: readonly {
    readonly id: string
    readonly agentId: string
    readonly triggerPolicy: 'always' | 'mentioned-or-replied' | 'command' | 'observe-only'
  }[]
}

interface SnapshotMessageJson {
  readonly id: string
  readonly channelId: string
  readonly role: 'member' | 'agent'
  readonly parts: readonly {
    type: string
    text?: string
    memberId?: string
    displayName?: string
    assetId?: string
    alt?: string
    name?: string
  }[]
  readonly sender?: { readonly memberId: string; readonly displayName?: string }
  readonly mentionedConnectionAccount?: boolean
  readonly occurredAt: number
  readonly deliveryState?: string
}

interface SnapshotConnectionJson {
  readonly id: string
  readonly adapterKey: string
  readonly status: string
  readonly appId?: string
  readonly proactiveSend?: boolean
  readonly credentialConfigured?: boolean
  readonly channelCount?: number
  readonly knownChannels?: readonly { readonly id: string; readonly name: string; readonly kind: string }[]
  readonly gateway?: { readonly state: string; readonly lastError?: string }
  readonly lastInbound?: { readonly receivedAt: number }
  readonly receiveTest?: { readonly status: string; readonly message?: string }
  readonly sendTest?: { readonly status: string; readonly message?: string }
}

interface SnapshotExtensionJson {
  readonly id: string
  readonly slug: string
  readonly displayName: string
  readonly description: string
  readonly revisionNumber: number
  readonly revisionId: string
  readonly activation: string
  readonly agentId?: string
}

interface SnapshotDynamicItemJson {
  readonly agentId: string
  readonly pluginId: string
  readonly packageId?: string
  readonly approvalRequestId?: string
  readonly status: string
}

interface SnapshotJson {
  readonly connectionAdapters: readonly AdapterConnectionDescriptor[]
  readonly models?: readonly SnapshotModelJson[]
  readonly agents: readonly SnapshotAgentJson[]
  readonly channels: readonly SnapshotChannelJson[]
  readonly messages: readonly SnapshotMessageJson[]
  readonly connections: readonly SnapshotConnectionJson[]
  readonly extensions: readonly SnapshotExtensionJson[]
  readonly dynamic: readonly SnapshotDynamicItemJson[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasString = (value: Record<string, unknown>, key: string): boolean => typeof value[key] === 'string'
const hasOptionalString = (value: Record<string, unknown>, key: string): boolean =>
  value[key] === undefined || typeof value[key] === 'string'
const hasOptionalBoolean = (value: Record<string, unknown>, key: string): boolean =>
  value[key] === undefined || typeof value[key] === 'boolean'
const hasOptionalFiniteNumber = (value: Record<string, unknown>, key: string): boolean =>
  value[key] === undefined || (typeof value[key] === 'number' && Number.isFinite(value[key]))

const isSnapshotJson = (value: unknown): value is SnapshotJson => {
  if (!isRecord(value)) return false
  const arrays = ['connectionAdapters', 'agents', 'channels', 'messages', 'connections', 'extensions', 'dynamic']
  if (!arrays.every((key) => Array.isArray(value[key]))) return false
  if (value.models !== undefined && !Array.isArray(value.models)) return false

  const adaptersValid = (value.connectionAdapters as unknown[]).every(
    (item) => isRecord(item) && hasString(item, 'key') && hasString(item, 'displayName'),
  )
  const modelsValid = ((value.models as unknown[] | undefined) ?? []).every(
    (item) =>
      isRecord(item) &&
      hasString(item, 'provider') &&
      hasString(item, 'providerName') &&
      hasString(item, 'id') &&
      hasString(item, 'name') &&
      hasOptionalString(item, 'description'),
  )
  const agentsValid = (value.agents as unknown[]).every(
    (item) =>
      isRecord(item) &&
      hasString(item, 'id') &&
      hasString(item, 'displayName') &&
      hasOptionalString(item, 'persona') &&
      hasOptionalString(item, 'currentRevisionId') &&
      (item.runtimeStatus === undefined || item.runtimeStatus === 'idle' || item.runtimeStatus === 'running') &&
      isRecord(item.model) &&
      hasString(item.model, 'provider') &&
      hasString(item.model, 'model') &&
      hasOptionalString(item.model, 'reasoningEffort') &&
      isRecord(item.capabilities) &&
      typeof item.capabilities.dynamicCreation === 'boolean' &&
      typeof item.capabilities.developmentShell === 'boolean' &&
      typeof item.capabilities.fullFileAccess === 'boolean' &&
      Array.isArray(item.channels) &&
      item.channels.every((channelId) => typeof channelId === 'string'),
  )
  const channelsValid = (value.channels as unknown[]).every(
    (item) =>
      isRecord(item) &&
      hasString(item, 'id') &&
      hasString(item, 'connectionId') &&
      hasString(item, 'platformChannelId') &&
      (item.kind === 'web' || item.kind === 'group' || item.kind === 'direct') &&
      hasOptionalString(item, 'displayName') &&
      hasOptionalString(item, 'boundAgentId') &&
      Array.isArray(item.bindings) &&
      item.bindings.every(
        (binding) =>
          isRecord(binding) &&
          hasString(binding, 'id') &&
          hasString(binding, 'agentId') &&
          ['always', 'mentioned-or-replied', 'command', 'observe-only'].includes(
            typeof binding.triggerPolicy === 'string' ? binding.triggerPolicy : '',
          ),
      ),
  )
  const messagesValid = (value.messages as unknown[]).every(
    (item) =>
      isRecord(item) &&
      hasString(item, 'id') &&
      hasString(item, 'channelId') &&
      (item.role === 'member' || item.role === 'agent') &&
      typeof item.occurredAt === 'number' &&
      Number.isFinite(item.occurredAt) &&
      hasOptionalString(item, 'deliveryState') &&
      (item.sender === undefined ||
        (isRecord(item.sender) &&
          hasString(item.sender, 'memberId') &&
          hasOptionalString(item.sender, 'displayName'))) &&
      hasOptionalBoolean(item, 'mentionedConnectionAccount') &&
      Array.isArray(item.parts) &&
      item.parts.every(
        (part) =>
          isRecord(part) &&
          hasString(part, 'type') &&
          hasOptionalString(part, 'text') &&
          hasOptionalString(part, 'memberId') &&
          hasOptionalString(part, 'displayName') &&
          hasOptionalString(part, 'assetId') &&
          hasOptionalString(part, 'alt') &&
          hasOptionalString(part, 'name'),
      ),
  )
  const connectionsValid = (value.connections as unknown[]).every(
    (item) =>
      isRecord(item) &&
      hasString(item, 'id') &&
      hasString(item, 'adapterKey') &&
      hasString(item, 'status') &&
      hasOptionalString(item, 'appId') &&
      hasOptionalBoolean(item, 'proactiveSend') &&
      hasOptionalBoolean(item, 'credentialConfigured') &&
      hasOptionalFiniteNumber(item, 'channelCount') &&
      (item.knownChannels === undefined ||
        (Array.isArray(item.knownChannels) &&
          item.knownChannels.every(
            (channel) =>
              isRecord(channel) && hasString(channel, 'id') && hasString(channel, 'name') && hasString(channel, 'kind'),
          ))) &&
      (item.gateway === undefined ||
        (isRecord(item.gateway) && hasString(item.gateway, 'state') && hasOptionalString(item.gateway, 'lastError'))) &&
      (item.lastInbound === undefined ||
        (isRecord(item.lastInbound) &&
          typeof item.lastInbound.receivedAt === 'number' &&
          Number.isFinite(item.lastInbound.receivedAt))) &&
      (item.receiveTest === undefined ||
        (isRecord(item.receiveTest) &&
          hasString(item.receiveTest, 'status') &&
          hasOptionalString(item.receiveTest, 'message'))) &&
      (item.sendTest === undefined ||
        (isRecord(item.sendTest) && hasString(item.sendTest, 'status') && hasOptionalString(item.sendTest, 'message'))),
  )
  const extensionsValid = (value.extensions as unknown[]).every(
    (item) =>
      isRecord(item) &&
      hasString(item, 'id') &&
      hasString(item, 'slug') &&
      hasString(item, 'displayName') &&
      hasString(item, 'description') &&
      typeof item.revisionNumber === 'number' &&
      Number.isFinite(item.revisionNumber) &&
      hasString(item, 'revisionId') &&
      hasString(item, 'activation') &&
      hasOptionalString(item, 'agentId'),
  )
  const dynamicValid = (value.dynamic as unknown[]).every(
    (item) =>
      isRecord(item) &&
      hasString(item, 'agentId') &&
      hasString(item, 'pluginId') &&
      hasString(item, 'status') &&
      hasOptionalString(item, 'packageId') &&
      hasOptionalString(item, 'approvalRequestId'),
  )
  return (
    adaptersValid &&
    modelsValid &&
    agentsValid &&
    channelsValid &&
    messagesValid &&
    connectionsValid &&
    extensionsValid &&
    dynamicValid
  )
}

const nonEmptyLabel = (value: string | undefined, fallback: string): string => value?.trim() || fallback

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
    if (!part.assetId || !['image', 'file', 'audio'].includes(part.type)) return []
    const kind = part.type as 'image' | 'file' | 'audio'
    const fallback = kind === 'image' ? '图片' : kind === 'audio' ? '语音' : '文件'
    return [
      {
        assetId: part.assetId,
        kind,
        name: nonEmptyLabel(part.name ?? part.alt, fallback),
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
    provider: model.provider,
    providerName: providerDisplayName(model.provider, model.providerName),
    id: model.id,
    name: nonEmptyLabel(model.name, '未命名模型'),
    ...(model.description === undefined ? {} : { description: model.description }),
  }))
  const agents: AgentSummary[] = json.agents.map((agent) => ({
    id: agent.id,
    name: nonEmptyLabel(agent.displayName, '未命名智能体'),
    description: '',
    state: agent.runtimeStatus === 'running' ? '思考中' : '空闲',
    model:
      models.find((model) => model.provider === agent.model.provider && model.id === agent.model.model)?.name ??
      '未命名模型',
    modelRef: { ...agent.model },
    persona: agent.persona ?? '',
    ...(agent.currentRevisionId === undefined ? {} : { currentRevisionId: agent.currentRevisionId }),
    channels: [...agent.channels],
    extensionCount: json.extensions.filter((extension) => extension.agentId === agent.id).length,
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
    trigger:
      channel.bindings[0]?.triggerPolicy === 'mentioned-or-replied'
        ? '被提及或回复时'
        : channel.bindings[0]?.triggerPolicy === 'observe-only'
          ? '仅观察'
          : channel.bindings[0]?.triggerPolicy === 'command'
            ? '收到命令时'
            : '始终响应',
    bindings: channel.bindings,
    unread: 0,
  }))
  const messages: ConversationMessage[] = json.messages.map((message) =>
    projectConversationMessage(message, channels, agents),
  )
  const testLabel = (result: { readonly status: string; readonly message?: string } | undefined): string => {
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
        connection.status === 'active'
          ? '已连接'
          : connection.status === 'configured'
            ? '已配置'
            : connection.status === 'failed'
              ? '异常'
              : '已断开',
      appId: connection.appId ?? '',
      credentialConfigured: connection.credentialConfigured ?? false,
      gatewayState: connection.gateway?.state ?? connection.status,
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
    const targetAgent = extension.agentId
      ? nonEmptyLabel(json.agents.find((agent) => agent.id === extension.agentId)?.displayName, '未命名智能体')
      : ''
    return {
      id: extension.id,
      name: extension.displayName,
      description: extension.description,
      revision: extension.revisionNumber,
      activation:
        extension.activation === 'active'
          ? ('已激活' as const)
          : extension.activation === 'failed'
            ? ('激活失败' as const)
            : extension.activation === 'waiting-safe-switch'
              ? ('等待安全切换' as const)
              : ('未激活' as const),
      targetAgent,
      contributions: [],
      revisionId: extension.revisionId,
      ...(extension.agentId === undefined ? {} : { agentId: extension.agentId }),
    }
  })
  return {
    host: { status: 'ready', error: null, lastSuccessfulAt: successfulAt },
    connectionAdapters: json.connectionAdapters,
    models,
    agents,
    channels,
    messages,
    connections,
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
  #listener: (() => void) | undefined
  readonly #loadedChannels = new Set<string>()

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
        const data = JSON.parse((event as MessageEvent<string>).data) as { readonly channelId?: unknown }
        if (typeof data.channelId === 'string' && this.#loadedChannels.has(data.channelId)) {
          void this.#loadChannelMessages(data.channelId, 'latest', 40)
        } else {
          void this.#refreshAndNotify()
        }
      })
      source.addEventListener('extensions-changed', () => {
        void this.#refreshAndNotify()
      })
      source.addEventListener('status', () => {
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
      const result = await this.#postJson('/api/agents', body)
      await this.#refreshAndNotify()
      return result
    }
    if (command === 'agents.revise') {
      const agentId = typeof input?.agentId === 'string' ? input.agentId : ''
      const expectedCurrentRevisionId =
        typeof input?.expectedCurrentRevisionId === 'string' ? input.expectedCurrentRevisionId : ''
      const displayName = typeof input?.displayName === 'string' ? input.displayName : ''
      const persona = typeof input?.persona === 'string' ? input.persona : ''
      const rawModel = typeof input?.model === 'object' && input.model !== null ? input.model : {}
      const model = rawModel as Record<string, unknown>
      if (
        !agentId.trim() ||
        !expectedCurrentRevisionId.trim() ||
        !displayName.trim() ||
        typeof model.provider !== 'string' ||
        !model.provider.trim() ||
        typeof model.model !== 'string' ||
        !model.model.trim()
      ) {
        throw new Error('智能体配置不完整，请刷新页面后重试。')
      }
      const result = await this.#postJson(`/api/agents/${encodeURIComponent(agentId)}/revision`, {
        expectedCurrentRevisionId,
        displayName,
        persona,
        model: {
          provider: model.provider,
          model: model.model,
          ...(typeof model.reasoningEffort === 'string' ? { reasoningEffort: model.reasoningEffort } : {}),
        },
      })
      await this.#refreshAndNotify()
      return result
    }
    if (command === 'channels.sendMessage') {
      const channelId = typeof input?.channelId === 'string' ? input.channelId : ''
      const text = typeof input?.body === 'string' ? input.body : ''
      if (!channelId.trim()) throw new Error('缺少目标频道，请刷新页面后重试。')
      if (!text.trim()) throw new Error('消息内容不能为空。')
      const result = await this.#postJson(`/api/channels/${encodeURIComponent(channelId)}/messages`, {
        parts: [{ type: 'text', text }],
      })
      await this.#refreshAndNotify()
      return result
    }
    if (command === 'channels.listMessages') {
      const channelId = typeof input?.channelId === 'string' ? input.channelId : ''
      const mode = input?.mode === 'older' || input?.mode === 'latest' ? input.mode : 'initial'
      const limit = typeof input?.limit === 'number' ? Math.min(Math.max(Math.trunc(input.limit), 1), 100) : 40
      if (!channelId.trim()) throw new Error('缺少目标频道，请刷新页面后重试。')
      const beforeOccurredAt = typeof input?.beforeOccurredAt === 'number' ? input.beforeOccurredAt : undefined
      const beforeSourceId = typeof input?.beforeSourceId === 'string' ? input.beforeSourceId : undefined
      return await this.#loadChannelMessages(channelId, mode, limit, beforeOccurredAt, beforeSourceId)
    }
    if (command === 'channels.rename') {
      const channelId = typeof input?.channelId === 'string' ? input.channelId : ''
      const displayName = typeof input?.displayName === 'string' ? input.displayName : ''
      if (!channelId.trim()) throw new Error('缺少目标频道，请刷新页面后重试。')
      if (!displayName.trim()) throw new Error('请输入频道名称。')
      const result = await this.#postJson(`/api/channels/${encodeURIComponent(channelId)}/display-name`, {
        displayName,
      })
      await this.#refreshAndNotify()
      return result
    }
    if (command === 'agents.updateCapabilities') {
      const agentId = typeof input?.agentId === 'string' ? input.agentId : ''
      if (!agentId.trim()) throw new Error('缺少智能体标识，请刷新页面后重试。')
      const body: Record<string, unknown> = {}
      if (typeof input?.dynamicCreation === 'boolean') body.dynamicCreation = input.dynamicCreation
      if (typeof input?.developmentShell === 'boolean') body.developmentShell = input.developmentShell
      if (typeof input?.fullFileAccess === 'boolean') body.fullFileAccess = input.fullFileAccess
      if (Object.keys(body).length === 0) throw new Error('请选择至少一项要更新的智能体权限。')
      const result = await this.#postJson(`/api/agents/${encodeURIComponent(agentId)}/capabilities`, body)
      await this.#refreshAndNotify()
      return result
    }
    if (command === 'connections.create') {
      const adapterKey = typeof input?.adapterKey === 'string' ? input.adapterKey : ''
      const configuration = isRecord(input?.configuration) ? input.configuration : undefined
      const credentials = isRecord(input?.credentials) ? input.credentials : undefined
      if (!adapterKey.trim()) throw new Error('请选择连接平台。')
      if (configuration === undefined || credentials === undefined) throw new Error('连接配置格式无效，请重新填写。')
      const result = await this.#postJson('/api/connections', { adapterKey, configuration, credentials })
      await this.#refreshAndNotify()
      return result
    }
    if (command === 'bindings.create') {
      const agentId = typeof input?.agentId === 'string' ? input.agentId : ''
      const channelId = typeof input?.channelId === 'string' ? input.channelId : ''
      const triggerPolicy = typeof input?.triggerPolicy === 'string' ? input.triggerPolicy : ''
      if (!agentId.trim()) throw new Error('缺少智能体标识，请刷新页面后重试。')
      if (!channelId.trim()) throw new Error('请选择要绑定的频道。')
      if (!['always', 'mentioned-or-replied', 'command', 'observe-only'].includes(triggerPolicy)) {
        throw new Error('频道触发策略无效，请重新选择。')
      }
      const result = await this.#postJson('/api/bindings', { agentId, channelId, triggerPolicy })
      await this.#refreshAndNotify()
      return result
    }
    if (command === 'connections.test') {
      const connectionId = typeof input?.connectionId === 'string' ? input.connectionId : ''
      const direction = input?.direction === 'receive' || input?.direction === 'send' ? input.direction : undefined
      const channelId = typeof input?.channelId === 'string' ? input.channelId : undefined
      if (!connectionId.trim()) throw new Error('缺少连接标识，请刷新页面后重试。')
      if (direction === undefined) throw new Error('连接测试方向无效，请重新选择。')
      const result = await this.#postJson(`/api/connections/${encodeURIComponent(connectionId)}/test`, {
        direction,
        ...(channelId === undefined ? {} : { channelId }),
      })
      await this.#refreshAndNotify()
      return result
    }
    if (command === 'dynamic.approve' || command === 'dynamic.decline') {
      const agentId = typeof input?.agentId === 'string' ? input.agentId : ''
      const requestId = typeof input?.requestId === 'string' ? input.requestId : ''
      const pluginRunId = typeof input?.pluginRunId === 'string' ? input.pluginRunId : ''
      if (!agentId.trim()) throw new Error('缺少智能体标识，请刷新页面后重试。')
      if (!requestId.trim()) throw new Error('缺少批准请求，请刷新页面后重试。')
      const result = await this.#postJson(
        `/api/dynamic/${encodeURIComponent(agentId)}/${command === 'dynamic.approve' ? 'approve' : 'decline'}`,
        { requestId, ...(pluginRunId.trim() ? { pluginRunId } : {}) },
      )
      await this.#refreshAndNotify()
      return result
    }
    if (command === 'extensions.activate') {
      const extensionId = typeof input?.extensionId === 'string' ? input.extensionId : ''
      const agentId = typeof input?.agentId === 'string' ? input.agentId : ''
      const revisionId = typeof input?.revisionId === 'string' ? input.revisionId : ''
      if (!extensionId.trim()) throw new Error('缺少本地扩展标识，请刷新页面后重试。')
      if (!agentId.trim()) throw new Error('此本地扩展缺少目标智能体，无法启用。')
      if (!revisionId.trim()) throw new Error('此本地扩展缺少可启用版本，请重新保存后重试。')
      const result = await this.#postJson(`/api/extensions/${encodeURIComponent(extensionId)}/activation`, {
        agentId,
        revisionId,
      })
      await this.#refreshAndNotify()
      return result
    }
    if (command === 'extensions.deactivate') {
      const extensionId = typeof input?.extensionId === 'string' ? input.extensionId : ''
      if (!extensionId.trim()) throw new Error('缺少本地扩展标识，请刷新页面后重试。')
      const result = await this.#requestJson(`/api/extensions/${encodeURIComponent(extensionId)}/activation`, {
        method: 'DELETE',
      })
      await this.#refreshAndNotify()
      return result
    }
    if (command === 'extensions.saveFromDynamic') {
      const agentId = typeof input?.agentId === 'string' ? input.agentId : ''
      const name = typeof input?.name === 'string' ? input.name : ''
      const slug = typeof input?.slug === 'string' ? input.slug : ''
      const description = typeof input?.description === 'string' ? input.description : ''
      if (!agentId.trim()) throw new Error('缺少智能体标识，请刷新页面后重试。')
      if (!name.trim()) throw new Error('请输入本地扩展名称。')
      if (!slug.trim()) throw new Error('缺少本地扩展标识，请重新生成后重试。')
      const result = await this.#postJson('/api/extensions/save-from-dynamic', {
        agentId,
        name,
        displayName: name,
        slug,
        description: description.trim() || '从创造工作台保存的动态 Package。',
      })
      await this.#refreshAndNotify()
      return result
    }
    throw new Error(`当前 Web Host 不支持操作“${command}”。`)
  }

  async #postJson(path: string, body: unknown): Promise<unknown> {
    return this.#observeRequest(() => postJson(path, body))
  }

  async #loadChannelMessages(
    channelId: string,
    mode: 'initial' | 'older' | 'latest',
    limit: number,
    beforeOccurredAt?: number,
    beforeSourceId?: string,
  ): Promise<{ readonly messages: readonly ConversationMessage[]; readonly hasMore: boolean }> {
    const query = new URLSearchParams({ limit: String(limit) })
    if (beforeOccurredAt !== undefined && beforeSourceId) {
      query.set('beforeOccurredAt', String(beforeOccurredAt))
      query.set('beforeSourceId', beforeSourceId)
    }
    const raw = await this.#observeRequest(() =>
      requestJson(`/api/channels/${encodeURIComponent(channelId)}/messages?${query.toString()}`, { method: 'GET' }),
    )
    if (!isRecord(raw) || !Array.isArray(raw.messages) || typeof raw.hasMore !== 'boolean') {
      throw new Error('频道历史返回结果无效，请重新加载。')
    }
    const projected = (raw.messages as SnapshotMessageJson[]).map((message) =>
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
    this.#snapshot = { ...this.#snapshot, messages: [...other, ...deduplicated] }
    this.#listener?.()
    return { messages: projected, hasMore: raw.hasMore }
  }

  async #requestJson(
    path: string,
    init: { readonly method?: 'POST' | 'DELETE'; readonly body?: unknown },
  ): Promise<unknown> {
    return this.#observeRequest(() => requestJson(path, init))
  }

  async #observeRequest(request: () => Promise<unknown>): Promise<unknown> {
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
    let response: Response
    try {
      response = await fetch('/api/snapshot', { headers: { accept: 'application/json' } })
    } catch (cause) {
      const failure = new Error(errorMessage(cause, '无法连接 NekroNxt Host。'))
      this.#publishFailure({ code: 'network', message: failure.message })
      return failure
    }

    let json: unknown = null
    try {
      json = await response.json()
    } catch (cause) {
      if (response.ok) {
        const failure = new Error(errorMessage(cause, 'NekroNxt Host 返回了无法读取的数据。'))
        this.#publishFailure({ code: 'invalid-snapshot', message: failure.message })
        return failure
      }
    }
    if (!response.ok) {
      const message = serverErrorMessage(response.status, json)
      const failure = new Error(message)
      this.#publishFailure({ code: 'http', message })
      return failure
    }
    if (!isSnapshotJson(json)) {
      const failure = new Error('NekroNxt Host 返回的数据格式无效，请刷新或检查服务版本。')
      this.#publishFailure({ code: 'invalid-snapshot', message: failure.message })
      return failure
    }
    const projected = projectSnapshot(json, Date.now())
    this.#snapshot = {
      ...projected,
      messages: this.#loadedChannels.size > 0 ? this.#snapshot.messages : projected.messages,
    }
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

const createAgentRequestBody = (input?: Readonly<Record<string, unknown>>): unknown => {
  const displayName = typeof input?.displayName === 'string' ? input.displayName : ''
  const model =
    typeof input?.model === 'object' && input.model !== null
      ? (input.model as { readonly provider?: unknown; readonly model?: unknown })
      : undefined
  const provider = typeof model?.provider === 'string' ? model.provider.trim() : ''
  const modelId = typeof model?.model === 'string' ? model.model.trim() : ''
  const persona = typeof input?.persona === 'string' ? input.persona : ''
  const rawCapabilities =
    typeof input?.capabilities === 'object' && input.capabilities !== null
      ? (input.capabilities as Record<string, unknown>)
      : {}
  if (!displayName.trim()) throw new Error('请输入智能体名称。')
  if (!provider || !modelId) throw new Error('请选择当前可用的模型。')
  return {
    displayName: displayName.trim(),
    persona,
    model: { provider, model: modelId },
    capabilities: {
      dynamicCreation: rawCapabilities.dynamicCreation === true,
      developmentShell: rawCapabilities.developmentShell === true,
      fullFileAccess: rawCapabilities.fullFileAccess === true,
    },
  }
}

const errorMessage = (cause: unknown, fallback: string): string =>
  cause instanceof Error && cause.message.trim() ? cause.message : fallback

class HostRequestError extends Error {
  constructor(
    readonly kind: 'network' | 'http',
    message: string,
  ) {
    super(message)
    this.name = 'HostRequestError'
  }
}

const requestJson = async (
  path: string,
  init?: { readonly method?: 'GET' | 'POST' | 'DELETE'; readonly body?: unknown },
): Promise<unknown> => {
  let response: Response
  try {
    response = await fetch(path, {
      method: init?.method ?? 'POST',
      headers: { 'content-type': 'application/json' },
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
  } catch (cause) {
    throw new HostRequestError('network', errorMessage(cause, '无法连接 NekroNxt Host。'))
  }
  const json: unknown = await response.json().catch(() => null)
  if (!response.ok) throw new HostRequestError('http', serverErrorMessage(response.status, json))
  return json
}

const postJson = (path: string, body: unknown): Promise<unknown> => requestJson(path, { method: 'POST', body })

const serverErrorMessage = (status: number, body: unknown): string => {
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const error = body.error
    if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') {
      return error.message
    }
  }
  return `服务请求失败：${status}`
}
