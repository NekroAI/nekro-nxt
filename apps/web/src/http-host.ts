import type {
  AgentSummary,
  ChannelSummary,
  ConnectionSummary,
  ConversationMessage,
  DeliveryState,
} from './product-store.js'
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
 * failures degrade silently to the last good snapshot instead of crashing the
 * Shell (the UI keeps working against the previous projection).
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

const partsToBody = (parts: readonly { type: string; text?: string; memberId?: string }[]): string =>
  parts
    .map((part) =>
      part.type === 'text' ? (part.text ?? '') : part.type === 'mention' ? `@${part.memberId ?? ''}` : '',
    )
    .join('')

const emptySnapshot = (): ProductSnapshot => ({
  agents: [],
  channels: [],
  messages: [],
  connections: [],
  extensions: [],
  approvals: [],
  diagnosticNote: '正在连接本机 Server 数据源…',
})

interface SnapshotAgentJson {
  readonly id: string
  readonly displayName: string
  readonly model: { readonly provider: string; readonly model: string }
  readonly capabilities: {
    readonly dynamicCreation: boolean
    readonly developmentShell: boolean
    readonly fullFileAccess: boolean
  }
  readonly channels: readonly string[]
}

interface SnapshotChannelJson {
  readonly id: string
  readonly platformChannelId: string
  readonly kind: string
  readonly displayName?: string
  readonly boundAgentId?: string
}

interface SnapshotMessageJson {
  readonly id: string
  readonly channelId: string
  readonly role: 'member' | 'agent'
  readonly parts: readonly { type: string; text?: string; memberId?: string }[]
  readonly occurredAt: number
  readonly deliveryState?: string
}

