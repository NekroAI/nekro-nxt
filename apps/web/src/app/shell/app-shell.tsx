import { useGo } from '../model/nav.js'
import { ReleaseBanner } from '../system/compatibility.js'
import {
  Activity,
  AppWindow,
  Bell,
  Cable,
  LockOpen,
  MessagesSquare,
  MoreHorizontal,
  Search,
  Server,
  Settings,
  ScrollText,
  Sparkles,
  Store,
  Wrench,
} from 'lucide-react'
import { browserInstanceName, isUnencryptedRemoteConnection } from '../../management-access.js'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { useDesktopInstance, type DesktopInstanceStatus } from '../../desktop-shell.js'
import { HOST_ICONS } from '../../extension-ui/icons.js'
import { useProductStore, type ProductHostStatus } from '../../product-runtime.js'
import { Kbd, Menu, Popover, StatusDot, useIndicator, type Tone, cssVars, Pressable } from '../../ui-kit/index.js'
import { AttentionList } from '../attention/attention-list.js'
import { useAttention } from '../model/attention.js'
import { connectionStatus } from '../model/connection-status.js'
import { agentAccent, connectionLabel, isAgentWorking } from '../model/identity.js'
import { CommandPalette } from './command-palette.js'
import { useCurrentCrumb } from './crumb.js'
import styles from './shell.module.css'
import { updateLabel, useProductUpdates, versionDescription, versionLabel } from './product-updates.js'

export const SPACES = [
  { path: '/live', label: '概览', icon: Activity },
  { path: '/channels', label: '频道', icon: MessagesSquare },
  { path: '/agents', label: '智能体', icon: Sparkles },
  { path: '/workshop', label: '工坊', icon: Wrench },
  { path: '/community', label: '社区', icon: Store },
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

/** Address of an extension page's own SVG icon, served by the Host after checking its digest. */
const pageSvgIconUrl = (page: {
  readonly icon: { readonly kind: string; readonly sha256?: string }
  readonly owner: { readonly kind: string; readonly extensionId?: string; readonly revisionId?: string }
}): string | undefined =>
  page.icon.kind === 'svg' &&
  page.icon.sha256 &&
  page.owner.kind === 'extension' &&
  page.owner.extensionId &&
  page.owner.revisionId
    ? `/api/extensions/${encodeURIComponent(page.owner.extensionId)}/revisions/${encodeURIComponent(page.owner.revisionId)}/host-ui/assets/${page.icon.sha256}.svg`
    : undefined

/** Extension pages that registered a rail entry (`rail` in the page contribution) and are not hidden by the user. */
function useRailPages() {
  const pages = useProductStore((state) => state.hostUi.pages)
  return pages
    .filter((page) => page.rail !== undefined && page.visible)
    .sort((a, b) => (a.rail?.order ?? 0) - (b.rail?.order ?? 0) || a.sortOrder - b.sortOrder)
}

type RailPage = ReturnType<typeof useRailPages>[number]

const NARROW = '(max-width: 760px)'
/** Spaces that stay in the bottom bar on a phone (05 §6.2); the rest open from its “更多”. */
const MOBILE_SPACES = new Set<string>(['/live', '/channels', '/agents', '/workshop'])

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia?.(NARROW).matches)
  useEffect(() => {
    if (!window.matchMedia) return
    const query = window.matchMedia(NARROW)
    const sync = () => setNarrow(query.matches)
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  }, [])
  return narrow
}

/**
 * How many extension pages fit between the built-in spaces and the bottom group (05 §6). The rail measures its own
 * free height; when not every page fits, one slot goes to “更多”.
 */
