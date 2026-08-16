import type {
  AgentSummary,
  ChannelSummary,
  ConnectionSummary,
  ConversationMessage,
  DynamicApproval,
  LocalExtensionSummary,
} from './product-store.js'
import { useProductStore } from './product-store.js'

export interface ProductSnapshot {
  readonly agents: readonly AgentSummary[]
  readonly channels: readonly ChannelSummary[]
  readonly messages: readonly ConversationMessage[]
  readonly connections: readonly ConnectionSummary[]
  readonly extensions: readonly LocalExtensionSummary[]
  readonly approvals: readonly DynamicApproval[]
  readonly diagnosticNote: string
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

  /** Delegates product actions to the underlying Host (may be a no-op in demo mode). */
  execute(command: string, input?: Readonly<Record<string, unknown>>): Promise<unknown> {
    return this.#host.execute(command, input)
  }

  start(): void {
    if (this.#unsubscribe) throw new Error('Product Host coordinator is already started.')
    const apply = (): void => {
      const snapshot = this.#host.getSnapshot()
      useProductStore.setState({
        agents: snapshot.agents,
        channels: snapshot.channels,
        messages: snapshot.messages,
        connections: snapshot.connections,
        extensions: snapshot.extensions,
        approvals: snapshot.approvals,
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
