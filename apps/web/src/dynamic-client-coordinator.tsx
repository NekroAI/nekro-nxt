import {
  Component,
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { setDynamicClientApprovalBridge } from './dynamic-client-bridge.js'
import {
  DshDynamicClientRuntime,
  type DynamicClientHostPort,
  type DynamicHostPageEntry,
  type DynamicInventoryRow,
  type DynamicProductSlotName,
  type DynamicProductSlotPropsMap,
} from './dsh-dynamic-client.js'
import type {
  AdapterClientSlotName,
  AgentClientSlotName,
  HostPageContribution,
  HostUiKitComponentName,
  HostUiPageGeometryEvidence,
  HostUiPermissionDeclaration,
} from '@nekro-nxt/contracts'
import {
  ADAPTER_CLIENT_SLOT_NAMES,
  AGENT_CLIENT_SLOT_NAMES,
  HostUiKitComponentNameSchema,
  HostUiNavigationModelSchema,
} from '@nekro-nxt/contracts'
import { HttpDynamicClientHost } from './http-dynamic-host.js'
import type { DynamicPackageSummary } from './product-port.js'
import { useProductStore } from './product-store.js'
import { Button } from './ui-kit/index.js'
import { HostUiPageFrame } from './host-ui-client.js'
import styles from './dynamic-client-coordinator.module.css'

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
    renderedSlots: readonly AgentClientSlotName[],
    renderedHostSlots: readonly { readonly name: AdapterClientSlotName; readonly key: string }[],
    renderedPages: readonly HostPageContribution[],
    usedUiComponents: readonly HostUiKitComponentName[],
    pageGeometry: readonly HostUiPageGeometryEvidence[],
    permissions: HostUiPermissionDeclaration,
    navigationEntries: readonly string[],
  ): Promise<void> {
    const owner = this.#pluginOwner.get(pluginId)
    if (!owner) return Promise.reject(new Error('找不到动态扩展所属的 Episode。'))
    return this.#ownedHost(owner).reportClientVerification(
      agentId,
      pluginId,
      packageId,
      pluginRunId,
      renderedSlots,
      renderedHostSlots,
      renderedPages,
      usedUiComponents,
      pageGeometry,
      permissions,
      navigationEntries,
    )
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

  entries<Name extends DynamicProductSlotName>(name: Name) {
    return this.#runtime?.entries(name) ?? []
  }

  pageEntries(): readonly DynamicHostPageEntry[] {
    return this.#runtime?.pageEntries() ?? []
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
        const renderedSlots = loaded.slots.filter((slot): slot is AgentClientSlotName =>
          AGENT_CLIENT_SLOT_NAMES.some((candidate) => candidate === slot),
        )
        const renderedHostSlots = ADAPTER_CLIENT_SLOT_NAMES.flatMap((name) =>
          loaded.slots.includes(name) ? runtime.entries(name).map((entry) => ({ name, key: entry.id })) : [],
        )
        const renderedPages = runtime.pageEntries().map(({ page }) => page)
        const usedUiComponents = [...new Set(runtime.pageEntries().flatMap((entry) => entry.usedUiComponents()))]
        const pageGeometry = runtime.pageEntries().flatMap((entry) => {
          const geometry = entry.pageGeometry()
          return geometry === undefined ? [] : [geometry]
        })
        const navigationEntries = runtime
          .pageEntries()
          .filter(({ page, navigation }) => page.objectPane === 'navigation' && navigation !== undefined)
          .map(({ page }) => page.entryId)
        if (renderedSlots.length === 0 && renderedHostSlots.length === 0 && renderedPages.length === 0) continue
        await this.#host.reportClientVerification(
          agentId,
          loaded.pluginId,
          loaded.packageId,
          loaded.pluginRunId,
          renderedSlots,
          renderedHostSlots,
          renderedPages,
          usedUiComponents,
          pageGeometry,
          runtime.pagePermissions(),
          navigationEntries,
        )
        this.#reportedClientRuns.add(key)
      }
    })
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
      const before = await this.#host.inventory(agentId, episodeId)
      const pending = before.find((row) => row.latestRun?.approvalRequestId === requestId)
      await runtime.reconcile(before)
      if (approved) await runtime.approve(requestId)
      else await runtime.decline(requestId)
      const after = await this.#host.inventory(agentId, episodeId)
      await runtime.reconcile(after)
      const settled = pending === undefined ? undefined : after.find((row) => row.pluginId === pending.pluginId)
      const failure = settled?.latestRun?.error
      if (
        approved &&
        (failure !== undefined ||
          settled?.latestRun?.status === 'failed' ||
          settled?.latestRun?.status === 'cancelled' ||
          settled?.latestRun?.status === 'rejected')
      ) {
        throw new Error(failure?.message ?? '动态界面运行失败。')
      }
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

