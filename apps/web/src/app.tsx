import { Boxes, Cable, MessageSquare, Monitor, Moon, Settings, Sun } from 'lucide-react'
import { Component, useEffect, useMemo, useState, type CSSProperties, type ErrorInfo, type ReactNode } from 'react'
import { Navigate, NavLink, Outlet, Route, Routes, useLocation, useParams } from 'react-router-dom'
import styles from './app.module.css'
import { NotificationCenter } from './components/notifications.js'
import { EmptyState, HostNotice } from './components/product-feedback.js'
import { DynamicClientProvider } from './dynamic-client-coordinator.js'
import {
  AgentManagePage,
  AgentsPage,
  ChannelConversationPage,
  ConnectionsPage,
  CreatorPage,
  ExtensionsPage,
  SettingsPage,
} from './pages/product-pages.js'
import { useProductStore, type ProductHostStatus } from './product-store.js'
import { isWorkPath, workHomePath } from './shell/last-channel.js'
import { ObjectPane } from './shell/object-pane.js'
import { Button, IconButton, ResizeHandle, Tooltip, type StatusTone } from './ui-kit/index.js'
import { OBJECT_PANE_WIDTH, useUiPreferences } from './ui-preferences.js'

const modes = [
  { to: '/work', label: '工作', icon: MessageSquare, work: true },
  { to: '/connections', label: '连接', icon: Cable, work: false },
  { to: '/extensions', label: '扩展', icon: Boxes, work: false },
  { to: '/settings', label: '设置', icon: Settings, work: false },
] as const

export const hostPresentation = (status: ProductHostStatus): { readonly label: string; readonly tone: StatusTone } => {
  if (status === 'initializing') return { label: '正在连接', tone: 'info' }
  if (status === 'ready') return { label: '运行正常', tone: 'success' }
  if (status === 'stale') return { label: '连接不稳定', tone: 'warning' }
  return { label: '无法连接', tone: 'error' }
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
  const theme = useProductStore((state) => state.theme)
  const reducedMotion = useProductStore((state) => state.reducedMotion)
  const savedObjectPaneWidth = useUiPreferences((state) => state.layout.objectPaneWidth)
  const [objectPaneWidth, setObjectPaneWidth] = useState(savedObjectPaneWidth)
  const shellStyle: CSSProperties & {
    '--nxt-object-pane-width': string
  } = {
    '--nxt-object-pane-width': `${objectPaneWidth}px`,
  }
  useEffect(() => setObjectPaneWidth(savedObjectPaneWidth), [savedObjectPaneWidth])
  const nextTheme = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system'
  const themeLabel = theme === 'system' ? '跟随系统' : theme === 'light' ? '浅色' : '深色'
  const nextThemeLabel = nextTheme === 'system' ? '跟随系统' : nextTheme === 'light' ? '浅色' : '深色'
  const ThemeIcon = theme === 'system' ? Monitor : theme === 'light' ? Sun : Moon
  const cycleTheme = (): void => {
    const root = document.documentElement
    if (!reducedMotion) root.dataset['themeChanging'] = ''
    useProductStore.getState().setTheme(nextTheme)
    if (!reducedMotion) window.setTimeout(() => delete root.dataset['themeChanging'], 240)
  }

  return (
    <div className={styles.shell} style={shellStyle}>
      <header className={styles.windowTopBar} data-window-top-bar>
        <div className={styles.windowBrand} aria-label="NekroNxt">
          <span className={styles.mark} aria-hidden="true" />
        </div>
        <div className={styles.windowObjectTitle}>NekroNxt</div>
      </header>
      <div className={styles.shellBody} data-shell-body>
        <aside className={styles.rail} aria-label="模式">
          <nav aria-label="主导航">
            {modes.map(({ to, label, icon: Icon, work }) => (
              <NavLink
                to={to}
                aria-label={label}
                title={label}
                className={() => {
                  const active = work ? isWorkPath(location.pathname) : location.pathname.startsWith(to)
                  return [styles.railBtn, active ? styles.railBtnActive : ''].filter(Boolean).join(' ')
                }}
                aria-current={
                  (work ? isWorkPath(location.pathname) : location.pathname.startsWith(to)) ? 'page' : undefined
                }
                key={label}
              >
                <Icon size={18} strokeWidth={1.8} aria-hidden="true" />
              </NavLink>
            ))}
          </nav>
          <div className={styles.railSpacer} />
          <IconButton
            label={`主题：${themeLabel}；切换为${nextThemeLabel}`}
            className={styles.railTheme}
            onClick={cycleTheme}
          >
            <span className={styles.themeIcon} key={theme}>
              <ThemeIcon size={16} strokeWidth={1.8} aria-hidden="true" />
            </span>
          </IconButton>
        </aside>
        <aside className={styles.tree} aria-label="对象列">
          <ObjectPane />
        </aside>
        <ResizeHandle
          className={styles.shellSplitter}
          label="调整对象列宽度"
          value={objectPaneWidth}
          min={OBJECT_PANE_WIDTH.min}
          max={OBJECT_PANE_WIDTH.max}
          defaultValue={OBJECT_PANE_WIDTH.default}
          onChange={setObjectPaneWidth}
          onCommit={(value) => useUiPreferences.getState().setObjectPaneWidth(value)}
        />
        <main className={styles.stage}>
          <NotificationCenter />
          <HostNotice />
          <div className={styles.stageView}>
            <div className={styles.routeView} key={location.pathname}>
              <Outlet />
            </div>
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
    if (theme === 'system') delete document.documentElement.dataset['theme']
    else document.documentElement.dataset['theme'] = theme
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
          <p>界面遇到未预期错误。重新加载不会清除已保存的数据。</p>
          <Button variant="primary" onClick={() => window.location.reload()}>
            重新加载
          </Button>
        </div>
      </div>
    )
  }
}

export function NekroNxtApp() {
  const tooltipProps = useMemo(() => ({ delayDuration: 450 }), [])
  return (
    <ProductErrorBoundary>
      <DynamicClientProvider>
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
              <Route path="agents" element={<LegacyWorkRedirect kind="agents" />} />
              <Route path="agents/:agentId" element={<LegacyWorkRedirect kind="agent" />} />
              <Route path="channels" element={<LegacyWorkRedirect kind="channels" />} />
              <Route path="channels/:channelId" element={<LegacyWorkRedirect kind="channel" />} />
              <Route path="connections" element={<ConnectionsPage />} />
              <Route path="connections/:connectionId" element={<ConnectionsPage />} />
              <Route path="extensions" element={<ExtensionsPage />} />
              <Route path="extensions/:extensionId" element={<ExtensionsPage />} />
              <Route path="creator" element={<LegacyWorkRedirect kind="creator" />} />
              <Route path="runtime" element={<RuntimeRedirect />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="*" element={<NotFoundPage />} />
            </Route>
          </Routes>
        </Tooltip.Provider>
      </DynamicClientProvider>
    </ProductErrorBoundary>
  )
}
