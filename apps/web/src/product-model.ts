import type { AdapterConnectionDescriptor } from '@nekro-nxt/adapter-sdk'
import type {
  ChannelRuntimePhase,
  HostApiRequest,
  HostApiResponse,
  AdapterActivityKey,
  HostUiPermissionDeclaration,
  PromptDocumentV1,
} from '@nekro-nxt/contracts'
import type { ExtensionJsonValue } from '@nekro-nxt/extension-sdk'
import type { DynamicPackageSummary } from './product-port.js'
export type { ThemeChoice } from './theme-preference.js'
export type AgentRuntimeState = ChannelRuntimePhase

export const runtimeStateLabel = (phase: AgentRuntimeState): string =>
  ({
    idle: '空闲',
    thinking: '思考中',
    'using-tool': '使用工具',
    'waiting-input': '等待输入',
    unavailable: '不可用',
  })[phase]

export const CHANNEL_MESSAGE_INITIAL_PAGE_SIZE = 16
export const CHANNEL_MESSAGE_PAGE_SIZE = 24
export type DeliveryState = '已发送' | '发送中' | '部分发送' | '失败' | '结果未知'
export type ConnectionState = '已连接' | '正在连接' | '认证过期' | '已配置' | '已断开' | '异常'

export interface ImageUnderstandingPolicy {
  readonly history: {
    readonly mode: 'persistent-distinct'
    readonly detail: 'low' | 'auto' | 'high'
    readonly restoreAfterCompaction: {
      readonly recentMessages: number
      readonly maxImages: number
    }
  }
  readonly textModel:
    | { readonly mode: 'disabled' }
    | {
        readonly mode: 'auxiliary'
        readonly model: {
          readonly provider: string
          readonly model: string
          readonly reasoningEffort?: string | undefined
        }
        readonly maxTokens: number
      }
}

export const defaultImageUnderstandingPolicy = (): ImageUnderstandingPolicy => ({
  history: {
    mode: 'persistent-distinct',
    detail: 'auto',
    restoreAfterCompaction: { recentMessages: 32, maxImages: 20 },
  },
  textModel: { mode: 'disabled' },
})

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
  readonly personaDocument: PromptDocumentV1
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
  readonly imagePolicy: ImageUnderstandingPolicy
  readonly dynamicClientApprovalPolicy: 'manual' | 'automatic'
  readonly imageDiagnostics: HostApiResponse<'snapshot'>['agents'][number]['imageDiagnostics']
}

export interface ModelSummary {
  readonly provider: string
  readonly providerName: string
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly inputModalities?: readonly string[]
}

export interface ChannelSummary {
  readonly id: string
  readonly connectionId: string
  readonly name: string
  readonly kind: 'internal' | 'group' | 'direct'
  readonly connectionName: string
  readonly agentId: string
  readonly trigger: string
  readonly runtimePhase: AgentRuntimeState
  readonly bindings: readonly {
    readonly id: string
    readonly agentId: string
    readonly triggerPolicy: 'always' | 'mentioned-or-replied' | 'command' | 'observe-only'
    readonly processingFeedback: 'auto' | 'off'
    readonly activityTriggerOverrides: HostApiResponse<'snapshot'>['channels'][number]['bindings'][number]['activityTriggerOverrides']
  }[]
  readonly unread: number
}

export interface ChannelRuntimeToolView {
  readonly callId: string
  readonly name: string
  readonly displayName: string
  readonly state: 'running' | 'succeeded' | 'failed'
  readonly inputPreview?: string
  readonly resultPreview?: string
  readonly wroteToChannel?: boolean
}

export interface ChannelRuntimeView {
  readonly channelId: string
  readonly agentId?: string
  readonly episodeId?: string
  readonly phase: AgentRuntimeState
  readonly summary: string
  readonly pendingInjectCount: number
  readonly occupancy?: HostApiResponse<'getChannelRuntime'>['occupancy']
  readonly cache?: HostApiResponse<'getChannelRuntime'>['cache']
  readonly performance?: HostApiResponse<'getChannelRuntime'>['performance']
  readonly turns: HostApiResponse<'getChannelRuntime'>['turns']
}

