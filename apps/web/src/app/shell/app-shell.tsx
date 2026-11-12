import { useGo } from '../model/nav.js'
import { ReleaseBanner } from '../system/compatibility.js'
import {
  Activity,
  AppWindow,
  Bell,
  Cable,
  ArrowLeftRight,
  ChevronLeft,
  CircleHelp,
  LockOpen,
  Menu as MenuIcon,
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
import { inAndroidShell, postToAndroidShell } from '../../android-shell.js'
import { browserInstanceName, isUnencryptedRemoteConnection } from '../../management-access.js'
import { Suspense, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { useDesktopInstance, type DesktopInstanceStatus } from '../../desktop-shell.js'
import { HOST_ICONS } from '../../extension-ui/icons.js'
import { useProductStore, type ProductHostStatus } from '../../product-runtime.js'
import {
  Kbd,
  Menu,
  Popover,
  SidePanel,
  Skeleton,
  StatusDot,
  type Tone,
  cssVars,
  Pressable,
  usePhone,
} from '../../ui-kit/index.js'
import { removeBootSplash } from '../../boot-splash.js'
import { AttentionList } from '../attention/attention-list.js'
import { bellStore, useBell } from '../attention/bell.js'
import { useAttention } from '../model/attention.js'
import { connectionStatus } from '../model/connection-status.js'
import { agentAccent, connectionLabel, isAgentWorking } from '../model/identity.js'
import { CommandPalette } from './command-palette.js'
import { HomeScreenHint, HomeScreenMenuItem } from './home-screen.js'
import { useBackTo, useHistoryTrail } from './back.js'
import { useCurrentCrumb, useCurrentPageBar, usePageBarActionsSlot } from './crumb.js'
import { useRailSteering } from './rail-steering.js'
import { useSwitchTab, useTabHistory } from './tab-history.js'
import styles from './shell.module.css'
import type { ProductUpdateStatus } from '@nekro-nxt/contracts'
import { docsHelpHref } from './docs-help.js'
import { updateLabel, useProductUpdates, versionDescription, versionLabel } from './product-updates.js'

export const SPACES = [
  { path: '/live', label: '概览', icon: Activity, motion: 'pulse' },
  { path: '/channels', label: '频道', icon: MessagesSquare, motion: 'tilt' },
  { path: '/agents', label: '智能体', icon: Sparkles, motion: 'twinkle' },
  { path: '/workshop', label: '工坊', icon: Wrench, motion: 'turn' },
  { path: '/community', label: '社区', icon: Store, motion: 'hop' },
  { path: '/wiring', label: '接线', icon: Cable, motion: 'sway' },
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

/** Spaces in the bottom bar on a phone (05 §6.2); every page, these included, opens from the menu in the top bar. */
const MOBILE_SPACES = new Set<string>(['/live', '/channels', '/agents', '/workshop', '/settings'])

/** Names of the first-level spaces, as the navigation shows them; the phone's top bar titles their pages with these. */
const SPACE_TITLES = new Map<string, string>([
  ...SPACES.map(({ path, label }) => [path, label] as const),
  ['/logs', '日志'],
  ['/settings', '设置'],
])

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
  const narrow = usePhone()
  const railPages = useRailPages()
  const space = useCurrentPlace()
  const ref = useRef<HTMLElement>(null)
  const fit = useRailFit(ref, railPages.length)
  const shown = railPages.slice(0, fit)
  const overflow = railPages.slice(fit)
  const desktopMore = !narrow && overflow.some((page) => page.routeBase === space)
  const indicator = useRef<HTMLSpanElement>(null)
  // A phone's bottom bar switches between sibling tabs without adding history (05 §6.2); a computer's rail pushes.
  const switchTab = useSwitchTab()
  const openPath = (href: string) => (narrow ? switchTab(href) : go(href))
  const onLinkClick = (href: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (!narrow || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    switchTab(href)
  }
  const steering = useRailSteering({
    nav: ref,
    indicator,
    selectionKey: `${location.key}:${space}:${narrow}:${fit}`,
    layoutKey: `${narrow}:${fit}:${railPages.length}`,
    draggable: narrow,
    onRelease: (item) => {
      const href = item.getAttribute('href')
      if (href) openPath(href)
    },
  })
  const current = (path: string) => (space === path ? 'page' : undefined)
  // Entries hidden from the phone's bar say `false`: left undefined, NavLink would mark the active one itself and the
  // selection would sit on an invisible item. A page the bar does not hold (日志, 接线) selects nothing there.
  return (
    <nav ref={ref} className={styles.rail} aria-label="主导航" {...steering}>
      <span ref={indicator} className={styles.railIndicator} aria-hidden="true" />
      {SPACES.map(({ path, label, icon: Icon, motion }) => (
        <NavLink
          key={path}
          to={path}
          onClick={onLinkClick(path)}
          className={[styles.railItem, MOBILE_SPACES.has(path) ? '' : styles.railDesktopOnly].join(' ')}
          aria-current={narrow && !MOBILE_SPACES.has(path) ? false : current(path)}
          data-rail-space=""
          data-rail-item="link"
          data-motion={motion}
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
          onClick={onLinkClick(pagePath(page))}
          className={[styles.railItem, styles.railExtension].join(' ')}
          aria-current={narrow ? false : current(page.routeBase)}
          title={page.title}
          data-extension-rail=""
          data-rail-item="link"
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
        onClick={onLinkClick('/logs')}
        className={[styles.railItem, styles.railDesktopOnly].join(' ')}
        aria-current={narrow ? false : current('/logs')}
        data-motion="hop"
        data-rail-item="link"
      >
        <ScrollText aria-hidden="true" strokeWidth={1.7} />
        <span>日志</span>
      </NavLink>
      <NavLink
        to="/settings"
        onClick={onLinkClick('/settings')}
        className={styles.railItem}
        aria-current={current('/settings')}
        data-motion="gear"
        data-rail-item="link"
      >
        <Settings aria-hidden="true" strokeWidth={1.7} />
        <span>设置</span>
      </NavLink>
    </nav>
  )
}

/** The space or extension page the address shows, as the navigation marks it. */
function useCurrentPlace(): string {
  const location = useLocation()
  const railPages = useRailPages()
  const activePage = railPages.find(
    (page) => location.pathname === page.routeBase || location.pathname.startsWith(`${page.routeBase}/`),
  )
  return activePage?.routeBase ?? spaceOf(location.pathname)
}

/**
 * The phone's menu of every page (05 §6.2), opened from the top bar of a first-level page: the spaces, the extension
 * pages, then 日志 and 设置. Choosing one switches to it as the bottom bar does, without adding history.
 */
function SideMenu({
  open,
  onOpenChange,
  opener,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly opener: React.RefObject<HTMLElement | null>
}) {
  const place = useCurrentPlace()
  const railPages = useRailPages()
  const switchTab = useSwitchTab()
  const desktop = useDesktopInstance()
  const entry = (key: string, href: string, label: string, icon: React.ReactNode, base = href) => (
    <Link
      key={key}
      to={href}
      className={styles.menuItem}
      aria-current={place === base ? 'page' : undefined}
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        event.preventDefault()
        onOpenChange(false)
        if (place !== base) switchTab(href)
      }}
    >
      {icon}
      <span>{label}</span>
    </Link>
  )
  return (
    <SidePanel open={open} onOpenChange={onOpenChange} label="菜单" opener={opener}>
      <div className={styles.menuHead}>
        <img src="/brand/mark.svg" alt="" />
        <div className={styles.menuBrand}>
          <b>NekroNXT</b>
          <span>{desktop.enabled ? desktop.presentation.displayName : browserInstanceName()}</span>
        </div>
      </div>
      <nav className={styles.menuList} aria-label="全部页面">
        {SPACES.map(({ path, label, icon: Icon }) =>
          entry(path, path, label, <Icon aria-hidden="true" strokeWidth={1.7} />),
        )}
        {railPages.length > 0 ? (
          <>
            <span className={styles.menuHeading}>扩展页面</span>
            {railPages.map((page) =>
              entry(page.pageInstanceId, pagePath(page), page.title, <RailPageIcon page={page} />, page.routeBase),
            )}
          </>
        ) : null}
        <span className={styles.menuDivider} aria-hidden="true" />
        {entry('/logs', '/logs', '日志', <ScrollText aria-hidden="true" strokeWidth={1.7} />)}
        {entry('/settings', '/settings', '设置', <Settings aria-hidden="true" strokeWidth={1.7} />)}
        {inAndroidShell() ? (
          // The page knows only its own instance; the Android app keeps the others and switches between them.
          <Pressable
            className={styles.menuItem}
            onClick={() => {
              onOpenChange(false)
              postToAndroidShell({ type: 'switch-instance' })
            }}
          >
            <ArrowLeftRight aria-hidden="true" strokeWidth={1.7} />
            <span>切换实例</span>
          </Pressable>
        ) : null}
        <HomeScreenMenuItem onChosen={() => onOpenChange(false)} />
      </nav>
    </SidePanel>
  )
}

/** Counts up each time `count` grows, so the bell swings once per new item and stays still on first load. */
function useRingOnIncrease(count: number): number {
  const previous = useRef(count)
  const [ring, setRing] = useState(0)
  useEffect(() => {
    if (count > previous.current) setRing((value) => value + 1)
    previous.current = count
  }, [count])
  return ring
}

const desktopStatusLabel: Record<DesktopInstanceStatus, string> = {
  ready: '运行正常',
  connecting: '正在连接',
  unstable: '连接不稳定',
  'authentication-required': '需要重新认证',
  incompatible: '版本不兼容',
  offline: '无法连接',
}

/**
 * The phone's top bar is the page's title bar (05 §6.2): a first-level page shows its space's name, a page opened from
 * a list shows a back arrow to it and its own name, with an optional status line under the name.
 */
function PhoneTitle({
  menu,
}: {
  /** The menu button of a first-level page; a page opened from a list or a mode has none. */
  readonly menu?: { readonly ref: React.RefObject<HTMLButtonElement>; readonly onOpen: () => void } | undefined
}) {
  const location = useLocation()
  const crumb = useCurrentCrumb()
  const bar = useCurrentPageBar()
  const back = useBackTo()
  const title = bar?.title ?? SPACE_TITLES.get(spaceOf(location.pathname)) ?? crumb.at(-1) ?? 'NekroNXT'
  const status = bar?.status
  return (
    <div className={styles.barTitle}>
      {bar?.back ? (
        <Pressable
          type="button"
          className={styles.barBack}
          aria-label={bar.back.label}
          onClick={() => bar.back && back(bar.back.to)}
        >
          <ChevronLeft aria-hidden="true" strokeWidth={2} />
        </Pressable>
      ) : menu ? (
        <Pressable ref={menu.ref} type="button" className={styles.barMenu} aria-label="菜单" onClick={menu.onOpen}>
          <MenuIcon aria-hidden="true" strokeWidth={1.8} />
        </Pressable>
      ) : null}
      {/* A new title fades in on its own; the bar around it never moves. */}
      <div key={`${bar?.back ? 'item' : 'space'}:${title}`} className={styles.barText}>
        <span className={styles.barName}>{title}</span>
        {status ? (
          <span className={styles.barStatus}>
            <StatusDot tone={status.tone} />
            <span>
              {status.label}
              {status.detail ? ` · ${status.detail}` : ''}
            </span>
          </span>
        ) : null}
      </div>
    </div>
  )
}

function TopBar({
  onSearch,
  release,
}: {
  readonly onSearch: () => void
  readonly release: ProductUpdateStatus | undefined
}) {
  const { pathname } = useLocation()
  const phone = usePhone()
  const bar = useCurrentPageBar()
  const setActions = usePageBarActionsSlot()
  const crumb = useCurrentCrumb()
  const attention = useAttention()
  const bell = useBell()
  const setBellOpen = bellStore.setOpen
  const ring = useRingOnIncrease(attention.length)
  const desktop = useDesktopInstance()
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuButton = useRef<HTMLButtonElement>(null)
  // Widened past the phone layout (a rotated tablet), the menu has nothing left to open from.
  if (menuOpen && !phone) setMenuOpen(false)
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
  // A page opened from a list, or in a mode, puts its own actions where the instance, search and bell sit on a
  // first-level page; a first-level page puts them before those.
  const phoneBar = bar?.back ? 'item' : bar?.mode ? 'mode' : 'space'
  const sideMenu = phone ? <SideMenu open={menuOpen} onOpenChange={setMenuOpen} opener={menuButton} /> : null
  if (phone && phoneBar !== 'space')
    return (
      <>
        <header className={styles.top} data-phone-bar={phoneBar}>
          <PhoneTitle />
          <div ref={setActions} className={styles.barActions} />
        </header>
        {sideMenu}
      </>
    )
  return (
    <>
      <header className={styles.top} data-phone-bar={phone ? 'space' : undefined}>
        {phone ? (
          <>
            <PhoneTitle menu={{ ref: menuButton, onOpen: () => setMenuOpen(true) }} />
            <div ref={setActions} className={styles.barActions} />
          </>
        ) : (
          <div className={styles.brand}>
            <img src="/brand/mark.svg" alt="" />
            NekroNXT
          </div>
        )}
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
          <Link
            to="/settings/about"
            className={styles.instance}
            aria-label={`服务状态：本机 · ${hostLabel[hostStatus]}`}
          >
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
        <a
          className={styles.bell}
          href={docsHelpHref(pathname, release?.channel)}
          target="_blank"
          rel="noreferrer"
          aria-label="使用文档"
          title="打开这一页的使用文档"
        >
          <CircleHelp aria-hidden="true" strokeWidth={1.7} />
        </a>
        <Popover
          label="需要关注"
          open={bell.open}
          onOpenChange={setBellOpen}
          className={styles.bellPanel}
          trigger={
            <Pressable
              type="button"
              className={styles.bell}
              aria-label={attention.length ? `${attention.length} 项需要关注` : '没有需要关注的事项'}
            >
              <span key={ring} className={ring > 0 ? styles.bellRing : undefined}>
                <Bell aria-hidden="true" strokeWidth={1.7} />
              </span>
              {attention.length ? <span className={styles.bellCount}>{attention.length}</span> : null}
            </Pressable>
          }
        >
          <div className={styles.bellHead}>
            <b>需要关注</b>
          </div>
          <AttentionList
            docsChannel={release?.channel}
            compact
            focus={bell.focus}
            onClearFocus={bellStore.clearFocus}
            onAction={() => setBellOpen(false)}
          />
        </Popover>
      </header>
      {sideMenu}
    </>
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
function VersionStatus({ status }: { readonly status: ProductUpdateStatus | undefined }) {
  const navigate = useGo()
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

function StatusBar({ release }: { readonly release: ProductUpdateStatus | undefined }) {
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
      <VersionStatus status={release} />
      <Clock />
    </footer>
  )
}

function SpaceLoading() {
  return (
    <div data-canvas="" className={styles.canvas}>
      <div style={{ display: 'grid', gap: 12, padding: 32, maxWidth: 720 }}>
        <Skeleton width="40%" height={24} />
        <Skeleton height={14} />
        <Skeleton width="70%" height={14} />
      </div>
    </div>
  )
}

export function AppShell() {
  const location = useLocation()
  const space = spaceOf(location.pathname)
  const phone = usePhone()
  const bar = useCurrentPageBar()
  const immersive = phone && bar?.immersive === true
  // Leaving a full-height page, the bottom bar slides back at once but the page keeps its height until the page
  // sliding away has gone, so its composer never jumps up mid-move.
  const [wasImmersive, setWasImmersive] = useState(immersive)
  const [lingering, setLingering] = useState(false)
  if (wasImmersive !== immersive) {
    setWasImmersive(immersive)
    setLingering(!immersive)
  }
  useEffect(() => {
    if (!lingering) return
    const timer = window.setTimeout(() => setLingering(false), 400)
    return () => window.clearTimeout(timer)
  }, [lingering])
  useHistoryTrail()
  useTabHistory()
  const [paletteOpen, setPaletteOpen] = useState(false)
  // One read of the host's release serves the status bar's version and the help button's documentation channel.
  const { status: release } = useProductUpdates()
  useEffect(() => {
    removeBootSplash()
  }, [])
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
    <div className={styles.app} data-immersive={immersive || undefined} data-tall={immersive || lingering || undefined}>
      <TopBar onSearch={() => setPaletteOpen(true)} release={release} />
      <Rail />
      <main className={styles.main}>
        <ReleaseBanner />
        <HomeScreenHint />
        {/*
          Route changes render as transitions, and a boundary that already shows a page keeps it while the next space
          loads; a boundary inside each space would flash its placeholder instead.
        */}
        <Suspense fallback={<SpaceLoading />}>
          <div key={space} data-canvas="" className={[styles.canvas, styles.canvasEnter].join(' ')}>
            <Outlet />
          </div>
        </Suspense>
      </main>
      <StatusBar release={release} />
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  )
}
