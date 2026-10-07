import { useGo } from '../model/nav.js'
import { ReleaseBanner } from '../system/compatibility.js'
import {
  Activity,
  Bell,
  Cable,
  LockOpen,
  MessagesSquare,
  Search,
  Server,
  Settings,
  Sparkles,
  Wrench,
} from 'lucide-react'
import { browserInstanceName, isUnencryptedRemoteConnection } from '../../management-access.js'
import { useEffect, useRef, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { useDesktopInstance, type DesktopInstanceStatus } from '../../desktop-shell.js'
import { useProductStore, type ProductHostStatus } from '../../product-runtime.js'
import { Kbd, Popover, StatusDot, useIndicator, type Tone, cssVars, Pressable } from '../../ui-kit/index.js'
import { AttentionList } from '../attention/attention-list.js'
import { useAttention } from '../model/attention.js'
import { connectionStatus } from '../model/connection-status.js'
import { agentAccent, connectionLabel, isAgentWorking } from '../model/identity.js'
import { CommandPalette } from './command-palette.js'
import { useCurrentCrumb } from './crumb.js'
import styles from './shell.module.css'

export const SPACES = [
  { path: '/live', label: '概览', icon: Activity },
  { path: '/channels', label: '频道', icon: MessagesSquare },
  { path: '/agents', label: '智能体', icon: Sparkles },
  { path: '/workshop', label: '工坊', icon: Wrench },
  { path: '/wiring', label: '接线', icon: Cable },
] as const

const spaceOf = (pathname: string): string => `/${pathname.split('/')[1] ?? ''}`

const hostTone: Record<ProductHostStatus, Tone> = { ready: 'ok', initializing: 'warn', stale: 'warn', error: 'bad' }
const hostLabel: Record<ProductHostStatus, string> = {
  ready: '运行正常',
  initializing: '正在连接',
  stale: '连接不稳定',
  error: '无法连接',
}

function Rail() {
  const location = useLocation()
  const space = spaceOf(location.pathname)
  const ref = useRef<HTMLElement>(null)
  const { geometry, ready } = useIndicator(ref, '[aria-current="page"]', space)
  return (
    <nav ref={ref} className={styles.rail} aria-label="主导航">
      <span
        className={[styles.railIndicator, ready ? styles.railIndicatorReady : ''].join(' ')}
        style={{
          opacity: geometry.visible ? 1 : 0,
          width: geometry.width,
          height: geometry.height,
          transform: `translate(${geometry.x}px, ${geometry.y}px)`,
        }}
        aria-hidden="true"
      />
      {SPACES.map(({ path, label, icon: Icon }) => (
        <NavLink key={path} to={path} className={styles.railItem} aria-current={space === path ? 'page' : undefined}>
          <Icon aria-hidden="true" strokeWidth={1.7} />
          <span>{label}</span>
        </NavLink>
      ))}
      <span className={styles.railSpacer} />
      <NavLink to="/settings" className={styles.railItem} aria-current={space === '/settings' ? 'page' : undefined}>
        <Settings aria-hidden="true" strokeWidth={1.7} />
        <span>设置</span>
      </NavLink>
    </nav>
  )
}

const desktopStatusLabel: Record<DesktopInstanceStatus, string> = {
  ready: '运行正常',
  connecting: '正在连接',
  unstable: '连接不稳定',
  'authentication-required': '需要重新认证',
  incompatible: '版本不兼容',
  offline: '无法连接',
}

function TopBar({ onSearch }: { readonly onSearch: () => void }) {
  const crumb = useCurrentCrumb()
  const location = useLocation()
  const attention = useAttention()
  const [bellOpen, setBellOpen] = useState(false)
  const desktop = useDesktopInstance()
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const hostStatus = useProductStore((state) => state.host.status)
  const instanceTone: Tone = desktop.enabled
    ? desktop.presentation.status === 'ready'
      ? 'ok'
      : desktop.presentation.status === 'connecting' || desktop.presentation.status === 'unstable'
        ? 'warn'
        : 'bad'
    : hostTone[hostStatus]
  const instance = (
    <>
      <Server aria-hidden="true" />
      <span>{desktop.enabled ? desktop.presentation.displayName : browserInstanceName()}</span>
      {!desktop.enabled && hostStatus !== 'ready' ? (
        <span className={styles.instanceState}>{hostLabel[hostStatus]}</span>
      ) : null}
      <StatusDot tone={instanceTone} />
    </>
  )
  return (
    <header className={styles.top}>
      <div className={styles.brand}>
        <img src="/brand/mark.svg" alt="" />
        NekroNXT
      </div>
      {desktop.enabled ? (
        <Pressable
          type="button"
          className={styles.instance}
          data-desktop-instance-switcher=""
          aria-expanded={switcherOpen}
          aria-label={`管理并添加远程服务实例：${desktop.presentation.displayName} · ${desktopStatusLabel[desktop.presentation.status]}`}
          onClick={() => {
            if (switcherOpen) {
              setSwitcherOpen(false)
              void window.nekroDesktopShell?.closeInstanceSwitcher()
              return
            }
            setSwitcherOpen(true)
            void window.nekroDesktopShell?.openInstanceSwitcher().finally(() => setSwitcherOpen(false))
          }}
        >
          {instance}
        </Pressable>
      ) : (
        <Link to="/settings/about" className={styles.instance} aria-label={`服务状态：本机 · ${hostLabel[hostStatus]}`}>
          {instance}
        </Link>
      )}
      {/* Where you are, as text: the rail is the way between spaces, so the path does not navigate. */}
      <div className={styles.crumb} role="group" aria-label="位置">
        {crumb.length > 1
          ? crumb.map((part, index) => (
              <span key={`${index}:${part}`} className={styles.crumbPart}>
                {index > 0 ? <span className={styles.crumbSep}>/</span> : null}
                {index === crumb.length - 1 ? <b aria-current="page">{part}</b> : <span>{part}</span>}
              </span>
            ))
          : null}
      </div>
      <Pressable type="button" className={styles.search} onClick={onSearch} aria-label="搜索">
        <Search aria-hidden="true" />
        <span>搜索</span>
        <Kbd>⌘K</Kbd>
      </Pressable>
      <Popover
        label="需要关注"
        open={bellOpen}
        onOpenChange={setBellOpen}
        className={styles.bellPanel}
        trigger={
          <Pressable
            type="button"
            className={styles.bell}
            aria-label={attention.length ? `${attention.length} 项需要关注` : '没有需要关注的事项'}
          >
            <Bell aria-hidden="true" strokeWidth={1.7} />
            {attention.length ? <span className={styles.bellCount}>{attention.length}</span> : null}
          </Pressable>
        }
      >
        <div className={styles.bellHead}>
          <b>需要关注</b>
          {location.pathname !== '/live' ? (
            <Link to="/live" className={styles.bellMore} onClick={() => setBellOpen(false)}>
              打开概览
            </Link>
          ) : null}
        </div>
        <AttentionList compact onAction={() => setBellOpen(false)} />
      </Popover>
    </header>
  )
}

function Clock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])
  return <span className={styles.statusClock}>{now.toLocaleTimeString('zh-CN', { hour12: false })}</span>
}

