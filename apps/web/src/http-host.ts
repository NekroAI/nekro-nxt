import {
  CHANNEL_MESSAGE_INITIAL_PAGE_SIZE,
  CHANNEL_MESSAGE_PAGE_SIZE,
  connectionDisplayName,
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
    .replaceAll('[QQ 消息不包含可处理内容]', '该消息包含暂不支持显示的内容。')
    .replaceAll('[QQ 表情]', '[表情]')
    .replace(/<faceType=\d+,faceId="[^"]*",ext="[^"]*">/gu, '[表情]')

export const renderConversationBody = (
  parts: readonly {
    type: string
    text?: string | undefined
    memberId?: string | undefined
    displayName?: string | undefined
    assetId?: string | undefined
    alt?: string | undefined
    name?: string | undefined
    title?: string | undefined
    summary?: string | undefined
  }[],
): string =>
  parts
    .map((part) => {
      if (part.type === 'text') return visibleText(part.text ?? '')
      if (part.type === 'mention') return `@${nonEmptyLabel(part.displayName, '群成员')}`
      if (part.type === 'image' || part.type === 'file' || part.type === 'audio') return ''
      if (part.type === 'quote') return '[引用消息]'
      if (part.type === 'rich') return part.title || part.summary || '[卡片]'
      return '[暂不支持显示的消息内容]'
    })
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
  platformUsersRevision: 0,
  approvals: [],
  dynamic: [],
  diagnosticNote: '正在连接 NekroNXT 服务…',
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

const safeExternalTargetUrl = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || value.length > 2048) return undefined
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : undefined
  } catch {
    return undefined
  }
}

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

const platformChannelLabel = (platformChannelId: string, kind: 'group' | 'direct' = 'group'): string => {
  const suffix = platformChannelId.trim().match(/([\p{L}\p{N}]{4})$/u)?.[1]
  const type = kind === 'group' ? '群聊' : '私聊'
  return suffix ? `${type}（尾号 ${suffix}）` : `未命名${type}`
}