function DynamicRuntimeSlot<Name extends DynamicProductSlotName>({
  coordinator,
  agentId,
  name,
  props,
}: {
  readonly coordinator: DynamicClientCoordinator
  readonly agentId: string
  readonly name: Name
  readonly props: DynamicProductSlotPropsMap[Name]
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

const EMPTY_DYNAMIC_NAVIGATION: ReturnType<typeof HostUiNavigationModelSchema.parse> = { revision: 0, groups: [] }

export const inspectDynamicPageUi = (
  root: ParentNode,
): { readonly usedUiComponents: readonly HostUiKitComponentName[]; readonly violations: readonly string[] } => {
  const usedUiComponents = [
    ...new Set(
      [...root.querySelectorAll('[data-nxt-ui-component]')].flatMap((element) => {
        const parsed = HostUiKitComponentNameSchema.safeParse(element.getAttribute('data-nxt-ui-component'))
        return parsed.success ? [parsed.data] : []
      }),
    ),
  ]
  const nakedControls = [...root.querySelectorAll('button, input, select, textarea')].filter(
    (element) => element.closest('[data-nxt-ui-component]') === null,
  )
  const nakedTables = [...root.querySelectorAll('table')].filter(
    (element) => element.closest('[data-nxt-ui-component="DataTable"]') === null,
  )
  const violations: string[] = []
  if (usedUiComponents.length === 0) violations.push('页面没有实际使用 NekroNXT UI Kit。')
  if (nakedControls.length > 0) violations.push('页面使用了浏览器默认交互控件。')
  if (nakedTables.length > 0) violations.push('页面使用了裸表格，必须改用 DataTable。')
  return { usedUiComponents, violations }
}

const cssPixels = (value: string): number => {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export const inspectDynamicPageGeometry = (
  viewport: HTMLElement,
  page: HostPageContribution,
): { readonly evidence: HostUiPageGeometryEvidence; readonly violations: readonly string[] } => {
  const frame = viewport.querySelector<HTMLElement>('[data-host-ui-frame]')
  const content = viewport.querySelector<HTMLElement>('[data-host-ui-content]')
  if (!frame || !content) throw new Error('Host 页面预览缺少标准内容框。')
  const viewportRect = viewport.getBoundingClientRect()
  const contentRect = content.getBoundingClientRect()
  const frameStyle = window.getComputedStyle(frame)
  const insets = {
    top: cssPixels(frameStyle.paddingTop),
    right: cssPixels(frameStyle.paddingRight),
    bottom: cssPixels(frameStyle.paddingBottom),
    left: cssPixels(frameStyle.paddingLeft),
  }
  const axisTargets = [
    ...content.querySelectorAll<HTMLElement>(
      '[data-page-header], [data-nxt-ui-component="Section"], [data-nxt-ui-component="Grid"], [data-nxt-ui-component="DataTable"]',
    ),
  ].filter((target) => {
    const containingTarget = target.parentElement?.closest(
      '[data-page-header], [data-nxt-ui-component="Section"], [data-nxt-ui-component="Grid"], [data-nxt-ui-component="DataTable"]',
    )
    return containingTarget === null || containingTarget === undefined || !content.contains(containingTarget)
  })
  const pageHeader = content.querySelector<HTMLElement>('[data-page-header]')
  const contentAxesAligned =
    pageHeader !== null &&
    axisTargets.length > 0 &&
    axisTargets.every((target) => {
      const rect = target.getBoundingClientRect()
      return Math.abs(rect.left - contentRect.left) <= 1 && Math.abs(rect.right - contentRect.right) <= 1
    })
  const pageTitle = pageHeader?.querySelector('h1')?.textContent?.trim() ?? ''
  const titleDistinct = page.objectPane === 'hidden' || (pageTitle.length > 0 && pageTitle !== page.title.trim())
  const horizontalOverflow = viewport.scrollWidth > viewport.clientWidth + 1
  const evidence: HostUiPageGeometryEvidence = {
    entryId: page.entryId,
    objectPane: page.objectPane,
    viewport: { width: viewportRect.width, height: viewportRect.height },
    insets,
    contentAxesAligned,
    horizontalOverflow,
    titleDistinct,
  }
  const expectedInline = viewportRect.width <= 960 ? 24 : viewportRect.width <= 1440 ? 32 : 40
  const violations: string[] = []
  for (const [side, actual, expected] of [
    ['top', insets.top, 24],
    ['right', insets.right, expectedInline],
    ['bottom', insets.bottom, 40],
    ['left', insets.left, expectedInline],
  ] as const) {
    if (Math.abs(actual - expected) > 1) {
      violations.push(`${side} 边距为 ${actual}px，Host 页面契约要求 ${expected}px。`)
    }
  }
  if (!contentAxesAligned) violations.push('PageHeader 与正文没有共享左右内容轴。')
  if (horizontalOverflow) violations.push('页面根产生了横向溢出。')
  if (!titleDistinct) violations.push('对象列应用标题与主画布当前视图标题重复。')
  return { evidence, violations }
}

function DynamicPagePreview({
  agentId,
  coordinator,
  entry,
}: {
  readonly agentId: string
  readonly coordinator: DynamicClientCoordinator
  readonly entry: DynamicHostPageEntry
}) {
  const [relativePath, setRelativePath] = useState(entry.page.startPath)
  const previewRoot = useRef<HTMLDivElement>(null)
  const navigationProvider = entry.navigation
  const navigationSnapshot = useSyncExternalStore(
    (listener) => navigationProvider?.subscribe(listener) ?? (() => undefined),
    () => navigationProvider?.getSnapshot() ?? EMPTY_DYNAMIC_NAVIGATION,
    () => EMPTY_DYNAMIC_NAVIGATION,
  )
  const navigation = HostUiNavigationModelSchema.parse(navigationSnapshot)
  const Page = entry.component
  useLayoutEffect(() => {
    const root = previewRoot.current
    if (!root) return
    const evidence = inspectDynamicPageUi(root)
    entry.recordUiComponents(evidence.usedUiComponents)
    const geometry = inspectDynamicPageGeometry(root, entry.page)
    entry.recordPageGeometry(geometry.evidence)
    const violations = [...evidence.violations, ...geometry.violations]
    if (violations.length > 0) {
      coordinator.reportSlotFailure(agentId, new Error(`页面样式验证失败：${violations.join(' ')}`))
    }
  }, [agentId, coordinator, entry, relativePath])
  return (
    <section
      className={styles.pagePreview}
      data-dynamic-host-page={entry.page.entryId}
      data-host-ui-owner="dynamic-preview"
    >
      <header className={styles.pagePreviewHeader}>
        <span>
          <strong>{entry.page.title}</strong>
          {entry.page.description ? <small>{entry.page.description}</small> : null}
        </span>
        <small>{entry.page.objectPane === 'navigation' ? '带对象列' : '全宽页面'}</small>
      </header>
      <div className={styles.pagePreviewFrame} data-object-pane={entry.page.objectPane}>
        {entry.page.objectPane === 'navigation' ? (
          <nav className={styles.pagePreviewNavigation} aria-label={`${entry.page.title} 预览导航`}>
            {navigation.groups.length === 0 ? <small>页面没有提供导航项</small> : null}
            {navigation.groups.map((group) => (
              <div key={group.id}>
                {group.label ? <strong>{group.label}</strong> : null}
                {group.items.map((item) => (
                  <Button
                    variant="ghost"
                    size="small"
                    key={item.id}
                    disabled={item.disabledReason !== undefined}
                    title={item.disabledReason}
                    aria-current={relativePath === item.path ? 'page' : undefined}
                    onClick={() => setRelativePath(item.path)}
                  >
                    <span>{item.label}</span>
                    {item.badge ? <small>{item.badge}</small> : null}
                  </Button>
                ))}
              </div>
            ))}
          </nav>
        ) : null}
        <div className={styles.pagePreviewCanvas}>
          <HostUiPageFrame viewportRef={previewRoot}>
            <DynamicSlotBoundary
              entryId={entry.page.entryId}
              onFailure={(error) => coordinator.reportSlotFailure(agentId, error)}
            >
              <Page
                pageInstanceId={`dynamic-preview-${entry.page.entryId}`}
                entryId={entry.page.entryId}
                relativePath={relativePath}
                search={{}}
                navigate={(path, options) => {
                  void options
                  const normalized = path.trim().replace(/^\/+|\/+$/gu, '')
                  if (normalized.split('/').includes('..') || !/^(?:[a-z0-9][a-z0-9/_-]*)?$/u.test(normalized)) {
                    throw new Error('页面预览只能在当前入口内导航。')
                  }
                  setRelativePath(normalized)
                }}
              />
            </DynamicSlotBoundary>
          </HostUiPageFrame>
        </div>
      </div>
    </section>
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

export const dynamicClientInventoryVersion = (inventory: readonly DynamicPackageSummary[], agentId: string): string =>
  inventory
    .filter((item) => item.agentId === agentId)
    .map((item) =>
      [
        item.pluginId,
        item.packageId ?? '',
        item.status,
        item.approvalRequestId ?? '',
        item.activeRun?.pluginRunId ?? '',
        item.activeRun?.packageId ?? '',
        item.latestRun?.pluginRunId ?? '',
        item.latestRun?.packageId ?? '',
        item.latestRun?.status ?? '',
        item.latestRun?.approvalRequestId ?? '',
      ].join(':'),
    )
    .sort()
    .join('|')

export function DynamicClientProvider({ children }: { readonly children: ReactNode }) {
  const coordinator = useMemo(browserDynamicClientCoordinator, [])
  const agents = useProductStore((state) => state.agents)
  const dynamic = useProductStore((state) => state.dynamic)
  const authoringTasks = useProductStore((state) => state.authoringTasks)
  const automaticApprovalInFlight = useRef(new Set<string>())
  const automaticRequests = useMemo(
    () =>
      dynamic.filter((item) => {
        if (item.status !== 'awaiting-approval' || item.approvalRequestId === undefined) return false
        if (agents.find((agent) => agent.id === item.agentId)?.dynamicClientApprovalPolicy === 'automatic') return true
        const task = authoringTasks.find(
          (candidate) => candidate.agentId === item.agentId && candidate.episodeId === item.episodeId,
        )
        return (
          task?.status === 'awaiting-approval' &&
          task.candidateAttempt?.state === 'awaiting-approval' &&
          task.approvedRiskDigest !== undefined &&
          task.candidateAttempt.riskDigest === task.approvedRiskDigest
        )
      }),
    [agents, authoringTasks, dynamic],
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
      void useProductStore
        .getState()
        .resolveApproval({ requestId, agentId: request.agentId, approved: true })
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
  const inventoryVersion = useProductStore((state) => dynamicClientInventoryVersion(state.dynamic, agentId))
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
    AGENT_CLIENT_SLOT_NAMES.some((name) => coordinator.entries(name).length > 0) ||
    ADAPTER_CLIENT_SLOT_NAMES.some((name) => coordinator.entries(name).length > 0) ||
    coordinator.pageEntries().length > 0
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
      <DynamicRuntimeSlot
        coordinator={coordinator}
        agentId={agentId}
        name="extension.activation.panels"
        props={{
          agentId,
          extensionId: 'dynamic-preview',
          revisionId: 'dynamic-preview',
          activation: 'active',
          activationId: 'dynamic-preview',
          runtimeStatus: 'active',
        }}
      />
      <DynamicRuntimeSlot
        coordinator={coordinator}
        agentId={agentId}
        name="channel.inspector.agent.sections"
        props={{
          agentId,
          channelId: 'dynamic-preview',
          connectionId: 'dynamic-preview',
          episodeId,
          runtimePhase: 'idle',
        }}
      />
      <DynamicRuntimeSlot
        coordinator={coordinator}
        agentId={agentId}
        name="conversation.tool.card"
        props={{
          agentId,
          channelId: 'dynamic-preview',
          callId: 'dynamic-preview',
          toolName: 'dynamic-preview',
          displayName: '工具卡片预览',
          state: 'succeeded',
          surface: 'stream',
          inputPresentation: '{}',
          resultPresentation: '预览结果',
        }}
      />
      {coordinator.entries('conversation.message.rich').map((entry) => {
        const separator = entry.id.indexOf(':')
        const adapterKey = separator > 0 ? entry.id.slice(0, separator) : entry.id
        const kind = separator > 0 ? entry.id.slice(separator + 1) : 'preview'
        const Entry = entry.component
        return (
          <DynamicSlotBoundary
            entryId={entry.id}
            key={`conversation.message.rich:${entry.id}`}
            onFailure={(error) => coordinator.reportSlotFailure(agentId, error)}
          >
            <Entry
              part={{
                type: 'rich',
                adapterKey,
                kind,
                summary: '动态适配器富消息预览',
              }}
              messageId="dynamic-preview-message"
              channelId="dynamic-preview-channel"
            />
          </DynamicSlotBoundary>
        )
      })}
      <DynamicRuntimeSlot
        coordinator={coordinator}
        agentId={agentId}
        name="connection.adapter.setup"
        props={{ adapterKey: 'dynamic-preview', phase: 'setup' }}
      />
      <DynamicRuntimeSlot
        coordinator={coordinator}
        agentId={agentId}
        name="connection.adapter.status"
        props={{ adapterKey: 'dynamic-preview', connectionId: 'dynamic-preview', phase: 'active' }}
      />
      <DynamicRuntimeSlot
        coordinator={coordinator}
        agentId={agentId}
        name="connection.adapter.test"
        props={{ adapterKey: 'dynamic-preview', connectionId: 'dynamic-preview', phase: 'testing' }}
      />
      <DynamicRuntimeSlot
        coordinator={coordinator}
        agentId={agentId}
        name="channel.inspector.adapter.sections"
        props={{
          adapterKey: 'dynamic-preview',
          connectionId: 'dynamic-preview',
          channelId: 'dynamic-preview',
          channelKind: 'group',
        }}
      />
      {coordinator.pageEntries().map((entry) => (
        <DynamicPagePreview agentId={agentId} coordinator={coordinator} entry={entry} key={entry.page.entryId} />
      ))}
    </div>
  ) : null
}
