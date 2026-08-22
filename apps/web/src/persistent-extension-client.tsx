import type {
  ExtensionDetailsSlotProps,
  NekroNxtClientSlotName,
  NekroNxtClientSlotPropsMap,
} from '@nekro-nxt/extension-sdk'
import {
  Component,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import {
  ExtensionClientActivationCoordinator,
  ExtensionClientRuntime,
  type ClientActivationDescriptor,
  type ClientActivationSource,
  type ProductClientSlotEntry,
} from './extension-client.js'
import { useProductStore, type LocalExtensionSummary } from './product-store.js'
import { Button } from './ui-kit/index.js'

interface PersistentClientActivation {
  readonly activationId: string
  readonly agentId: string
  readonly extensionId: string
  readonly revisionId: string
  readonly buildKey: string
}

class MutableActivationSource implements ClientActivationSource {
  readonly #listeners = new Set<() => void>()
  #snapshot: readonly ClientActivationDescriptor[] = []

  getSnapshot = (): readonly ClientActivationDescriptor[] => this.#snapshot
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  publish(snapshot: readonly ClientActivationDescriptor[]): void {
    this.#snapshot = snapshot
    for (const listener of this.#listeners) listener()
  }
}

interface AgentClientRuntime {
  readonly runtime: ExtensionClientRuntime
  readonly source: MutableActivationSource
  readonly coordinator: ExtensionClientActivationCoordinator
}

const activationIdentity = (agentId: string, extensionId: string): string => `${agentId}:${extensionId}`

const projectActivations = (extensions: readonly LocalExtensionSummary[]): readonly PersistentClientActivation[] =>
  extensions.flatMap((extension) =>
    extension.clientActivations.map((activation) => ({
      activationId: activationIdentity(activation.agentId, extension.id),
      agentId: activation.agentId,
      extensionId: extension.id,
      revisionId: activation.revisionId,
      buildKey: activation.buildKey,
    })),
  )

class PersistentExtensionClientCoordinator {
  readonly #agents = new Map<string, AgentClientRuntime>()
  readonly #listeners = new Set<() => void>()
  #activations: readonly PersistentClientActivation[] = []
  #queue: Promise<void> = Promise.resolve()
  #version = 0
  #disposed = false

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }
  getVersion = (): number => this.#version

  sync(extensions: readonly LocalExtensionSummary[]): Promise<void> {
    this.#activations = projectActivations(extensions)
    return this.#enqueue(() => this.#reconcile())
  }

  runtime(agentId: string): ExtensionClientRuntime | undefined {
    return this.#agents.get(agentId)?.runtime
  }

  activationId(agentId: string, extensionId: string): string {
    return activationIdentity(agentId, extensionId)
  }

  reload(agentId: string): Promise<void> {
    return this.#enqueue(async () => {
      await this.#disposeAgent(agentId)
      await this.#reconcile()
    })
  }

  reportRenderFailure(agentId: string, entryId: string, error: unknown): void {
    const activation = this.#activations.find(
      (candidate) => candidate.agentId === agentId && entryId.startsWith(`${candidate.activationId}:`),
    )
    if (activation) void this.#reportDiagnostic(activation, 'failed', error)
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    await this.#queue.catch(() => undefined)
    await Promise.allSettled([...this.#agents.keys()].map((agentId) => this.#disposeAgent(agentId)))
    this.#publish()
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.#queue.then(operation, operation)
    this.#queue = next.catch(() => undefined)
    return next
  }

  async #reconcile(): Promise<void> {
    if (this.#disposed) return
    const byAgent = new Map<string, PersistentClientActivation[]>()
    for (const activation of this.#activations) {
      const group = byAgent.get(activation.agentId) ?? []
      group.push(activation)
      byAgent.set(activation.agentId, group)
    }
    for (const agentId of [...this.#agents.keys()]) {
      if (!byAgent.has(agentId)) await this.#disposeAgent(agentId)
    }
    for (const [agentId, activations] of byAgent) {
      let owned = this.#agents.get(agentId)
      if (!owned) {
        owned = this.#createAgentRuntime(agentId)
        this.#agents.set(agentId, owned)
        await owned.coordinator.start()
      }
      owned.source.publish(activations.map((activation) => this.#descriptor(activation)))
      await owned.coordinator.idle()
    }
    this.#publish()
  }

  #createAgentRuntime(agentId: string): AgentClientRuntime {
    const runtime = new ExtensionClientRuntime()
    const source = new MutableActivationSource()
    const find = (activationId: string) =>
      this.#activations.find((candidate) => candidate.agentId === agentId && candidate.activationId === activationId)
    const coordinator = new ExtensionClientActivationCoordinator(
      runtime,
      source,
      (activationId, error) => {
        const activation = find(activationId)
        if (activation) void this.#reportDiagnostic(activation, 'failed', error)
        this.#publish()
      },
      (activationId) => {
        const activation = find(activationId)
        if (activation) void this.#reportDiagnostic(activation, 'loaded')
        this.#publish()
      },
    )
    return { runtime, source, coordinator }
  }

  #descriptor(activation: PersistentClientActivation): ClientActivationDescriptor {
    const extensionId = encodeURIComponent(activation.extensionId)
    const revisionId = encodeURIComponent(activation.revisionId)
    const agentId = encodeURIComponent(activation.agentId)
    return {
      activationId: activation.activationId,
      moduleUrl: `/api/extensions/${extensionId}/revisions/${revisionId}/client/${activation.buildKey}.mjs?agentId=${agentId}`,
      host: {
        call: (method, input) =>
          useProductStore.getState().callExtensionClient({
            agentId: activation.agentId,
            extensionId: activation.extensionId,
            revisionId: activation.revisionId,
            method,
            ...(input === undefined ? {} : { value: input }),
          }),
      },
    }
  }

  async #reportDiagnostic(
    activation: PersistentClientActivation,
    status: 'loaded' | 'failed',
    error?: unknown,
  ): Promise<void> {
    const message =
      error === undefined
        ? undefined
        : (error instanceof Error ? error.message : typeof error === 'string' ? error : '未知 Client 错误').slice(
            0,
            4096,
          )
    await useProductStore
      .getState()
      .reportExtensionClientDiagnostic({
        agentId: activation.agentId,
        extensionId: activation.extensionId,
        revisionId: activation.revisionId,
        status,
        ...(message === undefined ? {} : { message }),
      })
      .catch(() => undefined)
  }

  async #disposeAgent(agentId: string): Promise<void> {
    const owned = this.#agents.get(agentId)
    if (!owned) return
    this.#agents.delete(agentId)
    owned.source.publish([])
    await owned.coordinator.idle()
    await owned.coordinator.dispose()
    await owned.runtime.dispose()
  }

  #publish(): void {
    this.#version += 1
    for (const listener of this.#listeners) listener()
  }
}