export type ConversationPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'mention'; readonly memberId: string; readonly displayName: string }
  | { readonly type: 'image'; readonly assetId: string; readonly alt: string; readonly url: string }
  | { readonly type: 'file'; readonly assetId: string; readonly name: string; readonly url: string }
  | { readonly type: 'audio'; readonly assetId: string; readonly url: string }
  | { readonly type: 'quote'; readonly messageId: string }
  | {
      readonly type: 'rich'
      readonly adapterKey: string
      readonly kind: string
      readonly summary: string
      readonly title?: string
      readonly source?: string
      readonly targetUrl?: string
      readonly previewUrl?: string
      readonly preview?: string
      readonly extension?: ExtensionJsonValue
      readonly items?: readonly {
        readonly sender?: string
        readonly text?: string
        readonly card?: {
          readonly summary: string
          readonly title?: string
          readonly source?: string
          readonly targetUrl?: string
          readonly previewUrl?: string
        }
        readonly imageUrl?: string
        readonly imageName?: string
      }[]
    }
  | { readonly type: 'unsupported'; readonly label: string }

export interface ConversationMessage {
  readonly id: string
  readonly channelId: string
  readonly author: string
  readonly role: 'member' | 'agent' | 'system'
  readonly activityKey?: AdapterActivityKey
  readonly body: string
  readonly parts: readonly ConversationPart[]
  readonly mentionedConnectionAccount: boolean
  readonly time: string
  readonly occurredAt?: number
  readonly delivery?: DeliveryState
  readonly origin?: 'admin-console'
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
  /** Optional user-facing name; the Adapter name remains the platform identity. */
  readonly alias?: string
  readonly name: string
  /** User-facing Adapter name. The opaque key only joins Descriptor, Runtime, and Slot projections. */
  readonly adapter: string
  readonly adapterKey: string
  readonly userManaged: boolean
  readonly state: ConnectionState
  readonly accountReference: string
  readonly credentialConfigured: boolean
  readonly runtimeState: string
  readonly lastError: string
  readonly proactiveSend: boolean
  readonly activityCapabilities: HostApiResponse<'snapshot'>['connections'][number]['status']['activities']
  readonly activityTriggerDefaults: HostApiResponse<'snapshot'>['connections'][number]['activityTriggerDefaults']
  readonly processingFeedbackCapability?: HostApiResponse<'snapshot'>['connections'][number]['status']['processingFeedback']
  readonly channels: number
  readonly knownChannels: readonly { readonly id: string; readonly name: string; readonly kind: string }[]
  readonly lastEvent: string
  readonly receiveTest: string
  readonly sendTest: string
  readonly events: HostApiResponse<'listConnectionEvents'>['events']
  readonly eventsLoaded: boolean
  readonly eventsLoading: boolean
  readonly eventsHasMore: boolean
}

export interface ArchivedConnectionSummary {
  readonly id: string
  readonly adapterKey: string
  readonly alias?: string
  readonly adapter: string
  readonly channelCount: number
  readonly archivedAt: number
}

export interface LocalExtensionSummary {
  readonly id: string
  readonly slug: string
  readonly name: string
  readonly description: string
  readonly revision: number
  readonly scope: 'agent' | 'host-adapter' | 'host-ui'
  readonly revisions: readonly {
    readonly id: string
    readonly revision: number
    readonly createdAt: number
    readonly scope: 'agent' | 'host-adapter' | 'host-ui'
    readonly contributions: readonly string[]
    readonly clientBuilt: boolean
    readonly buildKey?: string
    readonly hostSlots: readonly { readonly name: string; readonly key: string }[]
    readonly pages: HostApiResponse<'snapshot'>['hostUi']['pages']
    readonly verification?: {
      readonly verifiedAt: number
      readonly dshVersion: string
      readonly contractVersion: string
      readonly hostBuilt: boolean
      readonly clientBuilt: boolean
      readonly buildKey: string
      readonly toolInvocationCount: number
      readonly rpcMethods: readonly string[]
      readonly renderedSlots: readonly string[]
      readonly permissions?: HostUiPermissionDeclaration
      readonly permissionDigest?: string
      readonly permissionApprovalRequired?: boolean
    }
  }[]
  readonly createdByAgentId?: string
  readonly createdByAgent: string
  readonly activations: readonly {
    readonly agentId: string
    readonly agentName: string
    readonly revisionId: string
    readonly revision: number
    readonly activatedAt: number
    readonly runtime?: {
      readonly status: 'active' | 'restore-failed' | 'dispose-failed'
      readonly message?: string
      readonly observedAt: number
    }
  }[]
  readonly contributions: readonly string[]
  readonly verification?: {
    readonly verifiedAt: number
    readonly dshVersion: string
    readonly contractVersion: string
    readonly hostBuilt: boolean
    readonly clientBuilt: boolean
    readonly buildKey: string
    readonly toolInvocationCount: number
    readonly rpcMethods: readonly string[]
    readonly renderedSlots: readonly string[]
    readonly permissions?: HostUiPermissionDeclaration
    readonly permissionDigest?: string
    readonly permissionApprovalRequired?: boolean
  }
  readonly clientActivations: readonly {
    readonly agentId: string
    readonly revisionId: string
    readonly buildKey: string
  }[]
  readonly clientDiagnostics: readonly {
    readonly agentId: string
    readonly revisionId: string
    readonly status: 'loaded' | 'failed'
    readonly message?: string
    readonly observedAt: number
  }[]
  readonly installation?: {
    readonly revisionId: string
    readonly installedAt: number
    readonly runtime?: {
      readonly status: 'active' | 'restore-failed' | 'dispose-failed'
      readonly message?: string
      readonly observedAt: number
    }
  }
  readonly hostClientDiagnostic?: {
    readonly revisionId: string
    readonly status: 'loaded' | 'failed'
    readonly message?: string
    readonly observedAt: number
  }
  readonly hostUiPermission?: HostApiResponse<'snapshot'>['extensions'][number]['hostUiPermission']
  /** Latest saved Revision id; not intended for display. */
  readonly revisionId?: string
}

