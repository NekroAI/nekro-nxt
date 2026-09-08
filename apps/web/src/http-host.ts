import type { ProductActions } from './product-actions.js'
import { callHostApi, HostRequestError, StaleHostReadError } from './host-api-client.js'
import { createStore } from 'zustand/vanilla'
import {
  CHANNEL_MESSAGE_INITIAL_PAGE_SIZE,
  CHANNEL_MESSAGE_PAGE_SIZE,
  connectionDisplayName,
  type AgentRuntimeState,
  type AgentSummary,
  type ChannelRuntimeView,
  type ChannelSummary,
  type ConnectionSummary,
  type ConversationMessage,
  type DeliveryState,
  type ModelSummary,
  type ProductHostError,
} from './product-model.js'
import type { AdapterConnectionDescriptor, AdapterConfigurationProperty } from '@nekro-nxt/adapter-sdk'
import {
  HostApiContracts,
  ChannelFactSseDataSchema,
  ChannelRuntimeSseDataSchema,
  HostConnectionEventSchema,
  HostSseStatusDataSchema,
  type ChannelFactSseData,
  type ChannelRuntimeSseData,
  type HostApiContract,
  type HostApiContractParams,
  type HostApiContractRequest,
  type HostApiResponse,
  type HostConnectionEvent,
} from '@nekro-nxt/contracts'
import { providerDisplayName } from './provider-labels.js'
import type { ProductHostPort, ProductSnapshot } from './product-port.js'
import { HostEventStream, type HostEventStreamHandlers } from './host-event-stream.js'

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
  if (state === 'unavailable') return 4
  if (state === 'using-tool') return 3
  if (state === 'thinking') return 2
  if (state === 'waiting-input') return 1
  return 0
}

const worstAgentState = (states: readonly AgentRuntimeState[]): AgentRuntimeState =>
  states.reduce<AgentRuntimeState>(
    (current, state) => (agentStateRank(state) > agentStateRank(current) ? state : current),
    'idle',
  )

const sseEventData = (event: unknown): string | undefined => {
  if (event instanceof MessageEvent && typeof event.data === 'string') return event.data
  if (event && typeof event === 'object' && 'data' in event && typeof event.data === 'string') return event.data
  return undefined
}

const formatTime = (occurredAt: number): string =>
  new Date(occurredAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })

const visibleText = (text: string): string => text

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
): string => {
  const tokens = parts
    .map((part) => {
      if (part.type === 'text') return visibleText(part.text ?? '')
      if (part.type === 'mention') return `@${nonEmptyLabel(part.displayName, '群成员')}`
      if (part.type === 'image' || part.type === 'file' || part.type === 'audio') return ''
      if (part.type === 'quote') return '[引用消息]'
      if (part.type === 'rich') return part.title || part.summary || '[卡片]'
      return '[暂不支持显示的消息内容]'
    })
    .filter((token) => token.trim().length > 0)
  return tokens.reduce(
    (body, token) =>
      body.length === 0 || /\s$/u.test(body) || /^\s/u.test(token) ? `${body}${token}` : `${body} ${token}`,
    '',
  )
}

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
  archivedConnections: [],
  extensions: [],
  hostUi: { preferencesRevision: 0, pages: [] },
  platformUsersRevision: 0,
  approvals: [],
  dynamic: [],
  authoringTasks: [],
  notificationSettings: {
    system: { enabled: true },
    bark: { enabled: false, serverUrl: 'https://api.day.app', deviceKeyConfigured: false },
    events: { 'dynamic-client-approval-requested': true },
  },
  diagnosticNote: '正在连接 NekroNXT 服务…',
  workTreeOrder: { agentIds: [], channelIdsByAgent: {}, unboundChannelIds: [] },
})

type SnapshotJson = HostApiResponse<'snapshot'>
type MessagePage = { readonly messages: readonly ConversationMessage[]; readonly hasMore: boolean }

type SyncCursor = SnapshotJson['cursor']

type SnapshotMessageJson = SnapshotJson['messages'][number]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const eventCursor = (event: unknown): SyncCursor | undefined => {
  const id = isRecord(event) && typeof event['lastEventId'] === 'string' ? event['lastEventId'] : ''
  const match = /^([a-zA-Z0-9_-]{1,100}):([1-9]\d*)$/u.exec(id)
  const sequence = Number(match?.[2])
  return match === null || !Number.isSafeInteger(sequence) ? undefined : { epoch: match[1]!, sequence }
}

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
    ...(property.credentialKey === undefined ? {} : { credentialKey: property.credentialKey }),
  }
}

