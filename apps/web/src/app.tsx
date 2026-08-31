import {
  AppWindow,
  BarChart3,
  BookOpen,
  Boxes,
  Cable,
  Database,
  FileText,
  Folder,
  Globe,
  LayoutDashboard,
  MessageSquare,
  Moon,
  Puzzle,
  Server,
  Settings,
  Sun,
  Terminal,
  UsersRound,
  Workflow,
  Wrench,
} from 'lucide-react'
import {
  Component,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ErrorInfo,
  type ReactNode,
} from 'react'
import type { HostUiPageEntry } from '@nekro-nxt/contracts'
import { Navigate, Outlet, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom'
import styles from './app.module.css'
import { NotificationCenter, notify } from './components/notifications.js'
import { EmptyState, HostNotice } from './components/product-feedback.js'
import { DynamicClientProvider } from './dynamic-client-coordinator.js'
import { useDesktopInstance } from './desktop-shell.js'
import { PersistentExtensionClientProvider } from './persistent-extension-client.js'
import { AdapterHostClientProvider } from './adapter-host-client.js'
import {
  AgentManagePage,
  AgentsPage,
  ChannelConversationPage,
  ConnectionsPage,
  CreatorPage,
  ExtensionsPage,
  SettingsPage,
  UsersPage,
} from './pages/product-pages.js'
import { useProductStore, type ProductHostStatus } from './product-store.js'
import { isWorkPath, workHomePath } from './shell/last-channel.js'
import { CommandPalette } from './shell/command-palette.js'
import { NxtNavLink } from './shell/nxt-link.js'
import { ObjectPane } from './shell/object-pane.js'
import { canvasKind } from './shell/route-kind.js'
import {
  Button,
  IconButton,
  NavGlyph,
  NavMarkGroup,
  NxtMotionProvider,
  ResizeHandle,
  RouteTransition,
  ThemeIconSwap,
  Tooltip,
  type StatusTone,
} from './ui-kit/index.js'
import { OBJECT_PANE_WIDTH, useUiPreferences } from './ui-preferences.js'
import { applyThemeChoice } from './theme-preference.js'
import { HostUiClientProvider, HostUiObjectPane, HostUiPageCanvas } from './host-ui-client.js'

const modes = [
  { to: '/work', label: '工作', icon: MessageSquare, work: true },
  { to: '/connections', label: '连接', icon: Cable, work: false },
  { to: '/users', label: '用户', icon: UsersRound, work: false },
  { to: '/extensions', label: '扩展', icon: Boxes, work: false },
  { to: '/settings', label: '设置', icon: Settings, work: false },
] as const

const hostPageIcons = {
  'app-window': AppWindow,
  'bar-chart': BarChart3,
  'book-open': BookOpen,
  boxes: Boxes,
  database: Database,
  'file-text': FileText,
  folder: Folder,
  globe: Globe,
  'layout-dashboard': LayoutDashboard,
  puzzle: Puzzle,
  terminal: Terminal,
  workflow: Workflow,
  wrench: Wrench,
} as const

const hostPageSvgUrl = (page: HostUiPageEntry): string =>
  page.owner.kind === 'extension'
    ? `/api/extensions/${encodeURIComponent(page.owner.extensionId)}/revisions/${encodeURIComponent(page.owner.revisionId)}/host-ui/assets/${page.icon.kind === 'svg' ? page.icon.sha256 : ''}.svg`
    : `/api/dsh/plugin-entries/${encodeURIComponent(page.owner.entryId)}/host-ui/assets/${page.icon.kind === 'svg' ? page.icon.sha256 : ''}.svg`

function HostPageGlyph({ page }: { readonly page: HostUiPageEntry }) {
  if (page.icon.kind === 'host-icon') {
    const Icon = hostPageIcons[page.icon.name]
    return <Icon size={18} strokeWidth={1.8} aria-hidden="true" />
  }
  const url = hostPageSvgUrl(page)
  const iconStyle: CSSProperties & { '--nxt-host-page-icon': string } = {
    '--nxt-host-page-icon': `url(${JSON.stringify(url)})`,
  }
  return <span className={styles.hostPageSvgIcon} aria-hidden="true" style={iconStyle} />
}

export const hostPresentation = (status: ProductHostStatus): { readonly label: string; readonly tone: StatusTone } => {
  if (status === 'initializing') return { label: '正在连接', tone: 'info' }
  if (status === 'ready') return { label: '运行正常', tone: 'success' }
  if (status === 'stale') return { label: '连接不稳定', tone: 'warning' }
  return { label: '无法连接', tone: 'error' }
}

export const nextVisibleHostUiPage = (
  previous: HostUiPageEntry | undefined,
  previousOrder: readonly HostUiPageEntry[],
  current: readonly HostUiPageEntry[],
): HostUiPageEntry | undefined => {
  const visibleById = new Map(current.filter(({ visible }) => visible).map((page) => [page.pageInstanceId, page]))
  if (visibleById.size === 0) return undefined
  if (!previous) return visibleById.values().next().value
  const index = previousOrder.findIndex(({ pageInstanceId }) => pageInstanceId === previous.pageInstanceId)
  if (index < 0) return visibleById.values().next().value
  for (const candidate of [...previousOrder.slice(index + 1), ...previousOrder.slice(0, index)]) {
    const visible = visibleById.get(candidate.pageInstanceId)
    if (visible) return visible
  }
  return visibleById.values().next().value
}

function WorkIndex() {
  const host = useProductStore((state) => state.host)
  const channels = useProductStore((state) => state.channels)
  const agents = useProductStore((state) => state.agents)
  if (host.lastSuccessfulAt === null && channels.length === 0 && agents.length === 0) {
    return (
      <div className={styles.centeredState}>
        <EmptyState loading title="正在读取" description="连接完成后会打开最近使用的频道。" />
      </div>
    )
  }
  return <Navigate to={workHomePath({ channels, agents })} replace />
}

function RootRedirect() {
  return <Navigate to="/work" replace />
}

function LegacyWorkRedirect({ kind }: { readonly kind: 'agents' | 'agent' | 'channels' | 'channel' | 'creator' }) {
  const location = useLocation()
  const { agentId, channelId } = useParams()
  const suffix = `${location.search}${location.hash}`
  if (kind === 'agent' && agentId)
    return <Navigate to={`/work/agents/${encodeURIComponent(agentId)}${suffix}`} replace />
  if (kind === 'channel' && channelId) {
    return <Navigate to={`/work/channels/${encodeURIComponent(channelId)}${suffix}`} replace />
  }
  if (kind === 'agents' && new URLSearchParams(location.search).get('create') === '1') {
    return <Navigate to={`/work/agents/new${location.hash}`} replace />
  }
  if (kind === 'creator') return <Navigate to={`/work/creator${suffix}`} replace />
  return <Navigate to="/work" replace />
}

function RuntimeRedirect() {
  const host = useProductStore((state) => state.host)
  const channels = useProductStore((state) => state.channels)
  const agents = useProductStore((state) => state.agents)
  if (host.lastSuccessfulAt === null && channels.length === 0 && agents.length === 0) {
    return (
      <div className={styles.centeredState}>
        <EmptyState loading title="正在读取" description="连接完成后会打开最近使用的频道。" />
      </div>
    )
  }
  return <Navigate to={workHomePath({ channels, agents })} replace />
}

function DesktopShell() {
  const location = useLocation()
  const navigate = useNavigate()
  const theme = useProductStore((state) => state.theme)
  const reducedMotion = useProductStore((state) => state.reducedMotion)
  const savedObjectPaneWidth = useUiPreferences((state) => state.layout.objectPaneWidth)
  const [objectPaneWidth, setObjectPaneWidth] = useState(savedObjectPaneWidth)
  const desktopInstance = useDesktopInstance()
  const hostSnapshotReady = useProductStore((state) => state.host.lastSuccessfulAt !== null)
  const hostUiPages = useProductStore((state) => state.hostUi.pages)
  const visibleHostUiPages = hostUiPages.filter(({ visible }) => visible)
  const activeHostUiPage = hostUiPages.find(({ routeBase }) => location.pathname.startsWith(routeBase))
  const lastActiveHostUiPage = useRef<HostUiPageEntry | undefined>(activeHostUiPage)
  const previousHostUiOrder = useRef(hostUiPages)
  const objectPaneHidden = activeHostUiPage?.objectPane === 'hidden'
  useEffect(() => {
    if (activeHostUiPage) lastActiveHostUiPage.current = activeHostUiPage
    if (!location.pathname.startsWith('/apps/')) return
    if (!hostSnapshotReady) return
    if (activeHostUiPage?.visible) return
    const previous = activeHostUiPage ?? lastActiveHostUiPage.current
    const fallback = nextVisibleHostUiPage(previous, previousHostUiOrder.current, hostUiPages)
    if (fallback) {
      void navigate(`${fallback.routeBase}${fallback.startPath ? `/${fallback.startPath}` : ''}`, { replace: true })
      notify('当前扩展页面已不可用，已打开下一个页面。', 'info', 'host-ui-page-recovery')
      return
    }
    void navigate(
      previous?.owner.kind === 'extension'
        ? `/extensions/${previous.owner.extensionId}`
        : '/settings?tab=dsh-extensions',
      { replace: true },
    )
    notify('当前扩展页面已不可用，已返回扩展管理。', 'info', 'host-ui-page-recovery')
  }, [activeHostUiPage, hostSnapshotReady, hostUiPages, location.pathname, navigate, visibleHostUiPages])
  useEffect(() => {
    previousHostUiOrder.current = hostUiPages
  }, [hostUiPages])
  const [instanceSwitcherOpen, setInstanceSwitcherOpen] = useState(false)
  const instanceStatusClass = {
    connecting: styles.instanceStatus_connecting,
    ready: styles.instanceStatus_ready,
    unstable: styles.instanceStatus_unstable,
    offline: styles.instanceStatus_offline,
    'authentication-required': styles.instanceStatus_authenticationRequired,
    incompatible: styles.instanceStatus_incompatible,
  }[desktopInstance.presentation.status]
  const shellStyle: CSSProperties & {
    '--nxt-object-pane-width': string
  } = {
    '--nxt-object-pane-width': `${objectPaneWidth}px`,
  }
  useEffect(() => setObjectPaneWidth(savedObjectPaneWidth), [savedObjectPaneWidth])
  const nextTheme = theme === 'light' ? 'dark' : 'light'
  const themeLabel = theme === 'light' ? '浅色' : '深色'
  const nextThemeLabel = nextTheme === 'light' ? '浅色' : '深色'
  const ThemeIcon = theme === 'light' ? Sun : Moon
  const cycleTheme = (): void => {
    const root = document.documentElement
    if (!reducedMotion) root.dataset['themeChanging'] = ''
    useProductStore.getState().setTheme(nextTheme)
    if (!reducedMotion) window.setTimeout(() => delete root.dataset['themeChanging'], 240)
  }

  return (
    <div className={styles.shell} style={shellStyle} data-object-pane-hidden={objectPaneHidden ? '' : undefined}>
      <header className={styles.windowTopBar} data-window-top-bar>
        <div className={styles.windowBrand} data-window-brand>
          <img className={styles.brandMark} src="/brand/mark.svg" alt="" aria-hidden="true" />
          <span className={styles.brandCopy}>
            <strong>NekroNXT</strong>
            <small>月潮观测所</small>
          </span>
        </div>
        <div className={styles.windowObjectTitle} data-window-drag-title aria-hidden="true">
          <span className={styles.experimentBadge}>LAB</span>
          <span>CALM · PRECISE · ALIVE</span>
        </div>
      </header>
      <div className={styles.shellBody} data-shell-body>
        <aside className={styles.rail} aria-label="模式">
          <NavMarkGroup id="rail">
            <nav className={styles.railSystem} aria-label="主导航">
              {modes.map(({ to, label, icon: Icon, work }) => {
                const active = work ? isWorkPath(location.pathname) : location.pathname.startsWith(to)
                return (
                  <NxtNavLink
                    to={to}
                    aria-label={label}
                    title={label}
                    className={() => [styles.railBtn, active ? styles.railBtnActive : ''].filter(Boolean).join(' ')}
                    aria-current={active ? 'page' : undefined}
                    data-nav-active={active ? '' : undefined}
                    key={label}
                  >
                    <NavGlyph active={active}>
                      <Icon size={18} strokeWidth={1.8} aria-hidden="true" />
                    </NavGlyph>
                  </NxtNavLink>
                )
              })}
            </nav>
            {visibleHostUiPages.length > 0 ? <div className={styles.railDivider} aria-hidden="true" /> : null}
            {visibleHostUiPages.length > 0 ? (
              <nav className={styles.railExtensions} aria-label="扩展页面">
                {visibleHostUiPages.map((page) => {
                  const active = location.pathname.startsWith(page.routeBase)
                  const start = page.startPath ? `/${page.startPath}` : ''
                  return (
                    <NxtNavLink
                      key={page.pageInstanceId}
                      to={`${page.routeBase}${start}`}
                      aria-label={page.title}
                      title={page.title}
                      className={() => [styles.railBtn, active ? styles.railBtnActive : ''].filter(Boolean).join(' ')}
                      aria-current={active ? 'page' : undefined}
                      data-nav-active={active ? '' : undefined}
                      data-host-ui-error={page.diagnostic && page.diagnostic.status !== 'ready' ? '' : undefined}
                      data-host-ui-rail-entry={page.pageInstanceId}
                    >
                      <NavGlyph active={active}>
                        <HostPageGlyph page={page} />
                      </NavGlyph>
                    </NxtNavLink>
                  )
                })}
              </nav>
            ) : null}
          </NavMarkGroup>
          <div className={styles.railSpacer} />
          <IconButton
            label={`主题：${themeLabel}；切换为${nextThemeLabel}`}
            tooltip={false}
            className={styles.railUtility}
            onClick={cycleTheme}
          >
            <ThemeIconSwap swapKey={theme}>
              <ThemeIcon size={16} strokeWidth={1.8} aria-hidden="true" />
            </ThemeIconSwap>
          </IconButton>
          {desktopInstance.enabled ? (
            <IconButton
              label={`管理并添加远程服务实例：${desktopInstance.presentation.displayName} · ${
                desktopInstance.presentation.status === 'ready'
                  ? '运行正常'
                  : desktopInstance.presentation.status === 'connecting'
                    ? '正在连接'
                    : desktopInstance.presentation.status === 'unstable'
                      ? '连接不稳定'
                      : desktopInstance.presentation.status === 'authentication-required'
                        ? '需要重新认证'
                        : desktopInstance.presentation.status === 'incompatible'
                          ? '版本不兼容'
                          : '无法连接'
              }`}
              tooltip={false}
              className={`${styles.railUtility} ${styles.railInstance} ${instanceSwitcherOpen ? styles.railInstanceOpen : ''}`}
              data-desktop-instance-switcher=""
              aria-expanded={instanceSwitcherOpen}
              onClick={() => {
                if (instanceSwitcherOpen) {
                  setInstanceSwitcherOpen(false)
                  void window.nekroDesktopShell?.closeInstanceSwitcher()
                  return
                }
                setInstanceSwitcherOpen(true)
                void window.nekroDesktopShell?.openInstanceSwitcher().finally(() => setInstanceSwitcherOpen(false))
              }}
            >
              <Server size={16} strokeWidth={1.8} aria-hidden="true" />
              <span className={`${styles.instanceStatus} ${instanceStatusClass}`} aria-hidden="true" />
            </IconButton>
          ) : null}
        </aside>
        <aside className={styles.tree} aria-label="对象列" aria-hidden={objectPaneHidden || undefined}>
          {activeHostUiPage?.objectPane === 'navigation' ? (
            <HostUiObjectPane page={activeHostUiPage} />
          ) : objectPaneHidden ? null : (
            <ObjectPane />
          )}
        </aside>
        <ResizeHandle
          className={styles.shellSplitter}
          label="调整对象列宽度"
          value={objectPaneWidth}
          min={OBJECT_PANE_WIDTH.min}
          max={OBJECT_PANE_WIDTH.max}
          defaultValue={OBJECT_PANE_WIDTH.default}
          disabled={objectPaneHidden}
          onChange={setObjectPaneWidth}
          onCommit={(value) => useUiPreferences.getState().setObjectPaneWidth(value)}
        />
        <main className={styles.stage}>
          <CommandPalette />
          <NotificationCenter />
          <HostNotice />
          <div className={styles.stageView}>
            <RouteTransition
              className={styles.routeView}
              modeKey={canvasKind(location.pathname)}
              objectKey={location.pathname}
            >
              <Outlet />
            </RouteTransition>
          </div>
        </main>
      </div>
    </div>
  )
}

function ThemeEffects() {
  const theme = useProductStore((state) => state.theme)
  const reducedMotion = useProductStore((state) => state.reducedMotion)
  const reducedTransparency = useUiPreferences((state) => state.appearance.reducedTransparency)
  const contrast = useUiPreferences((state) => state.appearance.contrast)

  useEffect(() => {
    applyThemeChoice(document.documentElement, theme)
    document.documentElement.dataset['glinExperiment'] = ''
    document.documentElement.dataset['reducedMotion'] = String(reducedMotion)
    document.documentElement.dataset['reducedTransparency'] = String(reducedTransparency)
    document.documentElement.dataset['contrast'] = contrast
  }, [theme, reducedMotion, reducedTransparency, contrast])
  return null
}

function NotFoundPage() {
  return (
    <div className={styles.centeredState}>
      <div>
        <h1>页面不存在</h1>
        <p>这个入口已被移除，或对应内容不再可用。</p>
        <Button variant="primary" onClick={() => window.location.assign('/')}>
          返回工作台
        </Button>
      </div>
    </div>
  )
}

interface ProductErrorBoundaryState {
  readonly failed: boolean
}

class ProductErrorBoundary extends Component<{ readonly children: ReactNode }, ProductErrorBoundaryState> {
  override state: ProductErrorBoundaryState = { failed: false }

  static getDerivedStateFromError(): ProductErrorBoundaryState {
    return { failed: true }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[nekro-nxt] 产品界面渲染失败', error, info)
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <div className={styles.centeredState} role="alert">
        <div>
          <h1>页面运行失败</h1>
          <p>界面遇到未预期错误。重新加载可恢复已保存数据。</p>
          <Button variant="primary" onClick={() => window.location.reload()}>
            重新加载
          </Button>
        </div>
      </div>
    )
  }
}

