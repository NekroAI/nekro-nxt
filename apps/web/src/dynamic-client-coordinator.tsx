import type { NekroNxtClientSlotName, NekroNxtClientSlotPropsMap } from '@nekro-nxt/extension-sdk'
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
import { setDynamicClientApprovalBridge } from './dynamic-client-bridge.js'
import { DshDynamicClientRuntime, type DynamicClientHostPort, type DynamicInventoryRow } from './dsh-dynamic-client.js'
import { HttpDynamicClientHost } from './http-dynamic-host.js'
import { useProductStore } from './product-store.js'

/** One browser ModuleLoader/SlotRegistry multiplexed across product intelligent-agents. */
class MultiplexDynamicClientHost implements DynamicClientHostPort {
  readonly #hosts = new Map<string, HttpDynamicClientHost>()
  readonly #requestOwner = new Map<string, string>()
  readonly #pluginOwner = new Map<string, string>()

  async inventory(agentId: string, episodeId: string): Promise<readonly DynamicInventoryRow[]> {
    const owner = this.#owner(agentId, episodeId)
    const rows = await this.#host(agentId, episodeId).inventory()
    for (const [requestId, candidate] of this.#requestOwner)
      if (candidate === owner) this.#requestOwner.delete(requestId)
    for (const [pluginId, candidate] of this.#pluginOwner) if (candidate === owner) this.#pluginOwner.delete(pluginId)
    for (const row of rows) {
      this.#pluginOwner.set(row.pluginId, owner)
      if (row.latestRun?.approvalRequestId) this.#requestOwner.set(row.latestRun.approvalRequestId, owner)
    }
    return rows
  }

  runHostHalf(
    agentId: string,
    pluginId: string,
    packageId: string,
    mode: 'run' | 'update',
    requestId: string | null,
    approveFutureVersions: boolean,
  ) {
    const owner = this.#pluginOwner.get(pluginId)
    if (!owner) return Promise.reject(new Error('找不到动态扩展所属的 Episode。'))
    if (requestId) this.#requestOwner.set(requestId, owner)
    return this.#ownedHost(owner).runHostHalf(agentId, pluginId, packageId, mode, requestId, approveFutureVersions)
  }

  getClientCode(agentId: string, pluginId: string, pluginRunId: string) {
    const owner = this.#pluginOwner.get(pluginId)
    if (!owner) return Promise.reject(new Error('找不到动态扩展所属的 Episode。'))
    return this.#ownedHost(owner).getClientCode(agentId, pluginId, pluginRunId)
  }

  resolveRequestRun(requestId: string, resolution: Parameters<DynamicClientHostPort['resolveRequestRun']>[1]) {
    const owner = this.#requestOwner.get(requestId)
    if (!owner) return Promise.reject(new Error('找不到动态审批所属的 Episode。'))
    return this.#ownedHost(owner).resolveRequestRun(requestId, resolution)
  }

  settleUserRun(agentId: string, pluginId: string, resolution: Parameters<DynamicClientHostPort['settleUserRun']>[2]) {
    const owner = this.#pluginOwner.get(pluginId)
    if (!owner) return Promise.reject(new Error('找不到动态扩展所属的 Episode。'))
    return this.#ownedHost(owner).settleUserRun(agentId, pluginId, resolution)
  }

  invoke(pluginId: string, pluginRunId: string, method: string, args: unknown): Promise<unknown> {
    const owner = this.#pluginOwner.get(pluginId)
    if (!owner) return Promise.reject(new Error('找不到动态扩展所属的 Episode。'))
    return this.#ownedHost(owner).invoke(pluginId, pluginRunId, method, args)
  }

  reportRenderFailure(agentId: string, pluginId: string, pluginRunId: string, failure: unknown): Promise<void> {
    const owner = this.#pluginOwner.get(pluginId)
    if (!owner) return Promise.reject(new Error('找不到动态扩展所属的 Episode。'))
    return this.#ownedHost(owner).reportRenderFailure(agentId, pluginId, pluginRunId, failure)
  }

  reportGuardFailure(agentId: string, pluginId: string, pluginRunId: string, failure: unknown): Promise<void> {
    const owner = this.#pluginOwner.get(pluginId)
    if (!owner) return Promise.reject(new Error('找不到动态扩展所属的 Episode。'))
    return this.#ownedHost(owner).reportGuardFailure(agentId, pluginId, pluginRunId, failure)
  }

  reportClientVerification(
    agentId: string,
    pluginId: string,
    packageId: string,
    pluginRunId: string,
    renderedSlots: readonly ('agent.workbench.sections' | 'extension.details.panels')[],
  ): Promise<void> {
    const owner = this.#pluginOwner.get(pluginId)
    if (!owner) return Promise.reject(new Error('找不到动态扩展所属的 Episode。'))
    return this.#ownedHost(owner).reportClientVerification(agentId, pluginId, packageId, pluginRunId, renderedSlots)
  }

  #host(agentId: string, episodeId: string): HttpDynamicClientHost {
    const owner = this.#owner(agentId, episodeId)
    let host = this.#hosts.get(owner)
    if (!host) {
      host = new HttpDynamicClientHost(agentId, episodeId)
      this.#hosts.set(owner, host)
    }
    return host
  }

  #ownedHost(owner: string): HttpDynamicClientHost {
    const host = this.#hosts.get(owner)
    if (!host) throw new Error('找不到动态扩展所属的 Episode Host。')
    return host
  }