const projectAdapterDescriptor = (
  descriptor: SnapshotJson['connectionAdapters'][number],
): AdapterConnectionDescriptor => ({
  key: descriptor.key,
  displayName: descriptor.displayName,
  description: descriptor.description,
  provisioning: descriptor.provisioning,
  aliasEditable: descriptor.aliasEditable,
  channelDiscovery: descriptor.channelDiscovery,
  channelKinds: descriptor.channelKinds,
  activities: descriptor.activities.map((activity) => ({
    key: activity.key,
    scope: activity.scope,
    displayName: activity.displayName,
    description: activity.description,
    triggerable: activity.triggerable,
    ...(activity.icon === undefined ? {} : { icon: activity.icon }),
    ...(activity.channelKinds === undefined ? {} : { channelKinds: activity.channelKinds }),
  })),
  features:
    descriptor.features.processingFeedback === undefined
      ? {}
      : { processingFeedback: { channelKinds: descriptor.features.processingFeedback.channelKinds } },
  diagnostics: descriptor.diagnostics,
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
        ...(part.extension === undefined ? {} : { extension: part.extension }),
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
    role: message.role === 'agent' ? 'agent' : message.role === 'system' ? 'system' : 'member',
    ...(message.activityKey === undefined ? {} : { activityKey: message.activityKey }),
    author:
      message.role === 'agent'
        ? (sourceAgent?.name ?? '智能体')
        : message.role === 'system'
          ? '频道事件'
          : message.sender !== undefined
            ? nonEmptyLabel(message.sender.displayName, '群成员')
            : sourceChannel?.kind === 'internal'
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
    state: agent.runtimePhase ?? (agent.runtimeStatus === 'running' ? 'thinking' : 'idle'),
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
    dynamicClientApprovalPolicy: agent.dynamicClientApprovalPolicy,
    imageDiagnostics: agent.imageDiagnostics,
  }))
  const connectionAdapterName = (connection: SnapshotJson['connections'][number]): string =>
    nonEmptyLabel(
      json.connectionAdapters.find((adapter) => adapter.key === connection.adapterKey)?.displayName,
      '未命名连接平台',
    )
  const connectionNameById = new Map(
    json.connections.map((connection) => [
      connection.id,
      connectionDisplayName({
        name: nonEmptyLabel(
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
      channel.kind === 'internal' ? '未命名内置频道' : channel.kind === 'group' ? '未命名群聊' : '未命名私聊',
    ),
    kind: channel.kind === 'group' ? 'group' : channel.kind === 'direct' ? 'direct' : 'internal',
    connectionName: connectionNameById.get(channel.connectionId) ?? '未命名连接',
    agentId: channel.boundAgentId ?? '',
    runtimePhase: channel.runtimePhase ?? 'idle',
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
      processingFeedback: binding.processingFeedback,
      activityTriggerOverrides: binding.activityTriggerOverrides,
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
    const descriptor = json.connectionAdapters.find(({ key }) => key === connection.adapterKey)
    const runtimeState = connection.status.state
    return {
      id: connection.id,
      ...(connection.alias === undefined ? {} : { alias: connection.alias }),
      name: adapterName,
      adapter: adapterName,
      adapterKey: connection.adapterKey,
      userManaged: descriptor?.provisioning === 'user-created',
      state:
        runtimeState === 'connected'
          ? '已连接'
          : runtimeState === 'failed'
            ? '异常'
            : connection.status.credentialConfigured
              ? '已配置'
              : '已断开',
      accountReference: connection.status.accountReference ?? '',
      credentialConfigured: connection.status.credentialConfigured,
      runtimeState,
      lastError: connection.status.message ?? '',
      proactiveSend: connection.status.proactiveSend,
      activityCapabilities: connection.status.activities,
      activityTriggerDefaults: connection.activityTriggerDefaults,
      ...(connection.status.processingFeedback === undefined
        ? {}
        : { processingFeedbackCapability: connection.status.processingFeedback }),
      channels: connection.channelCount ?? 0,
      knownChannels: (connection.knownChannels ?? []).map((channel) => ({
        ...channel,
        name: nonEmptyLabel(
          channel.name,
          channel.kind === 'group' ? '未命名群聊' : channel.kind === 'direct' ? '未命名私聊' : '未命名内置频道',
        ),
      })),
      lastEvent:
        connection.lastInbound === undefined
          ? '尚无入站消息'
          : new Date(connection.lastInbound.receivedAt).toLocaleString('zh-CN'),
      receiveTest: testLabel(connection.receiveTest),
      sendTest: testLabel(connection.sendTest),
      events: [],
      eventsLoaded: false,
      eventsLoading: false,
      eventsHasMore: true,
    }
  })
  const archivedConnections = json.archivedConnections.map((connection) => {
    const descriptor = json.connectionAdapters.find(({ key }) => key === connection.adapterKey)
    return {
      id: connection.id,
      adapterKey: connection.adapterKey,
      ...(connection.alias === undefined ? {} : { alias: connection.alias }),
      adapter: descriptor?.displayName ?? '适配器未安装',
      channelCount: connection.channelCount,
      archivedAt: connection.archivedAt,
    }
  })
  const extensionsLocal = json.extensions.map((extension) => {
    const latestRevision = extension.revisions.at(-1)
    return {
      id: extension.id,
      slug: extension.slug,
      name: extension.displayName,
      description: extension.description,
      revision: latestRevision?.revisionNumber ?? 0,
      scope: extension.scope,
      revisions: extension.revisions.map((revision) => ({
        id: revision.id,
        revision: revision.revisionNumber,
        createdAt: revision.createdAt,
        scope: revision.scope,
        contributions: revision.contributions,
        clientBuilt: revision.verification?.clientBuilt ?? false,
        ...(revision.verification === undefined ? {} : { buildKey: revision.verification.buildKey }),
        hostSlots: revision.verification?.renderedHostSlots ?? [],
        pages: json.hostUi.pages.filter(
          (page) => page.owner.kind === 'extension' && page.owner.revisionId === revision.id,
        ),
        ...(revision.verification === undefined
          ? {}
          : {
              verification: {
                verifiedAt: revision.verification.verifiedAt,
                dshVersion: revision.verification.dshVersion,
                contractVersion: revision.verification.contractVersion,
                hostBuilt: revision.verification.hostBuilt,
                clientBuilt: revision.verification.clientBuilt,
                buildKey: revision.verification.buildKey,
                toolInvocationCount: revision.verification.toolInvocationCount,
                rpcMethods: revision.verification.rpcMethods,
                renderedSlots: revision.verification.renderedSlots,
                ...(revision.verification.permissions === undefined
                  ? {}
                  : { permissions: revision.verification.permissions }),
                ...(revision.verification.permissionDigest === undefined
                  ? {}
                  : { permissionDigest: revision.verification.permissionDigest }),
                ...(revision.verification.permissionApprovalRequired === undefined
                  ? {}
                  : { permissionApprovalRequired: revision.verification.permissionApprovalRequired }),
              },
            }),
      })),
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
          ...(candidate.runtime === undefined
            ? {}
            : {
                runtime: {
                  status: candidate.runtime.status,
                  observedAt: candidate.runtime.observedAt,
                  ...(candidate.runtime.message === undefined ? {} : { message: candidate.runtime.message }),
                },
              }),
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
              ...(latestRevision.verification.permissions === undefined
                ? {}
                : { permissions: latestRevision.verification.permissions }),
              ...(latestRevision.verification.permissionDigest === undefined
                ? {}
                : { permissionDigest: latestRevision.verification.permissionDigest }),
              ...(latestRevision.verification.permissionApprovalRequired === undefined
                ? {}
                : { permissionApprovalRequired: latestRevision.verification.permissionApprovalRequired }),
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
      ...(extension.installation === undefined
        ? {}
        : {
            installation: {
              revisionId: extension.installation.extensionRevisionId,
              installedAt: extension.installation.installedAt,
              ...(extension.installation.runtime === undefined
                ? {}
                : {
                    runtime: {
                      status: extension.installation.runtime.status,
                      observedAt: extension.installation.runtime.observedAt,
                      ...(extension.installation.runtime.message === undefined
                        ? {}
                        : { message: extension.installation.runtime.message }),
                    },
                  }),
            },
          }),
      ...(extension.hostClientDiagnostic === undefined
        ? {}
        : {
            hostClientDiagnostic: {
              revisionId: extension.hostClientDiagnostic.revisionId,
              status: extension.hostClientDiagnostic.status,
              ...(extension.hostClientDiagnostic.message === undefined
                ? {}
                : { message: extension.hostClientDiagnostic.message }),
              observedAt: extension.hostClientDiagnostic.observedAt,
            },
          }),
      ...(extension.hostUiPermission === undefined ? {} : { hostUiPermission: extension.hostUiPermission }),
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
    archivedConnections,
    workTreeOrder: json.workTreeOrder,
    extensions: extensionsLocal,
    hostUi: json.hostUi,
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
      ...(item.activeRun === undefined ? {} : { activeRun: { ...item.activeRun } }),
      ...(item.latestRun === undefined
        ? {}
        : {
            latestRun: {
              pluginRunId: item.latestRun.pluginRunId,
              packageId: item.latestRun.packageId,
              mode: item.latestRun.mode,
              status: item.latestRun.status,
              ...(item.latestRun.approvalRequestId === undefined
                ? {}
                : { approvalRequestId: item.latestRun.approvalRequestId }),
              ...(item.latestRun.requiresApproval === undefined
                ? {}
                : { requiresApproval: item.latestRun.requiresApproval }),
              host: {
                status: item.latestRun.host.status,
                waitingFor: [...item.latestRun.host.waitingFor],
                ...(item.latestRun.host.error === undefined ? {} : { error: item.latestRun.host.error }),
              },
              client: {
                status: item.latestRun.client.status,
                waitingFor: [...item.latestRun.client.waitingFor],
                ...(item.latestRun.client.error === undefined ? {} : { error: item.latestRun.client.error }),
              },
              ...(item.latestRun.error === undefined
                ? {}
                : {
                    error: {
                      phase: item.latestRun.error.phase,
                      message: item.latestRun.error.message,
                      ...(item.latestRun.error.stack === undefined ? {} : { stack: item.latestRun.error.stack }),
                      pluginId: item.latestRun.error.pluginId,
                      packageId: item.latestRun.error.packageId,
                      pluginRunId: item.latestRun.error.pluginRunId,
                    },
                  }),
            },
          }),
      packages: item.packages,
      policy: {
        turn: item.policy.turn,
        consecutiveFailures: item.policy.consecutiveFailures,
        repeatedFingerprintCount: item.policy.repeatedFingerprintCount,
        ...(item.policy.blockedReason === undefined ? {} : { blockedReason: item.policy.blockedReason }),
      },
    })),
    authoringTasks: json.authoringTasks,
    notificationSettings: json.notificationSettings,
    diagnosticNote: `服务连接正常（${agents.length} 个智能体 · ${channels.length} 个频道 · ${extensionsLocal.length} 个本地扩展）。`,
  }
}

export class HttpProductHost implements ProductHostPort {
  #refreshRevision = 0
  #snapshotRequest: Promise<Error | null> | undefined
  #refreshAgain = false
  #snapshotInvalidation: SyncCursor | undefined
  #snapshotCursor: SyncCursor | undefined
  #mutationInvalidation = 0
  #syncAfterCommit = false
  #retryTimer: ReturnType<typeof setTimeout> | undefined
  #retryAttempt = 0
  #readController = new AbortController()
  #snapshotEvents:
    | Array<{
        cursor: { epoch: string; sequence: number } | undefined
        replay: () => void
      }>
    | undefined
  #snapshotOverflow = false
  #replayingSnapshot = false
  readonly #messageRequests = new Map<string, { key: string; promise: Promise<MessagePage> }>()
  readonly #messageAgain = new Set<string>()
  readonly #messageCursor = new Map<string, SyncCursor>()
  readonly #runtimeCursor = new Map<string, SyncCursor>()
  readonly #runtimeRequests = new Map<string, Promise<ChannelRuntimeView>>()
  readonly #pendingRuntimeFrames = new Map<
    string,
    Array<{ data: ChannelRuntimeSseData; cursor: SyncCursor | undefined }>
  >()
  readonly #runtimeOverflow = new Set<string>()
  #lifecycle = 0
  readonly #data: {
    getSnapshot(): ProductSnapshot
    applySnapshot(snapshot: ProductSnapshot): void
    resetLoads?(): void
  }
  get #snapshot(): ProductSnapshot {
    return this.#data.getSnapshot()
  }
  set #snapshot(snapshot: ProductSnapshot) {
    this.#data.applySnapshot(snapshot)
  }
  #listener: (() => void) | undefined
  readonly #events: HostEventStream
  readonly #loadedChannels = new Set<string>()
  readonly #loadedRuntimes = new Set<string>()
  readonly #messageRevision = new Map<string, number>()
  readonly #runtimeRevision = new Map<string, number>()
  readonly #reconciling = new Set<string>()
  readonly #messageReconcileDepth = new Map<string, number>()
  readonly #pendingChannelFacts = new Map<string, Array<{ data: ChannelFactSseData; cursor: SyncCursor | undefined }>>()
  #reconcilePromise: Promise<void> | undefined

  constructor(
    events: HostEventStream = new HostEventStream(),
    data?: { getSnapshot(): ProductSnapshot; applySnapshot(snapshot: ProductSnapshot): void; resetLoads?(): void },
  ) {
    this.#events = events
    const isolated = data === undefined ? createStore<ProductSnapshot>(() => emptySnapshot()) : undefined
    this.#data = data ?? {
      getSnapshot: () => isolated!.getState(),
      applySnapshot: (snapshot) => isolated!.setState(snapshot, true),
    }
  }

  getSnapshot(): ProductSnapshot {
    return this.#snapshot
  }

  subscribe(listener: () => void): () => void {
    if (this.#listener) throw new Error('HttpProductHost 已经订阅，不能再订阅。')
    this.#lifecycle += 1
    this.#listener = listener
    void this.#refreshAndNotify()
    const handlers: HostEventStreamHandlers = {
      'snapshot-changed': (event) => {
        this.#mutationInvalidation += 1
        const cursor = eventCursor(event)
        if (
          cursor !== undefined &&
          this.#snapshotCursor?.epoch === cursor.epoch &&
          cursor.sequence <= this.#snapshotCursor.sequence
        )
          return
        this.#snapshotInvalidation = cursor
        if (this.#snapshotRequest !== undefined && cursor !== undefined) return
        void this.#refreshAndNotify()
      },
      open: () => {
        this.#requestReconcile()
      },
      'channel-fact': (event) => {
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
        this.#applyChannelFact(parsed.data, eventCursor(event))
      },
      'connection-fact': (event) => {
        const rawData = sseEventData(event)
        if (rawData === undefined) return
        try {
          const parsed = HostConnectionEventSchema.safeParse(JSON.parse(rawData))
          if (parsed.success) this.#applyConnectionFact(parsed.data)
        } catch {
          // A malformed connection fact is isolated from the rest of the stream.
        }
      },
      runtime: (event) => {
        const rawData = sseEventData(event)
        if (rawData === undefined) return
        try {
          const parsed = ChannelRuntimeSseDataSchema.safeParse(JSON.parse(rawData))
          if (parsed.success) this.#applyRuntimeFrame(parsed.data, eventCursor(event))
        } catch {
          // Ignore malformed runtime frames; do not refetch the global snapshot.
        }
      },
      'extensions-changed': () => {
        void this.#refreshAndNotify()
      },
      'dynamic-changed': () => {
        void this.#refreshAndNotify()
      },
      status: (event) => {
        const rawData = sseEventData(event)
        if (rawData === undefined) {
          void this.#refreshAndNotify()
          return
        }
        try {
          const parsed = HostSseStatusDataSchema.safeParse(JSON.parse(rawData))
          if (parsed.success && parsed.data.replay === 'complete') return
          if (parsed.success && parsed.data.replay === 'expired') {
            this.#requestReconcile()
            return
          }
        } catch {
          // Fall through to a snapshot refresh for unparseable status frames.
        }
        void this.#refreshAndNotify()
      },
      error: () => {
        this.#publishFailure({ code: 'sse', message: '与 NekroNXT Host 的实时连接已中断，正在尝试恢复。' })
      },
    }
    const unsubscribeEvents = this.#events.subscribe(
      Object.fromEntries(
        Object.entries(handlers).map(([type, handler]) => [
          type,
          (event: unknown) => {
            if (type === 'runtime' || type === 'channel-fact' || type === 'connection-fact') {
              this.#bufferSnapshotEvent(event, () => handler(event))
            }
            handler(event)
          },
        ]),
      ),
    )
    return () => {
      this.#lifecycle += 1
      this.#readController.abort()
      this.#readController = new AbortController()
      this.#snapshotRequest = undefined
      this.#snapshotEvents = undefined
      this.#snapshotInvalidation = undefined
      this.#snapshotCursor = undefined
      this.#syncAfterCommit = false
      this.#messageReconcileDepth.clear()
      this.#pendingChannelFacts.clear()
      this.#reconciling.clear()
      this.#messageRequests.clear()
      this.#messageAgain.clear()
      this.#messageCursor.clear()
      this.#runtimeCursor.clear()
      this.#runtimeRequests.clear()
      this.#pendingRuntimeFrames.clear()
      this.#runtimeOverflow.clear()
      this.#refreshAgain = false
      if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer)
      this.#retryTimer = undefined
      this.#retryAttempt = 0
      this.#listener = undefined
      this.#data.resetLoads?.()
      unsubscribeEvents()
    }
  }

  #bufferSnapshotEvent(event: unknown, replay: () => void): void {
    if (this.#snapshotEvents === undefined) return
    if (this.#snapshotEvents.length >= 512) {
      this.#snapshotOverflow = true
      return
    }
    const cursor = eventCursor(event)
    this.#snapshotEvents.push({ cursor, replay })
  }

  readonly actions: ProductActions = {
    'settings.providers': (signal) => this.#call(HostApiContracts.llmProviders, {}, undefined, signal),
    'settings.catalog': async (signal) => {
      const [plugins, settings] = await Promise.all([
        this.#call(HostApiContracts.dshPlugins, {}, undefined, signal),
        this.#call(HostApiContracts.dshSettings, {}, undefined, signal),
      ])
      return { plugins: plugins.plugins, namespaces: settings.namespaces }
    },

    'extensions.commitImport': async ({ token, ...body }) =>
      this.#mutate(HostApiContracts.commitExtensionImport, { token }, body),
    'extensions.delete': async (params) => this.#mutate(HostApiContracts.deleteLocalExtension, params, undefined),
    'hostUi.updatePreferences': async (body) => this.#mutate(HostApiContracts.updateHostUiPagePreferences, {}, body),
    'host.refresh': async () => {
      const failure = await this.#refreshAndNotify()
      if (failure !== null) throw failure
      return null
    },
    'host.reconnect': async () => {
      this.#events.reconnectNow()
      return this.actions['host.refresh']()
    },
    'notifications.update': async (body) => this.#mutate(HostApiContracts.updateNotificationSettings, {}, body),
    'notifications.testBark': async (body) => this.#call(HostApiContracts.testBarkNotification, {}, body),
    'notifications.testSystem': async () => this.#call(HostApiContracts.testSystemNotification, {}, undefined),
    'platformUsers.list': async (input = {}, signal) =>
      this.#call(HostApiContracts.listPlatformUsers, { ...input, limit: input.limit ?? 50 }, undefined, signal),
    'connections.listEvents': async (input) =>
      this.#call(HostApiContracts.listConnectionEvents, { ...input, limit: input.limit ?? 30 }, undefined),
    'agents.create': async (body) => this.#mutate(HostApiContracts.createAgent, {}, body),
    'agents.revise': async ({ agentId, ...body }) => this.#mutate(HostApiContracts.reviseAgent, { agentId }, body),
    'agents.delete': async ({ agentId, ...body }) => this.#mutate(HostApiContracts.deleteAgent, { agentId }, body),
    'channels.resetContext': async ({ channelId, ...body }) =>
      this.#mutate(HostApiContracts.resetChannelContext, { channelId }, body),
    'channels.delete': async ({ channelId, ...body }) =>
      this.#mutate(HostApiContracts.deleteChannel, { channelId }, body),
    'channels.rename': async ({ channelId, ...body }) =>
      this.#mutate(HostApiContracts.renameChannel, { channelId }, body),
    'agents.updateCapabilities': async ({ agentId, ...body }) =>
      this.#mutate(HostApiContracts.updateAgentCapabilities, { agentId }, body),
    'connections.create': async (body) => this.#mutate(HostApiContracts.createConnection, {}, body),
    'connections.updateAlias': async ({ connectionId, ...body }) =>
      this.#mutate(HostApiContracts.updateConnectionAlias, { connectionId }, body),
    'connections.updateActivityTriggerDefaults': async ({ connectionId, ...body }) =>
      this.#mutate(HostApiContracts.updateConnectionActivityTriggerDefaults, { connectionId }, body),
    'connections.delete': async ({ connectionId, ...body }) =>
      this.#mutate(HostApiContracts.deleteConnection, { connectionId }, body),
    'connections.restore': async ({ connectionId }) =>
      this.#mutate(HostApiContracts.restoreConnection, { connectionId }, undefined),
    'channels.createInternal': async (body) => this.#mutate(HostApiContracts.createInternalChannel, {}, body),
    'bindings.create': async (body) => this.#mutate(HostApiContracts.createBinding, {}, body),
    'bindings.clear': async ({ channelId }) => this.#mutate(HostApiContracts.clearBinding, { channelId }, undefined),
    'workTreeOrder.put': async (body) => this.#mutate(HostApiContracts.putWorkTreeOrder, {}, body),
    'connections.test': async ({ connectionId, ...body }) =>
      this.#mutate(HostApiContracts.testConnection, { connectionId }, body),
    'dynamic.approve': async ({ agentId, ...body }) => this.#mutate(HostApiContracts.dynamicApprove, { agentId }, body),
    'dynamic.decline': async ({ agentId, ...body }) => this.#mutate(HostApiContracts.dynamicDecline, { agentId }, body),
    'authoring.decide': async ({ taskId, attemptId, ...body }) =>
      this.#mutate(HostApiContracts.decideAuthoringAttempt, { taskId, attemptId }, body),
    'authoring.stop': async ({ taskId, ...body }) => this.#mutate(HostApiContracts.stopAuthoringTask, { taskId }, body),
    'authoring.delete': async ({ taskId }) => this.#mutate(HostApiContracts.deleteAuthoringTask, { taskId }, undefined),
    'extensions.activate': async ({ agentId, extensionId, ...body }) =>
      this.#mutate(HostApiContracts.activateExtension, { agentId, extensionId }, body),
    'extensions.uninstall': async ({ extensionId }) =>
      this.#mutate(HostApiContracts.uninstallHostExtension, { extensionId }, undefined),
    'extensions.hostClientDiagnostic': async ({ extensionId, revisionId, ...body }) =>
      this.#call(HostApiContracts.hostExtensionClientDiagnostic, { extensionId, revisionId }, body),
    'extensions.deactivate': async ({ agentId, extensionId }) =>
      this.#mutate(HostApiContracts.deactivateExtension, { agentId, extensionId }, undefined),
    'extensions.clientDiagnostic': async ({ extensionId, revisionId, ...body }) =>
      this.#call(HostApiContracts.extensionClientDiagnostic, { extensionId, revisionId }, body),
    'channels.sendMessage': async ({ channelId, body }) =>
      this.#mutate(HostApiContracts.sendChannelMessage, { channelId }, { parts: [{ type: 'text', text: body }] }),
    'channels.listMessages': async ({ channelId, mode = 'initial', limit, beforeOccurredAt, beforeSourceId }) =>
      this.#loadChannelMessages(
        channelId,
        mode,
        limit ?? (mode === 'initial' ? CHANNEL_MESSAGE_INITIAL_PAGE_SIZE : CHANNEL_MESSAGE_PAGE_SIZE),
        beforeOccurredAt,
        beforeSourceId,
      ),
    'channels.getRuntime': async ({ channelId }) => this.#loadChannelRuntime(channelId),
    'extensions.install': async ({ extensionId, permissionDigest, ...body }) =>
      this.#mutate(
        HostApiContracts.installHostExtension,
        { extensionId },
        {
          ...body,
          ...(permissionDigest === undefined ? {} : { permissionApproval: { permissionDigest } }),
        },
      ),
    'extensions.saveFromDynamic': async ({ name, ...body }) =>
      this.#mutate(HostApiContracts.saveExtensionFromDynamic, {}, { ...body, displayName: name }),
    'extensions.clientCall': async ({ extensionId, revisionId, value, ...body }) =>
      this.#call(
        HostApiContracts.extensionClientCall,
        { extensionId, revisionId },
        {
          ...body,
          ...(value === undefined ? {} : { input: value }),
        },
      ),
  }

  async #mutate<Contract extends HostApiContract, Output>(
    contract: Contract & { readonly parseResponse: (input: unknown) => Output },
    params: HostApiContractParams<Contract>,
    body: HostApiContractRequest<Contract>,
  ): Promise<Output> {
    const lifecycle = this.#lifecycle
    const invalidation = this.#mutationInvalidation
    const result = await this.#call(contract, params, body)
    if (lifecycle === this.#lifecycle) {
      this.#syncAfterCommit = true
      // A committed action never waits for synchronization or resubmits on its failure.
      if (invalidation === this.#mutationInvalidation) void this.#refreshAndNotify()
    }
    return result
  }

  async #call<Contract extends HostApiContract, Output>(
    contract: Contract & { readonly parseResponse: (input: unknown) => Output },
    params: HostApiContractParams<Contract>,
    body: HostApiContractRequest<Contract>,
    signal?: AbortSignal,
  ): Promise<Output> {
    const lifecycle = this.#lifecycle
    const reading = contract.method === 'GET'
    try {
      const result = await callHostApi(
        contract,
        params,
        body,
        reading
          ? {
              signal:
                signal === undefined
                  ? this.#readController.signal
                  : AbortSignal.any([this.#readController.signal, signal]),
            }
          : {},
      )
      if (reading && lifecycle !== this.#lifecycle) throw new StaleHostReadError()
      return result
    } catch (cause) {
      if (reading && lifecycle !== this.#lifecycle) throw new StaleHostReadError()
      if (lifecycle === this.#lifecycle && cause instanceof HostRequestError && cause.kind === 'network') {
        this.#publishFailure({ code: 'network', message: cause.message })
      }
      throw cause
    }
  }

  #loadChannelMessages(
    channelId: string,
    mode: 'initial' | 'older' | 'latest',
    limit: number,
    beforeOccurredAt?: number,
    beforeSourceId?: string,
  ): Promise<MessagePage> {
    const lifecycle = this.#lifecycle
    const key = JSON.stringify([mode, limit, beforeOccurredAt, beforeSourceId])
    const current = this.#messageRequests.get(channelId)
    if (current !== undefined) {
      if (current.key === key) return current.promise
      return current.promise
        .catch(() => undefined)
        .then(() => {
          if (lifecycle !== this.#lifecycle) throw new StaleHostReadError()
          return this.#loadChannelMessages(channelId, mode, limit, beforeOccurredAt, beforeSourceId)
        })
    }
    const task = this.#readChannelMessages(channelId, mode, limit, beforeOccurredAt, beforeSourceId).finally(() => {
      if (this.#messageRequests.get(channelId)?.promise === task) {
        this.#messageRequests.delete(channelId)
        if (this.#messageAgain.delete(channelId)) {
          void this.#loadChannelMessages(channelId, 'latest', CHANNEL_MESSAGE_PAGE_SIZE).catch(() => undefined)
        }
      }
    })
    this.#messageRequests.set(channelId, { key, promise: task })
    return task
  }

  async #readChannelMessages(
    channelId: string,
    mode: 'initial' | 'older' | 'latest',
    limit: number,
    beforeOccurredAt?: number,
    beforeSourceId?: string,
  ): Promise<{ readonly messages: readonly ConversationMessage[]; readonly hasMore: boolean }> {
    const lifecycle = this.#lifecycle
    let cursor: SyncCursor | undefined
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
      cursor = raw.cursor
      const buffered = this.#pendingChannelFacts.get(channelId) ?? []
      if (buffered.some((entry) => entry.cursor !== undefined && entry.cursor.epoch !== raw.cursor.epoch)) {
        this.#messageAgain.add(channelId)
        return { messages: [], hasMore: true }
      }
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
      this.#messageCursor.set(channelId, raw.cursor)
      this.#messageRevision.delete(channelId)
      this.#snapshot = { ...this.#snapshot, messages: [...other, ...deduplicated] }
      this.#listener?.()
      return { messages: projected, hasMore: raw.hasMore }
    } finally {
      if (lifecycle === this.#lifecycle) {
        const remaining = (this.#messageReconcileDepth.get(channelId) ?? 1) - 1
        if (remaining > 0) {
          this.#messageReconcileDepth.set(channelId, remaining)
        } else {
          this.#messageReconcileDepth.delete(channelId)
          const pending = this.#pendingChannelFacts.get(channelId) ?? []
          this.#pendingChannelFacts.delete(channelId)
          for (const fact of pending) {
            if (cursor !== undefined && fact.cursor !== undefined) {
              if (fact.cursor.epoch !== cursor.epoch) {
                this.#messageAgain.add(channelId)
                continue
              }
              if (fact.cursor.sequence <= cursor.sequence) continue
            }
            this.#applyChannelFact(fact.data, fact.cursor)
          }
        }
      }
    }
  }

  #loadChannelRuntime(channelId: string): Promise<ChannelRuntimeView> {
    const current = this.#runtimeRequests.get(channelId)
    if (current !== undefined) return current
    const task = this.#readChannelRuntime(channelId).finally(() => {
      if (this.#runtimeRequests.get(channelId) === task) this.#runtimeRequests.delete(channelId)
    })
    this.#runtimeRequests.set(channelId, task)
    return task
  }

  async #readChannelRuntime(channelId: string): Promise<ChannelRuntimeView> {
    const lifecycle = this.#lifecycle
    this.#reconciling.add(`runtime:${channelId}`)
    try {
      for (;;) {
        this.#reconciling.add(`runtime:${channelId}`)
        this.#runtimeOverflow.delete(channelId)
        this.#pendingRuntimeFrames.set(channelId, [])
        const raw = await this.#call(HostApiContracts.getChannelRuntime, { channelId }, undefined)
        const pending = this.#pendingRuntimeFrames.get(channelId) ?? []
        if (
          this.#runtimeOverflow.has(channelId) ||
          pending.some((entry) => entry.cursor !== undefined && entry.cursor.epoch !== raw.cursor.epoch)
        )
          continue
        const view = this.#runtimeViewFromProjection(raw)
        this.#loadedRuntimes.add(channelId)
        this.#runtimeCursor.set(channelId, raw.cursor)
        this.#runtimeRevision.delete(channelId)
        this.#writeRuntimeView(view, { includeTurns: true })
        this.#pendingRuntimeFrames.delete(channelId)
        this.#reconciling.delete(`runtime:${channelId}`)
        const newer = pending.filter(
          (entry) => entry.cursor === undefined || entry.cursor.sequence > raw.cursor.sequence,
        )
        // A truncated incremental frame cannot reconstruct the complete trajectory.
        if (
          newer.some(
            (entry, index) =>
              entry.data.truncated || (index > 0 && entry.data.revision > newer[index - 1]!.data.revision + 1),
          )
        )
          continue
        for (const entry of newer) this.#applyRuntimeFrame(entry.data, entry.cursor)
        return this.#snapshot.channelRuntimes[channelId] ?? view
      }
    } finally {
      if (lifecycle === this.#lifecycle) {
        this.#reconciling.delete(`runtime:${channelId}`)
        this.#pendingRuntimeFrames.delete(channelId)
        this.#runtimeOverflow.delete(channelId)
      }
    }
  }

  #applyChannelFact(data: ChannelFactSseData, cursor?: SyncCursor): void {
    if ((this.#messageReconcileDepth.get(data.channelId) ?? 0) > 0) {
      const pending = this.#pendingChannelFacts.get(data.channelId) ?? []
      if (pending.length >= 512) {
        this.#messageAgain.add(data.channelId)
        return
      }
      pending.push({ data, cursor })
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
    const floor = this.#messageCursor.get(data.channelId)
    if (cursor !== undefined && floor !== undefined) {
      if (cursor.epoch !== floor.epoch) {
        this.#requestReconcile()
        return
      }
      if (cursor.sequence <= floor.sequence) return
    }
    const last = this.#messageRevision.get(data.channelId)
    if (last !== undefined && data.revision <= last) return
    if (last !== undefined && data.revision !== last + 1) {
      if (this.#messageRequests.has(data.channelId)) this.#messageAgain.add(data.channelId)
      void this.#loadChannelMessages(data.channelId, 'latest', CHANNEL_MESSAGE_PAGE_SIZE).catch(() => undefined)
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
    if (cursor !== undefined) this.#messageCursor.set(data.channelId, cursor)
    this.#snapshot = { ...this.#snapshot, messages: [...other, ...deduplicated] }
    this.#listener?.()
  }

  #applyConnectionFact(event: HostConnectionEvent): void {
    const connections = this.#snapshot.connections.map((connection) => {
      if (connection.id !== event.connectionId) return connection
      return {
        ...connection,
        events: [event, ...connection.events.filter((candidate) => candidate.id !== event.id)],
        eventsLoaded: true,
      }
    })
    this.#snapshot = { ...this.#snapshot, connections, platformUsersRevision: this.#snapshot.platformUsersRevision + 1 }
    this.#listener?.()
  }

  #applyRuntimeFrame(data: ChannelRuntimeSseData, cursor?: SyncCursor): void {
    const pending = this.#pendingRuntimeFrames.get(data.channelId)
    if (pending !== undefined && !this.#replayingSnapshot) {
      if (pending.length >= 512) this.#runtimeOverflow.add(data.channelId)
      else pending.push({ data, cursor })
    }
    const view = this.#runtimeViewFromProjection(data)
    if (this.#replayingSnapshot) {
      this.#writeRuntimeView(view, { includeTurns: false })
      return
    }
    const floor = this.#runtimeCursor.get(data.channelId)
    if (cursor !== undefined && floor !== undefined) {
      if (cursor.epoch !== floor.epoch) {
        this.#requestReconcile()
        return
      }
      if (cursor.sequence <= floor.sequence) return
    }
    if (cursor !== undefined) this.#runtimeCursor.set(data.channelId, cursor)
    const previousRevision = this.#runtimeRevision.get(data.channelId)
    if (previousRevision !== undefined && data.revision <= previousRevision) return
    this.#writeRuntimeView(view, { includeTurns: false })
    if (!this.#loadedRuntimes.has(data.channelId)) return
    if (this.#reconciling.has(`runtime:${data.channelId}`)) return
    const last = this.#runtimeRevision.get(data.channelId)
    if (data.truncated === true || (last !== undefined && data.revision !== last + 1)) {
      void this.#loadChannelRuntime(data.channelId).catch(() => undefined)
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
      | 'performance'
      | 'turns'
    >,
  ): ChannelRuntimeView {
    return {
      channelId: raw.channelId,
      ...(raw.agentId === undefined ? {} : { agentId: raw.agentId }),
      ...(raw.episodeId === undefined ? {} : { episodeId: raw.episodeId }),
      phase: raw.phase,
      summary: raw.summary,
      pendingInjectCount: raw.pendingInjectCount,
      ...(raw.occupancy === undefined ? {} : { occupancy: raw.occupancy }),
      ...(raw.cache === undefined ? {} : { cache: raw.cache }),
      ...(raw.performance === undefined ? {} : { performance: raw.performance }),
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
    const failure = await this.#refreshAndNotify()
    if (failure !== null) return
    await Promise.all([
      ...[...this.#loadedChannels].map((channelId) =>
        this.#loadChannelMessages(channelId, 'latest', CHANNEL_MESSAGE_PAGE_SIZE),
      ),
      ...[...this.#loadedRuntimes].map((channelId) => this.#loadChannelRuntime(channelId)),
    ])
  }

  #requestReconcile(): void {
    if (this.#reconcilePromise !== undefined) return
    const task = this.#reconcileLoaded()
      .catch(() => undefined)
      .finally(() => {
        if (this.#reconcilePromise === task) this.#reconcilePromise = undefined
      })
    this.#reconcilePromise = task
  }

  #refreshAndNotify(): Promise<Error | null> {
    if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer)
    this.#retryTimer = undefined
    if (this.#snapshotRequest !== undefined) {
      this.#refreshAgain = true
      return this.#snapshotRequest
    }
    const lifecycle = this.#lifecycle
    const task = (async (): Promise<Error | null> => {
      let failure: Error | null
      do {
        this.#refreshAgain = false
        failure = await this.#readSnapshot()
      } while (this.#refreshAgain && lifecycle === this.#lifecycle)
      return failure
    })().finally(() => {
      if (this.#snapshotRequest === task) this.#snapshotRequest = undefined
    })
    this.#snapshotRequest = task
    return task
  }

  async #readSnapshot(): Promise<Error | null> {
    this.#snapshotEvents = []
    this.#snapshotOverflow = false
    const revision = ++this.#refreshRevision
    const lifecycle = this.#lifecycle
    const current = (): boolean => revision === this.#refreshRevision && lifecycle === this.#lifecycle
    let json: SnapshotJson
    try {
      json = await callHostApi(HostApiContracts.snapshot, {}, undefined, { signal: this.#readController.signal })
    } catch (cause) {
      if (!current()) return null
      this.#snapshotEvents = undefined
      const failure = cause instanceof Error ? cause : new Error(errorMessage(cause, '无法连接 NekroNXT Host。'))
      const code =
        cause instanceof HostRequestError
          ? cause.kind === 'network'
            ? 'network'
            : cause.kind === 'http'
              ? 'http'
              : 'invalid-snapshot'
          : 'invalid-snapshot'
      this.#publishFailure({
        code,
        message: this.#syncAfterCommit ? `已保存，界面同步失败：${failure.message}` : failure.message,
      })
      this.#scheduleReadRetry()
      return failure
    }
    if (!current()) return null
    const buffered = this.#snapshotEvents ?? []
    this.#snapshotEvents = undefined
    if (
      this.#snapshotOverflow ||
      buffered.some((entry) => entry.cursor !== undefined && entry.cursor.epoch !== json.cursor.epoch)
    ) {
      this.#refreshAgain = false
      this.#scheduleReadRetry()
      return null
    }
    this.#retryAttempt = 0
    this.#syncAfterCommit = false
    this.#snapshotCursor = json.cursor
    if (this.#snapshotInvalidation !== undefined) {
      if (
        this.#snapshotInvalidation.epoch !== json.cursor.epoch ||
        this.#snapshotInvalidation.sequence > json.cursor.sequence
      ) {
        this.#refreshAgain = true
      } else {
        this.#snapshotInvalidation = undefined
      }
    }
    const projected = projectSnapshot(json, Date.now())
    const previousConnections = new Map(this.#snapshot.connections.map((connection) => [connection.id, connection]))
    this.#snapshot = {
      ...projected,
      messages: this.#loadedChannels.size > 0 ? this.#snapshot.messages : projected.messages,
      channelRuntimes: this.#snapshot.channelRuntimes,
      connections: projected.connections.map((connection) => {
        const previous = previousConnections.get(connection.id)
        return previous === undefined
          ? connection
          : {
              ...connection,
              events: previous.events,
              eventsLoaded: previous.eventsLoaded,
              eventsLoading: previous.eventsLoading,
              eventsHasMore: previous.eventsHasMore,
            }
      }),
      platformUsersRevision: this.#snapshot.platformUsersRevision,
    }
    for (const message of this.#snapshot.messages) this.#loadedChannels.add(message.channelId)
    const replay = buffered.filter(
      (entry) => entry.cursor === undefined || entry.cursor.sequence > json.cursor.sequence,
    )
    replay.sort((left, right) => (left.cursor?.sequence ?? Infinity) - (right.cursor?.sequence ?? Infinity))
    this.#replayingSnapshot = true
    try {
      for (const entry of replay) entry.replay()
    } finally {
      this.#replayingSnapshot = false
    }
    this.#listener?.()
    return null
  }

  #scheduleReadRetry(): void {
    if (!this.#listener || this.#retryTimer !== undefined) return
    const lifecycle = this.#lifecycle
    const delay = Math.min(1000 * 2 ** this.#retryAttempt++, 30_000)
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined
      if (lifecycle === this.#lifecycle) this.#requestReconcile()
    }, delay)
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

const errorMessage = (cause: unknown, fallback: string): string =>
  cause instanceof Error && cause.message.trim() ? cause.message : fallback
