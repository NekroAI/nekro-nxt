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
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
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
} from '../../shell/work-tree-order.js'
import {
  connectionDisplayName,
  useProductStore,
  type AgentSummary,
  type ChannelSummary,
  type ConnectionSummary,
  type ConversationMessage,
} from '../../product-runtime.js'
import { AgentAvatar, MemberAvatar, Segmented, SelectionList, toast } from '../../ui-kit/next/index.js'
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
        {working && agent ? <i className={styles.runDot} style={{ '--run-color': agentAccent(agent) } as CSSProperties} /> : null}
      </span>
      <span className={styles.rowTime}>{relativeTime(activity.at)}</span>
      <span className={styles.rowSub}>
        {mode === 'recent' && activity.preview ? `${activity.preview.author}：${activity.preview.text}` : sourceFull}
      </span>
      {channel.unread > 0 ? <span className={styles.rowBadge}>{channel.unread > 99 ? '99+' : channel.unread}</span> : null}
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
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: channelSortId(channel.id) })
  return (
    <Link
      ref={setNodeRef}
      to={`/channels/${channel.id}`}
      className={[styles.row, isDragging ? styles.rowDragging : ''].join(' ')}
      data-selected={selected}
      aria-current={selected ? 'page' : undefined}
      style={{ transform: CSS.Translate.toString(transform), transition }}
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
  const navigate = useNavigate()
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: agentSortId(agent.id) })
  const phase = agentPhase[agent.state]
  return (
    <div
      ref={setNodeRef}
      className={[styles.group, highlight ? styles.groupDrop : ''].join(' ')}
      style={{ transform: CSS.Translate.toString(transform), transition, '--group-accent': agentAccent(agent) } as CSSProperties}
    >
      <button
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
      </button>
      {children}
    </div>
  )
}

function UnboundGroup({ children, count, highlight }: { readonly children: ReactNode; readonly count: number; readonly highlight: boolean }) {
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
      channelIdsByAgent: Object.fromEntries(tree.agents.map((group) => [group.agent.id, group.channels.map((channel) => channel.id)])),
      unboundChannelIds: tree.unbound.map((channel) => channel.id),
      channelAgentId,
    }
  }, [tree])
  const recent = useMemo(() => {
    const time = (channel: ChannelActivity) => channel.lastActivityAt ?? 0
    return [...channels].sort((left, right) => time(right) - time(left))
  }, [channels])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const collision: CollisionDetection = (args) => {
    const hits = pointerWithin(args).map((hit) => String(hit.id))
    if (hits.length) {
      const picked = pickWorkTreeCollision({ activeId: String(args.active.id), pointerHits: hits, channelOwnerById: lists.channelAgentId })
      if (picked) return [{ id: picked }]
    }
    return closestCenter(args)
  }

  const onDragEnd = (event: DragEndEvent) => {
    setActiveId('')
    setOverId('')
    window.setTimeout(() => (dragged.current = false), 80)
    const resolution = resolveWorkTreeDragEnd({ activeId: String(event.active.id), overId: event.over ? String(event.over.id) : '', lists })
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

  const suppressClick = (event: MouseEvent) => {
    if (dragged.current) event.preventDefault()
  }
  const activeChannelId = parsePrefixedId(activeId, CHANNEL_SORT_PREFIX)
  const activeChannel = activeChannelId ? channels.find((channel) => channel.id === activeChannelId) : undefined
  const activeAgentId = parsePrefixedId(activeId, AGENT_SORT_PREFIX)
  const activeAgent = activeAgentId ? agentById.get(activeAgentId) : undefined
  const overAgent = parsePrefixedId(overId, AGENT_SORT_PREFIX)
  const sourceAgent = activeChannelId ? (lists.channelAgentId[activeChannelId] ?? '') : ''
  const highlightAgent = activeChannel && overAgent && overAgent !== sourceAgent ? overAgent : ''
  const highlightUnbound = Boolean(activeChannel && sourceAgent && overId === UNBOUND_DROP_ID)
  const selectedAgent = selectedId ? agentById.get(channels.find((channel) => channel.id === selectedId)?.agentId ?? '') : undefined

  return (
    <aside className={styles.list} aria-label="频道">
      <div className={styles.listHead}>
        <h2 className={styles.listTitle}>频道</h2>
        <span className={styles.listCount}>{channels.length}</span>
      </div>
      <Segmented
        className={styles.viewSwitch}
        label="排列方式"
        value={mode}
        onChange={setMode}
        options={[
          { value: 'agent', label: '按智能体' },
          { value: 'recent', label: '最近活动' },
        ]}
      />
      <div className={styles.listBody}>
        <SelectionList selectedKey={`${mode}:${selectedId ?? ''}`} accent={selectedAgent ? agentAccent(selectedAgent) : undefined}>
          {mode === 'recent' ? (
            recent.map((channel) => (
              <Link
                key={channel.id}
                to={`/channels/${channel.id}`}
                className={styles.row}
                data-selected={channel.id === selectedId}
                aria-current={channel.id === selectedId ? 'page' : undefined}
              >
                <RowContent channel={channel} agent={agentById.get(channel.agentId)} connection={connectionById.get(channel.connectionId)} mode="recent" />
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
              }}
              onDragEnd={onDragEnd}
              accessibility={{
                screenReaderInstructions: { draggable: '按空格开始拖动，用方向键移动，再按空格放下，按 Esc 取消。跨智能体放下会先确认。' },
              }}
            >
              <SortableContext items={lists.agentIds.map(agentSortId)} strategy={verticalListSortingStrategy}>
                {tree.agents.map((group) => (
                  <AgentGroup key={group.agent.id} agent={group.agent} highlight={highlightAgent === group.agent.id}>
                    <SortableContext items={group.channels.map((channel) => channelSortId(channel.id))} strategy={verticalListSortingStrategy}>
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
                <SortableContext items={tree.unbound.map((channel) => channelSortId(channel.id))} strategy={verticalListSortingStrategy}>
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
              <DragOverlay dropAnimation={{ duration: 220, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }}>
                {activeChannel ? <div className={styles.dragOverlay}>{activeChannel.name}</div> : activeAgent ? <div className={styles.dragOverlay}>{activeAgent.name}</div> : null}
              </DragOverlay>
            </DndContext>
          )}
        </SelectionList>
      </div>
      <BindDialog intent={intent} onClose={() => setIntent(null)} />
    </aside>
  )
}