function StatusBar() {
  const navigate = useGo()
  const connections = useProductStore((state) => state.connections)
  const agents = useProductStore((state) => state.agents)
  const working = agents.filter(isAgentWorking)
  const external = connections.filter((connection) => connection.userManaged)
  return (
    <footer className={styles.status}>
      {external.map((connection) => {
        const status = connectionStatus(connection)
        return (
          <Pressable
            key={connection.id}
            type="button"
            className={styles.statusItem}
            title={status.reason ?? status.label}
            onClick={() => navigate(`/wiring/connections/${connection.id}`)}
          >
            <StatusDot tone={status.tone} pulse={status.health === 'connecting'} />
            {connectionLabel(connection)}
            {status.health === 'ok' ? '' : ` ${status.label}`}
          </Pressable>
        )
      })}
      {external.length && working.length ? <span className={styles.statusSep} /> : null}
      {working.map((agent) => (
        <Pressable
          key={agent.id}
          type="button"
          className={styles.statusItem}
          onClick={() => navigate(`/agents/${agent.id}`)}
        >
          <i className={styles.runDot} style={cssVars({ '--run-color': agentAccent(agent) })} />
          {agent.name}
        </Pressable>
      ))}
      {isUnencryptedRemoteConnection() ? (
        <Pressable
          type="button"
          className={[styles.statusItem, styles.statusInsecure].join(' ')}
          title="当前通过未加密的 HTTP 访问，管理密钥和登录状态可能在网络中被截获。公网访问请使用 HTTPS 或反向代理。"
          onClick={() => navigate('/settings/access')}
        >
          <LockOpen size={13} aria-hidden="true" />
          未加密连接
        </Pressable>
      ) : null}
      <Clock />
    </footer>
  )
}

export function AppShell() {
  const location = useLocation()
  const space = spaceOf(location.pathname)
  const [paletteOpen, setPaletteOpen] = useState(false)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen((open) => !open)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return (
    <div className={styles.app}>
      <TopBar onSearch={() => setPaletteOpen(true)} />
      <Rail />
      <main className={styles.main}>
        <ReleaseBanner />
        <div key={space} data-canvas="" className={[styles.canvas, styles.canvasEnter].join(' ')}>
          <Outlet />
        </div>
      </main>
      <StatusBar />
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  )
}