export interface DynamicApproval {
  readonly id: string
  readonly title: string
  readonly purpose: string
  readonly packageName: string
  readonly state: '等待批准' | '已批准' | '已拒绝'
}

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

export interface ProductMetadataView {
  readonly displayName: string
  readonly organizationName: string
  readonly version: string
  readonly releaseId: string
  readonly repositoryUrl: string
  readonly licenseSpdx: string | null
  readonly dshVersion?: string | undefined
}

export interface SavedDynamicExtension {
  readonly extensionId: string
  readonly revisionId: string
}

export interface CapabilityAvailability {
  readonly subagents: { readonly available: boolean }
  readonly webSearch: {
    readonly provider: string
    readonly available: boolean
    readonly credentialConfigured: boolean
    readonly credentialReference: string
    readonly maxUsesPerCall: number
    readonly maxResultsPerCall: number
    readonly timeoutMs: number
  }
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
  readonly productMetadata: ProductMetadataView | undefined
  readonly connectionAdapters: readonly AdapterConnectionDescriptor[]
  readonly capabilityAvailability: CapabilityAvailability
  readonly models: readonly ModelSummary[]
  readonly agents: readonly AgentSummary[]
  readonly channels: readonly ChannelSummary[]
  readonly messages: readonly ConversationMessage[]
  readonly channelHistory: Readonly<Record<string, ChannelHistoryState>>
  readonly channelRuntimes: Readonly<Record<string, ChannelRuntimeView>>
  readonly connections: readonly ConnectionSummary[]
  readonly archivedConnections: readonly ArchivedConnectionSummary[]
  readonly extensions: readonly LocalExtensionSummary[]
  readonly hostUi: HostApiResponse<'snapshot'>['hostUi']
  readonly platformUserFacets: HostApiResponse<'listPlatformUsers'>['facets']
  readonly platformUsersRevision: number
  readonly approvals: readonly DynamicApproval[]
  readonly dynamic: readonly DynamicPackageSummary[]
  readonly authoringTasks: HostApiResponse<'snapshot'>['authoringTasks']
  readonly notificationSettings: HostApiResponse<'snapshot'>['notificationSettings']
  readonly diagnosticNote: string
  refreshHost(): Promise<void>
  createAgent(input: {
    readonly name: string
    readonly persona: string
    readonly personaDocument: PromptDocumentV1
    readonly model: ModelSummary
    readonly capabilities: AgentSummary['capabilities']
    readonly imagePolicy?: ImageUnderstandingPolicy
  }): Promise<{ readonly agentId: string; readonly channelId: string }>
  reviseAgent(input: {
    readonly agentId: string
    readonly expectedCurrentRevisionId?: string
    readonly displayName: string
    readonly persona: string
    readonly personaDocument: PromptDocumentV1
    readonly model: ModelSummary
    readonly reasoningEffort?: string
    readonly imagePolicy: ImageUnderstandingPolicy
    readonly dynamicClientApprovalPolicy: 'manual' | 'automatic'
  }): Promise<void>
  updateNotificationSettings(
    input: HostApiRequest<'updateNotificationSettings'>,
  ): Promise<HostApiResponse<'updateNotificationSettings'>>
  testBarkNotification(input: HostApiRequest<'testBarkNotification'>): Promise<void>
  testSystemNotification(): Promise<void>
  deleteAgent(
    agentId: string,
    expectedCurrentRevisionId: string,
    confirmationName: string,
    deleteAutoCreatedBuiltInChannels: boolean,
  ): Promise<void>
  createConnection(input: {
    readonly adapterKey: string
    readonly configuration: Readonly<Record<string, string | number | boolean>>
    readonly credentials: Readonly<Record<string, string>>
    readonly alias?: string
  }): Promise<void>
  updateConnectionAlias(connectionId: string, alias: string): Promise<void>
  updateConnectionActivityTriggerDefaults(connectionId: string, activityKeys: readonly string[]): Promise<void>
  deleteConnection(connectionId: string, deleteChannelData: boolean): Promise<void>
  restoreConnection(connectionId: string): Promise<void>
  workTreeOrder: {
    readonly agentIds: readonly string[]
    readonly channelIdsByAgent: Readonly<Record<string, readonly string[]>>
    readonly unboundChannelIds: readonly string[]
  }
  createInternalChannel(input: { readonly displayName: string }): Promise<{ readonly channelId: string }>
  createBinding(input: {
    readonly agentId: string
    readonly channelId: string
    readonly triggerPolicy: 'always' | 'mentioned-or-replied' | 'command' | 'observe-only'
    readonly processingFeedback?: 'auto' | 'off'
    readonly activityTriggerOverrides?: HostApiResponse<'snapshot'>['channels'][number]['bindings'][number]['activityTriggerOverrides']
  }): Promise<void>
  clearBinding(channelId: string): Promise<void>
  deleteChannel(channelId: string, expectedBoundAgentId: string | null): Promise<void>
  resetChannelContext(channelId: string, episodeId: string, mode: 'clear' | 'compact'): Promise<void>
  putWorkTreeOrder(order: ProductState['workTreeOrder']): Promise<void>
  sendMessage(channelId: string, body: string): Promise<void>
  loadChannelMessages(channelId: string, mode?: 'initial' | 'older' | 'latest'): Promise<void>
  loadChannelRuntime(channelId: string): Promise<void>
  renameChannel(channelId: string, displayName: string): Promise<void>
  setCapability(agentId: string, capability: keyof AgentSummary['capabilities'], enabled: boolean): Promise<void>
  setCapabilities(agentId: string, capabilities: Partial<AgentSummary['capabilities']>): Promise<void>
  runConnectionTest(id: string, direction: 'receive' | 'send', channelId?: string): Promise<void>
  loadConnectionEvents(connectionId: string, older?: boolean): Promise<void>
  resolveApproval(input: { requestId: string; agentId: string; approved: boolean }): Promise<void>
  stopAuthoringTask(taskId: string, expectedRevision: number): Promise<void>
  deleteAuthoringTask(taskId: string): Promise<void>
  saveDynamicExtension(input: {
    readonly taskId?: string
    readonly attemptId?: string
    readonly agentId: string
    readonly episodeId: string
    readonly pluginId: string
    readonly packageId: string
    readonly name: string
    readonly slug: string
    readonly description: string
    readonly targetExtensionId?: string
  }): Promise<SavedDynamicExtension>
  setExtensionActive(id: string, agentId: string, enabled: boolean, revisionId?: string): Promise<void>
  setHostExtensionInstalled(id: string, revisionId: string | null, permissionDigest?: string): Promise<void>
  reportHostExtensionClientDiagnostic(input: {
    readonly extensionId: string
    readonly revisionId: string
    readonly status: 'loaded' | 'failed'
    readonly message?: string
  }): Promise<void>
  callExtensionClient(input: {
    readonly agentId: string
    readonly extensionId: string
    readonly revisionId: string
    readonly method: string
    readonly value?: ExtensionJsonValue
  }): Promise<ExtensionJsonValue>
  reportExtensionClientDiagnostic(input: {
    readonly agentId: string
    readonly extensionId: string
    readonly revisionId: string
    readonly status: 'loaded' | 'failed'
    readonly message?: string
  }): Promise<void>
  listPlatformUsers(input?: {
    readonly query?: string
    readonly adapterKey?: string
    readonly connectionId?: string
    readonly cursor?: string
    readonly limit?: number
  }): Promise<HostApiResponse<'listPlatformUsers'>>
}

/** The one product projection for a Connection's primary user-facing label. */
export const connectionDisplayName = (connection: Pick<ConnectionSummary, 'alias' | 'name'>): string =>
  connection.alias?.trim() || connection.name
