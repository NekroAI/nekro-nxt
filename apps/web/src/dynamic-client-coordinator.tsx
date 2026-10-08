import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createContext, useContext } from 'react'
import {
  DshDynamicClientRuntime,
  type DynamicClientEvidence,
  type DynamicClientHostPort,
  type DynamicClientSource,
  type DynamicHostPageEntry,
  type DynamicInventoryRow,
} from './dsh-dynamic-client.js'
import type {
  HostPageContribution,
  HostUiKitComponentName,
  HostUiPageGeometryEvidence,
  PanelContribution,
  PanelDensity,
  ToolViewDensity,
} from '@nekro-nxt/contracts'
import { HostUiKitComponentNameSchema, HostUiNavigationModelSchema } from '@nekro-nxt/contracts'
import { HttpDynamicClientHost } from './http-dynamic-host.js'
import type { DynamicPackageSummary } from './product-port.js'
import { useProductStore, useProductRuntime, type ProductRuntime } from './product-runtime.js'
import { Button } from './ui-kit/index.js'
import { HostUiPageFrame } from './host-ui-client.js'
import { ContributionBoundary, ContributionFrame } from './extension-ui/contribution-frame.js'
import type { ContributionRegistry, PanelEntry } from './extension-ui/registry.js'
import styles from './dynamic-client-coordinator.module.css'

