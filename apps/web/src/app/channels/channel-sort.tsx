import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  useSensor,
  useSensors,
  type Modifier,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS as DndCSS } from '@dnd-kit/utilities'
import { MenuIcon, Pin } from 'lucide-react'
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useLocation } from 'react-router-dom'
import type { AgentSummary, ChannelSummary } from '../../product-runtime.js'
import { AgentAvatar, cssVars, MemberAvatar, Pressable, usePhone } from '../../ui-kit/index.js'
import { agentAccent, agentHue, agentPhase, isAgentWorking } from '../model/identity.js'
import { useGo } from '../model/nav.js'
import { useBackTo } from '../shell/back.js'
import { PageBarActions } from '../shell/crumb.js'
import styles from './channels.module.css'

/**
 * Sort mode is a history entry of its own on the phone's channel list (05 §6.2): the system's back step, the bottom
 * bar or any other page leaves it, and the top bar's back arrow and “完成” take that same step.
 */
const SORT_STATE_KEY = 'channelSort'

export function useChannelSorting(): {
  readonly sorting: boolean
  readonly enter: () => void
  readonly exit: () => void
} {
  const location = useLocation()
  const phone = usePhone()
  const go = useGo()
  const back = useBackTo()
  const state: unknown = location.state
  const sorting =
    phone &&
    location.pathname === '/channels' &&
    typeof state === 'object' &&
    state !== null &&
    SORT_STATE_KEY in state &&
    state[SORT_STATE_KEY] === true
  return {
    sorting,
    enter: () => go('/channels', { state: { [SORT_STATE_KEY]: true } }),
    exit: () => back('/channels'),
  }
}

/** Where a row sat on screen before the list changed shape, so the list can put it back there. */
export type RowAnchor = { readonly key: string; readonly top: number }

export const channelRowKey = (channelId: string): string => `channel:${channelId}`
export const agentRowKey = (agentId: string): string => `agent:${agentId}`

const scrollerOf = (element: HTMLElement): HTMLElement | undefined => {
  for (let node = element.parentElement; node; node = node.parentElement) {
    if (/auto|scroll/u.test(getComputedStyle(node).overflowY)) return node
  }
  return undefined
}

/** The first row whose lower half is still in view inside `root`'s scroll area. */
export const firstVisibleRow = (root: HTMLElement | null): RowAnchor | undefined => {
  const rows = root ? [...root.querySelectorAll<HTMLElement>('[data-row-key]')] : []
  const scroller = rows[0] ? scrollerOf(rows[0]) : undefined
  const top = scroller?.getBoundingClientRect().top ?? 0
  for (const row of rows) {
    const box = row.getBoundingClientRect()
    if (box.top + box.height / 2 >= top) return { key: row.dataset['rowKey'] ?? '', top: box.top }
  }
  return undefined
}

const rowByKey = (root: HTMLElement, key: string): HTMLElement | null =>
  root.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(key)}"]`)

/** Where the row `key` sits on screen now. */
export const rowAnchor = (root: HTMLElement | null, key: string): RowAnchor | undefined => {
  const row = root ? rowByKey(root, key) : null
  return row ? { key, top: row.getBoundingClientRect().top } : undefined
}

/** Scrolls `root`'s list so the row `anchor` names is back where it was. */
export const restoreAnchor = (root: HTMLElement | null, anchor: RowAnchor | undefined): void => {
  if (!root || !anchor) return
  const row = rowByKey(root, anchor.key)
  const scroller = row ? scrollerOf(row) : undefined
  if (!row || !scroller) return
  scroller.scrollTop += row.getBoundingClientRect().top - anchor.top
}

const motionReduced = (): boolean =>
  document.documentElement.dataset['nxtMotion'] === 'off' ||
  (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)

/** --ease and --dur-2 (tokens.css): rows making room move like the rest of the interface. */
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)'
const SETTLE_MS = 280

/** A short tick where the device has one, on picking a row up and on putting it down. */
const tick = () => {
  try {
    navigator.vibrate?.(8)
  } catch {
    // Nothing on devices without it.
  }
}

