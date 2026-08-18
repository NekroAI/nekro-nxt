import type { AdapterConnectionDescriptor } from '@nekro-nxt/adapter-sdk'
import { create } from 'zustand'
import type { DynamicPackageSummary, ProductHostPort } from './product-port.js'
import { approveDynamicClientRequest, declineDynamicClientRequest } from './dynamic-client-bridge.js'

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
    readonly subagents: boolean
    readonly fileTools: boolean
    readonly webSearch: boolean
    readonly dynamicCreation: boolean
    readonly developmentShell: boolean
    readonly unrestrictedFileAccess: boolean
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
  readonly kind: 'web' | 'qq-group' | 'qq-direct'
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
  readonly occurredAt?: number
  readonly delivery?: DeliveryState
  readonly resources: readonly {
    readonly assetId: string
    readonly name: string
    readonly kind: 'image' | 'file' | 'audio'
    readonly url: string
  }[]
}

export interface ChannelHistoryState {
  readonly loaded: boolean
  readonly loading: boolean
  readonly loadingMore: boolean
  readonly hasMore: boolean
  readonly error: string
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
  readonly channelHistory: Readonly<Record<string, ChannelHistoryState>>
  readonly connections: readonly ConnectionSummary[]
  readonly extensions: readonly LocalExtensionSummary[]
  readonly approvals: readonly DynamicApproval[]
  readonly dynamic: readonly DynamicPackageSummary[]
  readonly theme: ThemeChoice
  readonly reducedMotion: boolean
  readonly diagnosticNote: string
  refreshHost(): Promise<void>
  createAgent(input: {
    readonly name: string
    readonly persona: string
    readonly model: ModelSummary
    readonly capabilities: AgentSummary['capabilities']
  }): Promise<{ readonly agentId: string; readonly channelId: string }>
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
  loadChannelMessages(channelId: string, mode?: 'initial' | 'older' | 'latest'): Promise<void>
  renameChannel(channelId: string, displayName: string): Promise<void>
  setCapability(agentId: string, capability: keyof AgentSummary['capabilities'], enabled: boolean): Promise<void>
  runConnectionTest(id: string, direction: 'receive' | 'send', channelId?: string): Promise<void>
  resolveApproval(input: { requestId: string; agentId: string; approved: boolean }): Promise<void>
  saveDynamicExtension(input: {
    readonly agentId: string
    readonly name: string
    readonly slug: string
    readonly description: string
  }): Promise<void>
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
  channelHistory: {},
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
  createAgent: async ({ name, persona, model, capabilities }) => {
    const result = await requireHost().execute('agents.create', {
      displayName: requireValue(name, '请输入智能体名称。'),
      persona,
      model: { provider: model.provider, model: model.id },
      capabilities,
    })
    if (
      typeof result !== 'object' ||
      result === null ||
      typeof (result as { readonly agentId?: unknown }).agentId !== 'string' ||
      typeof (result as { readonly channelId?: unknown }).channelId !== 'string'
    ) {
      throw new ProductActionError('invalid-input', '智能体已创建，但返回结果不完整，请刷新页面。')
    }
    return result as { readonly agentId: string; readonly channelId: string }
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
  loadChannelMessages: async (channelId, mode = 'initial') => {
    const normalizedChannelId = requireValue(channelId, '缺少目标频道，请刷新页面后重试。')
    const currentState = useProductStore.getState()
    const history = currentState.channelHistory[normalizedChannelId]
    if (mode === 'initial' && (history?.loaded || history?.loading)) return
    if (mode === 'older' && (history?.loadingMore || history?.hasMore === false)) return
    const existing = currentState.messages.filter((message) => message.channelId === normalizedChannelId)
    const oldest = existing[0]
    useProductStore.setState((state) => ({
      channelHistory: {
        ...state.channelHistory,
        [normalizedChannelId]: {
          loaded: history?.loaded ?? false,
          loading: mode === 'initial',
          loadingMore: mode === 'older',
          hasMore: history?.hasMore ?? true,
          error: '',
        },
      },
    }))
    try {
      const result = await requireHost().execute('channels.listMessages', {
        channelId: normalizedChannelId,
        mode,
        limit: 40,
        ...(mode === 'older' && oldest?.occurredAt !== undefined
          ? { beforeOccurredAt: oldest.occurredAt, beforeSourceId: oldest.id }
          : {}),
      })
      if (
        typeof result !== 'object' ||
        result === null ||
        typeof (result as { readonly hasMore?: unknown }).hasMore !== 'boolean'
      ) {
        throw new ProductActionError('invalid-input', '频道历史返回结果无效，请重新加载。')
      }
      useProductStore.setState((state) => ({
        channelHistory: {
          ...state.channelHistory,
          [normalizedChannelId]: {
            loaded: true,
            loading: false,
            loadingMore: false,
            hasMore: (result as { readonly hasMore: boolean }).hasMore,
            error: '',
          },
        },
      }))
    } catch (error) {
      useProductStore.setState((state) => ({
        channelHistory: {
          ...state.channelHistory,
          [normalizedChannelId]: {
            loaded: history?.loaded ?? false,
            loading: false,
            loadingMore: false,
            hasMore: history?.hasMore ?? true,
            error: error instanceof Error ? error.message : String(error),
          },
        },
      }))
      throw error
    }
  },
  renameChannel: async (channelId, displayName) => {
    await requireHost().execute('channels.rename', {
      channelId: requireValue(channelId, '缺少目标频道，请刷新页面后重试。'),
      displayName: requireValue(displayName, '请输入频道名称。'),
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
    const normalizedRequestId = requireValue(requestId, '缺少批准请求，请刷新页面后重试。')
    const normalizedAgentId = requireValue(agentId, '缺少智能体标识，请刷新页面后重试。')
    const handled = approved
      ? await approveDynamicClientRequest(normalizedAgentId, normalizedRequestId)
      : await declineDynamicClientRequest(normalizedAgentId, normalizedRequestId)
    if (!handled) {
      await requireHost().execute(approved ? 'dynamic.approve' : 'dynamic.decline', {
        requestId: normalizedRequestId,
        agentId: normalizedAgentId,
      })
    }
    await requireHost().execute('host.refresh')
  },
  saveDynamicExtension: async ({ agentId, name, slug, description }) => {
    await requireHost().execute('extensions.saveFromDynamic', {
      agentId: requireValue(agentId, '缺少智能体标识，请刷新页面后重试。'),
      name: requireValue(name, '请输入本地扩展名称。'),
      slug: requireValue(slug, '请输入本地扩展标识。'),
      description,
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
