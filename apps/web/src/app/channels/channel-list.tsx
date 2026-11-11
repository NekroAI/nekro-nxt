import { useGo } from '../model/nav.js'
import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  createContext,
  Fragment,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from 'react'
import { Link } from 'react-router-dom'
import {
  agentSortId,
  applyWorkTreeDragResolution,
  arrayMoveIds,
  buildWorkTree,
  channelSortId,
  parsePrefixedId,
  pickWorkTreeCollision,
  resolveWorkTreeDragEnd,
  AGENT_SORT_PREFIX,
  CHANNEL_SORT_PREFIX,
  UNBOUND_DROP_ID,
  type WorkTreeDragLists,
  type WorkTreeDragResolution,
} from '../model/work-tree-order.js'
import {
  connectionDisplayName,
  useProductStore,
  type AgentSummary,
  type ChannelSummary,
  type ConnectionSummary,
  type ConversationMessage,
} from '../../product-runtime.js'
import {
  ArrowDown,
  ArrowRightLeft,
  ArrowUp,
  ArrowUpDown,
  Check,
  ChevronDown,
  MoreHorizontal,
  Pin,
  PinOff,
  Plus,
  Unplug,
} from 'lucide-react'
import {
  ActionSheet,
  AgentAvatar,
  Button,
  Dialog,
  Field,
  IconButton,
  Input,
  ListPane,
  MemberAvatar,
  SearchField,
  Menu,
  Select,
  SelectionList,
  toast,
  cssVars,
  Pressable,
  usePhone,
  type ActionSheetEntry,
  type ActionSheetLift,
} from '../../ui-kit/index.js'
import { useAttention } from '../model/attention.js'
import { agentAccent, agentHue, agentPhase, isAgentWorking } from '../model/identity.js'
import { BindDialog, type BindIntent } from './bind-dialog.js'
import { useProductApi } from '../model/store.js'
import { SubConversationRows } from './sub-conversation-rows.js'
import { useLongPress } from './long-press.js'
import {
  agentRowKey,
  channelRowKey,
  restoreAnchor,
  rowAnchor,
  SortModeList,
  useChannelSorting,
  type RowAnchor,
} from './channel-sort.js'
import {
  UNBOUND_GROUP_ID,
  keepHiddenSlots,
  movePinnedChannel,
  pinChannel,
  toggleGroupCollapsed,
  unpinChannel,
  type ChannelListView,
} from '../model/channel-list-view.js'
import styles from './channels.module.css'
import { relativeTime } from './timeline-model.js'

type ListMode = 'agent' | 'recent'
/** Sort mode draws pinned rows as the pins do (with their agent and source), and group rows as the groups do. */
const PINNED_ROW_MODE: ListMode = 'recent'
const TREE_ROW_MODE: ListMode = 'agent'
const MODE_KEY = 'nekro-nxt.channel-list-mode'
const readMode = (): ListMode => {
  try {
    return window.localStorage.getItem(MODE_KEY) === 'recent' ? 'recent' : 'agent'
  } catch {
    return 'agent'
  }
}

type ChannelActivity = ChannelSummary

const EMPTY: readonly ConversationMessage[] = []

/** Last activity and preview: Host projection when present, otherwise the newest loaded message. */
function useActivity(channel: ChannelActivity) {
  const messages = useProductStore((state) => state.messagesByChannel[channel.id] ?? EMPTY)
  const last = messages.at(-1)
  return {
    at: channel.lastActivityAt ?? last?.occurredAt,
    preview: channel.lastMessage ?? (last ? { author: last.author, text: last.body } : undefined),
  }
}

function RowContent({
  channel,
  agent,
  connection,
  mode,
}: {
  readonly channel: ChannelActivity
  readonly agent: AgentSummary | undefined
  readonly connection: ConnectionSummary | undefined
  readonly mode: ListMode
}) {
  const activity = useActivity(channel)
  const source = connection ? connectionDisplayName(connection) : channel.connectionName
  const sourceFull = connection && connection.alias ? `${connection.alias} · ${connection.adapter}` : source
  const working = channel.runtimePhase === 'thinking' || channel.runtimePhase === 'using-tool'
  return (
    <>
      <span className={styles.rowName}>
        {mode === 'recent' && agent ? <AgentAvatar name={agent.name} hue={agentHue(agent)} size="xs" /> : null}
        <span>{channel.name}</span>
        {mode === 'recent' ? <span className={styles.rowSource}>{source}</span> : null}
        {working && agent ? (
          <i className={styles.runDot} style={cssVars({ '--run-color': agentAccent(agent) })} />
        ) : null}
      </span>
      <span className={styles.rowTime}>{relativeTime(activity.at)}</span>
      <span className={styles.rowSub}>
        {channel.bindings[0]?.paused ? '已暂停 · ' : ''}
        {mode === 'recent' && activity.preview ? `${activity.preview.author}：${activity.preview.text}` : sourceFull}
      </span>
      {channel.unread > 0 ? (
        <span className={styles.rowBadge}>{channel.unread > 99 ? '99+' : channel.unread}</span>
      ) : null}
    </>
  )
}

/** Where a pinned row sits, so its menu can offer 上移 / 下移. */
type PinPlace = { readonly index: number; readonly count: number }

type ViewChange = (change: (view: ChannelListView) => ChannelListView) => void

/**
 * What a phone's actions sheet is for. `inTree` says the channel row sits in an agent's group (or 未接线), where it can
 * move up and down; `lift` is the row raised above the dim after a long press.
 */
type ActionsTarget =
  | { readonly kind: 'channel'; readonly channelId: string; readonly inTree: boolean; readonly lift?: ActionSheetLift }
  | { readonly kind: 'agent'; readonly agentId: string; readonly lift?: ActionSheetLift }

