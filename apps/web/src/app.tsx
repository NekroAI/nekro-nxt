import { Bot, Boxes, Cable, MessageSquare, RefreshCw, Settings } from 'lucide-react'
import { Component, useEffect, useMemo, useState, type ErrorInfo, type ReactNode } from 'react'
import { Navigate, NavLink, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import styles from './app.module.css'
import { HostNotice, runHostRefresh } from './components/product-feedback.js'
import {
  AgentManagePage,
  AgentsPage,
  ChannelConversationPage,
  ConnectionsPage,
  CreatorPage,
  ExtensionsPage,
  RuntimePage,
  SettingsPage,
} from './pages/product-pages.js'
import { useProductStore, type ProductHostStatus } from './product-store.js'
import { Button, StatusBadge, Tooltip, type StatusTone } from './ui-kit/index.js'

const navigation = [
  { to: '/agents', label: '智能体', icon: Bot },
  { to: '/channels', label: '消息', icon: MessageSquare },
  { to: '/connections', label: '连接', icon: Cable },
  { to: '/extensions', label: '扩展', icon: Boxes },
  { to: '/settings', label: '设置', icon: Settings },
] as const

export const hostPresentation = (status: ProductHostStatus): { readonly label: string; readonly tone: StatusTone } => {
  if (status === 'initializing') return { label: '正在连接', tone: 'info' }
  if (status === 'ready') return { label: '运行正常', tone: 'success' }
  if (status === 'stale') return { label: '连接不稳定', tone: 'warning' }
  return { label: '无法连接', tone: 'error' }
}

function AppShell() {
  const location = useLocation()
  const host = useProductStore((state) => state.host)
  const status = hostPresentation(host.status)
  const [refreshPending, setRefreshPending] = useState(false)
  const [refreshError, setRefreshError] = useState('')
  const reconnect = async (): Promise<void> => {
    if (refreshPending) return
    await runHostRefresh(() => useProductStore.getState().refreshHost(), setRefreshPending, setRefreshError)
  }

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          <div className={styles.mark} aria-hidden="true" />
          <span className={styles.brandName}>NekroNxt</span>
        </div>
        <nav className={styles.nav} aria-label="主导航">
          {navigation.map(({ to, label, icon: Icon }) => (
            <NavLink
              to={to}
              className={({ isActive }) =>
                [styles.navLink, isActive ? styles.navLinkActive : ''].filter(Boolean).join(' ')
              }
              key={to}
            >
              <Icon size={16} strokeWidth={1.8} aria-hidden="true" />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className={styles.sidebarFooter}>
          <div className={styles.hostStatus}>
            <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
            {host.status === 'stale' || host.status === 'error' ? (
              <Button
                size="small"
                variant="ghost"
                aria-label="重新连接"
                loading={refreshPending}
                loadingLabel="连接中…"
                onClick={() => void reconnect()}
              >
                <RefreshCw size={14} aria-hidden="true" />
              </Button>
            ) : null}
          </div>
          {refreshError ? (
            <div className={styles.refreshError} role="alert">
              重新连接失败：{refreshError}
            </div>
          ) : null}
        </div>
      </aside>
      <main className={styles.main}>
        <HostNotice />
        <div className={styles.routeView} key={location.pathname.split('/')[1]}>
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
    if (theme === 'system') delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = theme
    document.documentElement.dataset.reducedMotion = String(reducedMotion)
  }, [theme, reducedMotion])
  return null
}

function NotFoundPage() {
  return (
    <div className={styles.centeredState}>
      <div>
        <h1>页面不存在</h1>
        <p>这个入口已被移除，或对应内容不再可用。</p>
        <Button variant="primary" onClick={() => window.location.assign('/agents')}>
          返回智能体
        </Button>
      </div>
    </div>
  )
}

interface ProductErrorBoundaryState {
  readonly failed: boolean
}

class ProductErrorBoundary extends Component<{ readonly children: ReactNode }, ProductErrorBoundaryState> {
  state: ProductErrorBoundaryState = { failed: false }

  static getDerivedStateFromError(): ProductErrorBoundaryState {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[nekro-nxt] 产品界面渲染失败', error, info)
  }

  render(): ReactNode {
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
      <Tooltip.Provider {...tooltipProps}>
        <ThemeEffects />
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<Navigate to="/agents" replace />} />
            <Route path="agents" element={<AgentsPage />} />
            <Route path="agents/:agentId" element={<AgentManagePage />} />
            <Route path="channels" element={<ChannelConversationPage />} />
            <Route path="channels/:channelId" element={<ChannelConversationPage />} />
            <Route path="connections" element={<ConnectionsPage />} />
            <Route path="extensions" element={<ExtensionsPage />} />
            <Route path="creator" element={<CreatorPage />} />
            <Route path="runtime" element={<RuntimePage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </Tooltip.Provider>
    </ProductErrorBoundary>
  )
}
