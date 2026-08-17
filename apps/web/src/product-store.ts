import type { AdapterConnectionDescriptor } from '@nekro-nxt/adapter-sdk'
import { create } from 'zustand'
import type { DynamicPackageSummary, ProductHostPort } from './product-port.js'

let activeHost: ProductHostPort | null = null

export const setActiveProductHost = (host: ProductHostPort | null): void => {
  activeHost = host
}

export const getActiveProductHost = (): ProductHostPort | null => activeHost

export type AgentRuntimeState = '空闲' | '思考中' | '使用工具' | '等待输入' | '已暂停' | '不可用'
export type DeliveryState = '已发送' | '发送中' | '部分发送' | '失败' | '结果未知'
export type ConnectionState = '已连接' | '正在连接' | '认证过期' | '已配置' | '已断开' | '异常'

export interface AgentSummary {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly state: AgentRuntimeState
  readonly model: string
  readonly modelRef?: {
    readonly provider: string
    readonly model: string
    readonly reasoningEffort?: string
  }
  readonly persona?: string
  readonly currentRevisionId?: string
  readonly channels: readonly string[]
  readonly extensionCount: number
  readonly capabilities: {
    readonly dynamicCreation: boolean
    readonly developmentShell: boolean
    readonly fullFileAccess: boolean
  }
}

export interface ModelSummary {
  readonly provider: string
  readonly providerName: string
  readonly id: string
  readonly name: string
  readonly description?: string
}

export interface ChannelSummary {
  readonly id: string
  readonly connectionId: string
  readonly name: string
  readonly kind: 'web' | 'qq-group'
  readonly connectionName: string
  readonly agentId: string
  readonly trigger: string
  readonly bindings: readonly {
    readonly id: string
    readonly agentId: string
    readonly triggerPolicy: 'always' | 'mentioned-or-replied' | 'command' | 'observe-only'
  }[]
  readonly unread: number
}

export interface ConversationMessage {
  readonly id: string
  readonly channelId: string
  readonly author: string
  readonly role: 'member' | 'agent' | 'system'
  readonly body: string
  readonly time: string
  readonly delivery?: DeliveryState
  readonly attachment?: { readonly name: string; readonly kind: 'image' | 'file' }
}

export interface ConnectionSummary {
  readonly id: string
  readonly name: string
  /** User-facing Adapter name. The stable key remains available only for internal branching. */
  readonly adapter: string
  readonly adapterKey: string
  readonly state: ConnectionState
  readonly appId: string
  readonly credentialConfigured: boolean
  readonly gatewayState: string
  readonly lastError: string
  readonly proactiveSend: boolean
  readonly channels: number
  readonly knownChannels: readonly { readonly id: string; readonly name: string; readonly kind: string }[]
  readonly lastEvent: string
  readonly receiveTest: string
  readonly sendTest: string
}

export interface LocalExtensionSummary {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly revision: number
  readonly activation: '已激活' | '等待安全切换' | '未激活' | '激活失败'
  readonly targetAgent: string
  readonly contributions: readonly string[]
  /** Saved Revision id + owning intelligent-agent id; not intended for display. */
  readonly revisionId?: string
  readonly agentId?: string
}

export interface DynamicApproval {
  readonly id: string
  readonly title: string
  readonly purpose: string
  readonly packageName: string
  readonly state: '等待批准' | '已批准' | '已拒绝'
}

export type ThemeChoice = 'system' | 'light' | 'dark'
export type ProductHostStatus = 'initializing' | 'ready' | 'stale' | 'error'

export interface ProductHostError {
  readonly code: 'network' | 'http' | 'invalid-snapshot' | 'sse' | 'unknown'
  readonly message: string
}

export interface ProductHostState {
  readonly status: ProductHostStatus
  readonly error: ProductHostError | null
  readonly lastSuccessfulAt: number | null
}

export type ProductActionErrorCode = 'host-unavailable' | 'invalid-input' | 'missing-prerequisite'

export class ProductActionError extends Error {
  constructor(
    readonly code: ProductActionErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ProductActionError'
  }
}

export interface ProductState {
  readonly host: ProductHostState
  readonly connectionAdapters: readonly AdapterConnectionDescriptor[]
  readonly models: readonly ModelSummary[]
  readonly agents: readonly AgentSummary[]
  readonly channels: readonly ChannelSummary[]
  readonly messages: readonly ConversationMessage[]
  readonly connections: readonly ConnectionSummary[]
  readonly extensions: readonly LocalExtensionSummary[]
  readonly approvals: readonly DynamicApproval[]
  readonly dynamic: readonly DynamicPackageSummary[]
  readonly theme: ThemeChoice
  readonly reducedMotion: boolean
  readonly diagnosticNote: string
  refreshHost(): Promise<void>
  createAgent(input: { readonly name: string; readonly model: ModelSummary }): Promise<void>
  reviseAgent(input: {
    readonly agentId: string
    readonly expectedCurrentRevisionId?: string
    readonly displayName: string
    readonly persona: string
    readonly model: ModelSummary
    readonly reasoningEffort?: string
  }): Promise<void>
  createConnection(input: {
    readonly adapterKey: string
    readonly configuration: Readonly<Record<string, string | number | boolean>>
    readonly credentials: Readonly<Record<string, string>>
  }): Promise<void>
  createBinding(input: {
    readonly agentId: string
    readonly channelId: string
    readonly triggerPolicy: 'always' | 'mentioned-or-replied' | 'command' | 'observe-only'
  }): Promise<void>
  sendMessage(channelId: string, body: string): Promise<void>
  setCapability(agentId: string, capability: keyof AgentSummary['capabilities'], enabled: boolean): Promise<void>
  runConnectionTest(id: string, direction: 'receive' | 'send', channelId?: string): Promise<void>
  resolveApproval(input: { requestId: string; agentId: string; approved: boolean }): Promise<void>
  setExtensionActive(id: string, enabled: boolean): Promise<void>
  setTheme(theme: ThemeChoice): void
  setReducedMotion(enabled: boolean): void
}