type RowActions = {
  /** Phone layout: a long press or the more button opens the actions sheet. */
  readonly phone: boolean
  /** A mouse or trackpad is present, so rows can be dragged and say so. */
  readonly draggable: boolean
  /** Opens the sheet; false when there is nothing to offer. */
  readonly open: (target: ActionsTarget) => boolean
}

const RowActionsContext = createContext<RowActions>({ phone: false, draggable: true, open: () => false })

const FINE_POINTER = '(any-pointer: fine)'
const subscribePointer = (change: () => void) => {
  const query = window.matchMedia?.(FINE_POINTER)
  query?.addEventListener('change', change)
  return () => query?.removeEventListener('change', change)
}

/**
 * Whether any pointer can drag rows. Touch never drags (a finger scrolls, and a held finger opens the actions
 * sheet), so a phone or tablet without a mouse or trackpad shows plain rows; a touch-screen laptop keeps dragging.
 */
const useFinePointer = (): boolean =>
  useSyncExternalStore(
    subscribePointer,
    () => window.matchMedia?.(FINE_POINTER).matches ?? true,
    () => true,
  )

/** Draws a copy of `node` (a row as it looks right now) inside the raised card. */
function Snapshot({ node }: { readonly node: HTMLElement }) {
  return (
    <div
      ref={(host) => {
        if (host && host.firstChild !== node) host.replaceChildren(node)
      }}
    />
  )
}

/** The row `element` raised in place: its box on screen and an inert copy of how it looks. */
const liftOf = (element: HTMLElement | null): ActionSheetLift | undefined => {
  if (!element) return undefined
  const box = element.getBoundingClientRect()
  const copy = element.cloneNode(true)
  if (!(copy instanceof HTMLElement)) return undefined
  copy.inert = true
  return {
    rect: { top: box.top, left: box.left, width: box.width, height: box.height },
    content: <Snapshot node={copy} />,
  }
}

/**
 * On a phone a long press opens a row's actions and nothing is drawn for them. Screen readers and keyboards still
 * need a way in: this button is only read out (and shown while it has keyboard focus), and opens the same sheet.
 */
function HiddenActions({ label, target }: { readonly label: string; readonly target: ActionsTarget }) {
  const actions = useContext(RowActionsContext)
  return (
    <div className={[styles.rowMenu, styles.hiddenActions].join(' ')}>
      <IconButton label={label} size="small" aria-haspopup="dialog" onClick={() => actions.open(target)}>
        <MoreHorizontal size={15} />
      </IconButton>
    </div>
  )
}

function RowMenu({
  channel,
  pin,
  inTree,
  onViewChange,
}: {
  readonly channel: ChannelSummary
  readonly pin: PinPlace | undefined
  readonly inTree: boolean
  readonly onViewChange: ViewChange
}) {
  const actions = useContext(RowActionsContext)
  if (actions.phone)
    return (
      <HiddenActions label={`${channel.name} 的更多操作`} target={{ kind: 'channel', channelId: channel.id, inTree }} />
    )
  const items = pin
    ? [
        ...(pin.index > 0
          ? [
              {
                key: 'up',
                label: '上移',
                icon: <ArrowUp size={14} />,
                onSelect: () => onViewChange((view) => movePinnedChannel(view, channel.id, pin.index - 1)),
              },
            ]
          : []),
        ...(pin.index < pin.count - 1
          ? [
              {
                key: 'down',
                label: '下移',
                icon: <ArrowDown size={14} />,
                onSelect: () => onViewChange((view) => movePinnedChannel(view, channel.id, pin.index + 1)),
              },
            ]
          : []),
        {
          key: 'unpin',
          label: '取消置顶',
          icon: <PinOff size={14} />,
          onSelect: () => onViewChange((view) => unpinChannel(view, channel.id)),
        },
      ]
    : [
        {
          key: 'pin',
          label: '置顶',
          icon: <Pin size={14} />,
          onSelect: () => onViewChange((view) => pinChannel(view, channel.id)),
        },
      ]
  return (
    <div className={styles.rowMenu}>
      <Menu
        label={`${channel.name} 的更多操作`}
        trigger={
          <IconButton label={`${channel.name} 的更多操作`} size="small">
            <MoreHorizontal size={15} />
          </IconButton>
        }
        items={items}
      />
    </div>
  )
}

/** A long press on a channel row opens its actions sheet with the row raised; `element` is the row link. */
const useRowLongPress = (channelId: string, inTree: boolean) => {
  const actions = useContext(RowActionsContext)
  return useLongPress(
    (element) => actions.open({ kind: 'channel', channelId, inTree, ...withLift(element.parentElement) }),
    actions.phone,
  )
}

const withLift = (element: HTMLElement | null): { readonly lift?: ActionSheetLift } => {
  const lift = liftOf(element)
  return lift ? { lift } : {}
}

/**
 * A channel row with its more-menu; `sortId` keeps pinned rows in their own drag list. A mouse drags it and the
 * keyboard moves it; a finger only scrolls past it, taps it, or holds it for the actions sheet.
 */
