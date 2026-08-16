import { create } from 'zustand'
import type { DynamicPackageSummary, ProductHostPort } from './product-port.js'

/**
 * The active real-host port (when the Shell is wired to a live Server, set by
 * the browser entry). Mutating product actions prefer this port's `execute`;
 * without it they fall back to the local demo data so the Shell stays fully
 * usable offline (and the existing UI tests keep passing).
 */
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
  readonly channels: readonly string[]
  readonly extensionCount: number
  readonly capabilities: {
    readonly dynamicCreation: boolean
    readonly developmentShell: boolean
    readonly fullFileAccess: boolean
  }
}

export interface ChannelSummary {
  readonly id: string
  readonly name: string
  readonly kind: 'web' | 'qq-group'
  readonly connectionName: string
  readonly agentId: string
  readonly trigger: string
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
  readonly adapter: string
  readonly state: ConnectionState
  readonly appId: string
  readonly credentialRef: string
  readonly proactiveSend: boolean
  readonly channels: number
  readonly lastEvent: string
  readonly receiveTest: '未测试' | '通过' | '失败'
  readonly sendTest: '未测试' | '通过' | '失败'
}

export interface LocalExtensionSummary {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly revision: number
  readonly activation: '已激活' | '等待安全切换' | '未激活' | '激活失败'
  readonly targetAgent: string
  readonly contributions: readonly string[]
  /** Saved Revision id + owning Agent id, present when projected from a live Server. */
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

interface ProductState {
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
  createAgent(input: { readonly name: string; readonly model: string }): void
  createConnection(input: { readonly name: string; readonly appId: string; readonly credentialRef: string }): void
  sendMessage(channelId: string, body: string): void
  setCapability(agentId: string, capability: keyof AgentSummary['capabilities'], enabled: boolean): void
  updateConnection(
    id: string,
    patch: Partial<Pick<ConnectionSummary, 'appId' | 'credentialRef' | 'proactiveSend'>>,
  ): void
  runConnectionTest(id: string, direction: 'receive' | 'send'): void
  resolveApproval(input: { requestId: string; agentId: string; approved: boolean }): void
  setExtensionActive(id: string, enabled: boolean): void
  setTheme(theme: ThemeChoice): void
  setReducedMotion(enabled: boolean): void
}

const initialTheme = (): ThemeChoice => {
  if (typeof window === 'undefined') return 'system'
  const stored = window.localStorage.getItem('nekro-nxt.theme')
  return stored === 'light' || stored === 'dark' ? stored : 'system'
}

let messageSequence = 10
let agentSequence = 2
let connectionSequence = 2

export const useProductStore = create<ProductState>((set) => ({
  agents: [
    {
      id: 'xiaonai',
      name: '小奈',
      description: '负责频道协作、资料整理与本地扩展创造。',
      state: '使用工具',
      model: 'DeepSeek V4 · 高推理',
      channels: ['web-main', 'qq-product'],
      extensionCount: 2,
      capabilities: { dynamicCreation: true, developmentShell: false, fullFileAccess: false },
    },
    {
      id: 'reviewer',
      name: '审阅者',
      description: '专注于方案复核与风险检查。',
      state: '空闲',
      model: 'DeepSeek V4 · 标准',
      channels: ['web-review'],
      extensionCount: 0,
      capabilities: { dynamicCreation: false, developmentShell: false, fullFileAccess: false },
    },
  ],
  channels: [
    {
      id: 'web-main',
      name: 'Web 控制台',
      kind: 'web',
      connectionName: '本地 Web',
      agentId: 'xiaonai',
      trigger: '始终响应',
      unread: 0,
    },
    {
      id: 'qq-product',
      name: 'QQ 产品讨论群',
      kind: 'qq-group',
      connectionName: 'QQ 机器人账号',
      agentId: 'xiaonai',
      trigger: '被提及或回复时',
      unread: 3,
    },
    {
      id: 'web-review',
      name: '审阅工作台',
      kind: 'web',
      connectionName: '本地 Web',
      agentId: 'reviewer',
      trigger: '始终响应',
      unread: 0,
    },
  ],
  messages: [
    {
      id: 'm1',
      channelId: 'web-main',
      author: '你',
      role: 'member',
      body: '复核一下第一期计划，先把 QQ 适配器的可靠性问题收口。',
      time: '12:41',
    },
    {
      id: 'm2',
      channelId: 'web-main',
      author: '小奈',
      role: 'agent',
      body: '已经完成离线链路复核。Gateway 只在事实提交后推进，媒体按内容去重，响应丢失会保留为结果未知。',
      time: '12:43',
      delivery: '已发送',
    },
    {
      id: 'm3',
      channelId: 'web-main',
      author: '系统事件',
      role: 'system',
      body: '3 条新消息已收录，将在当前工具完成后纳入下一步思考。',
      time: '12:44',
    },
    {
      id: 'm4',
      channelId: 'web-main',
      author: '小奈',
      role: 'agent',
      body: '正在运行全仓检查，完成后会更新实现记录。',
      time: '12:45',
      delivery: '发送中',
      attachment: { name: 'M5 验证摘要.md', kind: 'file' },
    },
    {
      id: 'q1',
      channelId: 'qq-product',
      author: '成员甲',
      role: 'member',
      body: '@小奈 请确认这个视频会不会被忽略。',
      time: '12:20',
      attachment: { name: '演示视频.mp4', kind: 'file' },
    },
    {
      id: 'q2',
      channelId: 'qq-product',
      author: '小奈',
      role: 'agent',
      body: '不会。视频在一期作为普通文件完整入库与转发，不会伪装成已经理解。',
      time: '12:21',
      delivery: '已发送',
    },
  ],
  connections: [
    {
      id: 'qq-main',
      name: 'QQ 机器人账号',
      adapter: 'QQ OpenClaw',
      state: '已连接',
      appId: '102•••••481',
      credentialRef: 'credential:qq-main',
      proactiveSend: false,
      channels: 1,
      lastEvent: '42 秒前',
      receiveTest: '通过',
      sendTest: '未测试',
    },
    {
      id: 'web-local',
      name: '本地 Web',
      adapter: 'Web Channel',
      state: '已连接',
      appId: 'local',
      credentialRef: '无需凭据',
      proactiveSend: true,
      channels: 2,
      lastEvent: '刚刚',
      receiveTest: '通过',
      sendTest: '通过',
    },
  ],
  extensions: [
    {
      id: 'channel-summary',
      name: '频道摘要',
      description: '生成结构化阶段摘要，并保留来源消息引用。',
      revision: 3,
      activation: '已激活',
      targetAgent: '小奈',
      contributions: ['Tool', 'Client UI'],
    },
    {
      id: 'asset-catalog',
      name: '资源目录',
      description: '按频道整理已授权的图片与文件。',
      revision: 1,
      activation: '等待安全切换',
      targetAgent: '小奈',
      contributions: ['Tool'],
    },
  ],
  approvals: [
    {
      id: 'approval-1',
      title: '运行“频道摘要”动态界面',
      purpose: '在创造工作台预览摘要结果和来源。',
      packageName: 'channel-summary-preview@draft-4',
      state: '等待批准',
    },
  ],
  dynamic: [],
  theme: initialTheme(),
  reducedMotion: false,
  diagnosticNote: 'Core、DSH Session 与扩展运行时均正常；QQ Gateway 最近一次 resume 成功。',
  createAgent: ({ name, model }) => {
    if (activeHost) {
      void activeHost.execute('agents.create', { displayName: name, modelLabel: model })
      return
    }
    set((state) => {
      const sequence = ++agentSequence
      const id = `agent-${sequence}`
      const channelId = `web-agent-${sequence}`
      return {
        agents: [
          ...state.agents,
          {
            id,
            name,
            description: '新创建的智能体；尚未补充人设说明。',
            state: '空闲' as const,
            model,
            channels: [channelId],
            extensionCount: 0,
            capabilities: { dynamicCreation: false, developmentShell: false, fullFileAccess: false },
          },
        ],
        channels: [
          ...state.channels,
          {
            id: channelId,
            name: `${name}的 Web 频道`,
            kind: 'web' as const,
            connectionName: '本地 Web',
            agentId: id,
            trigger: '始终响应',
            unread: 0,
          },
        ],
      }
    })
  },
  createConnection: ({ name, appId, credentialRef }) => {
    if (activeHost) {
      void activeHost.execute('connections.create', { appId, credentialRef })
      return
    }
    set((state) => ({
      connections: [
        ...state.connections,
        {
          id: `qq-${++connectionSequence}`,
          name,
          adapter: 'QQ OpenClaw',
          state: '已断开' as const,
          appId,
          credentialRef,
          proactiveSend: false,
          channels: 0,
          lastEvent: '尚无事件',
          receiveTest: '未测试' as const,
          sendTest: '未测试' as const,
        },
      ],
    }))
  },
  sendMessage: (channelId, body) => {
    if (activeHost) {
      void activeHost.execute('channels.sendMessage', { channelId, body })
      return
    }
    set((state) => ({
      messages: [
        ...state.messages,
        {
          id: `local-${++messageSequence}`,
          channelId,
          author: '你',
          role: 'member' as const,
          body,
          time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
        },
      ],
    }))
  },
  setCapability: (agentId, capability, enabled) => {
    if (activeHost) {
      void activeHost.execute('agents.updateCapabilities', { agentId, [capability]: enabled })
      return
    }
    set((state) => ({
      agents: state.agents.map((agent) =>
        agent.id === agentId ? { ...agent, capabilities: { ...agent.capabilities, [capability]: enabled } } : agent,
      ),
    }))
  },
  updateConnection: (id, patch) =>
    set((state) => ({
      connections: state.connections.map((connection) =>
        connection.id === id ? { ...connection, ...patch } : connection,
      ),
    })),
  runConnectionTest: (id, direction) => {
    if (activeHost) {
      void activeHost.execute('connections.test', { connectionId: id, direction })
      return
    }
    set((state) => ({
      connections: state.connections.map((connection) =>
        connection.id === id
          ? { ...connection, [direction === 'receive' ? 'receiveTest' : 'sendTest']: '通过' as const }
          : connection,
      ),
    }))
  },
  resolveApproval: ({ requestId, agentId, approved }) => {
    if (activeHost) {
      void activeHost.execute(approved ? 'dynamic.approve' : 'dynamic.decline', { agentId, requestId })
      return
    }
    set((state) => ({
      approvals: state.approvals.map((approval) =>
        approval.id === requestId ? { ...approval, state: approved ? '已批准' : '已拒绝' } : approval,
      ),
    }))
  },
  setExtensionActive: (id, enabled) => {
    if (activeHost) {
      const extension = useProductStore.getState().extensions.find((candidate) => candidate.id === id)
      if (!extension?.revisionId || !extension.agentId) return
      void activeHost.execute(enabled ? 'extensions.activate' : 'extensions.deactivate', {
        extensionId: id,
        agentId: extension.agentId,
        revisionId: extension.revisionId,
      })
      return
    }
    set((state) => ({
      extensions: state.extensions.map((extension) =>
        extension.id === id ? { ...extension, activation: enabled ? '已激活' : '未激活' } : extension,
      ),
    }))
  },
  setTheme: (theme) => {
    if (typeof window !== 'undefined') {
      if (theme === 'system') window.localStorage.removeItem('nekro-nxt.theme')
      else window.localStorage.setItem('nekro-nxt.theme', theme)
    }
    set({ theme })
  },
  setReducedMotion: (reducedMotion) => set({ reducedMotion }),
}))
