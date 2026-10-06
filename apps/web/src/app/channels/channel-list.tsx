import { useGo } from '../model/nav.js'
import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
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
import { useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  agentSortId,
  applyWorkTreeDragResolution,
  buildWorkTree,
  channelSortId,
  parsePrefixedId,
  pickWorkTreeCollision,
  resolveWorkTreeDragEnd,
  AGENT_SORT_PREFIX,
  CHANNEL_SORT_PREFIX,
  UNBOUND_DROP_ID,
  type WorkTreeDragLists,
} from '../model/work-tree-order.js'
import {
  connectionDisplayName,
  useProductStore,
  type AgentSummary,
  type ChannelSummary,
  type ConnectionSummary,
  type ConversationMessage,
} from '../../product-runtime.js'
import { Plus } from 'lucide-react'
import {
  AgentAvatar,
  Button,
  Dialog,
  Field,
  IconButton,
  Input,
  ListPane,
  MemberAvatar,
  SearchField,
  Segmented,
  Select,
  SelectionList,
  toast,
  cssVars,
  Pressable,
} from '../../ui-kit/next/index.js'
import { useAttention } from '../model/attention.js'
import { agentAccent, agentHue, agentPhase, isAgentWorking } from '../model/identity.js'
import { BindDialog, type BindIntent } from './bind-dialog.js'
import { useProductApi } from '../model/store.js'
import styles from './channels.module.css'
import { relativeTime } from './timeline-model.js'

type ListMode = 'agent' | 'recent'
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
        {mode === 'recent' && activity.preview ? `${activity.preview.author}：${activity.preview.text}` : sourceFull}
      </span>
      {channel.unread > 0 ? (
        <span className={styles.rowBadge}>{channel.unread > 99 ? '99+' : channel.unread}</span>
      ) : null}
    </>
  )
}

function SortableRow({
  channel,
  agent,
  connection,
  selected,
  suppressClick,
}: {
  readonly channel: ChannelSummary
  readonly agent: AgentSummary | undefined
  readonly connection: ConnectionSummary | undefined
  readonly selected: boolean
  readonly suppressClick: (event: MouseEvent) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: channelSortId(channel.id),
  })
  return (
    <Link
      ref={setNodeRef}
      to={`/channels/${channel.id}`}
      className={[styles.row, isDragging ? styles.rowDragging : ''].join(' ')}
      data-selected={selected}
      aria-current={selected ? 'page' : undefined}
      // Rows are links: without these the browser's own link drag or text selection can win over the sortable drag.
      draggable={false}
      style={{ transform: CSS.Translate.toString(transform), transition, userSelect: 'none', WebkitUserSelect: 'none' }}
      onClick={suppressClick}
      {...attributes}
      {...listeners}
      aria-roledescription="可拖动的频道"
    >
      <RowContent channel={channel} agent={agent} connection={connection} mode="agent" />
    </Link>
  )
}

function AgentGroup({
  agent,
  children,
  highlight,
}: {
  readonly agent: AgentSummary
  readonly children: ReactNode
  readonly highlight: boolean
}) {
  const navigate = useGo()
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: agentSortId(agent.id) })
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
      <Pressable
        type="button"
        className={styles.groupHead}
        onClick={() => navigate(`/agents/${agent.id}`)}
        {...attributes}
        {...listeners}
        aria-roledescription="可拖动的智能体分组"
      >
        <AgentAvatar name={agent.name} hue={agentHue(agent)} size="sm" live={isAgentWorking(agent)} />
        {agent.name}
        <span className={styles.groupMeta}>{phase.label}</span>
      </Pressable>
      {children}
    </div>
  )
}