  #owner(agentId: string, episodeId: string): string {
    return `${agentId}\0${episodeId}`
  }
}

class DynamicClientCoordinator {
  readonly #host = new MultiplexDynamicClientHost()
  readonly #listeners = new Set<() => void>()
  #runtime: DshDynamicClientRuntime | undefined
  #activeAgentId: string | undefined
  #activeEpisodeId: string | undefined
  #version = 0
  #queue: Promise<void> = Promise.resolve()
  #disposed = false
  #failure = ''
  #nativeFailure = ''
  #nativeReady = false
  readonly #reportedClientRuns = new Set<string>()

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  getVersion = (): number => this.#version

  sync(agentId: string, episodeId: string): Promise<void> {
    return this.#enqueue(async () => {
      this.#activeAgentId = agentId
      this.#activeEpisodeId = episodeId
      const runtime = await this.#ensureRuntime()
      await runtime.reconcile(await this.#host.inventory(agentId, episodeId))
      this.#failure = ''
      this.#publish()
    })
  }

  clear(agentId: string, episodeId: string): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#activeAgentId !== agentId || this.#activeEpisodeId !== episodeId) return
      this.#activeAgentId = undefined
      this.#activeEpisodeId = undefined
      await this.#runtime?.reconcile([])
      this.#failure = ''
      this.#publish()
    })
  }

  approve(agentId: string, requestId: string): Promise<void> {
    return this.#resolve(agentId, requestId, true)
  }

  decline(agentId: string, requestId: string): Promise<void> {
    return this.#resolve(agentId, requestId, false)
  }

  entries<Name extends NekroNxtClientSlotName>(name: Name) {
    return this.#runtime?.entries(name) ?? []
  }

  reportSlotFailure(agentId: string, error: unknown): void {
    this.#failure = error instanceof Error ? error.message : String(error)
    void this.#runtime?.reportRenderFailure(agentId, error).catch(() => undefined)
    this.#publish()
  }

  reportRendered(agentId: string): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#failure) return
      const runtime = this.#runtime
      if (!runtime) return
      for (const loaded of runtime.loaded()) {
        const key = `${loaded.pluginId}:${loaded.pluginRunId}`
        if (this.#reportedClientRuns.has(key)) continue
        const renderedSlots = loaded.slots.filter(
          (slot): slot is 'agent.workbench.sections' | 'extension.details.panels' =>
            slot === 'agent.workbench.sections' || slot === 'extension.details.panels',
        )
        if (renderedSlots.length === 0) continue
        await this.#host.reportClientVerification(
          agentId,
          loaded.pluginId,
          loaded.packageId,
          loaded.pluginRunId,
          renderedSlots,
        )
        this.#reportedClientRuns.add(key)
      }
    })
  }

  loadNativeSettings(): Promise<void> {
    return this.#enqueue(async () => {
      try {
        const runtime = await this.#ensureRuntime()
        await runtime.loadNativeSettings()
        this.#nativeReady = true
        this.#nativeFailure = ''
      } catch (error) {
        this.#nativeReady = false
        this.#nativeFailure = error instanceof Error ? error.message : String(error)
      }
      this.#publish()
    })
  }

  renderNativeSettings(): ReactNode | undefined {
    if (!this.#runtime || !this.#nativeReady) return undefined
    try {
      return this.#runtime.renderNativeSettings()
    } catch (error) {
      this.#nativeReady = false
      this.#nativeFailure = error instanceof Error ? error.message : String(error)
      return undefined
    }
  }

  nativeFailure(): string {
    return this.#nativeFailure
  }

  failure(): string {
    return this.#failure
  }

  reportFailure(error: unknown): void {
    this.#failure = error instanceof Error ? error.message : String(error)
    this.#publish()
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    await this.#queue.catch(() => undefined)
    await this.#runtime?.dispose()
    this.#runtime = undefined
    this.#publish()
  }

  #resolve(agentId: string, requestId: string, approved: boolean): Promise<void> {
    return this.#enqueue(async () => {
      const runtime = await this.#ensureRuntime()
      const episodeId = this.#activeAgentId === agentId ? this.#activeEpisodeId : undefined
      if (!episodeId) throw new Error('请先打开这个动态运行所属的 Episode。')
      await runtime.reconcile(await this.#host.inventory(agentId, episodeId))
      if (approved) await runtime.approve(requestId)
      else await runtime.decline(requestId)
      await runtime.reconcile(await this.#host.inventory(agentId, episodeId))
      this.#failure = ''
      this.#publish()
    })
  }

  async #ensureRuntime(): Promise<DshDynamicClientRuntime> {
    if (this.#runtime) return this.#runtime
    if (this.#disposed) throw new Error('动态 Client Runtime 已停止。')
    this.#runtime = await DshDynamicClientRuntime.create(this.#host)
    return this.#runtime
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.#queue.then(operation, operation)
    this.#queue = next.catch(() => undefined)
    return next
  }

  #publish(): void {
    this.#version += 1
    for (const listener of this.#listeners) listener()
  }
}