/**
 * Keeps the dragged row on the list's line and inside its own container, whose box is read live (it moves while
 * the list scrolls under the finger). Beyond either end the row stops at the end, so it can only land inside.
 */
const keepInside =
  (container: { readonly current: HTMLElement | null }): Modifier =>
  ({ transform, draggingNodeRect }) => {
    const box = container.current?.getBoundingClientRect()
    if (!box || !draggingNodeRect) return { ...transform, x: 0 }
    const highest = box.top - draggingNodeRect.top
    const lowest = box.bottom - draggingNodeRect.bottom
    return { ...transform, x: 0, y: Math.max(highest, Math.min(lowest, transform.y)) }
  }

/** The handle that drags a row; only it starts a drag, so a finger elsewhere on the row scrolls the list. */
function Handle({
  label,
  handle,
}: {
  readonly label: string
  readonly handle?: ReturnType<typeof useSortable> | undefined
}) {
  if (!handle)
    return (
      <span className={styles.sortHandle} aria-hidden="true">
        <MenuIcon />
      </span>
    )
  return (
    <Pressable
      type="button"
      ref={handle.setActivatorNodeRef}
      className={styles.sortHandle}
      {...handle.attributes}
      {...handle.listeners}
      aria-roledescription="排序手柄"
      aria-label={label}
    >
      <MenuIcon aria-hidden="true" />
    </Pressable>
  )
}

const sortableStyle = (sortable: ReturnType<typeof useSortable>): CSSProperties => ({
  transform: DndCSS.Translate.toString(sortable.transform),
  transition: sortable.transition,
})

function SortRow({ id, name, rowKey, children }: SortItemProps) {
  const sortable = useSortable({ id, transition: motionReduced() ? null : { duration: SETTLE_MS, easing: EASE } })
  return (
    <div
      ref={sortable.setNodeRef}
      className={styles.sortRow}
      data-row-key={rowKey}
      data-dragging={sortable.isDragging || undefined}
      style={sortableStyle(sortable)}
    >
      <div className={styles.sortRowBody}>{children}</div>
      <Handle label={`调整「${name}」的位置`} handle={sortable} />
    </div>
  )
}

type SortItemProps = {
  readonly id: string
  readonly name: string
  readonly rowKey: string
  readonly children: ReactNode
}

/**
 * One container's rows, sortable among themselves only: each container has its own drag context, so a row can
 * never land in another one (no binding changes here). `onMove` saves the move from one index to another.
 */
function SortList({
  label,
  ids,
  nameOf,
  onMove,
  onLift,
  renderItem,
  renderLifted,
}: {
  readonly label: string
  readonly ids: readonly string[]
  readonly nameOf: (id: string) => string
  readonly onMove: (from: number, to: number) => void
  readonly onLift?: (lifted: boolean) => void
  readonly renderItem: (id: string) => ReactNode
  readonly renderLifted: (id: string) => ReactNode
}) {
  const container = useRef<HTMLDivElement>(null)
  const [activeId, setActiveId] = useState('')
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 3 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const modifiers = useMemo(() => [keepInside(container)], [])
  const settle = () => {
    setActiveId('')
    onLift?.(false)
  }
  const quote = (id: string) => `「${nameOf(id)}」`
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={modifiers}
      // Rows move while a group folds or the list scrolls; measure them as they are.
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragStart={(event) => {
        window.getSelection()?.removeAllRanges()
        tick()
        setActiveId(String(event.active.id))
        onLift?.(true)
      }}
      onDragCancel={settle}
      onDragEnd={(event) => {
        settle()
        tick()
        const from = ids.indexOf(String(event.active.id))
        const to = event.over ? ids.indexOf(String(event.over.id)) : -1
        if (from >= 0 && to >= 0 && from !== to) onMove(from, to)
      }}
      accessibility={{
        screenReaderInstructions: {
          draggable: `在${label}内调整顺序：按空格拿起，用方向键移动，再按空格放下，按 Esc 取消。`,
        },
        announcements: {
          onDragStart: ({ active }) => `已拿起${quote(String(active.id))}`,
          onDragOver: ({ active, over }) =>
            over ? `${quote(String(active.id))}移到${quote(String(over.id))}的位置` : `${quote(String(active.id))}`,
          onDragEnd: ({ active, over }) =>
            over
              ? `${quote(String(active.id))}放在${quote(String(over.id))}的位置`
              : `${quote(String(active.id))}已放回原处`,
          onDragCancel: ({ active }) => `${quote(String(active.id))}已放回原处`,
        },
      }}
    >
      <SortableContext items={[...ids]} strategy={verticalListSortingStrategy}>
        <div ref={container} className={styles.sortList}>
          {ids.map(renderItem)}
        </div>
      </SortableContext>
      {createPortal(
        <DragOverlay
          style={{ pointerEvents: 'none' }}
          dropAnimation={motionReduced() ? null : { duration: SETTLE_MS, easing: EASE }}
        >
          {activeId ? renderLifted(activeId) : null}
        </DragOverlay>,
        document.body,
      )}
    </DndContext>
  )
}

