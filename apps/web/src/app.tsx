import { Boxes, Cable, MessageSquare, Moon, Server, Settings, Sun, UsersRound } from 'lucide-react'
import { Component, useEffect, useMemo, useState, type CSSProperties, type ErrorInfo, type ReactNode } from 'react'
import { Navigate, Outlet, Route, Routes, useLocation, useParams } from 'react-router-dom'
import styles from './app.module.css'
import { NotificationCenter } from './components/notifications.js'
import { EmptyState, HostNotice } from './components/product-feedback.js'
import { DynamicClientProvider } from './dynamic-client-coordinator.js'
import { useDesktopInstance } from './desktop-shell.js'
import { PersistentExtensionClientProvider } from './persistent-extension-client.js'
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

const modes = [
  { to: '/work', label: '工作', icon: MessageSquare, work: true },
  { to: '/connections', label: '连接', icon: Cable, work: false },
  { to: '/users', label: '用户', icon: UsersRound, work: false },
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
  const desktopInstance = useDesktopInstance()
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
    <div className={styles.shell} style={shellStyle}>
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
            <nav aria-label="主导航">
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
          </NavMarkGroup>
          <div className={styles.railSpacer} />
          <IconButton
            label={`主题：${themeLabel}；切换为${nextThemeLabel}`}
            className={styles.railTheme}
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
              className={`${styles.railInstance} ${instanceSwitcherOpen ? styles.railInstanceOpen : ''}`}
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
          <PersistentExtensionClientProvider>
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
                  <Route path="users" element={<UsersPage />} />
                  <Route path="extensions" element={<ExtensionsPage />} />
                  <Route path="extensions/:extensionId" element={<ExtensionsPage />} />
                  <Route path="creator" element={<LegacyWorkRedirect kind="creator" />} />
                  <Route path="runtime" element={<RuntimeRedirect />} />
                  <Route path="settings" element={<SettingsPage />} />
                  <Route path="*" element={<NotFoundPage />} />
                </Route>
              </Routes>
            </Tooltip.Provider>
          </PersistentExtensionClientProvider>
        </DynamicClientProvider>
      </MotionRoot>
    </ProductErrorBoundary>
  )
}