const PersistentExtensionClientContext = createContext<PersistentExtensionClientCoordinator | null>(null)

export function PersistentExtensionClientProvider({ children }: { readonly children: ReactNode }) {
  const coordinator = useMemo(() => new PersistentExtensionClientCoordinator(), [])
  const disposeTimer = useRef<number | undefined>(undefined)
  const activationVersion = useProductStore((state) =>
    state.extensions
      .flatMap((extension) =>
        extension.clientActivations.map(
          (activation) => `${activation.agentId}:${extension.id}:${activation.revisionId}:${activation.buildKey}`,
        ),
      )
      .sort()
      .join('|'),
  )

  useEffect(() => {
    if (disposeTimer.current !== undefined) window.clearTimeout(disposeTimer.current)
    void coordinator.sync(useProductStore.getState().extensions)
    return () => {
      disposeTimer.current = window.setTimeout(() => void coordinator.dispose(), 0)
    }
  }, [activationVersion, coordinator])

  return (
    <PersistentExtensionClientContext.Provider value={coordinator}>
      {children}
    </PersistentExtensionClientContext.Provider>
  )
}

interface SlotBoundaryProps {
  readonly agentId: string
  readonly entryId: string
  readonly onFailure: (error: unknown) => void
  readonly onReload: () => void
  readonly children: ReactNode
}

