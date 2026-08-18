import { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { setDynamicClientApprovalBridge } from './dynamic-client-bridge.js'
import { DshDynamicClientRuntime, type DynamicClientHostPort, type DynamicInventoryRow } from './dsh-dynamic-client.js'
import { HttpDynamicClientHost } from './http-dynamic-host.js'
import { useProductStore } from './product-store.js'

/** One browser ModuleLoader/SlotRegistry multiplexed across product intelligent-agents. */
class MultiplexDynamicClientHost implements DynamicClientHostPort {
  readonly #hosts = new Map<string, HttpDynamicClientHost>()
  readonly #requestOwner = new Map<string, string>()
  readonly #pluginOwner = new Map<string, string>()

  async inventory(agentId: string): Promise<readonly DynamicInventoryRow[]> {
    const rows = await this.#host(agentId).inventory()
    this.#requestOwner.clear()
    this.#pluginOwner.clear()
    for (const row of rows) {
      this.#pluginOwner.set(row.pluginId, agentId)
      if (row.latestRun?.approvalRequestId) this.#requestOwner.set(row.latestRun.approvalRequestId, agentId)
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
    this.#pluginOwner.set(pluginId, agentId)
    if (requestId) this.#requestOwner.set(requestId, agentId)
    return this.#host(agentId).runHostHalf(agentId, pluginId, packageId, mode, requestId, approveFutureVersions)
  }

  getClientCode(agentId: string, pluginId: string, pluginRunId: string) {
    return this.#host(agentId).getClientCode(agentId, pluginId, pluginRunId)
  }

  resolveRequestRun(requestId: string, resolution: Parameters<DynamicClientHostPort['resolveRequestRun']>[1]) {
    const agentId = this.#requestOwner.get(requestId)
    if (!agentId) return Promise.reject(new Error('找不到动态审批所属的智能体。'))
    return this.#host(agentId).resolveRequestRun(requestId, resolution)
  }

  settleUserRun(agentId: string, pluginId: string, resolution: Parameters<DynamicClientHostPort['settleUserRun']>[2]) {
    return this.#host(agentId).settleUserRun(agentId, pluginId, resolution)
  }

  invoke(pluginId: string, pluginRunId: string, method: string, args: unknown): Promise<unknown> {
    const agentId = this.#pluginOwner.get(pluginId)
    if (!agentId) return Promise.reject(new Error('找不到动态扩展所属的智能体。'))
    return this.#host(agentId).invoke(pluginId, pluginRunId, method, args)
  }

  reportRenderFailure(agentId: string, pluginId: string, pluginRunId: string, failure: unknown): Promise<void> {
    return this.#host(agentId).reportRenderFailure(agentId, pluginId, pluginRunId, failure)
  }

  reportGuardFailure(agentId: string, pluginId: string, pluginRunId: string, failure: unknown): Promise<void> {
    return this.#host(agentId).reportGuardFailure(agentId, pluginId, pluginRunId, failure)
  }

  #host(agentId: string): HttpDynamicClientHost {
    let host = this.#hosts.get(agentId)
    if (!host) {
      host = new HttpDynamicClientHost(agentId)
      this.#hosts.set(agentId, host)
    }
    return host
  }
}

class DynamicClientCoordinator {
  readonly #host = new MultiplexDynamicClientHost()
  readonly #listeners = new Set<() => void>()
  #runtime: DshDynamicClientRuntime | undefined
  #activeAgentId: string | undefined
  #version = 0
  #queue: Promise<void> = Promise.resolve()
  #disposed = false
  #failure = ''
  #nativeFailure = ''
  #nativeReady = false

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  getVersion = (): number => this.#version

  sync(agentId: string): Promise<void> {
    return this.#enqueue(async () => {
      this.#activeAgentId = agentId
      const runtime = await this.#ensureRuntime()
      await runtime.reconcile(await this.#host.inventory(agentId))
      this.#failure = ''
      this.#publish()
    })
  }

  clear(agentId: string): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#activeAgentId !== agentId) return
      this.#activeAgentId = undefined
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

  renderRoot(): ReactNode | undefined {
    if (!this.#runtime || this.#runtime.loaded().length === 0) return undefined
    return this.#runtime.renderRoot()
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
      this.#activeAgentId = agentId
      await runtime.reconcile(await this.#host.inventory(agentId))
      if (approved) await runtime.approve(requestId)
      else await runtime.decline(requestId)
      await runtime.reconcile(await this.#host.inventory(agentId))
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

const DynamicClientContext = createContext<DynamicClientCoordinator | null>(null)

export function DynamicClientProvider({ children }: { readonly children: ReactNode }) {
  const coordinator = useMemo(() => new DynamicClientCoordinator(), [])
  const disposeTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (disposeTimer.current !== undefined) window.clearTimeout(disposeTimer.current)
    setDynamicClientApprovalBridge(coordinator)
    return () => {
      setDynamicClientApprovalBridge(null)
      disposeTimer.current = window.setTimeout(() => void coordinator.dispose(), 0)
    }
  }, [coordinator])

  return <DynamicClientContext.Provider value={coordinator}>{children}</DynamicClientContext.Provider>
}

export function DynamicClientSlots({ agentId }: { readonly agentId: string }) {
  const coordinator = useContext(DynamicClientContext)
  if (!coordinator) throw new Error('动态 Client Slot 缺少产品级运行时。')
  const inventoryVersion = useProductStore((state) =>
    state.dynamic
      .filter((item) => item.agentId === agentId)
      .map((item) => `${item.pluginId}:${item.packageId ?? ''}:${item.status}:${item.approvalRequestId ?? ''}`)
      .sort()
      .join('|'),
  )
  useSyncExternalStore(coordinator.subscribe, coordinator.getVersion, coordinator.getVersion)
  useEffect(() => {
    void coordinator.sync(agentId).catch((error: unknown) => coordinator.reportFailure(error))
  }, [agentId, coordinator, inventoryVersion])
  useEffect(() => {
    return () => {
      void coordinator.clear(agentId).catch((error: unknown) => coordinator.reportFailure(error))
    }
  }, [agentId, coordinator])
  const failure = coordinator.failure()
  if (failure) return <div role="alert">即时界面加载失败：{failure}</div>
  const root = coordinator.renderRoot()
  return root === undefined ? null : <div data-dynamic-client-slots="">{root}</div>
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