/** The raised copy of a row that follows the finger. */
function Lifted({ children }: { readonly children: ReactNode }) {
  return (
    <div className={[styles.sortRow, styles.sortLifted].join(' ')}>
      <div className={styles.sortRowBody}>{children}</div>
      <Handle label="" />
    </div>
  )
}

function GroupHead({ agent }: { readonly agent: AgentSummary }) {
  return (
    <div className={styles.groupHead}>
      <AgentAvatar name={agent.name} hue={agentHue(agent)} size="sm" live={isAgentWorking(agent)} />
      <span className={styles.groupName}>{agent.name}</span>
      <span className={styles.groupMeta}>{agentPhase[agent.state].label}</span>
    </div>
  )
}

/** An agent's group: its head carries the handle that moves the whole group. */
function SortGroup({
  agent,
  folded,
  children,
}: {
  readonly agent: AgentSummary
  readonly folded: boolean
  readonly children: ReactNode
}) {
  const sortable = useSortable({
    id: agentRowKey(agent.id),
    transition: motionReduced() ? null : { duration: SETTLE_MS, easing: EASE },
  })
  return (
    <div
      className={styles.group}
      data-dragging={sortable.isDragging || undefined}
      style={{ ...sortableStyle(sortable), ...cssVars({ '--group-accent': agentAccent(agent) }) }}
    >
      {/* The head is what sorts: while a group moves every group folds to its head. */}
      <div ref={sortable.setNodeRef} className={styles.groupHeadRow} data-row-key={agentRowKey(agent.id)}>
        <GroupHead agent={agent} />
        <Handle label={`调整「${agent.name}」分组的位置`} handle={sortable} />
      </div>
      {folded ? null : children}
    </div>
  )
}

export type SortGroups = {
  readonly pinned: readonly ChannelSummary[]
  readonly agents: readonly { readonly agent: AgentSummary; readonly channels: readonly ChannelSummary[] }[]
  readonly unbound: readonly ChannelSummary[]
}

/**
 * The phone's sort mode (05 §6.2): the whole arrangement — pins, each agent's group with its channels, 未接线 — with
 * a handle on every row and group head. Rows are not links here; each container sorts only within itself and saves
 * on release. `anchor` receives the first row in view as the mode closes, so the list can keep its place.
 */