function SortableRow({
  sortId,
  channel,
  agent,
  connection,
  mode,
  selected,
  pin,
  suppressClick,
  onViewChange,
}: {
  readonly sortId: string
  readonly channel: ChannelSummary
  readonly agent: AgentSummary | undefined
  readonly connection: ConnectionSummary | undefined
  readonly mode: ListMode
  readonly selected: boolean
  readonly pin: PinPlace | undefined
  readonly suppressClick: (event: MouseEvent) => void
  readonly onViewChange: ViewChange
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: sortId })
  const { draggable } = useContext(RowActionsContext)
  const inTree = pin === undefined
  const longPress = useRowLongPress(channel.id, inTree)
  return (
    <div
      ref={setNodeRef}
      className={[styles.rowWrap, isDragging ? styles.rowDragging : ''].join(' ')}
      data-row-key={channelRowKey(channel.id)}
      style={{ transform: CSS.Translate.toString(transform), transition }}
    >
      <Link
        to={`/channels/${channel.id}`}
        className={styles.row}
        data-selected={selected}
        aria-current={selected ? 'page' : undefined}
        // Rows are links: without these the browser's own link drag or text selection can win over the sortable drag.
        draggable={false}
        style={{ userSelect: 'none', WebkitUserSelect: 'none' }}
        onClick={suppressClick}
        {...(draggable ? { ...attributes, ...listeners, 'aria-roledescription': '可拖动的频道' } : {})}
        {...longPress}
      >
        <RowContent channel={channel} agent={agent} connection={connection} mode={mode} />
      </Link>
      <RowMenu channel={channel} pin={pin} inTree={inTree} onViewChange={onViewChange} />
    </div>
  )
}

/** A plain channel row with its more-menu, for the recent and search lists. */
function PlainRow({
  channel,
  agent,
  connection,
  selected,
  onViewChange,
}: {
  readonly channel: ChannelSummary
  readonly agent: AgentSummary | undefined
  readonly connection: ConnectionSummary | undefined
  readonly selected: boolean
  readonly onViewChange: ViewChange
}) {
  const pinned = useProductStore((state) => state.channelListView)
  const index = pinned.pinnedChannelIds.indexOf(channel.id)
  const longPress = useRowLongPress(channel.id, false)
  return (
    <div className={styles.rowWrap} data-row-key={channelRowKey(channel.id)}>
      <Link
        to={`/channels/${channel.id}`}
        className={styles.row}
        data-selected={selected}
        aria-current={selected ? 'page' : undefined}
        {...longPress}
      >
        <RowContent channel={channel} agent={agent} connection={connection} mode="recent" />
      </Link>
      <RowMenu
        channel={channel}
        pin={index >= 0 ? { index, count: pinned.pinnedChannelIds.length } : undefined}
        inTree={false}
        onViewChange={onViewChange}
      />
    </div>
  )
}

/** Unread member messages a collapsed group hides. */
function GroupUnread({ count }: { readonly count: number }) {
  if (count === 0) return null
  return (
    <span className={styles.groupBadge} title={`${count} 条未读`}>
      {count > 99 ? '99+' : count}
    </span>
  )
}

function CollapseToggle({
  name,
  collapsed,
  onToggle,
}: {
  readonly name: string
  readonly collapsed: boolean
  readonly onToggle: () => void
}) {
  return (
    <IconButton
      label={`${collapsed ? '展开' : '收起'}「${name}」`}
      size="small"
      className={styles.groupToggle}
      data-collapsed={collapsed}
      aria-expanded={!collapsed}
      onClick={onToggle}
    >
      <ChevronDown size={15} />
    </IconButton>
  )
}

function AgentGroup({
  agent,
  children,
  highlight,
  collapsed,
  unread,
  onToggle,
}: {
  readonly agent: AgentSummary
  readonly children: ReactNode
  readonly highlight: boolean
  readonly collapsed: boolean
  readonly unread: number
  readonly onToggle: () => void
}) {
  const navigate = useGo()
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: agentSortId(agent.id) })
  const actions = useContext(RowActionsContext)
  // A long press on the name offers moving the group; a tap still opens the agent.
  const longPress = useLongPress(
    (element) => actions.open({ kind: 'agent', agentId: agent.id, ...withLift(element.parentElement) }),
    actions.phone,
  )
  const phase = agentPhase[agent.state]
  return (
    <div
      ref={setNodeRef}
      className={[styles.group, highlight ? styles.groupDrop : ''].join(' ')}
      style={
        {
          transform: CSS.Translate.toString(transform),
          transition,
          '--group-accent': agentAccent(agent),
        } as CSSProperties
      }
    >
      <div className={styles.groupHeadRow} data-row-key={agentRowKey(agent.id)}>
        <Pressable
          type="button"
          className={styles.groupHead}
          onClick={() => navigate(`/agents/${agent.id}`)}
          {...(actions.draggable ? { ...attributes, ...listeners, 'aria-roledescription': '可拖动的智能体分组' } : {})}
          {...longPress}
        >
          <AgentAvatar name={agent.name} hue={agentHue(agent)} size="sm" live={isAgentWorking(agent)} />
          <span className={styles.groupName}>{agent.name}</span>
          <span className={styles.groupMeta}>{phase.label}</span>
          {collapsed ? <GroupUnread count={unread} /> : null}
        </Pressable>
        {actions.phone ? (
          <HiddenActions label={`${agent.name} 的更多操作`} target={{ kind: 'agent', agentId: agent.id }} />
        ) : null}
        <CollapseToggle name={agent.name} collapsed={collapsed} onToggle={onToggle} />
      </div>
      {collapsed ? null : children}
    </div>
  )
}

function UnboundGroup({
  children,
  count,
  highlight,
  collapsed,
  unread,
  onToggle,
}: {
  readonly children: ReactNode
  readonly count: number
  readonly highlight: boolean
  readonly collapsed: boolean
  readonly unread: number
  readonly onToggle: () => void
}) {
  const { setNodeRef } = useDroppable({ id: UNBOUND_DROP_ID })
  return (
    <div ref={setNodeRef} className={[styles.group, highlight ? styles.groupDrop : ''].join(' ')}>
      <div className={styles.groupHeadRow}>
        <div className={[styles.groupHead, styles.unboundHead].join(' ')}>
          <MemberAvatar name="?" size="sm" />
          未接线
          <span className={styles.groupMeta}>{count}</span>
          {collapsed ? <GroupUnread count={unread} /> : null}
        </div>
        <CollapseToggle name="未接线" collapsed={collapsed} onToggle={onToggle} />
      </div>
      {collapsed ? null : children}
    </div>
  )
}