const projectConversationMessage = (
  message: SnapshotMessageJson,
  channels: readonly ChannelSummary[],
  agents: readonly AgentSummary[],
): ConversationMessage => {
  const delivery = deliveryStateToUi(message.deliveryState)
  const sourceChannel = channels.find((channel) => channel.id === message.channelId)
  const sourceAgent = agents.find((agent) => agent.id === sourceChannel?.agentId)
  const parts: ConversationMessage['parts'] = message.parts.map((part) => {
    if (part.type === 'text') return { type: 'text', text: visibleText(part.text) }
    if (part.type === 'mention') {
      return {
        type: 'mention',
        memberId: part.memberId,
        displayName: nonEmptyLabel(part.displayName, '群成员'),
      }
    }
    if (part.type === 'quote') return { type: 'quote', messageId: part.messageId }
    if (part.type === 'rich') {
      const extension = part.extension
      const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
        typeof value === 'object' && value !== null && !Array.isArray(value)
      const record = isRecord(extension) ? extension : undefined
      const previewText = typeof record?.['preview'] === 'string' ? record['preview'] : undefined
      const rawItems = Array.isArray(record?.['items']) ? record['items'] : []
      const assetUrl = (assetId: string) =>
        `/api/channels/${encodeURIComponent(message.channelId)}/assets/${encodeURIComponent(assetId)}`
      const items = rawItems.flatMap((entry) => {
        if (!isRecord(entry)) return []
        const item = entry
        const cardRaw = item['card']
        const card = isRecord(cardRaw) ? cardRaw : undefined
        const imageAssetId = typeof item['imageAssetId'] === 'string' ? item['imageAssetId'] : undefined
        const cardPreviewId = typeof card?.['previewAssetId'] === 'string' ? card['previewAssetId'] : undefined
        const cardTargetUrl = safeExternalTargetUrl(card?.['targetUrl'])
        return [
          {
            ...(typeof item['sender'] === 'string' ? { sender: item['sender'] } : {}),
            ...(typeof item['text'] === 'string' ? { text: item['text'] } : {}),
            ...(card && typeof card['summary'] === 'string'
              ? {
                  card: {
                    summary: card['summary'],
                    ...(typeof card['title'] === 'string' ? { title: card['title'] } : {}),
                    ...(typeof card['source'] === 'string' ? { source: card['source'] } : {}),
                    ...(cardTargetUrl === undefined ? {} : { targetUrl: cardTargetUrl }),
                    ...(cardPreviewId === undefined ? {} : { previewUrl: assetUrl(cardPreviewId) }),
                  },
                }
              : {}),
            ...(imageAssetId === undefined
              ? {}
              : {
                  imageUrl: assetUrl(imageAssetId),
                  imageName: typeof item['imageName'] === 'string' ? item['imageName'] : '图片',
                }),
          },
        ]
      })
      return {
        type: 'rich',
        adapterKey: part.adapterKey,
        kind: part.kind,
        summary: part.summary,
        ...(part.title === undefined ? {} : { title: part.title }),
        ...(part.source === undefined ? {} : { source: part.source }),
        ...(part.targetUrl === undefined ? {} : { targetUrl: part.targetUrl }),
        ...(previewText === undefined ? {} : { preview: previewText }),
        ...(items.length === 0 ? {} : { items }),
        ...(part.previewAssetId === undefined ? {} : { previewUrl: assetUrl(part.previewAssetId) }),
      }
    }
    if (part.type !== 'image' && part.type !== 'file' && part.type !== 'audio') {
      return { type: 'unsupported', label: '暂不支持显示的消息内容' }
    }
    const kind = part.type
    const fallback = kind === 'image' ? '图片' : kind === 'audio' ? '语音' : '文件'
    const label = part.type === 'image' ? part.alt : part.type === 'file' ? part.name : undefined
    const url = `/api/channels/${encodeURIComponent(message.channelId)}/assets/${encodeURIComponent(part.assetId)}`
    if (kind === 'image') return { type: 'image', assetId: part.assetId, alt: nonEmptyLabel(label, fallback), url }
    if (kind === 'file') return { type: 'file', assetId: part.assetId, name: nonEmptyLabel(label, fallback), url }
    return { type: 'audio', assetId: part.assetId, url }
  })
  const resources = parts.flatMap<ConversationMessage['resources'][number]>((part) => {
    if (part.type === 'image') return [{ assetId: part.assetId, kind: part.type, name: part.alt, url: part.url }]
    if (part.type === 'file') return [{ assetId: part.assetId, kind: part.type, name: part.name, url: part.url }]
    if (part.type === 'audio') return [{ assetId: part.assetId, kind: part.type, name: '语音', url: part.url }]
    return []
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
    body: renderConversationBody(message.parts),
    parts,
    mentionedConnectionAccount: message.mentionedConnectionAccount === true,
    time: formatTime(message.occurredAt),
    occurredAt: message.occurredAt,
    resources,
    ...(delivery === undefined ? {} : { delivery }),
    ...(message.origin === 'admin-console' ? { origin: 'admin-console' as const } : {}),
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
    ...(model.inputModalities === undefined ? {} : { inputModalities: [...model.inputModalities] }),
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
    personaDocument: agent.personaDocument,
    ...(agent.currentRevisionId === undefined ? {} : { currentRevisionId: agent.currentRevisionId }),
    channels: [...agent.channels],
    extensionCount: json.extensions.filter((extension) =>
      extension.activations.some((activation) => activation.agentId === agent.id),
    ).length,
    capabilities: { ...agent.capabilities },
    imagePolicy: agent.imagePolicy,
    imageDiagnostics: agent.imageDiagnostics,
  }))
  const connectionAdapterName = (connection: SnapshotJson['connections'][number]): string =>
    connection.adapterKey === 'web'
      ? '内置频道'
      : nonEmptyLabel(
          json.connectionAdapters.find((adapter) => adapter.key === connection.adapterKey)?.displayName,
          '未命名连接平台',
        )
  const connectionNameById = new Map(
    json.connections.map((connection) => [
      connection.id,
      connectionDisplayName({
        name:
          connection.adapterKey === 'web'
            ? '内置频道'
            : nonEmptyLabel(
                json.connectionAdapters.find((adapter) => adapter.key === connection.adapterKey)?.displayName,
                '未命名连接',
              ),
        ...(connection.alias === undefined ? {} : { alias: connection.alias }),
      }),
    ]),
  )
  const channels: ChannelSummary[] = json.channels.map((channel) => ({
    id: channel.id,
    connectionId: channel.connectionId,
    name: nonEmptyLabel(
      channel.displayName,
      channel.kind === 'web'
        ? '未命名内置频道'
        : platformChannelLabel(channel.platformChannelId, channel.kind === 'group' ? 'group' : 'direct'),
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
    const adapterName = connectionAdapterName(connection)
    const gatewayState = connection.gateway?.state ?? (connection.adapterKey === 'web' ? 'connected' : 'disconnected')
    return {
      id: connection.id,
      ...(connection.alias === undefined ? {} : { alias: connection.alias }),
      name: adapterName,
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
            ? platformChannelLabel(channel.name)
            : channel.kind !== 'group' && /^(?:private|c2c):/u.test(channel.name)
              ? platformChannelLabel(channel.name, 'direct')
              : nonEmptyLabel(channel.name, channel.kind === 'group' ? '未命名群聊' : '未命名频道'),
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
    const latestRevision = extension.revisions.at(-1)
    return {
      id: extension.id,
      name: extension.displayName,
      description: extension.description,
      revision: latestRevision?.revisionNumber ?? 0,
      ...(extension.createdByAgentId === undefined ? {} : { createdByAgentId: extension.createdByAgentId }),
      createdByAgent:
        extension.createdByAgentId === undefined
          ? ''
          : nonEmptyLabel(
              json.agents.find((agent) => agent.id === extension.createdByAgentId)?.displayName,
              '已删除的智能体',
            ),
      activations: extension.activations.map((candidate) => {
        const activeRevision = extension.revisions.find((revision) => revision.id === candidate.extensionRevisionId)
        return {
          agentId: candidate.agentId,
          agentName: nonEmptyLabel(
            json.agents.find((agent) => agent.id === candidate.agentId)?.displayName,
            '未命名智能体',
          ),
          revisionId: candidate.extensionRevisionId,
          revision: activeRevision?.revisionNumber ?? 0,
          activatedAt: candidate.activatedAt,
        }
      }),
      contributions: latestRevision?.contributions ?? [],
      ...(latestRevision?.verification === undefined
        ? {}
        : {
            verification: {
              verifiedAt: latestRevision.verification.verifiedAt,
              dshVersion: latestRevision.verification.dshVersion,
              contractVersion: latestRevision.verification.contractVersion,
              hostBuilt: latestRevision.verification.hostBuilt,
              clientBuilt: latestRevision.verification.clientBuilt,
              buildKey: latestRevision.verification.buildKey,
              toolInvocationCount: latestRevision.verification.toolInvocationCount,
              rpcMethods: latestRevision.verification.rpcMethods,
              renderedSlots: latestRevision.verification.renderedSlots,
            },
          }),
      clientActivations: extension.activations.flatMap((candidate) => {
        const activeRevision = extension.revisions.find((revision) => revision.id === candidate.extensionRevisionId)
        if (!activeRevision?.verification?.clientBuilt) return []
        return [
          {
            agentId: candidate.agentId,
            revisionId: candidate.extensionRevisionId,
            buildKey: activeRevision.verification.buildKey,
          },
        ]
      }),
      clientDiagnostics: extension.clientDiagnostics.map((diagnostic) => ({
        agentId: diagnostic.agentId,
        revisionId: diagnostic.revisionId,
        status: diagnostic.status,
        ...(diagnostic.message === undefined ? {} : { message: diagnostic.message }),
        observedAt: diagnostic.observedAt,
      })),
      ...(latestRevision === undefined ? {} : { revisionId: latestRevision.id }),
    }
  })
  return {
    host: { status: 'ready', error: null, lastSuccessfulAt: successfulAt },
    ...(json.productMetadata === undefined ? {} : { productMetadata: json.productMetadata }),
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
    platformUsersRevision: 0,
    approvals: [],
    dynamic: json.dynamic.map((item) => ({
      agentId: item.agentId,
      episodeId: item.episodeId,
      pluginId: item.pluginId,
      ...(item.packageId === undefined ? {} : { packageId: item.packageId }),
      ...(item.currentPackageId === undefined ? {} : { currentPackageId: item.currentPackageId }),
      ...(item.nextPackageId === undefined ? {} : { nextPackageId: item.nextPackageId }),
      ...(item.approvalRequestId === undefined ? {} : { approvalRequestId: item.approvalRequestId }),
      status: item.status,
      packages: item.packages,
      policy: {
        turn: item.policy.turn,
        consecutiveFailures: item.policy.consecutiveFailures,
        repeatedFingerprintCount: item.policy.repeatedFingerprintCount,
        ...(item.policy.blockedReason === undefined ? {} : { blockedReason: item.policy.blockedReason }),
      },
    })),
    diagnosticNote: `服务连接正常（${agents.length} 个智能体 · ${channels.length} 个频道 · ${extensionsLocal.length} 个本地扩展）。`,
  }
}

export class HttpProductHost implements ProductHostPort {
  #snapshot: ProductSnapshot = emptySnapshot()
  #listener: (() => void) | undefined
  readonly #loadedChannels = new Set<string>()
  readonly #loadedRuntimes = new Set<string>()
  readonly #messageRevision = new Map<string, number>()
  readonly #runtimeRevision = new Map<string, number>()
  readonly #reconciling = new Set<string>()
  readonly #messageReconcileDepth = new Map<string, number>()
  readonly #pendingChannelFacts = new Map<string, ChannelFactSseData[]>()

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
        this.#snapshot = { ...this.#snapshot, platformUsersRevision: this.#snapshot.platformUsersRevision + 1 }
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
        this.#publishFailure({ code: 'sse', message: '与 NekroNXT Host 的实时连接已中断，正在尝试恢复。' })
      }
    } catch (cause) {
      this.#publishFailure({ code: 'sse', message: errorMessage(cause, '无法建立 NekroNXT Host 实时连接。') })
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
    if (command === 'platformUsers.list') {
      return await this.#call(
        HostApiContracts.listPlatformUsers,
        {
          ...(typeof input?.['query'] === 'string' ? { query: input['query'] } : {}),
          ...(typeof input?.['adapterKey'] === 'string' ? { adapterKey: input['adapterKey'] } : {}),
          ...(typeof input?.['connectionId'] === 'string' ? { connectionId: input['connectionId'] } : {}),
          ...(typeof input?.['cursor'] === 'string' ? { cursor: input['cursor'] } : {}),
          limit: typeof input?.['limit'] === 'number' ? input['limit'] : 50,
        },
        undefined,
      )
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
      const personaDocument = input?.['personaDocument']
      const model = isRecord(input?.['model']) ? input['model'] : {}
      const imagePolicy = input?.['imagePolicy']
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
      const body = HostApiContracts.reviseAgent.parseRequest({
        expectedCurrentRevisionId,
        displayName,
        persona,
        ...(personaDocument === undefined ? {} : { personaDocument }),
        model: {
          provider: model['provider'],
          model: model['model'],
          ...(typeof model['reasoningEffort'] === 'string' ? { reasoningEffort: model['reasoningEffort'] } : {}),
        },
        ...(imagePolicy === undefined ? {} : { imagePolicy }),
      })
      const result = await this.#call(HostApiContracts.reviseAgent, { agentId }, body)
      await this.#refreshAndNotify()
      return result
    }
    if (command === 'agents.delete') {
      const agentId = typeof input?.['agentId'] === 'string' ? input['agentId'] : ''
      const expectedCurrentRevisionId =
        typeof input?.['expectedCurrentRevisionId'] === 'string' ? input['expectedCurrentRevisionId'] : ''
      const confirmationName = typeof input?.['confirmationName'] === 'string' ? input['confirmationName'] : ''
      const deleteAutoCreatedBuiltInChannels = input?.['deleteAutoCreatedBuiltInChannels'] !== false
      if (!agentId.trim() || !expectedCurrentRevisionId.trim()) {
        throw new Error('智能体删除信息不完整，请刷新页面后重试。')
      }
      const body = HostApiContracts.deleteAgent.parseRequest({
        expectedCurrentRevisionId,
        confirmationName,
        deleteAutoCreatedBuiltInChannels,
      })
      const result = await this.#call(HostApiContracts.deleteAgent, { agentId }, body)
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
      const limit =
        typeof input?.['limit'] === 'number'
          ? Math.min(Math.max(Math.trunc(input['limit']), 1), 100)
          : mode === 'initial'
            ? CHANNEL_MESSAGE_INITIAL_PAGE_SIZE
            : CHANNEL_MESSAGE_PAGE_SIZE
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
    if (command === 'channels.resetContext') {
      const channelId = typeof input?.['channelId'] === 'string' ? input['channelId'] : ''
      const expectedEpisodeId = typeof input?.['expectedEpisodeId'] === 'string' ? input['expectedEpisodeId'] : ''
      const mode = input?.['mode'] === 'clear' || input?.['mode'] === 'compact' ? input['mode'] : undefined
      if (!channelId.trim() || !expectedEpisodeId.trim() || mode === undefined) {
        throw new Error('频道上下文操作信息不完整，请刷新页面后重试。')
      }
      const result = await this.#call(HostApiContracts.resetChannelContext, { channelId }, { expectedEpisodeId, mode })
      await this.#refreshAndNotify()
      return result
    }
    if (command === 'channels.delete') {
      const channelId = typeof input?.['channelId'] === 'string' ? input['channelId'] : ''
      const expectedBoundAgentId =
        input?.['expectedBoundAgentId'] === null
          ? null
          : typeof input?.['expectedBoundAgentId'] === 'string'
            ? input['expectedBoundAgentId']
            : undefined
      if (!channelId.trim() || expectedBoundAgentId === undefined) {
        throw new Error('频道删除信息不完整，请刷新页面后重试。')
      }
      const result = await this.#call(HostApiContracts.deleteChannel, { channelId }, { expectedBoundAgentId })
      await this.#refreshAndNotify()
      return result
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
      const alias = typeof input?.['alias'] === 'string' ? input['alias'] : undefined
      const configuration = isRecord(input?.['configuration'])
        ? HostApiContracts.createConnection.request.shape.configuration.parse(input['configuration'])
        : undefined
      const credentials = isStringRecord(input?.['credentials']) ? input['credentials'] : undefined
      if (!adapterKey.trim()) throw new Error('请选择连接平台。')
      if (configuration === undefined || credentials === undefined) throw new Error('连接配置格式无效，请重新填写。')
      const result = await this.#call(
        HostApiContracts.createConnection,
        {},
        { adapterKey, ...(alias === undefined ? {} : { alias }), configuration, credentials },
      )
      await this.#refreshAndNotify()
      return result
    }
    if (command === 'connections.updateAlias') {
      const connectionId = typeof input?.['connectionId'] === 'string' ? input['connectionId'] : ''
      const alias = typeof input?.['alias'] === 'string' ? input['alias'] : undefined
      if (!connectionId.trim()) throw new Error('缺少连接标识，请刷新页面后重试。')
      if (alias === undefined) throw new Error('连接别名格式无效，请重新填写。')
      const result = await this.#call(HostApiContracts.updateConnectionAlias, { connectionId }, { alias })
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
      const episodeId = typeof input?.['episodeId'] === 'string' ? input['episodeId'] : ''
      const requestId = typeof input?.['requestId'] === 'string' ? input['requestId'] : ''
      const pluginRunId = typeof input?.['pluginRunId'] === 'string' ? input['pluginRunId'] : ''
      if (!agentId.trim()) throw new Error('缺少智能体标识，请刷新页面后重试。')
      if (!episodeId.trim()) throw new Error('缺少 Episode 标识，请刷新页面后重试。')
      if (!requestId.trim()) throw new Error('缺少批准请求，请刷新页面后重试。')
      const result = await this.#call(
        command === 'dynamic.approve' ? HostApiContracts.dynamicApprove : HostApiContracts.dynamicDecline,
        { agentId },
        { episodeId, requestId, ...(pluginRunId.trim() ? { pluginRunId } : {}) },
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
      const episodeId = typeof input?.['episodeId'] === 'string' ? input['episodeId'] : ''
      const pluginId = typeof input?.['pluginId'] === 'string' ? input['pluginId'] : ''
      const packageId = typeof input?.['packageId'] === 'string' ? input['packageId'] : ''
      const name = typeof input?.['name'] === 'string' ? input['name'] : ''
      const slug = typeof input?.['slug'] === 'string' ? input['slug'] : ''
      const description = typeof input?.['description'] === 'string' ? input['description'] : ''
      if (!agentId.trim()) throw new Error('缺少智能体标识，请刷新页面后重试。')
      if (!episodeId.trim() || !pluginId.trim() || !packageId.trim()) {
        throw new Error('缺少精确的 Episode、Plugin 或 Package，请刷新页面后重试。')
      }
      if (!name.trim()) throw new Error('请输入本地扩展名称。')
      if (!slug.trim()) throw new Error('缺少本地扩展标识，请重新生成后重试。')
      const result = await this.#call(
        HostApiContracts.saveExtensionFromDynamic,
        {},
        {
          agentId,
          episodeId,
          pluginId,
          packageId,
          displayName: name,
          slug,
          description: description.trim() || '从创造工作台保存的动态 Package。',
        },
      )
      await this.#refreshAndNotify()
      return result
    }
    if (command === 'extensions.clientCall') {
      const extensionId = typeof input?.['extensionId'] === 'string' ? input['extensionId'] : ''
      const revisionId = typeof input?.['revisionId'] === 'string' ? input['revisionId'] : ''
      const agentId = typeof input?.['agentId'] === 'string' ? input['agentId'] : ''
      const method = typeof input?.['method'] === 'string' ? input['method'] : ''
      if (!extensionId.trim() || !revisionId.trim() || !agentId.trim() || !method.trim()) {
        throw new Error('扩展 RPC 请求缺少精确的智能体、扩展、版本或方法。')
      }
      const value =
        'value' in (input ?? {})
          ? HostApiContracts.extensionClientCall.request.shape.input.parse(input?.['value'])
          : undefined
      return await this.#call(
        HostApiContracts.extensionClientCall,
        { extensionId, revisionId },
        { agentId, method, ...(value === undefined ? {} : { input: value }) },
      )
    }
    if (command === 'extensions.clientDiagnostic') {
      const extensionId = typeof input?.['extensionId'] === 'string' ? input['extensionId'] : ''
      const revisionId = typeof input?.['revisionId'] === 'string' ? input['revisionId'] : ''
      const agentId = typeof input?.['agentId'] === 'string' ? input['agentId'] : ''
      const status = input?.['status'] === 'loaded' || input?.['status'] === 'failed' ? input['status'] : undefined
      const message = typeof input?.['message'] === 'string' ? input['message'] : undefined
      if (!extensionId.trim() || !revisionId.trim() || !agentId.trim() || status === undefined) {
        throw new Error('Client 诊断缺少精确的智能体、扩展、版本或状态。')
      }
      return await this.#call(
        HostApiContracts.extensionClientDiagnostic,
        { extensionId, revisionId },
        { agentId, status, ...(message === undefined ? {} : { message }) },
      )
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
    this.#messageReconcileDepth.set(channelId, (this.#messageReconcileDepth.get(channelId) ?? 0) + 1)
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
      const remaining = (this.#messageReconcileDepth.get(channelId) ?? 1) - 1
      if (remaining > 0) {
        this.#messageReconcileDepth.set(channelId, remaining)
      } else {
        this.#messageReconcileDepth.delete(channelId)
        const pending = this.#pendingChannelFacts.get(channelId) ?? []
        this.#pendingChannelFacts.delete(channelId)
        for (const fact of pending) this.#applyChannelFact(fact)
      }
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
    if ((this.#messageReconcileDepth.get(data.channelId) ?? 0) > 0) {
      const pending = this.#pendingChannelFacts.get(data.channelId) ?? []
      pending.push(data)
      this.#pendingChannelFacts.set(data.channelId, pending)
      return
    }
    if (
      !this.#loadedChannels.has(data.channelId) &&
      !this.#snapshot.messages.some((message) => message.channelId === data.channelId)
    ) {
      this.#listener?.()
      return
    }
    this.#loadedChannels.add(data.channelId)
    const last = this.#messageRevision.get(data.channelId)
    if (last !== undefined && data.revision !== last + 1) {
      void this.#loadChannelMessages(data.channelId, 'latest', CHANNEL_MESSAGE_PAGE_SIZE)
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
      | 'channelId'
      | 'agentId'
      | 'episodeId'
      | 'phase'
      | 'summary'
      | 'pendingInjectCount'
      | 'occupancy'
      | 'cache'
      | 'turns'
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
      ...(raw.cache === undefined ? {} : { cache: raw.cache }),
      turns: raw.turns,
    }
  }

  #writeRuntimeView(view: ChannelRuntimeView, options: { readonly includeTurns: boolean }): void {
    const channelId = view.channelId
    const nextRuntimes = { ...this.#snapshot.channelRuntimes }
    if (options.includeTurns) nextRuntimes[channelId] = view

    // Keep the channels/agents array references stable across runtime frames
    // that do not actually change the effective phase. Live phase is
    // represented authoritatively in channelRuntimes, so narrow selectors and
    // memoized consumers are not forced to re-render on every summary/turn
    // tick — the arrays are only re-cloned when the phase truly flips.
    const currentChannel = this.#snapshot.channels.find((channel) => channel.id === channelId)
    const phaseChanged = currentChannel?.runtimePhase !== view.phase
    let nextChannels = this.#snapshot.channels
    if (phaseChanged && currentChannel !== undefined) {
      nextChannels = this.#snapshot.channels.map((channel) =>
        channel.id === channelId ? { ...channel, runtimePhase: view.phase } : channel,
      )
    }

    let nextAgents = this.#snapshot.agents
    if (view.agentId !== undefined) {
      const agent = this.#snapshot.agents.find((candidate) => candidate.id === view.agentId)
      if (agent !== undefined) {
        const phases = (phaseChanged ? nextChannels : this.#snapshot.channels)
          .filter((channel) => channel.agentId === agent.id)
          .map((channel) => channel.runtimePhase)
        const nextState = worstAgentState(phases)
        if (nextState !== agent.state) {
          nextAgents = this.#snapshot.agents.map((candidate) =>
            candidate.id === agent.id ? { ...candidate, state: nextState } : candidate,
          )
        }
      }
    }

    this.#snapshot = { ...this.#snapshot, channelRuntimes: nextRuntimes, channels: nextChannels, agents: nextAgents }
    this.#listener?.()
  }

  async #reconcileLoaded(): Promise<void> {
    await this.#refreshAndNotify()
    await Promise.all([
      ...[...this.#loadedChannels].map((channelId) =>
        this.#loadChannelMessages(channelId, 'latest', CHANNEL_MESSAGE_PAGE_SIZE),
      ),
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
      const failure = cause instanceof Error ? cause : new Error(errorMessage(cause, '无法连接 NekroNXT Host。'))
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
    this.#snapshot = {
      ...projected,
      messages: this.#loadedChannels.size > 0 ? this.#snapshot.messages : projected.messages,
      channelRuntimes: this.#snapshot.channelRuntimes,
      platformUsersRevision: this.#snapshot.platformUsersRevision,
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
  const personaDocument = input?.['personaDocument']
  const rawCapabilities = isRecord(input?.['capabilities']) ? input['capabilities'] : {}
  const imagePolicy = input?.['imagePolicy']
  if (!displayName.trim()) throw new Error('请输入智能体名称。')
  if (!provider || !modelId) throw new Error('请选择当前可用的模型。')
  return HostApiContracts.createAgent.parseRequest({
    displayName: displayName.trim(),
    persona,
    ...(personaDocument === undefined ? {} : { personaDocument }),
    model: { provider, model: modelId },
    capabilities: {
      subagents: rawCapabilities['subagents'] === true,
      fileTools: rawCapabilities['fileTools'] === true,
      webSearch: rawCapabilities['webSearch'] === true,
      dynamicCreation: rawCapabilities['dynamicCreation'] === true,
      developmentShell: rawCapabilities['developmentShell'] === true,
      unrestrictedFileAccess: rawCapabilities['unrestrictedFileAccess'] === true,
    },
    ...(imagePolicy === undefined ? {} : { imagePolicy }),
  })
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
    throw new HostRequestError('network', errorMessage(cause, '无法连接 NekroNXT Host。'))
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
      `NekroNXT Host 返回的数据格式无效：${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }
}