function MotionRoot({ children }: { readonly children: ReactNode }) {
  const reducedMotion = useProductStore((state) => state.reducedMotion)
  return <NxtMotionProvider reducedMotion={reducedMotion}>{children}</NxtMotionProvider>
}

export function NekroNxtApp() {
  const tooltipProps = useMemo(() => ({ delayDuration: 450 }), [])
  return (
    <ProductErrorBoundary>
      <MotionRoot>
        <DynamicClientProvider>
          <AdapterHostClientProvider>
            <PersistentExtensionClientProvider>
              <HostUiClientProvider>
                <Tooltip.Provider {...tooltipProps}>
                  <ThemeEffects />
                  <Routes>
                    <Route element={<DesktopShell />}>
                      <Route index element={<RootRedirect />} />
                      <Route path="work" element={<WorkIndex />} />
                      <Route path="work/agents/new" element={<AgentsPage />} />
                      <Route path="work/agents/:agentId" element={<AgentManagePage />} />
                      <Route path="work/channels" element={<Navigate to="/work" replace />} />
                      <Route path="work/channels/:channelId" element={<ChannelConversationPage />} />
                      <Route path="work/creator" element={<CreatorPage />} />
                      <Route path="work/creator/:taskId" element={<CreatorPage />} />
                      <Route path="agents" element={<LegacyWorkRedirect kind="agents" />} />
                      <Route path="agents/:agentId" element={<LegacyWorkRedirect kind="agent" />} />
                      <Route path="channels" element={<LegacyWorkRedirect kind="channels" />} />
                      <Route path="channels/:channelId" element={<LegacyWorkRedirect kind="channel" />} />
                      <Route path="connections" element={<ConnectionsPage />} />
                      <Route path="connections/:connectionId" element={<ConnectionsPage />} />
                      <Route path="users" element={<UsersPage />} />
                      <Route path="extensions" element={<ExtensionsPage />} />
                      <Route path="extensions/:extensionId" element={<ExtensionsPage />} />
                      <Route path="apps/:pageInstanceId/*" element={<HostUiPageCanvas />} />
                      <Route path="creator" element={<LegacyWorkRedirect kind="creator" />} />
                      <Route path="runtime" element={<RuntimeRedirect />} />
                      <Route path="settings" element={<SettingsPage />} />
                      <Route path="*" element={<NotFoundPage />} />
                    </Route>
                  </Routes>
                </Tooltip.Provider>
              </HostUiClientProvider>
            </PersistentExtensionClientProvider>
          </AdapterHostClientProvider>
        </DynamicClientProvider>
      </MotionRoot>
    </ProductErrorBoundary>
  )
}