export function SortModeList({
  groups,
  renderRow,
  onMovePinned,
  onMoveChannels,
  onMoveAgents,
  onDone,
  leaving,
}: {
  readonly groups: SortGroups
  readonly renderRow: (channel: ChannelSummary, inPins: boolean) => ReactNode
  readonly onMovePinned: (from: number, to: number) => void
  /** `agentId` is empty for 未接线. */
  readonly onMoveChannels: (agentId: string, from: number, to: number) => void
  readonly onMoveAgents: (from: number, to: number) => void
  readonly onDone: () => void
  readonly leaving: (anchor: RowAnchor | undefined) => void
}) {
  const [folded, setFolded] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const latestLeaving = useRef(leaving)
  latestLeaving.current = leaving
  // Runs before the rows leave the page: the list behind takes its place from the first row still in view.
  useLayoutEffect(() => {
    const node = root.current
    return () => latestLeaving.current(firstVisibleRow(node))
  }, [])
  const channelById = new Map(
    [...groups.pinned, ...groups.agents.flatMap((group) => group.channels), ...groups.unbound].map((channel) => [
      channel.id,
      channel,
    ]),
  )
  const channelName = (id: string) => channelById.get(id)?.name ?? '未命名'
  const channelList = (label: string, channels: readonly ChannelSummary[], agentId: string) => (
    <SortList
      label={label}
      ids={channels.map((channel) => channel.id)}
      nameOf={channelName}
      onMove={(from, to) => onMoveChannels(agentId, from, to)}
      renderItem={(id) => {
        const channel = channelById.get(id)
        return channel ? (
          <SortRow key={id} id={id} name={channel.name} rowKey={channelRowKey(id)}>
            {renderRow(channel, false)}
          </SortRow>
        ) : null
      }}
      renderLifted={(id) => {
        const channel = channelById.get(id)
        return channel ? <Lifted>{renderRow(channel, false)}</Lifted> : null
      }}
    />
  )
  const agentIds = groups.agents.map((group) => agentRowKey(group.agent.id))
  const groupByKey = new Map(groups.agents.map((group) => [agentRowKey(group.agent.id), group]))
  return (
    <div ref={root} className={styles.sortMode}>
      <PageBarActions>
        <Pressable type="button" className={styles.sortDone} onClick={onDone}>
          完成
        </Pressable>
      </PageBarActions>
      {groups.pinned.length ? (
        <div className={styles.group} role="group" aria-label="置顶">
          <div className={[styles.groupHead, styles.unboundHead].join(' ')}>
            <span className={styles.pinnedIcon} aria-hidden="true">
              <Pin size={14} />
            </span>
            置顶
          </div>
          <SortList
            label="置顶"
            ids={groups.pinned.map((channel) => channel.id)}
            nameOf={channelName}
            onMove={onMovePinned}
            renderItem={(id) => {
              const channel = channelById.get(id)
              return channel ? (
                <SortRow key={id} id={id} name={channel.name} rowKey={channelRowKey(id)}>
                  {renderRow(channel, true)}
                </SortRow>
              ) : null
            }}
            renderLifted={(id) => {
              const channel = channelById.get(id)
              return channel ? <Lifted>{renderRow(channel, true)}</Lifted> : null
            }}
          />
        </div>
      ) : null}
      <SortList
        label="智能体分组"
        ids={agentIds}
        nameOf={(id) => groupByKey.get(id)?.agent.name ?? '未命名'}
        onMove={onMoveAgents}
        onLift={setFolded}
        renderItem={(id) => {
          const group = groupByKey.get(id)
          return group ? (
            <SortGroup key={id} agent={group.agent} folded={folded}>
              {channelList(`「${group.agent.name}」`, group.channels, group.agent.id)}
            </SortGroup>
          ) : null
        }}
        renderLifted={(id) => {
          const group = groupByKey.get(id)
          return group ? (
            <div className={[styles.groupHeadRow, styles.sortLifted].join(' ')}>
              <GroupHead agent={group.agent} />
              <Handle label="" />
            </div>
          ) : null
        }}
      />
      {groups.unbound.length ? (
        <div className={styles.group} role="group" aria-label="未接线">
          <div className={[styles.groupHead, styles.unboundHead].join(' ')}>
            <MemberAvatar name="?" size="sm" />
            未接线
            <span className={styles.groupMeta}>{groups.unbound.length}</span>
          </div>
          {channelList('未接线', groups.unbound, '')}
        </div>
      ) : null}
    </div>
  )
}