function UnboundGroup({
  children,
  count,
  highlight,
}: {
  readonly children: ReactNode
  readonly count: number
  readonly highlight: boolean
}) {
  const { setNodeRef } = useDroppable({ id: UNBOUND_DROP_ID })
  return (
    <div ref={setNodeRef} className={[styles.group, highlight ? styles.groupDrop : ''].join(' ')}>
      <div className={[styles.groupHead, styles.unboundHead].join(' ')}>
        <MemberAvatar name="?" size="sm" />
        未接线
        <span className={styles.groupMeta}>{count}</span>
      </div>
      {children}
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

export function ChannelList({ selectedId }: { readonly selectedId: string | undefined }) {
  const api = useProductApi()
  const agents = useProductStore((state) => state.agents)
  const channels = useProductStore((state) => state.channels)
  const connections = useProductStore((state) => state.connections)
  const order = useProductStore((state) => state.workTreeOrder)
  const [mode, setModeState] = useState<ListMode>(readMode)
  const [activeId, setActiveId] = useState('')
  const [overId, setOverId] = useState('')
  const [intent, setIntent] = useState<BindIntent | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const attention = useAttention()
  const dragged = useRef(false)

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
  const tree = useMemo(() => buildWorkTree(agents, channels, order), [agents, channels, order])
  const lists = useMemo<WorkTreeDragLists>(() => {
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
  }, [tree])
  const recent = useMemo(() => {
    const time = (channel: ChannelActivity) => channel.lastActivityAt ?? 0
    return [...channels].sort((left, right) => time(right) - time(left))
  }, [channels])
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

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
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
    const next = applyWorkTreeDragResolution(lists, resolution)
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

  // Search and filters show a flat result list; ordering and drag only apply to the full tree.
  const filtering = query.trim() !== '' || filter !== 'all'
  const listMode: ListMode = filtering ? 'recent' : mode
  const shown = filtering ? recent.filter(matches) : recent

  return (
    <ListPane
      title="频道"
      label="频道"
      actions={
        <>
          <span className={styles.listCount}>{channels.length}</span>
          <CreateInternalChannel />
        </>
      }
      toolbar={
        <>
          <div className={styles.filterRow}>
            <SearchField label="搜索频道" placeholder="搜索频道" value={query} onChange={setQuery} />
            <Select
              aria-label="筛选频道"
              className={styles.filter}
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
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
          </div>
          <Segmented
            label="排列方式"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'agent', label: '按智能体' },
              { value: 'recent', label: '最近活动' },
            ]}
          />
        </>
      }
    >
      <SelectionList
        selectedKey={`${listMode}:${selectedId ?? ''}`}
        accent={selectedAgent ? agentAccent(selectedAgent) : undefined}
      >
        {filtering && shown.length === 0 ? <p className={styles.noMatch}>没有符合条件的频道</p> : null}
        {listMode === 'recent' ? (
          shown.map((channel) => (
            <Link
              key={channel.id}
              to={`/channels/${channel.id}`}
              className={styles.row}
              data-selected={channel.id === selectedId}
              aria-current={channel.id === selectedId ? 'page' : undefined}
            >
              <RowContent
                channel={channel}
                agent={agentById.get(channel.agentId)}
                connection={connectionById.get(channel.connectionId)}
                mode="recent"
              />
            </Link>
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
                <AgentGroup key={group.agent.id} agent={group.agent} highlight={highlightAgent === group.agent.id}>
                  <SortableContext
                    items={group.channels.map((channel) => channelSortId(channel.id))}
                    strategy={verticalListSortingStrategy}
                  >
                    {group.channels.map((channel) => (
                      <SortableRow
                        key={channel.id}
                        channel={channel}
                        agent={group.agent}
                        connection={connectionById.get(channel.connectionId)}
                        selected={channel.id === selectedId}
                        suppressClick={suppressClick}
                      />
                    ))}
                  </SortableContext>
                </AgentGroup>
              ))}
            </SortableContext>
            <UnboundGroup count={tree.unbound.length} highlight={highlightUnbound}>
              <SortableContext
                items={tree.unbound.map((channel) => channelSortId(channel.id))}
                strategy={verticalListSortingStrategy}
              >
                {tree.unbound.map((channel) => (
                  <SortableRow
                    key={channel.id}
                    channel={channel}
                    agent={undefined}
                    connection={connectionById.get(channel.connectionId)}
                    selected={channel.id === selectedId}
                    suppressClick={suppressClick}
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
      <BindDialog intent={intent} onClose={() => setIntent(null)} />
    </ListPane>
  )
}