/** One browser ModuleLoader multiplexed across product intelligent-agents. */
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

  getClientCode(agentId: string, pluginId: string, pluginRunId: string): Promise<DynamicClientSource> {
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
    evidence: DynamicClientEvidence,
  ): Promise<void> {
    const owner = this.#pluginOwner.get(pluginId)
    if (!owner) return Promise.reject(new Error('找不到动态扩展所属的 Episode。'))
    return this.#ownedHost(owner).reportClientVerification(agentId, pluginId, packageId, pluginRunId, evidence)
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

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Owns the browser runtime for creation previews, approvals and verification reports. */
class DynamicClientCoordinator {
  constructor(readonly product: ProductRuntime) {}
  readonly #host = new MultiplexDynamicClientHost()
  readonly #listeners = new Set<() => void>()
  #runtime: DshDynamicClientRuntime | undefined
  #activeAgentId: string | undefined
  #activeEpisodeId: string | undefined
  #version = 0
  #queue: Promise<void> = Promise.resolve()
  #disposed = false
  #failure = ''
  readonly #reportedRuns = new Set<string>()
  readonly #inspectedPages = new Set<string>()

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

  /** Contributions of loaded candidates; empty until a candidate runs in this browser. */
  previews(): ContributionRegistry | undefined {
    return this.#runtime?.previews
  }

  /** Loaded candidates of one agent with the run each belongs to. */
  candidates(agentId: string): readonly { readonly pluginId: string; readonly pluginRunId: string }[] {
    const runtime = this.#runtime
    if (!runtime) return []
    return ownedCandidates(runtime.loaded(), this.#activeAgentId, agentId)
  }

  pageEntries(): readonly DynamicHostPageEntry[] {
    return this.#runtime?.pageEntries() ?? []
  }

  /** A preview threw or failed a check: the run must not reach `ready`. */
  reportPreviewFailure(pluginId: string, error: unknown): void {
    this.#failure = errorMessage(error)
    void this.#runtime
      ?.reportRenderFailure(pluginId, { slot: 'preview', message: this.#failure, abdicated: false })
      .catch(() => undefined)
    this.#publish()
  }

  notePageInspected(pluginId: string): void {
    if (this.#inspectedPages.has(pluginId)) return
    this.#inspectedPages.add(pluginId)
    this.#publish()
  }

  pageInspected(pluginId: string): boolean {
    return this.#inspectedPages.has(pluginId)
  }

  reported(pluginId: string, pluginRunId: string): boolean {
    return this.#reportedRuns.has(`${pluginId}:${pluginRunId}`)
  }

  /** Sends what really rendered for one run, once. */
  reportVerified(pluginId: string, pluginRunId: string, evidence: DynamicClientEvidence): Promise<void> {
    return this.#enqueue(async () => {
      const key = `${pluginId}:${pluginRunId}`
      if (this.#reportedRuns.has(key) || this.#failure) return
      await this.#runtime?.reportVerification(pluginId, evidence)
      this.#reportedRuns.add(key)
      this.#publish()
    })
  }

  failure(): string {
    return this.#failure
  }

  reportFailure(error: unknown): void {
    this.#failure = errorMessage(error)
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
    const runtime = await DshDynamicClientRuntime.create(this.#host, this.product.store, document, this.product.events)
    runtime.previews.subscribe(() => this.#publish())
    runtime.subscribePages(() => this.#publish())
    this.#runtime = runtime
    return runtime
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

/** Container widths the verification renders each density at. */
const DENSITY_WIDTH: Readonly<Record<PanelDensity, number>> = { compact: 300, full: 720 }
const THEMES = ['light', 'dark'] as const
const TOOL_VIEW_DENSITIES: readonly ToolViewDensity[] = ['chip', 'card']

interface VerificationCase {
  readonly key: string
  readonly width: number
  readonly theme: (typeof THEMES)[number]
  readonly render: () => ReactNode
}

/** Records that one case rendered; measures horizontal overflow of its container after layout. */
function CaseProbe({
  container,
  onDone,
}: {
  readonly container: React.RefObject<HTMLDivElement | null>
  readonly onDone: (problem?: string) => void
}) {
  useLayoutEffect(() => {
    const element = container.current
    if (!element) return onDone('预览容器缺失。')
    onDone(element.scrollWidth > element.clientWidth + 1 ? '内容产生了横向溢出。' : undefined)
  }, [container, onDone])
  return null
}

function VerificationCaseView({
  item,
  onResult,
}: {
  readonly item: VerificationCase
  readonly onResult: (key: string, problem?: string) => void
}) {
  const container = useRef<HTMLDivElement>(null)
  return (
    <div
      ref={container}
      className={styles.verificationCase}
      style={{ width: item.width }}
      data-nxt-theme={item.theme}
      data-host-ui-owner="dynamic-preview"
    >
      <ContributionBoundary
        resetKey={item.key}
        onError={(error) => onResult(item.key, errorMessage(error))}
        fallback={() => null}
      >
        {item.render()}
        <CaseProbe container={container} onDone={(problem) => onResult(item.key, problem)} />
      </ContributionBoundary>
    </div>
  )
}

const previewAnchorId = (panel: PanelContribution, agentId: string, channelId: string | undefined): string =>
  panel.anchor === 'agent' ? agentId : panel.anchor === 'channel' ? (channelId ?? 'preview') : 'preview'

/**
 * Decision §5.3: renders every panel at each declared density in both themes, every tool view as chip and card and
 * every message renderer, out of sight. Only contributions whose every case rendered without errors or horizontal
 * overflow are reported; one failure stops the run from becoming ready.
 */
function CandidateVerification({
  coordinator,
  registry,
  pluginId,
  pluginRunId,
  agentId,
  channelId,
}: {
  readonly coordinator: DynamicClientCoordinator
  readonly registry: ContributionRegistry
  readonly pluginId: string
  readonly pluginRunId: string
  readonly agentId: string
  readonly channelId: string | undefined
}) {
  const owner = `dynamic:${pluginId}`
  const panels = registry.panels().filter((entry) => entry.owner.key === owner)
  const toolViews = registry.toolViews().filter((entry) => entry.owner.key === owner)
  const renderers = registry.messageRenderers().filter((entry) => entry.owner.key === owner)
  const pages = coordinator.pageEntries().filter((entry) => entry.pluginId === pluginId)
  const cases = useMemo<readonly VerificationCase[]>(
    () => [
      ...panels.flatMap((entry) =>
        entry.declaration.densities.flatMap((density) =>
          THEMES.map((theme) => ({
            key: `panel:${entry.declaration.id}:${density}:${theme}`,
            width: DENSITY_WIDTH[density],
            theme,
            render: () => (
              <entry.component
                anchor={{
                  kind: entry.declaration.anchor,
                  id: previewAnchorId({ kind: 'panel', ...entry.declaration }, agentId, channelId),
                }}
                density={density}
                {...(entry.declaration.role === undefined ? {} : { role: entry.declaration.role })}
              />
            ),
          })),
        ),
      ),
      ...toolViews.flatMap((entry) =>
        TOOL_VIEW_DENSITIES.flatMap((density) =>
          THEMES.map((theme) => ({
            key: `tool:${entry.tool}:${density}:${theme}`,
            width: DENSITY_WIDTH.compact,
            theme,
            render: () => (
              <entry.component
                density={density}
                call={{
                  callId: 'verification',
                  toolName: entry.tool,
                  state: 'succeeded',
                  input: '{}',
                  result: '示例结果',
                  durationMs: 120,
                }}
              />
            ),
          })),
        ),
      ),
      ...renderers.flatMap((entry) =>
        THEMES.map((theme) => ({
          key: `renderer:${entry.richKind}:${theme}`,
          width: DENSITY_WIDTH.full,
          theme,
          render: () => (
            <entry.component
              part={{ type: 'rich', adapterKey: 'preview', kind: entry.richKind, summary: '示例富消息' }}
              messageId="verification-message"
              channelId={channelId ?? 'preview'}
            />
          ),
        })),
      ),
    ],
    // Contributions are stable per run; the run identity re-creates this component.
    [pluginRunId, panels.length, toolViews.length, renderers.length],
  )
  const [results, setResults] = useState<ReadonlyMap<string, string | undefined>>(new Map())
  const record = useMemo(
    () => (key: string, problem?: string) =>
      setResults((current) => {
        if (current.has(key) && current.get(key) === undefined && problem === undefined) return current
        const next = new Map(current)
        // A failure is final for the case; a later successful probe must not hide it.
        if (current.get(key) !== undefined) return current
        next.set(key, problem)
        return next
      }),
    [],
  )
  const pagesReady = pages.every((entry) => coordinator.pageInspected(pluginId) && entry.pageGeometry() !== undefined)
  const complete = cases.every((item) => results.has(item.key)) && pagesReady
  useEffect(() => {
    if (!complete || coordinator.reported(pluginId, pluginRunId)) return
    const failures = cases.flatMap((item) => {
      const problem = results.get(item.key)
      return problem === undefined ? [] : [`${item.key}：${problem}`]
    })
    if (failures.length > 0) {
      coordinator.reportPreviewFailure(pluginId, new Error(`界面验证未通过：${failures.join('；')}`))
      return
    }
    if (cases.length === 0 && pages.length === 0) return
    void coordinator
      .reportVerified(pluginId, pluginRunId, {
        renderedPanels: panels.map((entry) => ({ kind: 'panel', ...entry.declaration })),
        renderedToolViews: toolViews.map((entry) => entry.tool),
        renderedMessageRenderers: renderers.map((entry) => entry.richKind),
        renderedPages: pages.map((entry) => entry.page),
        usedUiComponents: [...new Set(pages.flatMap((entry) => entry.usedUiComponents()))],
        pageGeometry: pages.flatMap((entry) => {
          const geometry = entry.pageGeometry()
          return geometry === undefined ? [] : [geometry]
        }),
        navigationEntries: pages
          .filter(({ page, navigation }) => page.objectPane === 'navigation' && navigation !== undefined)
          .map(({ page }) => page.entryId),
      })
      .catch((error: unknown) => coordinator.reportFailure(error))
  }, [cases, complete, coordinator, pages, panels, pluginId, pluginRunId, renderers, results, toolViews])
  return (
    <div className={styles.verification} aria-hidden="true" data-dynamic-verification={pluginId}>
      {cases.map((item) => (
        <VerificationCaseView key={item.key} item={item} onResult={record} />
      ))}
    </div>
  )
}

/** What the user sees: each candidate panel in its frame, tool views as chip and card, renderers, pages. */
function CandidatePreview({
  coordinator,
  registry,
  panels,
  agentId,
  channelId,
}: {
  readonly coordinator: DynamicClientCoordinator
  readonly registry: ContributionRegistry
  readonly panels: readonly PanelEntry[]
  readonly agentId: string
  readonly channelId: string | undefined
}) {
  const toolViews = registry
    .toolViews()
    .filter((entry) => entry.owner.kind === 'dynamic' && entry.owner.agentId === agentId)
  const renderers = registry
    .messageRenderers()
    .filter((entry) => entry.owner.kind === 'dynamic' && entry.owner.agentId === agentId)
  return (
    <div className={styles.preview}>
      {panels.map((entry) => {
        const density: PanelDensity = entry.declaration.densities.includes('full') ? 'full' : 'compact'
        const pluginId = entry.owner.kind === 'dynamic' ? entry.owner.pluginId : ''
        return (
          <ContributionFrame
            key={entry.key}
            title={entry.declaration.title}
            icon={entry.declaration.icon}
            source={entry.owner.label}
            density={density}
            styleScope={entry.owner.styleScope}
            resetKey={entry.key}
            onError={(error) => coordinator.reportPreviewFailure(pluginId, error)}
          >
            <entry.component
              anchor={{
                kind: entry.declaration.anchor,
                id: previewAnchorId({ kind: 'panel', ...entry.declaration }, agentId, channelId),
              }}
              density={density}
              {...(entry.declaration.role === undefined ? {} : { role: entry.declaration.role })}
            />
          </ContributionFrame>
        )
      })}
      {toolViews.map((entry) => (
        <div key={entry.key} className={styles.toolPreview} data-host-ui-owner={entry.owner.styleScope}>
          {TOOL_VIEW_DENSITIES.map((density) => (
            <ContributionBoundary
              key={density}
              resetKey={`${entry.key}:${density}`}
              onError={(error) =>
                coordinator.reportPreviewFailure(entry.owner.kind === 'dynamic' ? entry.owner.pluginId : '', error)
              }
              fallback={() => null}
            >
              <entry.component
                density={density}
                call={{ callId: 'preview', toolName: entry.tool, state: 'succeeded', input: '{}', result: '示例结果' }}
              />
            </ContributionBoundary>
          ))}
        </div>
      ))}
      {renderers.map((entry) => (
        <div key={entry.key} data-host-ui-owner={entry.owner.styleScope}>
          <ContributionBoundary
            resetKey={entry.key}
            onError={(error) =>
              coordinator.reportPreviewFailure(entry.owner.kind === 'dynamic' ? entry.owner.pluginId : '', error)
            }
            fallback={() => null}
          >
            <entry.component
              part={{ type: 'rich', adapterKey: 'preview', kind: entry.richKind, summary: '示例富消息' }}
              messageId="preview-message"
              channelId={channelId ?? 'preview'}
            />
          </ContributionBoundary>
        </div>
      ))}
    </div>
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
  if (usedUiComponents.length === 0) violations.push('可以使用 UI Kit 统一控件外观。')
  if (nakedControls.length > 0) violations.push('页面使用原生控件，请检查主题与可访问性。')
  if (nakedTables.length > 0) violations.push('页面使用原生表格，请检查窄窗展示。')
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
  coordinator,
  entry,
}: {
  readonly coordinator: DynamicClientCoordinator
  readonly entry: DynamicHostPageEntry
}) {
  const [visualSuggestions, setVisualSuggestions] = useState<readonly string[]>([])
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
    setVisualSuggestions([...evidence.violations, ...geometry.violations])
    const content = root.querySelector<HTMLElement>('[data-host-ui-content]')
    if (
      !content ||
      (!content.innerText.trim() && !content.querySelector('img, svg, canvas, input, select, textarea, video'))
    ) {
      coordinator.reportPreviewFailure(entry.pluginId, new Error('页面没有可见内容。'))
    }
    coordinator.notePageInspected(entry.pluginId)
  }, [coordinator, entry, relativePath])
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
      {visualSuggestions.length > 0 ? (
        <details>
          <summary>视觉检查建议</summary>
          <ul>
            {visualSuggestions.map((suggestion) => (
              <li key={suggestion}>{suggestion}</li>
            ))}
          </ul>
        </details>
      ) : null}
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
            <ContributionBoundary
              resetKey={entry.page.entryId}
              onError={(error) => coordinator.reportPreviewFailure(entry.pluginId, error)}
              fallback={() => <div role="alert">页面渲染失败。</div>}
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
            </ContributionBoundary>
          </HostUiPageFrame>
        </div>
      </div>
    </section>
  )
}

const DynamicClientContext = createContext<DynamicClientCoordinator | null>(null)
/**
 * The browser runtime only holds the active Episode's candidates, and its inventory rows name the DSH Session
 * (`nxt-<episodeId>`) as their agent rather than the product agent. Ownership is therefore the active product agent.
 */
export const ownedCandidates = (
  loaded: readonly { readonly pluginId: string; readonly pluginRunId: string }[],
  activeAgentId: string | undefined,
  agentId: string,
): readonly { readonly pluginId: string; readonly pluginRunId: string }[] =>
  activeAgentId === agentId ? loaded.map(({ pluginId, pluginRunId }) => ({ pluginId, pluginRunId })) : []

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
  const useProductStore = useProductRuntime().store

  const product = useProductRuntime()
  const coordinator = useMemo(() => new DynamicClientCoordinator(product), [product])
  const disposeTimer = useRef<number | undefined>(undefined)
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
    if (disposeTimer.current !== undefined) window.clearTimeout(disposeTimer.current)
    const unregister = product.approvals.register(coordinator)
    return () => {
      unregister()
      disposeTimer.current = window.setTimeout(() => {
        void coordinator.dispose()
      }, 0)
    }
  }, [coordinator, product])

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

/**
 * Live preview and verification of one agent's running creation candidate. Rendered by the workshop task view;
 * verification needs this view open because it renders in this browser.
 */
export function DynamicClientSlots({ agentId, episodeId }: { readonly agentId: string; readonly episodeId: string }) {
  const coordinator = useContext(DynamicClientContext)
  if (!coordinator) throw new Error('动态预览缺少产品级运行时。')
  const inventoryVersion = useProductStore((state) => dynamicClientInventoryVersion(state.dynamic, agentId))
  const channelId = useProductStore((state) => state.channels.find((channel) => channel.agentId === agentId)?.id)
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
  const registry = coordinator.previews()
  const candidates = coordinator.candidates(agentId)
  const plugins = new Set(candidates.map((candidate) => candidate.pluginId))
  const panels =
    registry?.panels().filter((entry) => entry.owner.kind === 'dynamic' && plugins.has(entry.owner.pluginId)) ?? []
  const pages = coordinator.pageEntries().filter((entry) => plugins.has(entry.pluginId))
  if (failure) return <div role="alert">界面预览失败：{failure}</div>
  if (!registry || candidates.length === 0) return null
  return (
    <div data-dynamic-client-slots="">
      <CandidatePreview
        coordinator={coordinator}
        registry={registry}
        panels={panels}
        agentId={agentId}
        channelId={channelId}
      />
      {pages.map((entry) => (
        <DynamicPagePreview coordinator={coordinator} entry={entry} key={entry.page.entryId} />
      ))}
      {candidates
        .filter((candidate) => !coordinator.reported(candidate.pluginId, candidate.pluginRunId))
        .map((candidate) => (
          <CandidateVerification
            key={`${candidate.pluginId}:${candidate.pluginRunId}`}
            coordinator={coordinator}
            registry={registry}
            pluginId={candidate.pluginId}
            pluginRunId={candidate.pluginRunId}
            agentId={agentId}
            channelId={channelId}
          />
        ))}
    </div>
  )
}