class DynamicSlotBoundary extends Component<
  { readonly entryId: string; readonly onFailure: (error: unknown) => void; readonly children: ReactNode },
  { readonly failed: boolean }
> {
  override state = { failed: false }

  static getDerivedStateFromError(): { readonly failed: boolean } {
    return { failed: true }
  }

  override componentDidCatch(error: Error): void {
    this.props.onFailure(error)
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return <div role="alert">即时界面渲染失败；临时 Host 能力已停止保存验证。</div>
  }
}

function DynamicRuntimeSlot<Name extends NekroNxtClientSlotName>({
  coordinator,
  agentId,
  name,
  props,
}: {
  readonly coordinator: DynamicClientCoordinator
  readonly agentId: string
  readonly name: Name
  readonly props: NekroNxtClientSlotPropsMap[Name]
}) {
  return (
    <>
      {coordinator.entries(name).map((entry) => {
        const Entry = entry.component
        return (
          <DynamicSlotBoundary
            entryId={entry.id}
            key={`${name}:${entry.id}`}
            onFailure={(error) => coordinator.reportSlotFailure(agentId, error)}
          >
            <Entry {...props} />
          </DynamicSlotBoundary>
        )
      })}
    </>
  )
}

const DynamicClientContext = createContext<DynamicClientCoordinator | null>(null)
let sharedCoordinator: DynamicClientCoordinator | undefined
let sharedCoordinatorConsumers = 0
let sharedDisposeTimer: number | undefined

const browserDynamicClientCoordinator = (): DynamicClientCoordinator => {
  sharedCoordinator ??= new DynamicClientCoordinator()
  return sharedCoordinator
}