const PINNED_SORT_PREFIX = 'pinned:'
const pinnedSortId = (channelId: string): string => `${PINNED_SORT_PREFIX}${channelId}`

/**
 * Channels the console pinned, above every group. They keep their own drag list: dragging here only reorders the
 * pins and never binds or unbinds.
 */
function PinnedSection({
  pinned,
  selectedId,
  selectedConversationId,
  agentById,
  connectionById,
  onViewChange,
}: {
  readonly pinned: readonly ChannelSummary[]
  readonly selectedId: string | undefined
  readonly selectedConversationId: string | undefined
  readonly agentById: ReadonlyMap<string, AgentSummary>
  readonly connectionById: ReadonlyMap<string, ConnectionSummary>
  readonly onViewChange: ViewChange
}) {
  const [activeId, setActiveId] = useState('')
  const dragged = useRef(false)
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  if (pinned.length === 0) return null
  const ids = pinned.map((channel) => pinnedSortId(channel.id))
  const nameOf = (id: string) =>
    `频道「${pinned.find((channel) => pinnedSortId(channel.id) === id)?.name ?? '未命名'}」`
  const activeChannel = pinned.find((channel) => pinnedSortId(channel.id) === activeId)
  /** Swallows the click that ends a pointer drag, as the group lists do. */
  const settle = () => {
    setActiveId('')
    const swallow = (event: Event) => {
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener('click', swallow, { capture: true, once: true })
    window.setTimeout(() => {
      dragged.current = false
      window.removeEventListener('click', swallow, { capture: true })
    }, 120)
  }
  return (
    <div className={styles.group} role="group" aria-label="置顶">
      <div className={[styles.groupHead, styles.unboundHead].join(' ')}>
        <span className={styles.pinnedIcon} aria-hidden="true">
          <Pin size={14} />
        </span>
        置顶
      </div>
      <DndContext
        sensors={sensors}
        // The row under the pointer wins, as in the groups below; the nearest row only when the pointer is between rows.
        collisionDetection={(args) => {
          const hits = pointerWithin(args)
          return hits.length ? hits : closestCenter(args)
        }}
        onDragStart={(event) => {
          dragged.current = true
          setActiveId(String(event.active.id))
        }}
        onDragCancel={settle}
        onDragEnd={(event) => {
          settle()
          const channelId = parsePrefixedId(String(event.active.id), PINNED_SORT_PREFIX)
          const to = event.over ? ids.indexOf(String(event.over.id)) : -1
          if (channelId && to >= 0) onViewChange((view) => movePinnedChannel(view, channelId, to))
        }}
        accessibility={{
          screenReaderInstructions: { draggable: '按空格开始拖动，用方向键移动，再按空格放下，按 Esc 取消。' },
          announcements: {
            onDragStart: ({ active }) => `已拿起${nameOf(String(active.id))}`,
            onDragOver: ({ active, over }) =>
              over
                ? `${nameOf(String(active.id))}移到${nameOf(String(over.id))}`
                : `${nameOf(String(active.id))}不在置顶内`,
            onDragEnd: ({ active, over }) =>
              over
                ? `${nameOf(String(active.id))}放在${nameOf(String(over.id))}`
                : `${nameOf(String(active.id))}已放回原处`,
            onDragCancel: ({ active }) => `已取消拖动${nameOf(String(active.id))}`,
          },
        }}
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          {pinned.map((channel, index) => (
            <Fragment key={channel.id}>
              <SortableRow
                sortId={pinnedSortId(channel.id)}
                channel={channel}
                agent={agentById.get(channel.agentId)}
                connection={connectionById.get(channel.connectionId)}
                mode="recent"
                selected={channel.id === selectedId && selectedConversationId === undefined}
                pin={{ index, count: pinned.length }}
                suppressClick={(event) => {
                  if (dragged.current) event.preventDefault()
                }}
                onViewChange={onViewChange}
              />
              <SubConversationRows channelId={channel.id} selectedConversationId={selectedConversationId} />
            </Fragment>
          ))}
        </SortableContext>
        <DragOverlay
          style={{ pointerEvents: 'none' }}
          dropAnimation={{ duration: 220, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }}
        >
          {activeChannel ? <div className={styles.dragOverlay}>{activeChannel.name}</div> : null}
        </DragOverlay>
      </DndContext>
    </div>
  )
}

/** A new web channel starts unbound; wiring it to an agent is the next, separate step. */
function CreateInternalChannel() {
  const api = useProductApi()
  const go = useGo()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const create = async () => {
    setBusy(true)
    setError('')
    try {
      const { channelId } = await api.getState().createInternalChannel({ displayName: name.trim() })
      setOpen(false)
      setName('')
      toast(`已新建「${name.trim()}」`)
      go(`/channels/${channelId}`)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <IconButton label="新建内置频道" size="small" onClick={() => setOpen(true)}>
        <Plus size={15} />
      </IconButton>
      <Dialog
        open={open}
        onOpenChange={(next) => !busy && setOpen(next)}
        title="新建内置频道"
        actions={
          <>
            <Button onClick={() => setOpen(false)} disabled={busy}>
              取消
            </Button>
            <Button variant="primary" busy={busy} disabled={!name.trim()} onClick={() => void create()}>
              创建
            </Button>
          </>
        }
      >
        <Field label="频道名称" error={error || undefined}>
          <Input
            value={name}
            maxLength={80}
            autoFocus
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && name.trim() && !busy) void create()
            }}
          />
        </Field>
      </Dialog>
    </>
  )
}

