import { defaultProductRuntime } from '../src/product-runtime.js'
import { ProductActionError } from '../src/product-model.js'
import type { ProductSnapshot } from '../src/product-port.js'
export * from '../src/product-runtime.js'
export const useProductStore = defaultProductRuntime.store
export const useUiStateStore = defaultProductRuntime.uiStore
interface TestProductHost {
  getSnapshot(): ProductSnapshot
  subscribe(listener: () => void): () => void
  execute(command: string, input?: Readonly<Record<string, unknown>>): Promise<unknown>
}
let restore: (() => void) | undefined
export function setActiveProductHost(host: TestProductHost | null): void {
  restore?.()
  const actions = defaultProductRuntime.host.actions
  const originals = Object.getOwnPropertyDescriptors(actions)
  for (const name of Object.keys(actions)) {
    Object.defineProperty(actions, name, {
      configurable: true,
      value: async (input?: Readonly<Record<string, unknown>>) => {
        if (!host) throw new ProductActionError('host-unavailable', '当前未连接 NekroNXT Host，无法执行此操作。')
        return input === undefined ? host.execute(name) : host.execute(name, input)
      },
    })
  }
  restore = () => Object.defineProperties(actions, originals)
}
/** Applies authoritative Host projections to the Shell without exposing transport or database details to pages. */
export class ProductHostCoordinator implements TestProductHost {
  readonly #host: TestProductHost
  #unsubscribe: (() => void) | undefined

  constructor(host: TestProductHost) {
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
        productMetadata: snapshot.productMetadata,
        connectionAdapters: snapshot.connectionAdapters,
        capabilityAvailability: snapshot.capabilityAvailability,
        models: snapshot.models,
        agents: snapshot.agents,
        channels: snapshot.channels,
        messagesByChannel: snapshot.messagesByChannel,
        channelRuntimes: snapshot.channelRuntimes,
        connections: snapshot.connections,
        archivedConnections: snapshot.archivedConnections,
        extensions: snapshot.extensions,
        hostUi: snapshot.hostUi ?? { preferencesRevision: 0, pages: [] },
        platformUsersRevision: snapshot.platformUsersRevision,
        approvals: snapshot.approvals,
        dynamic: snapshot.dynamic,
        authoringTasks: snapshot.authoringTasks ?? [],
        notificationSettings: snapshot.notificationSettings,
        diagnosticNote: snapshot.diagnosticNote,
        workTreeOrder: snapshot.workTreeOrder,
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