const initialTheme = (): ThemeChoice => {
  if (typeof window === 'undefined') return 'system'
  const stored = window.localStorage.getItem('nekro-nxt.theme')
  return stored === 'light' || stored === 'dark' ? stored : 'system'
}

const requireHost = (): ProductHostPort => {
  if (activeHost === null)
    throw new ProductActionError('host-unavailable', '当前未连接 NekroNxt Host，无法执行此操作。')
  return activeHost
}

const requireValue = (value: string, message: string, code: ProductActionErrorCode = 'invalid-input'): string => {
  const normalized = value.trim()
  if (!normalized) throw new ProductActionError(code, message)
  return normalized
}

export const useProductStore = create<ProductState>(() => ({
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
  theme: initialTheme(),
  reducedMotion: false,
  diagnosticNote: '正在连接 NekroNxt Host…',
  refreshHost: async () => {
    await requireHost().execute('host.refresh')
  },
  createAgent: async ({ name, model }) => {
    await requireHost().execute('agents.create', {
      displayName: requireValue(name, '请输入智能体名称。'),
      model: { provider: model.provider, model: model.id },
    })
  },
  reviseAgent: async ({ agentId, expectedCurrentRevisionId, displayName, persona, model, reasoningEffort }) => {
    await requireHost().execute('agents.revise', {
      agentId: requireValue(agentId, '缺少智能体标识，请刷新页面后重试。'),
      expectedCurrentRevisionId: requireValue(
        expectedCurrentRevisionId ?? '',
        '缺少当前智能体配置版本，请刷新页面后重试。',
        'missing-prerequisite',
      ),
      displayName: requireValue(displayName, '请输入智能体名称。'),
      persona,
      model: { provider: model.provider, model: model.id, ...(reasoningEffort ? { reasoningEffort } : {}) },
    })
  },
  createConnection: async ({ adapterKey, configuration, credentials }) => {
    await requireHost().execute('connections.create', {
      adapterKey: requireValue(adapterKey, '请选择连接平台。'),
      configuration,
      credentials,
    })
  },
  createBinding: async ({ agentId, channelId, triggerPolicy }) => {
    await requireHost().execute('bindings.create', {
      agentId: requireValue(agentId, '缺少智能体标识，请刷新页面后重试。'),
      channelId: requireValue(channelId, '请选择要绑定的频道。'),
      triggerPolicy,
    })
  },
  sendMessage: async (channelId, body) => {
    await requireHost().execute('channels.sendMessage', {
      channelId: requireValue(channelId, '缺少目标频道，请刷新页面后重试。'),
      body: requireValue(body, '消息内容不能为空。'),
    })
  },
  setCapability: async (agentId, capability, enabled) => {
    await requireHost().execute('agents.updateCapabilities', {
      agentId: requireValue(agentId, '缺少智能体标识，请刷新页面后重试。'),
      [capability]: enabled,
    })
  },
  runConnectionTest: async (id, direction, channelId) => {
    await requireHost().execute('connections.test', {
      connectionId: requireValue(id, '缺少连接标识，请刷新页面后重试。'),
      direction,
      ...(channelId === undefined ? {} : { channelId }),
    })
  },
  resolveApproval: async ({ requestId, agentId, approved }) => {
    await requireHost().execute(approved ? 'dynamic.approve' : 'dynamic.decline', {
      requestId: requireValue(requestId, '缺少批准请求，请刷新页面后重试。'),
      agentId: requireValue(agentId, '缺少智能体标识，请刷新页面后重试。'),
    })
  },
  setExtensionActive: async (id, enabled) => {
    const extensionId = requireValue(id, '缺少本地扩展标识，请刷新页面后重试。')
    const extension = useProductStore.getState().extensions.find((candidate) => candidate.id === extensionId)
    if (extension === undefined) {
      throw new ProductActionError('missing-prerequisite', '找不到要更新的本地扩展，请刷新页面后重试。')
    }

    if (enabled) {
      const agentId = requireValue(
        extension.agentId ?? '',
        '此本地扩展缺少目标智能体，无法启用。',
        'missing-prerequisite',
      )
      const revisionId = requireValue(
        extension.revisionId ?? '',
        '此本地扩展缺少可启用版本，请重新保存后重试。',
        'missing-prerequisite',
      )
      await requireHost().execute('extensions.activate', { extensionId, agentId, revisionId })
      return
    }
    await requireHost().execute('extensions.deactivate', { extensionId })
  },
  setTheme: (theme) => {
    if (typeof window !== 'undefined') {
      if (theme === 'system') window.localStorage.removeItem('nekro-nxt.theme')
      else window.localStorage.setItem('nekro-nxt.theme', theme)
    }
    useProductStore.setState({ theme })
  },
  setReducedMotion: (reducedMotion) => useProductStore.setState({ reducedMotion }),
}))