class SlotBoundary extends Component<SlotBoundaryProps, { readonly failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError(): { readonly failed: boolean } {
    return { failed: true }
  }

  override componentDidCatch(error: Error): void {
    this.props.onFailure(error)
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <section className="nxt-extension-section" role="alert">
        <h3 className="nxt-extension-section-heading">扩展界面加载失败</h3>
        <p className="nxt-extension-secondary-text">界面加载失败不影响智能体工具和数据接口。可单独重新加载界面。</p>
        <div className="nxt-extension-action-row">
          <Button size="small" onClick={this.props.onReload}>
            重新加载界面
          </Button>
        </div>
      </section>
    )
  }
}

function RuntimeSlot<Name extends NekroNxtClientSlotName>({
  runtime,
  coordinator,
  agentId,
  name,
  props,
  entryPrefix,
}: {
  readonly runtime: ExtensionClientRuntime
  readonly coordinator: PersistentExtensionClientCoordinator
  readonly agentId: string
  readonly name: Name
  readonly props: NekroNxtClientSlotPropsMap[Name]
  readonly entryPrefix?: string
}) {
  useSyncExternalStore(
    (listener) => runtime.subscribe(name, listener),
    () => runtime.slotVersion(name),
    () => runtime.slotVersion(name),
  )
  const entries = runtime
    .entries(name)
    .filter((entry) => entryPrefix === undefined || entry.id.startsWith(`${entryPrefix}:`))
  return (
    <>
      {entries.map((entry: ProductClientSlotEntry<NekroNxtClientSlotPropsMap[Name]>) => {
        const Entry = entry.component
        return (
          <SlotBoundary
            agentId={agentId}
            entryId={entry.id}
            key={entry.id}
            onFailure={(error) => coordinator.reportRenderFailure(agentId, entry.id, error)}
            onReload={() => void coordinator.reload(agentId)}
          >
            <Entry {...props} />
          </SlotBoundary>
        )
      })}
    </>
  )
}

function usePersistentExtensionCoordinator(): PersistentExtensionClientCoordinator {
  const coordinator = useContext(PersistentExtensionClientContext)
  if (!coordinator) throw new Error('持久扩展界面缺少产品级 Client Runtime。')
  useSyncExternalStore(coordinator.subscribe, coordinator.getVersion, coordinator.getVersion)
  return coordinator
}

export function AgentWorkbenchExtensionSlots({
  agentId,
  displayName,
}: {
  readonly agentId: string
  readonly displayName: string
}) {
  const coordinator = usePersistentExtensionCoordinator()
  const runtime = coordinator.runtime(agentId)
  if (!runtime) return null
  return (
    <RuntimeSlot
      runtime={runtime}
      coordinator={coordinator}
      agentId={agentId}
      name="agent.workbench.sections"
      props={{ agentId, displayName }}
    />
  )
}

export function ExtensionDetailsExtensionSlots(props: ExtensionDetailsSlotProps) {
  const coordinator = usePersistentExtensionCoordinator()
  const diagnostic = useProductStore((state) =>
    state.extensions
      .find((extension) => extension.id === props.extensionId)
      ?.clientDiagnostics.find(
        (candidate) => candidate.agentId === props.agentId && candidate.revisionId === props.revisionId,
      ),
  )
  const runtime = coordinator.runtime(props.agentId)
  if (props.activation !== 'active') return null
  if (diagnostic?.status === 'failed') {
    return (
      <section className="nxt-extension-section" role="alert">
        <h3 className="nxt-extension-section-heading">扩展界面加载失败</h3>
        <p className="nxt-extension-secondary-text">{diagnostic.message ?? '没有可用的错误详情。'}</p>
        <div className="nxt-extension-action-row">
          <Button size="small" onClick={() => void coordinator.reload(props.agentId)}>
            重新加载界面
          </Button>
        </div>
      </section>
    )
  }
  if (!runtime) return null
  return (
    <RuntimeSlot
      runtime={runtime}
      coordinator={coordinator}
      agentId={props.agentId}
      name="extension.details.panels"
      props={props}
      entryPrefix={coordinator.activationId(props.agentId, props.extensionId)}
    />
  )
}