export function DynamicClientProvider({ children }: { readonly children: ReactNode }) {
  const coordinator = useMemo(browserDynamicClientCoordinator, [])
  const agents = useProductStore((state) => state.agents)
  const dynamic = useProductStore((state) => state.dynamic)
  const automaticApprovalInFlight = useRef(new Set<string>())
  const automaticRequests = useMemo(
    () =>
      dynamic.filter(
        (item) =>
          item.status === 'awaiting-approval' &&
          item.approvalRequestId !== undefined &&
          agents.find((agent) => agent.id === item.agentId)?.dynamicClientApprovalPolicy === 'automatic',
      ),
    [agents, dynamic],
  )

  useEffect(() => {
    sharedCoordinatorConsumers += 1
    if (sharedDisposeTimer !== undefined) window.clearTimeout(sharedDisposeTimer)
    sharedDisposeTimer = undefined
    setDynamicClientApprovalBridge(coordinator)
    return () => {
      sharedCoordinatorConsumers -= 1
      if (sharedCoordinatorConsumers > 0) return
      setDynamicClientApprovalBridge(null)
      sharedDisposeTimer = window.setTimeout(() => {
        sharedDisposeTimer = undefined
        if (sharedCoordinatorConsumers > 0 || sharedCoordinator !== coordinator) return
        sharedCoordinator = undefined
        void coordinator.dispose()
      }, 0)
    }
  }, [coordinator])

  useEffect(() => {
    for (const request of automaticRequests) {
      const requestId = request.approvalRequestId
      if (requestId === undefined || automaticApprovalInFlight.current.has(requestId)) continue
      automaticApprovalInFlight.current.add(requestId)
      void coordinator
        .sync(request.agentId, request.episodeId)
        .then(() => coordinator.approve(request.agentId, requestId))
        .catch((error: unknown) => coordinator.reportFailure(error))
        .finally(() => automaticApprovalInFlight.current.delete(requestId))
    }
  }, [automaticRequests, coordinator])

  return <DynamicClientContext.Provider value={coordinator}>{children}</DynamicClientContext.Provider>
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (sharedDisposeTimer !== undefined) window.clearTimeout(sharedDisposeTimer)
    sharedDisposeTimer = undefined
    sharedCoordinatorConsumers = 0
    setDynamicClientApprovalBridge(null)
    const coordinator = sharedCoordinator
    sharedCoordinator = undefined
    if (coordinator) void coordinator.dispose()
  })
}

export function DynamicClientSlots({ agentId, episodeId }: { readonly agentId: string; readonly episodeId: string }) {
  const coordinator = useContext(DynamicClientContext)
  if (!coordinator) throw new Error('动态 Client Slot 缺少产品级运行时。')
  const inventoryVersion = useProductStore((state) =>
    state.dynamic
      .filter((item) => item.agentId === agentId)
      .map((item) => `${item.pluginId}:${item.packageId ?? ''}:${item.status}:${item.approvalRequestId ?? ''}`)
      .sort()
      .join('|'),
  )
  const displayName = useProductStore((state) => state.agents.find((agent) => agent.id === agentId)?.name ?? '智能体')
  useSyncExternalStore(coordinator.subscribe, coordinator.getVersion, coordinator.getVersion)
  useEffect(() => {
    void coordinator.sync(agentId, episodeId).catch((error: unknown) => coordinator.reportFailure(error))
  }, [agentId, coordinator, episodeId, inventoryVersion])
  useEffect(() => {
    return () => {
      void coordinator.clear(agentId, episodeId).catch((error: unknown) => coordinator.reportFailure(error))
    }
  }, [agentId, coordinator, episodeId])
  const failure = coordinator.failure()
  const rendered =
    coordinator.entries('agent.workbench.sections').length > 0 ||
    coordinator.entries('extension.details.panels').length > 0
  useEffect(() => {
    if (rendered) void coordinator.reportRendered(agentId).catch((error) => coordinator.reportFailure(error))
  }, [agentId, coordinator, inventoryVersion, rendered])
  if (failure) return <div role="alert">即时界面加载失败：{failure}</div>
  return rendered ? (
    <div data-dynamic-client-slots="">
      <DynamicRuntimeSlot
        coordinator={coordinator}
        agentId={agentId}
        name="agent.workbench.sections"
        props={{ agentId, displayName }}
      />
      <DynamicRuntimeSlot
        coordinator={coordinator}
        agentId={agentId}
        name="extension.details.panels"
        props={{
          agentId,
          extensionId: 'dynamic-preview',
          revisionId: 'dynamic-preview',
          activation: 'active',
        }}
      />
    </div>
  ) : null
}

export function DshNativeSettingsSlots({ onFailure }: { readonly onFailure?: (message: string) => void }) {
  const coordinator = useContext(DynamicClientContext)
  if (!coordinator) throw new Error('DSH 原生界面缺少产品级 Client Runtime。')
  useSyncExternalStore(coordinator.subscribe, coordinator.getVersion, coordinator.getVersion)
  useEffect(() => {
    void coordinator.loadNativeSettings()
  }, [coordinator])
  const failure = coordinator.nativeFailure()
  useEffect(() => {
    if (failure) onFailure?.(failure)
  }, [failure, onFailure])
  if (failure) return <div role="alert">DSH 原生界面加载失败：{failure}</div>
  const content = coordinator.renderNativeSettings()
  return content === undefined ? <div>正在加载 DSH 原生界面…</div> : <>{content}</>
}