function useRailFit(ref: React.RefObject<HTMLElement | null>, count: number): number {
  const [fit, setFit] = useState(count)
  useLayoutEffect(() => {
    const rail = ref.current
    if (!rail) return
    const measure = () => {
      const item = rail.querySelector<HTMLElement>('[data-rail-space]')
      const spacer = rail.querySelector<HTMLElement>('[data-rail-spacer]')
      if (!item || !spacer) return
      const step = item.offsetHeight + 2
      const shown = rail.querySelectorAll('[data-extension-rail]').length
      const more = rail.querySelector('[data-rail-overflow]') ? 1 : 0
      // Free height if no extension page (and no “更多”) were shown.
      const free = spacer.offsetHeight + (shown + more) * step
      const all = Math.floor(free / step)
      setFit(all >= count ? count : Math.max(0, all - 1))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(rail)
    return () => observer.disconnect()
  }, [ref, count])
  return Math.min(fit, count)
}

function RailPageIcon({ page }: { readonly page: RailPage }) {
  const Icon = page.icon.kind === 'host-icon' ? HOST_ICONS[page.icon.name] : AppWindow
  const svg = pageSvgIconUrl(page)
  return svg === undefined ? (
    <Icon aria-hidden="true" strokeWidth={1.7} />
  ) : (
    // A mask keeps the extension's own icon in the rail's text colour in both themes.
    <span
      className={styles.railSvgIcon}
      style={{ maskImage: `url("${svg}")`, WebkitMaskImage: `url("${svg}")` }}
      aria-hidden="true"
    />
  )
}

const pagePath = (page: RailPage) => `${page.routeBase}${page.startPath ? `/${page.startPath}` : ''}`

function Rail() {
  const location = useLocation()
  const go = useGo()
  const narrow = useNarrow()
  const railPages = useRailPages()
  const activePage = railPages.find(
    (page) => location.pathname === page.routeBase || location.pathname.startsWith(`${page.routeBase}/`),
  )
  const space = activePage?.routeBase ?? spaceOf(location.pathname)
  const ref = useRef<HTMLElement>(null)
  const fit = useRailFit(ref, railPages.length)
  const shown = railPages.slice(0, fit)
  const overflow = railPages.slice(fit)
  // The “更多” that holds the current page carries the selection, so the indicator always has one target.
  const mobileMore = narrow && !MOBILE_SPACES.has(space)
  const desktopMore = !narrow && overflow.some((page) => page.routeBase === space)
  const { geometry, ready } = useIndicator(ref, '[aria-current="page"]', `${space}:${narrow}:${fit}`)
  const current = (path: string) => (space === path ? 'page' : undefined)
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
        <NavLink
          key={path}
          to={path}
          className={[styles.railItem, MOBILE_SPACES.has(path) ? '' : styles.railDesktopOnly].join(' ')}
          aria-current={narrow && !MOBILE_SPACES.has(path) ? undefined : current(path)}
          data-rail-space=""
        >
          <Icon aria-hidden="true" strokeWidth={1.7} />
          <span>{label}</span>
        </NavLink>
      ))}
      {railPages.length > 0 ? <span className={styles.railDivider} aria-hidden="true" /> : null}
      {shown.map((page) => (
        <NavLink
          key={page.pageInstanceId}
          to={pagePath(page)}
          className={[styles.railItem, styles.railExtension].join(' ')}
          aria-current={narrow ? undefined : current(page.routeBase)}
          title={page.title}
          data-extension-rail=""
        >
          <RailPageIcon page={page} />
          <span>{page.title}</span>
        </NavLink>
      ))}
      {overflow.length > 0 ? (
        <Menu
          label="更多扩展页面"
          align="start"
          trigger={
            <Pressable
              className={[styles.railItem, styles.railExtension].join(' ')}
              aria-current={desktopMore ? 'page' : undefined}
              data-rail-overflow=""
            >
              <MoreHorizontal aria-hidden="true" strokeWidth={1.7} />
              <span>更多</span>
            </Pressable>
          }
          items={overflow.map((page) => ({
            key: page.pageInstanceId,
            label: page.title,
            icon: <RailPageIcon page={page} />,
            onSelect: () => go(pagePath(page)),
          }))}
        />
      ) : null}
      <span className={styles.railSpacer} data-rail-spacer="" />
      <NavLink
        to="/logs"
        className={[styles.railItem, styles.railDesktopOnly].join(' ')}
        aria-current={narrow ? undefined : current('/logs')}
      >
        <ScrollText aria-hidden="true" strokeWidth={1.7} />
        <span>日志</span>
      </NavLink>
      <NavLink
        to="/settings"
        className={[styles.railItem, styles.railDesktopOnly].join(' ')}
        aria-current={narrow ? undefined : current('/settings')}
      >
        <Settings aria-hidden="true" strokeWidth={1.7} />
        <span>设置</span>
      </NavLink>
      <Menu
        label="更多"
        trigger={
          <Pressable
            className={[styles.railItem, styles.railMobileOnly].join(' ')}
            aria-current={mobileMore ? 'page' : undefined}
          >
            <MoreHorizontal aria-hidden="true" strokeWidth={1.7} />
            <span>更多</span>
          </Pressable>
        }
        items={[
          ...SPACES.filter(({ path }) => !MOBILE_SPACES.has(path)).map(({ path, label, icon: Icon }) => ({
            key: path,
            label,
            icon: <Icon size={16} aria-hidden="true" />,
            onSelect: () => go(path),
          })),
          ...(railPages.length > 0 ? [{ heading: '扩展页面' } as const] : []),
          ...railPages.map((page) => ({
            key: page.pageInstanceId,
            label: page.title,
            icon: <RailPageIcon page={page} />,
            onSelect: () => go(pagePath(page)),
          })),
          'separator' as const,
          {
            key: '/logs',
            label: '日志',
            icon: <ScrollText size={16} aria-hidden="true" />,
            onSelect: () => go('/logs'),
          },
          {
            key: '/settings',
            label: '设置',
            icon: <Settings size={16} aria-hidden="true" />,
            onSelect: () => go('/settings'),
          },
        ]}
      />
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
          onClick={(event) => {
            if (switcherOpen) {
              setSwitcherOpen(false)
              void window.nekroDesktopShell?.closeInstanceSwitcher()
              return
            }
            setSwitcherOpen(true)
            // 选择器贴着这个按钮弹出；按钮在顶栏中的位置随平台的窗口按钮而变。
            const left = event.currentTarget.getBoundingClientRect().left
            void window.nekroDesktopShell?.openInstanceSwitcher({ left }).finally(() => setSwitcherOpen(false))
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

/** The host's version at the right of the status bar; a newer release turns it into a link to the release page. */
function VersionStatus() {
  const navigate = useGo()
  const { status } = useProductUpdates()
  if (status === undefined) return null
  const checked =
    status.checkedAt === undefined
      ? ''
      : ` · ${new Date(status.checkedAt).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 检查`
  if (status.state === 'available' && status.latest !== undefined) {
    return (
      <a
        className={[styles.statusItem, styles.statusVersion, styles.statusUpdate].join(' ')}
        href={status.latest.url}
        target="_blank"
        rel="noreferrer"
        title={`当前 ${versionDescription(status)}，最新 ${status.latest.version}。点击查看更新内容${checked}`}
      >
        <i className={styles.updateDot} aria-hidden="true" />
        {updateLabel(status)}
      </a>
    )
  }
  return (
    <Pressable
      type="button"
      className={[styles.statusItem, styles.statusVersion].join(' ')}
      title={`${versionDescription(status)}${status.state === 'failed' ? ' · 检查更新失败' : status.state === 'up-to-date' ? ' · 已是最新' : ''}${checked}`}
      onClick={() => navigate('/settings/about')}
    >
      {versionLabel(status)}
    </Pressable>
  )
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
      <VersionStatus />
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