const dragLists = (tree: {
  readonly agents: readonly { readonly agent: AgentSummary; readonly channels: readonly ChannelSummary[] }[]
  readonly unbound: readonly ChannelSummary[]
}): WorkTreeDragLists => {
  const channelAgentId: Record<string, string> = {}
  for (const group of tree.agents) for (const channel of group.channels) channelAgentId[channel.id] = group.agent.id
  return {
    agentIds: tree.agents.map((group) => group.agent.id),
    channelIdsByAgent: Object.fromEntries(
      tree.agents.map((group) => [group.agent.id, group.channels.map((channel) => channel.id)]),
    ),
    unboundChannelIds: tree.unbound.map((channel) => channel.id),
    channelAgentId,
  }
}

export function ChannelList({
  selectedId,
  selectedConversationId,
}: {
  readonly selectedId: string | undefined
  /** A sub-conversation of `selectedId` shown instead of the channel itself. */
  readonly selectedConversationId?: string | undefined
}) {
  const api = useProductApi()
  const agents = useProductStore((state) => state.agents)
  const channels = useProductStore((state) => state.channels)
  const connections = useProductStore((state) => state.connections)
  const order = useProductStore((state) => state.workTreeOrder)
  const view = useProductStore((state) => state.channelListView)
  const [mode, setModeState] = useState<ListMode>(readMode)
  const [activeId, setActiveId] = useState('')
  const [overId, setOverId] = useState('')
  const [intent, setIntent] = useState<BindIntent | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const attention = useAttention()
  const dragged = useRef(false)
  const phone = usePhone()
  const draggable = useFinePointer()
  const [actions, setActions] = useState<ActionsTarget>()
  const [actionsOpen, setActionsOpen] = useState(false)
  const [actionsPage, setActionsPage] = useState<'main' | 'agents'>('main')
  const sorting = useChannelSorting()
  const listRoot = useRef<HTMLDivElement>(null)
  /** The row to keep in place across the switch into or out of sort mode. */
  const anchor = useRef<RowAnchor>(undefined)
  useLayoutEffect(() => {
    restoreAnchor(listRoot.current, anchor.current)
    anchor.current = undefined
  }, [sorting.sorting])

  const setMode = (next: ListMode) => {
    setModeState(next)
    try {
      window.localStorage.setItem(MODE_KEY, next)
    } catch {
      // Preference only.
    }
  }

  const connectionById = useMemo(() => new Map(connections.map((item) => [item.id, item])), [connections])
  const agentById = useMemo(() => new Map(agents.map((item) => [item.id, item])), [agents])
  const pinnedIds = useMemo(() => new Set(view.pinnedChannelIds), [view.pinnedChannelIds])
  const collapsedIds = useMemo(() => new Set(view.collapsedGroupIds), [view.collapsedGroupIds])
  const pinned = useMemo(() => {
    const byId = new Map(channels.map((channel) => [channel.id, channel]))
    return view.pinnedChannelIds.flatMap((id) => {
      const channel = byId.get(id)
      return channel ? [channel] : []
    })
  }, [channels, view.pinnedChannelIds])
  const fullTree = useMemo(() => buildWorkTree(agents, channels, order), [agents, channels, order])
  // Pinned channels leave their group; dragging only sees the rows still shown there.
  const tree = useMemo(
    () => ({
      agents: fullTree.agents.map((group) => ({
        agent: group.agent,
        channels: group.channels.filter((channel) => !pinnedIds.has(channel.id)),
      })),
      unbound: fullTree.unbound.filter((channel) => !pinnedIds.has(channel.id)),
    }),
    [fullTree, pinnedIds],
  )
  const lists = useMemo<WorkTreeDragLists>(() => dragLists(tree), [tree])
  const fullLists = useMemo<WorkTreeDragLists>(() => dragLists(fullTree), [fullTree])
  const recent = useMemo(() => {
    const time = (channel: ChannelActivity) => channel.lastActivityAt ?? 0
    return [...channels].sort((left, right) => time(right) - time(left))
  }, [channels])
  const unreadOf = (items: readonly ChannelSummary[]) => items.reduce((total, channel) => total + channel.unread, 0)

  const changeView: ViewChange = (change) => {
    void api
      .getState()
      .putChannelListView(change(api.getState().channelListView))
      .catch((error: unknown) => toast(error instanceof Error ? error.message : String(error), { tone: 'bad' }))
  }
  const toggleGroup = (groupId: string) => changeView((current) => toggleGroupCollapsed(current, groupId))
  const needsAttention = useMemo(
    () =>
      new Set(
        attention.flatMap((item) => {
          const match = /^\/channels\/([^/?#]+)/u.exec(item.href)
          return match?.[1] ? [decodeURIComponent(match[1])] : []
        }),
      ),
    [attention],
  )
  const matches = (channel: ChannelSummary): boolean => {
    if (filter === 'unread' && channel.unread === 0) return false
    if (filter === 'attention' && !needsAttention.has(channel.id)) return false
    if (filter.startsWith('connection:') && channel.connectionId !== filter.slice('connection:'.length)) return false
    const needle = query.trim().toLowerCase()
    if (!needle) return true
    const connection = connectionById.get(channel.connectionId)
    const source = connection ? connectionDisplayName(connection) : channel.connectionName
    const agentName = agentById.get(channel.agentId)?.name ?? ''
    return `${channel.name} ${source} ${agentName}`.toLowerCase().includes(needle)
  }

  // A mouse, not every pointer: a finger on a row scrolls the list, and a held one opens the actions sheet instead.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const collision: CollisionDetection = (args) => {
    const hits = pointerWithin(args).map((hit) => String(hit.id))
    if (hits.length) {
      const picked = pickWorkTreeCollision({
        activeId: String(args.active.id),
        pointerHits: hits,
        channelOwnerById: lists.channelAgentId,
      })
      if (picked) return [{ id: picked }]
    }
    return closestCenter(args)
  }

  const onDragEnd = (event: DragEndEvent) => {
    setActiveId('')
    setOverId('')
    swallowNextClick()
    const resolution = resolveWorkTreeDragEnd({
      activeId: String(event.active.id),
      overId: event.over ? String(event.over.id) : '',
      lists,
    })
    if (resolution.kind === 'bind' || resolution.kind === 'replace') {
      setIntent({ kind: resolution.kind, channelId: resolution.channelId, agentId: resolution.agentId })
      return
    }
    if (resolution.kind === 'unbind') {
      setIntent({ kind: 'unbind', channelId: resolution.channelId })
      return
    }
    saveOrder(resolution)
  }

  /** Saves a reorder of the shown rows, from a drag or from the actions sheet. */
  const saveOrder = (resolution: WorkTreeDragResolution) => {
    // Reorders happen among the shown rows; pinned channels keep their slots in the saved group order.
    const next = applyWorkTreeDragResolution(
      fullLists,
      resolution.kind === 'reorder-agent-channels'
        ? {
            ...resolution,
            channelIds: keepHiddenSlots(
              fullLists.channelIdsByAgent[resolution.agentId] ?? [],
              resolution.channelIds,
              pinnedIds,
            ),
          }
        : resolution.kind === 'reorder-unbound'
          ? {
              ...resolution,
              channelIds: keepHiddenSlots(fullLists.unboundChannelIds, resolution.channelIds, pinnedIds),
            }
          : resolution,
    )
    if (next) {
      void api
        .getState()
        .putWorkTreeOrder(next)
        .catch((error: unknown) => toast(error instanceof Error ? error.message : String(error), { tone: 'bad' }))
    }
  }

  /** Spoken name of a draggable or drop target; screen readers never hear internal ids. */
  const dragLabel = (id: string): string => {
    if (id === UNBOUND_DROP_ID) return '「未接线」'
    const channelId = parsePrefixedId(id, CHANNEL_SORT_PREFIX)
    if (channelId) return `频道「${channels.find((channel) => channel.id === channelId)?.name ?? '未命名'}」`
    const agentId = parsePrefixedId(id, AGENT_SORT_PREFIX)
    return `智能体「${(agentId && agentById.get(agentId)?.name) ?? '未命名'}」`
  }

  const suppressClick = (event: MouseEvent) => {
    if (dragged.current) event.preventDefault()
  }
  /**
   * The press that ends a pointer drag also produces a click on the row link. Swallow exactly that click in the
   * capture phase, before React Router can navigate; a keyboard drop produces none, so the guard expires.
   */
  const swallowNextClick = () => {
    const swallow = (event: Event) => {
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener('click', swallow, { capture: true, once: true })
    window.setTimeout(() => {
      dragged.current = false
      window.removeEventListener('click', swallow, { capture: true })
    }, 120)
  }
  const activeChannelId = parsePrefixedId(activeId, CHANNEL_SORT_PREFIX)
  const activeChannel = activeChannelId ? channels.find((channel) => channel.id === activeChannelId) : undefined
  const activeAgentId = parsePrefixedId(activeId, AGENT_SORT_PREFIX)
  const activeAgent = activeAgentId ? agentById.get(activeAgentId) : undefined
  const overAgent = parsePrefixedId(overId, AGENT_SORT_PREFIX)
  const sourceAgent = activeChannelId ? (lists.channelAgentId[activeChannelId] ?? '') : ''
  const highlightAgent = activeChannel && overAgent && overAgent !== sourceAgent ? overAgent : ''
  const highlightUnbound = Boolean(activeChannel && sourceAgent && overId === UNBOUND_DROP_ID)
  const selectedAgent = selectedId
    ? agentById.get(channels.find((channel) => channel.id === selectedId)?.agentId ?? '')
    : undefined

  // Search and filters show a flat result list across pins and collapsed groups, without changing either; ordering
  // and drag only apply to the full tree.
  const filtering = query.trim() !== '' || filter !== 'all'
  const listMode: ListMode = filtering ? 'recent' : mode
  const shown = filtering ? recent.filter(matches) : recent.filter((channel) => !pinnedIds.has(channel.id))

  /** Opens sort mode with `key`'s row kept where it is on screen. */
  const startSorting = (key: string) => {
    anchor.current = rowAnchor(listRoot.current, key)
    sorting.enter()
  }
  const sortItem = (key: string): ActionSheetEntry => ({
    key: 'sort',
    label: '排序',
    icon: <ArrowUpDown aria-hidden="true" />,
    onSelect: () => startSorting(key),
  })

  /**
   * The sheet for `target`: only what applies to the row where it sits. 排序 opens sort mode, where rows move by
   * their handles and save like a drag; giving the channel to another agent, or unbinding it, goes through the same
   * confirmation as a drop. Recent activity and search results have no order of their own to change.
   */
  const sheetFor = (
    target: ActionsTarget | undefined,
    page: 'main' | 'agents',
  ): { title: string; items: ActionSheetEntry[]; onBack?: () => void } | undefined => {
    if (target?.kind === 'agent') {
      const agent = agentById.get(target.agentId)
      if (!agent || listMode !== 'agent') return undefined
      return { title: agent.name, items: [sortItem(agentRowKey(agent.id))] }
    }
    const channel = target && channels.find((item) => item.id === target.channelId)
    if (!target || !channel) return undefined
    const owner = fullLists.channelAgentId[channel.id] ?? ''
    const others = tree.agents.map((group) => group.agent).filter((agent) => agent.id !== owner)
    const moveLabel = owner ? '移到其他智能体' : '接到智能体'
    if (page === 'agents') {
      return {
        title: moveLabel,
        onBack: () => setActionsPage('main'),
        items: others.map((agent) => ({
          key: agent.id,
          label: agent.name,
          icon: <AgentAvatar name={agent.name} hue={agentHue(agent)} size="xs" />,
          onSelect: () => setIntent({ kind: owner ? 'replace' : 'bind', channelId: channel.id, agentId: agent.id }),
        })),
      }
    }
    const isPinned = pinned.some((item) => item.id === channel.id)
    const sortable = isPinned ? !filtering : target.inTree && listMode === 'agent'
    return {
      title: channel.name,
      items: [
        isPinned
          ? {
              key: 'unpin',
              label: '取消置顶',
              icon: <PinOff aria-hidden="true" />,
              onSelect: () => changeView((current) => unpinChannel(current, channel.id)),
            }
          : {
              key: 'pin',
              label: '置顶',
              icon: <Pin aria-hidden="true" />,
              onSelect: () => changeView((current) => pinChannel(current, channel.id)),
            },
        ...(sortable ? [sortItem(channelRowKey(channel.id))] : []),
        ...(others.length
          ? [
              {
                key: 'move',
                label: `${moveLabel}…`,
                icon: <ArrowRightLeft aria-hidden="true" />,
                opensMore: true,
                onSelect: () => setActionsPage('agents'),
              },
            ]
          : []),
        ...(owner
          ? [
              {
                key: 'unbind',
                label: '解除接线',
                icon: <Unplug aria-hidden="true" />,
                danger: true,
                onSelect: () => setIntent({ kind: 'unbind', channelId: channel.id }),
              },
            ]
          : []),
      ],
    }
  }
  const sheet = sheetFor(actions, actionsPage)
  const rowActions: RowActions = {
    phone,
    draggable,
    open: (target) => {
      // A target with nothing to offer opens nothing.
      if (!sheetFor(target, 'main')) return false
      setActions(target)
      setActionsPage('main')
      setActionsOpen(true)
      return true
    },
  }

  return (
    <RowActionsContext.Provider value={rowActions}>
      <ListPane
        title={
          <>
            频道 <span className={styles.listCount}>{channels.length}</span>
          </>
        }
        label="频道"
        // Sort mode shows the whole arrangement: no search, filter or new channel until it is done.
        actions={sorting.sorting ? undefined : <CreateInternalChannel />}
        toolbar={
          sorting.sorting ? undefined : (
            <>
              <div className={styles.filterRow}>
                <SearchField label="搜索频道" placeholder="搜索频道" value={query} onChange={setQuery} />
                <Select
                  aria-label="筛选频道"
                  className={styles.filter}
                  value={filter}
                  onValueChange={(value) => setFilter(value)}
                  options={[
                    { value: 'all', label: '全部' },
                    { value: 'unread', label: '未读' },
                    { value: 'attention', label: '需要处理' },
                    ...connections.map((connection) => ({
                      value: `connection:${connection.id}`,
                      label: connectionDisplayName(connection),
                    })),
                  ]}
                />
                <Menu
                  label="排列方式"
                  trigger={
                    <IconButton label={`排列方式：${mode === 'agent' ? '按智能体' : '最近活动'}`}>
                      <ArrowUpDown size={15} />
                    </IconButton>
                  }
                  items={[
                    { heading: '排列方式' },
                    ...(['agent', 'recent'] as const).map((value) => ({
                      key: value,
                      label: value === 'agent' ? '按智能体' : '最近活动',
                      icon: value === mode ? <Check size={14} /> : <span className={styles.menuSpacer} />,
                      onSelect: () => setMode(value),
                    })),
                  ]}
                />
              </div>
            </>
          )
        }
      >
        <div ref={listRoot} className={styles.channelTree}>
          {sorting.sorting ? (
            <SortModeList
              groups={{ pinned, agents: tree.agents, unbound: tree.unbound }}
              renderRow={(channel, inPins) => (
                <RowContent
                  channel={channel}
                  agent={agentById.get(channel.agentId)}
                  connection={connectionById.get(channel.connectionId)}
                  mode={inPins ? PINNED_ROW_MODE : TREE_ROW_MODE}
                />
              )}
              onMovePinned={(from, to) => {
                const order = pinned.map((channel) => channel.id)
                const channelId = order[from]
                if (!channelId) return
                changeView((current) =>
                  movePinnedChannel(current, channelId, current.pinnedChannelIds.indexOf(order[to] ?? '')),
                )
              }}
              onMoveChannels={(agentId, from, to) => {
                const ids = agentId ? (lists.channelIdsByAgent[agentId] ?? []) : lists.unboundChannelIds
                const channelIds = arrayMoveIds(ids, from, to)
                saveOrder(
                  agentId
                    ? { kind: 'reorder-agent-channels', agentId, channelIds }
                    : { kind: 'reorder-unbound', channelIds },
                )
              }}
              onMoveAgents={(from, to) =>
                saveOrder({ kind: 'reorder-agents', agentIds: arrayMoveIds(lists.agentIds, from, to) })
              }
              onDone={sorting.exit}
              leaving={(row) => (anchor.current = row)}
            />
          ) : (
            <SelectionList
              // Pins and collapsed groups move the selected row, so they are part of the key that re-measures it.
              selectedKey={`${listMode}:${selectedId ?? ''}:${selectedConversationId ?? ''}:${view.pinnedChannelIds.join(',')}:${view.collapsedGroupIds.join(',')}:${String(filtering)}`}
              accent={selectedAgent ? agentAccent(selectedAgent) : undefined}
            >
              {filtering && shown.length === 0 ? <p className={styles.noMatch}>没有符合条件的频道</p> : null}
              {filtering ? null : (
                <PinnedSection
                  pinned={pinned}
                  selectedId={selectedId}
                  selectedConversationId={selectedConversationId}
                  agentById={agentById}
                  connectionById={connectionById}
                  onViewChange={changeView}
                />
              )}
              {listMode === 'recent' ? (
                shown.map((channel) => (
                  <Fragment key={channel.id}>
                    <PlainRow
                      channel={channel}
                      agent={agentById.get(channel.agentId)}
                      connection={connectionById.get(channel.connectionId)}
                      selected={channel.id === selectedId && selectedConversationId === undefined}
                      onViewChange={changeView}
                    />
                    <SubConversationRows channelId={channel.id} selectedConversationId={selectedConversationId} />
                  </Fragment>
                ))
              ) : (
                <DndContext
                  sensors={sensors}
                  collisionDetection={collision}
                  onDragStart={(event) => {
                    dragged.current = true
                    setActiveId(String(event.active.id))
                  }}
                  onDragOver={(event) => setOverId(event.over ? String(event.over.id) : '')}
                  onDragCancel={() => {
                    setActiveId('')
                    setOverId('')
                    swallowNextClick()
                  }}
                  onDragEnd={onDragEnd}
                  accessibility={{
                    screenReaderInstructions: {
                      draggable: '按空格开始拖动，用方向键移动，再按空格放下，按 Esc 取消。跨智能体放下会先确认。',
                    },
                    announcements: {
                      onDragStart: ({ active }) => `已拿起${dragLabel(String(active.id))}`,
                      onDragOver: ({ active, over }) =>
                        over
                          ? `${dragLabel(String(active.id))}移到${dragLabel(String(over.id))}`
                          : `${dragLabel(String(active.id))}不在可放下的位置`,
                      onDragEnd: ({ active, over }) =>
                        over
                          ? `${dragLabel(String(active.id))}放在${dragLabel(String(over.id))}`
                          : `${dragLabel(String(active.id))}已放回原处`,
                      onDragCancel: ({ active }) => `已取消拖动${dragLabel(String(active.id))}`,
                    },
                  }}
                >
                  <SortableContext items={lists.agentIds.map(agentSortId)} strategy={verticalListSortingStrategy}>
                    {tree.agents.map((group) => (
                      <AgentGroup
                        key={group.agent.id}
                        agent={group.agent}
                        highlight={highlightAgent === group.agent.id}
                        collapsed={collapsedIds.has(group.agent.id)}
                        unread={unreadOf(group.channels)}
                        onToggle={() => toggleGroup(group.agent.id)}
                      >
                        <SortableContext
                          items={group.channels.map((channel) => channelSortId(channel.id))}
                          strategy={verticalListSortingStrategy}
                        >
                          {group.channels.map((channel) => (
                            <Fragment key={channel.id}>
                              <SortableRow
                                sortId={channelSortId(channel.id)}
                                channel={channel}
                                agent={group.agent}
                                connection={connectionById.get(channel.connectionId)}
                                mode="agent"
                                selected={channel.id === selectedId && selectedConversationId === undefined}
                                pin={undefined}
                                suppressClick={suppressClick}
                                onViewChange={changeView}
                              />
                              <SubConversationRows
                                channelId={channel.id}
                                selectedConversationId={selectedConversationId}
                              />
                            </Fragment>
                          ))}
                        </SortableContext>
                      </AgentGroup>
                    ))}
                  </SortableContext>
                  <UnboundGroup
                    count={tree.unbound.length}
                    highlight={highlightUnbound}
                    collapsed={collapsedIds.has(UNBOUND_GROUP_ID)}
                    unread={unreadOf(tree.unbound)}
                    onToggle={() => toggleGroup(UNBOUND_GROUP_ID)}
                  >
                    <SortableContext
                      items={tree.unbound.map((channel) => channelSortId(channel.id))}
                      strategy={verticalListSortingStrategy}
                    >
                      {tree.unbound.map((channel) => (
                        <SortableRow
                          key={channel.id}
                          sortId={channelSortId(channel.id)}
                          channel={channel}
                          agent={undefined}
                          connection={connectionById.get(channel.connectionId)}
                          mode="agent"
                          selected={channel.id === selectedId}
                          pin={undefined}
                          suppressClick={suppressClick}
                          onViewChange={changeView}
                        />
                      ))}
                    </SortableContext>
                  </UnboundGroup>
                  <DragOverlay
                    // Only a picture of the dragged row: during its drop animation it must not catch the next press.
                    style={{ pointerEvents: 'none' }}
                    dropAnimation={{ duration: 220, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }}
                  >
                    {activeChannel ? (
                      <div className={styles.dragOverlay}>{activeChannel.name}</div>
                    ) : activeAgent ? (
                      <div className={styles.dragOverlay}>{activeAgent.name}</div>
                    ) : null}
                  </DragOverlay>
                </DndContext>
              )}
            </SelectionList>
          )}
        </div>
        <BindDialog intent={intent} onClose={() => setIntent(null)} />
        {phone ? (
          <ActionSheet
            open={actionsOpen && sheet !== undefined}
            onOpenChange={setActionsOpen}
            title={sheet?.title ?? ''}
            items={sheet?.items ?? []}
            page={actionsPage}
            {...(sheet?.onBack ? { onBack: sheet.onBack } : {})}
            {...(actions?.lift ? { lift: actions.lift } : {})}
          />
        ) : null}
      </ListPane>
    </RowActionsContext.Provider>
  )
}
