import { Boxes, Cable, MessageSquare, RefreshCw, Settings } from 'lucide-react'
import { Component, useEffect, useMemo, useState, type ErrorInfo, type ReactNode } from 'react'
import { Navigate, NavLink, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import styles from './app.module.css'
import { NotificationCenter, notify } from './components/notifications.js'
import { EmptyState, HostNotice, runHostRefresh } from './components/product-feedback.js'
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
import { Button, Tooltip, type StatusTone } from './ui-kit/index.js'

const modes = [
  { to: '/channels', label: '工作', icon: MessageSquare, work: true },
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

function HomeIndex() {
  const host = useProductStore((state) => state.host)
  const channels = useProductStore((state) => state.channels)
  const agents = useProductStore((state) => state.agents)
  if (host.status === 'initializing' && channels.length === 0 && agents.length === 0) {
    return (
      <div className={styles.centeredState}>
        <EmptyState loading title="正在读取" description="连接完成后会打开最近使用的频道。" />
      </div>
    )
  }
  return <Navigate to={workHomePath({ channels, agents })} replace />
}

function RuntimeRedirect() {
  const host = useProductStore((state) => state.host)
  const channels = useProductStore((state) => state.channels)
  const agents = useProductStore((state) => state.agents)
  if (host.status === 'initializing' && channels.length === 0 && agents.length === 0) {
    return (
      <div className={styles.centeredState}>
        <EmptyState loading title="正在读取" description="连接完成后会打开最近使用的频道。" />
      </div>
    )
  }
  return <Navigate to={workHomePath({ channels, agents })} replace />
}

function AppShell() {
  const location = useLocation()
  const host = useProductStore((state) => state.host)
  const channels = useProductStore((state) => state.channels)
  const agents = useProductStore((state) => state.agents)
  const status = hostPresentation(host.status)
  const [refreshPending, setRefreshPending] = useState(false)
  const workTo = workHomePath({ channels, agents })
  const reconnect = async (): Promise<void> => {
    if (refreshPending) return
    await runHostRefresh(
      () => useProductStore.getState().refreshHost(),
      setRefreshPending,
      (message) => {
        if (message) notify(`重新连接失败：${message}`, 'error', 'host-reconnect')
      },
    )
  }

  return (
    <div className={styles.shell}>
      <aside className={styles.rail} aria-label="模式">
        <div className={styles.mark} aria-hidden="true" />
        <nav aria-label="主导航">
          {modes.map(({ to, label, icon: Icon, work }) => (
            <NavLink
              to={work ? workTo : to}
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
        <div className={styles.railHost}>
          {host.status === 'stale' || host.status === 'error' ? (
            <Button
              size="small"
              variant="ghost"
              aria-label={`重新连接（${status.label}）`}
              loading={refreshPending}
              loadingLabel="连接中…"
              onClick={() => void reconnect()}
            >
              <RefreshCw size={14} aria-hidden="true" />
            </Button>
          ) : (
            <span className={styles.railHostDot} data-tone={status.tone} title={status.label} />
          )}
        </div>
      </aside>
      <aside className={styles.tree}>
        <ObjectPane />
      </aside>
      <main className={styles.stage}>
        <NotificationCenter />
        <HostNotice />
        <div className={styles.stageView}>
          <Outlet />
        </div>
      </main>
    </div>
  )
}

function ThemeEffects() {
  const theme = useProductStore((state) => state.theme)
  const reducedMotion = useProductStore((state) => state.reducedMotion)

  useEffect(() => {
    if (theme === 'system') delete document.documentElement.dataset['theme']
    else document.documentElement.dataset['theme'] = theme
    document.documentElement.dataset['reducedMotion'] = String(reducedMotion)
  }, [theme, reducedMotion])
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
            <Route element={<AppShell />}>
              <Route index element={<HomeIndex />} />
              <Route path="agents" element={<AgentsPage />} />
              <Route path="agents/:agentId" element={<AgentManagePage />} />
              <Route path="channels" element={<ChannelConversationPage />} />
              <Route path="channels/:channelId" element={<ChannelConversationPage />} />
              <Route path="connections" element={<ConnectionsPage />} />
              <Route path="connections/:connectionId" element={<ConnectionsPage />} />
              <Route path="extensions" element={<ExtensionsPage />} />
              <Route path="extensions/:extensionId" element={<ExtensionsPage />} />
              <Route path="creator" element={<CreatorPage />} />
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
