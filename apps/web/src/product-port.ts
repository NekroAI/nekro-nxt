import type {
  AgentSummary,
  CapabilityAvailability,
  ChannelSummary,
  ConnectionSummary,
  ConversationMessage,
  DynamicApproval,
  LocalExtensionSummary,
  ModelSummary,
  ProductHostState,
} from './product-store.js'
import type { AdapterConnectionDescriptor } from '@nekro-nxt/adapter-sdk'
import { useProductStore } from './product-store.js'

export interface ProductSnapshot {
  readonly host: ProductHostState
  readonly connectionAdapters: readonly AdapterConnectionDescriptor[]
  readonly capabilityAvailability: CapabilityAvailability
  readonly models: readonly ModelSummary[]
  readonly agents: readonly AgentSummary[]
  readonly channels: readonly ChannelSummary[]
  readonly messages: readonly ConversationMessage[]
  readonly connections: readonly ConnectionSummary[]
  readonly extensions: readonly LocalExtensionSummary[]
  readonly approvals: readonly DynamicApproval[]
  /** Running dynamic Packages by intelligent-agent (from the creator runtime). */
  readonly dynamic: readonly DynamicPackageSummary[]
  readonly diagnosticNote: string
}

export interface DynamicPackageSummary {
  readonly agentId: string
  readonly pluginId: string
  readonly packageId?: string
  readonly approvalRequestId?: string
  readonly status: string
}

export interface ProductHostPort {
  getSnapshot(): ProductSnapshot
  subscribe(listener: () => void): () => void
  execute(command: string, input?: Readonly<Record<string, unknown>>): Promise<unknown>
}

/** Applies authoritative Host projections to the Shell without exposing transport or database details to pages. */
export class ProductHostCoordinator implements ProductHostPort {
  readonly #host: ProductHostPort
  #unsubscribe: (() => void) | undefined

  constructor(host: ProductHostPort) {
    this.#host = host
  }

  /** The latest authoritative projection (delegated to the underlying Host). */
  getSnapshot(): ProductSnapshot {
    return this.#host.getSnapshot()
  }

  /** Subscribes the listener to Host updates (delegated to the underlying Host). */
  subscribe(listener: () => void): () => void {
    return this.#host.subscribe(listener)
  }

  /** Delegates product actions to the underlying Host and preserves rejection semantics. */
  execute(command: string, input?: Readonly<Record<string, unknown>>): Promise<unknown> {
    return this.#host.execute(command, input)
  }

  start(): void {
    if (this.#unsubscribe) throw new Error('Product Host coordinator is already started.')
    const apply = (): void => {
      const snapshot = this.#host.getSnapshot()
      useProductStore.setState({
        host: snapshot.host,
        connectionAdapters: snapshot.connectionAdapters,
        capabilityAvailability: snapshot.capabilityAvailability,
        models: snapshot.models,
        agents: snapshot.agents,
        channels: snapshot.channels,
        messages: snapshot.messages,
        connections: snapshot.connections,
        extensions: snapshot.extensions,
        approvals: snapshot.approvals,
        dynamic: snapshot.dynamic,
        diagnosticNote: snapshot.diagnosticNote,
      })
    }
    apply()
    this.#unsubscribe = this.#host.subscribe(apply)
  }

  dispose(): void {
    this.#unsubscribe?.()
    this.#unsubscribe = undefined
  }
}
