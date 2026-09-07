import type { ProductActions } from './product-actions.js'
import type {
  AgentSummary,
  CapabilityAvailability,
  ChannelRuntimeView,
  ChannelSummary,
  ConnectionSummary,
  ArchivedConnectionSummary,
  ConversationMessage,
  DynamicApproval,
  LocalExtensionSummary,
  ModelSummary,
  ProductMetadataView,
  ProductHostState,
} from './product-model.js'
import type { AdapterConnectionDescriptor } from '@nekro-nxt/adapter-sdk'
import type { ProductState } from './product-model.js'

export interface ProductSnapshot {
  readonly host: ProductHostState
  readonly productMetadata?: ProductMetadataView | undefined
  readonly connectionAdapters: readonly AdapterConnectionDescriptor[]
  readonly capabilityAvailability: CapabilityAvailability
  readonly models: readonly ModelSummary[]
  readonly agents: readonly AgentSummary[]
  readonly channels: readonly ChannelSummary[]
  readonly messages: readonly ConversationMessage[]
  readonly channelRuntimes: Readonly<Record<string, ChannelRuntimeView>>
  readonly connections: readonly ConnectionSummary[]
  readonly archivedConnections: readonly ArchivedConnectionSummary[]
  readonly extensions: readonly LocalExtensionSummary[]
  readonly hostUi?: ProductState['hostUi']
  readonly platformUsersRevision: number
  readonly approvals: readonly DynamicApproval[]
  /** Running dynamic Packages by intelligent-agent (from the creator runtime). */
  readonly dynamic: readonly DynamicPackageSummary[]
  readonly authoringTasks?: ProductState['authoringTasks']
  readonly notificationSettings: ProductState['notificationSettings']
  readonly diagnosticNote: string
  readonly workTreeOrder: {
    readonly agentIds: readonly string[]
    readonly channelIdsByAgent: Readonly<Record<string, readonly string[]>>
    readonly unboundChannelIds: readonly string[]
  }
}

export interface DynamicPackageSummary {
  readonly agentId: string
  readonly episodeId: string
  readonly pluginId: string
  readonly packageId?: string
  readonly currentPackageId?: string
  readonly nextPackageId?: string
  readonly approvalRequestId?: string
  readonly status: string
  readonly activeRun?: { readonly pluginRunId: string; readonly packageId: string }
  readonly latestRun?: {
    readonly pluginRunId: string
    readonly packageId: string
    readonly mode: 'run' | 'update'
    readonly status:
      | 'awaiting-approval'
      | 'starting-host'
      | 'client-pending'
      | 'running'
      | 'waiting'
      | 'rejected'
      | 'failed'
      | 'cancelled'
      | 'stopped'
    readonly approvalRequestId?: string
    readonly requiresApproval?: boolean
    readonly host: DynamicHalfStateSummary
    readonly client: DynamicHalfStateSummary
    readonly error?: {
      readonly phase: 'approval' | 'host-load' | 'host-apply' | 'client-load' | 'client-apply' | 'client-render'
      readonly message: string
      readonly stack?: string
      readonly pluginId: string
      readonly packageId: string
      readonly pluginRunId: string
    }
  }
  readonly packages: readonly {
    readonly packageId: string
    readonly name: string
    readonly purpose: string
    readonly hasHostHalf: boolean
    readonly hasClientHalf: boolean
  }[]
  readonly policy: {
    readonly turn: number
    readonly consecutiveFailures: number
    readonly repeatedFingerprintCount: number
    readonly blockedReason?: string
  }
}

interface DynamicHalfStateSummary {
  readonly status: 'absent' | 'pending' | 'stopped' | 'running' | 'waiting' | 'failed'
  readonly waitingFor: readonly string[]
  readonly error?: string
}

export interface ProductHostPort {
  getSnapshot(): ProductSnapshot
  subscribe(listener: () => void): () => void
  readonly actions: ProductActions
}