interface SnapshotConnectionJson {
  readonly id: string
  readonly adapterKey: string
  readonly status: string
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

interface SnapshotJson {
  readonly agents: readonly SnapshotAgentJson[]
  readonly channels: readonly SnapshotChannelJson[]
  readonly messages: readonly SnapshotMessageJson[]
  readonly connections: readonly SnapshotConnectionJson[]
  readonly extensions: readonly SnapshotExtensionJson[]
}

const isSnapshotJson = (value: unknown): value is SnapshotJson => {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<SnapshotJson>
  return (
    Array.isArray(candidate.agents) &&
    Array.isArray(candidate.channels) &&
    Array.isArray(candidate.messages) &&
    Array.isArray(candidate.connections) &&
    Array.isArray(candidate.extensions)
  )
}

/**
 * Project the authoritative Server projection onto the Shell's `ProductSnapshot`
 * shape. Business facts are not copied into a second store — the Shell only
 * re-shapes them for display (design docs/08 §2.3).
 */
const projectSnapshot = (json: SnapshotJson): ProductSnapshot => {
  const agentNameByChannel = new Map<string, string>()
  for (const channel of json.channels) {
    if (channel.boundAgentId !== undefined) {
      const agent = json.agents.find((candidate) => candidate.id === channel.boundAgentId)
      if (agent) agentNameByChannel.set(channel.id, agent.displayName)
    }
  }
  const agents: AgentSummary[] = json.agents.map((agent) => ({
    id: agent.id,
    name: agent.displayName,
    description: '',
    state: '空闲',
    model: agent.model.model,
    channels: [...agent.channels],
    extensionCount: 0,
    capabilities: { ...agent.capabilities },
  }))
  const channels: ChannelSummary[] = json.channels.map((channel) => ({
    id: channel.id,
    name: channel.displayName ?? (channel.kind === 'web' ? 'Web 频道' : channel.platformChannelId),
    kind: channel.kind === 'group' ? 'qq-group' : 'web',
    connectionName: '本地 Web',
    agentId: channel.boundAgentId ?? '',
    trigger: '始终响应',
    unread: 0,
  }))
  const messages: ConversationMessage[] = json.messages.map((message) => {
    const delivery = deliveryStateToUi(message.deliveryState)
    return {
      id: message.id,
      channelId: message.channelId,
      role: message.role === 'agent' ? 'agent' : 'member',
      author: message.role === 'agent' ? (agentNameByChannel.get(message.channelId) ?? '智能体') : '你',
      body: partsToBody(message.parts),
      time: formatTime(message.occurredAt),
      ...(delivery === undefined ? {} : { delivery }),
    }
  })
  const connections: ConnectionSummary[] = json.connections.map((connection) => ({
    id: connection.id,
    name:
      connection.adapterKey === 'web'
        ? '本地 Web'
        : connection.adapterKey === 'qq-openclaw'
          ? 'QQ 机器人账号'
          : connection.adapterKey,
    adapter: connection.adapterKey,
    state:
      connection.status === 'active'
        ? '已连接'
        : connection.status === 'configured'
          ? '已配置'
          : connection.status === 'failed'
            ? '异常'
            : '已断开',
    appId: '',
    credentialRef: '',
    proactiveSend: false,
    channels: 0,
    lastEvent: '',
    receiveTest: '未测试',
    sendTest: '未测试',
  }))
  const extensionsLocal = json.extensions.map((extension) => {
    const targetAgent = extension.agentId
      ? (json.agents.find((agent) => agent.id === extension.agentId)?.displayName ?? extension.agentId)
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
    agents,
    channels,
    messages,
    connections,
    extensions: extensionsLocal,
    approvals: [],
    diagnosticNote: `已连接真实 Server（${agents.length} 个智能体 · ${channels.length} 个频道 · ${extensionsLocal.length} 个本地扩展）。`,
  }
}

export class HttpProductHost implements ProductHostPort {
  #snapshot: ProductSnapshot = emptySnapshot()
  #listener: (() => void) | undefined

  getSnapshot(): ProductSnapshot {
    return this.#snapshot
  }

  subscribe(listener: () => void): () => void {
    if (this.#listener) throw new Error('HttpProductHost 已经订阅，不能再订阅。')
    this.#listener = listener
    void this.#refreshAndNotify()
    const source = new EventSource('/api/events')
    source.addEventListener('channel-fact', () => {
      void this.#refreshAndNotify()
    })
    source.addEventListener('status', () => {
      void this.#refreshAndNotify()
    })
    // SSE 连接失败或中断时静默保留上一次快照；EventSource 会按浏览器语义自动重连。
    source.onerror = () => undefined
    return () => {
      this.#listener = undefined
      source.close()
    }
  }

  async execute(command: string, input?: Readonly<Record<string, unknown>>): Promise<unknown> {
    try {
      if (command === 'agents.create') {
        const body = createAgentRequestBody(input)
        const result = await postJson('/api/agents', body)
        await this.#refreshAndNotify()
        return result
      }
      if (command === 'channels.sendMessage') {
        const channelId = typeof input?.channelId === 'string' ? input.channelId : ''
        const text = typeof input?.body === 'string' ? input.body : ''
        if (!channelId.trim() || !text.trim()) return null
        const result = await postJson(`/api/channels/${encodeURIComponent(channelId)}/messages`, {
          parts: [{ type: 'text', text }],
        })
        await this.#refreshAndNotify()
        return result
      }
      if (command === 'connections.create') {
        const appId = typeof input?.appId === 'string' ? input.appId : ''
        const credentialRef = typeof input?.credentialRef === 'string' ? input.credentialRef : ''
        if (!appId.trim() || !credentialRef.trim()) return null
        const result = await postJson('/api/connections', { appId, credentialRef })
        await this.#refreshAndNotify()
        return result
      }
      if (command === 'extensions.activate') {
        const extensionId = typeof input?.extensionId === 'string' ? input.extensionId : ''
        const agentId = typeof input?.agentId === 'string' ? input.agentId : ''
        const revisionId = typeof input?.revisionId === 'string' ? input.revisionId : ''
        if (!extensionId.trim() || !agentId.trim() || !revisionId.trim()) return null
        const result = await postJson(`/api/extensions/${encodeURIComponent(extensionId)}/activation`, {
          agentId,
          revisionId,
        })
        await this.#refreshAndNotify()
        return result
      }
      if (command === 'extensions.deactivate') {
        const extensionId = typeof input?.extensionId === 'string' ? input.extensionId : ''
        if (!extensionId.trim()) return null
        const result = await requestJson(`/api/extensions/${encodeURIComponent(extensionId)}/activation`, {
          method: 'DELETE',
        })
        await this.#refreshAndNotify()
        return result
      }
      // 尚未提供的能力（如保存动态扩展）：静默返回，避免让 Shell 因未接线而崩溃。
      return null
    } catch {
      // 网络/Server 暂不可用：保留上一次快照，不让 UI 崩溃。
      return null
    }
  }

  async #refreshAndNotify(): Promise<void> {
    try {
      const response = await fetch('/api/snapshot', { headers: { accept: 'application/json' } })
      if (!response.ok) return
      const json: unknown = await response.json()
      if (!isSnapshotJson(json)) return
      this.#snapshot = projectSnapshot(json)
      this.#listener?.()
    } catch {
      // 静默降级：保留上一次成功投影。
    }
  }
}

const createAgentRequestBody = (input?: Readonly<Record<string, unknown>>): unknown => {
  const displayName = typeof input?.displayName === 'string' ? input.displayName : ''
  const modelLabel = typeof input?.modelLabel === 'string' ? input.modelLabel : ''
  const hasModel = modelLabel.trim().length > 0
  // 切片1 的界面还没有真实模型选择器，统一使用 DeepSeek 通道；
  // UI 拿到模型选择后（切片2 或后续 UI 精细化）再透传 provider/model。
  return {
    displayName: displayName.trim(),
    persona: '',
    model: hasModel
      ? { provider: 'deepseek', model: modelLabel.trim() }
      : { provider: 'deepseek', model: 'deepseek-chat' },
  }
}

const requestJson = async (
  path: string,
  init?: { readonly method?: 'POST' | 'DELETE'; readonly body?: unknown },
): Promise<unknown> => {
  const response = await fetch(path, {
    method: init?.method ?? 'POST',
    headers: { 'content-type': 'application/json' },
    ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
  const json: unknown = await response.json().catch(() => null)
  if (!response.ok) throw new Error(`Server 请求失败：${response.status}`)
  return json
}

const postJson = async (path: string, body: unknown): Promise<unknown> => {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json: unknown = await response.json().catch(() => null)
  if (!response.ok) throw new Error(`Server 请求失败：${response.status}`)
  return json
}
