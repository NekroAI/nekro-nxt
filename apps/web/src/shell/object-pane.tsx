import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type KeyboardCoordinateGetter,
  type Modifier,
} from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS, type Transform } from '@dnd-kit/utilities'
import {
  Cable,
  CircleHelp,
  Cpu,
  MessageSquare,
  Move,
  PackageOpen,
  Palette,
  Plus,
  Puzzle,
  Settings,
  UsersRound,
} from 'lucide-react'
import { useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import { useLocation, useParams } from 'react-router-dom'
import { BindingChangeDialog, type BindingChangeIntent } from '../pages/binding-change.js'
import { notify } from '../components/notifications.js'
import { AgentAccessChip } from '../components/agent-access-chip.js'
import { connectionDisplayName, useProductStore, type AgentSummary, type ChannelSummary } from '../product-store.js'
import { NxtLink, NxtNavLink } from './nxt-link.js'
import { ConfirmDialog, Field, IconButton, Input, NavGlyph, NavMarkGroup, Tooltip } from '../ui-kit/index.js'
import styles from '../pages/product-pages.module.css'
import shell from '../app.module.css'
import {
  AGENT_SORT_PREFIX,
  CHANNEL_SORT_PREFIX,
  UNBOUND_DROP_ID,
  agentSortId,
  applyWorkTreeDragResolution,
  buildWorkTree,
  channelSortId,
  parsePrefixedId,
  pickWorkTreeCollision,
  resolveWorkTreeDragEnd,
} from './work-tree-order.js'

const restrictToVerticalAxis: Modifier = ({ transform }) => ({ ...transform, x: 0 })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const sortableContainerId = (value: unknown): string => {
  if (!isRecord(value)) return ''
  const sortable = value['sortable']
  if (!isRecord(sortable)) return ''
  const containerId = sortable['containerId']
  return typeof containerId === 'string' ? containerId : ''
}

const workTreeKeyboardCoordinates: KeyboardCoordinateGetter = (event, { active, currentCoordinates, context }) => {
  if (event.code !== 'ArrowDown' && event.code !== 'ArrowUp') return undefined
  const collisionRect = context.collisionRect
  const activeContainer = context.droppableContainers.get(active)
  const containerId = sortableContainerId(activeContainer?.data.current)
  if (!collisionRect || !containerId) return undefined

  event.preventDefault()
  const candidates = context.droppableContainers
    .getEnabled()
    .flatMap((container) => {
      if (container.id === active || sortableContainerId(container.data.current) !== containerId) return []
      const rect = context.droppableRects.get(container.id)
      if (!rect) return []
      if (event.code === 'ArrowDown' && rect.top <= collisionRect.top) return []
      if (event.code === 'ArrowUp' && rect.top >= collisionRect.top) return []
      return [{ rect, distance: Math.abs(rect.top - collisionRect.top) }]
    })
    .sort((left, right) => left.distance - right.distance)
  const next = candidates[0]?.rect
  if (!next) return currentCoordinates
  return {
    x: currentCoordinates.x,
    y: currentCoordinates.y + next.top - collisionRect.top,
  }
}

const sortableStyle = (
  transform: Transform | null,
  transition: string | undefined,
  dragging: boolean,
): CSSProperties => ({
  transform: CSS.Translate.toString(dragging ? null : transform),
  transition: dragging ? undefined : transition,
})

const TreeActivityIndicator = ({ state }: { readonly state: AgentSummary['state'] }) => (
  <span
    className={styles.treeActivityIndicator}
    data-runtime-state={state}
    role="img"
    aria-label={`运行状态：${state}`}
  />
)

const ChannelRowBody = ({ item }: { readonly item: ChannelSummary; readonly active?: boolean }) => (
  <>
    {item.kind === 'web' ? <MessageSquare size={15} aria-hidden="true" /> : <UsersRound size={15} aria-hidden="true" />}
    <span className={styles.treeCopy}>
      <strong>{item.name}</strong>
      <small>{item.connectionName}</small>
    </span>
    {item.runtimePhase !== '空闲' ? (
      <span className={styles.treeStateIndicator} data-tree-state-indicator>
        <TreeActivityIndicator state={item.runtimePhase} />
      </span>
    ) : item.unread > 0 ? (
      <span className={styles.unread}>{item.unread}</span>
    ) : null}
  </>
)

const AgentHeaderBody = ({
  agent,
  hint,
}: {
  readonly agent: Pick<AgentSummary, 'name' | 'state' | 'capabilities'>
  readonly hint: string
  readonly active?: boolean
}) => (
  <>
    <span className={styles.agentAvatar}>{agent.name.slice(0, 1)}</span>
    <span className={styles.treeCopy}>
      <span className={styles.agentNameLine}>
        <strong>{agent.name}</strong>
        <AgentAccessChip capabilities={agent.capabilities} />
      </span>
      <small>{hint}</small>
    </span>
    {agent.state !== '空闲' ? (
      <span className={styles.treeStateIndicator} data-tree-state-indicator>
        <TreeActivityIndicator state={agent.state} />
      </span>
    ) : null}
  </>
)

function SortableChannelLink({
  item,
  active,
  onGuardedClick,
}: {
  readonly item: ChannelSummary
  readonly active: boolean
  readonly onGuardedClick: (event: MouseEvent<HTMLAnchorElement>) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: channelSortId(item.id),
    animateLayoutChanges: () => false,
    data: { type: 'channel', channelId: item.id },
  })
  const { onKeyDown: onSortableKeyDown, onPointerDown: onSortablePointerDown } = listeners ?? {}
  return (
    <div
      ref={setNodeRef}
      style={sortableStyle(transform, transition, isDragging)}
      className={[styles.channelRow, isDragging ? styles.sortableOrigin : ''].filter(Boolean).join(' ')}
      onPointerDown={(event) => {
        onSortablePointerDown?.(event)
      }}
    >
      <NxtLink
        to={`/work/channels/${item.id}`}
        className={[styles.channelLink, active ? styles.channelLinkActive : ''].filter(Boolean).join(' ')}
        aria-current={active ? 'page' : undefined}
        data-nav-active={active ? '' : undefined}
        onClick={onGuardedClick}
      >
        <ChannelRowBody item={item} active={active} />
      </NxtLink>
      <IconButton
        label={`拖动“${item.name}”排序`}
        className={styles.treeRowDragHandle}
        data-work-tree-drag={`channel:${item.id}`}
        {...attributes}
        onKeyDown={(event) => {
          if (!event.defaultPrevented) onSortableKeyDown?.(event)
        }}
      >
        <Move size={14} aria-hidden="true" />
      </IconButton>
    </div>
  )
}

function SortableAgentSection({
  agent,
  channels,
  to,
  active,
  dropActive,
  channelActiveId,
  onGuardedClick,
}: {
  readonly agent: AgentSummary
  readonly channels: readonly ChannelSummary[]
  readonly to: string
  readonly active: boolean
  readonly dropActive: boolean
  readonly channelActiveId: string | undefined
  readonly onGuardedClick: (event: MouseEvent<HTMLAnchorElement>) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: agentSortId(agent.id),
    animateLayoutChanges: () => false,
    data: { type: 'agent', agentId: agent.id },
  })
  const { onKeyDown: onSortableKeyDown, onPointerDown: onSortablePointerDown } = listeners ?? {}
  const channelIds = channels.map((item) => channelSortId(item.id))
  return (
    <section
      ref={setNodeRef}
      style={sortableStyle(transform, transition, isDragging)}
      className={[styles.channelGroup, dropActive ? styles.dropTarget : '', isDragging ? styles.sortableOrigin : '']
        .filter(Boolean)
        .join(' ')}
    >
      <div
        className={styles.agentHeaderRow}
        onPointerDown={(event) => {
          onSortablePointerDown?.(event)
        }}
      >
        <NxtLink
          to={to}
          className={[
            styles.channelGroupHeader,
            active ? styles.channelGroupHeaderActive : '',
            dropActive ? styles.dropTarget : '',
          ]
            .filter(Boolean)
            .join(' ')}
          aria-current={active ? 'page' : undefined}
          data-nav-active={active ? '' : undefined}
          onClick={onGuardedClick}
        >
          <AgentHeaderBody
            agent={agent}
            hint={channels.length > 0 ? `${channels.length} 个频道` : '还没有绑定频道'}
            active={active}
          />
        </NxtLink>
        <IconButton
          label={`拖动“${agent.name}”及其频道排序`}
          className={styles.treeRowDragHandle}
          {...attributes}
          onKeyDown={(event) => {
            if (!event.defaultPrevented) onSortableKeyDown?.(event)
          }}
        >
          <Move size={14} aria-hidden="true" />
        </IconButton>
      </div>
      {channelIds.length > 0 ? (
        <SortableContext items={channelIds} strategy={verticalListSortingStrategy}>
          {channels.map((item) => (
            <SortableChannelLink
              key={`${agent.id}-${item.id}`}
              item={item}
              active={item.id === channelActiveId}
              onGuardedClick={onGuardedClick}
            />
          ))}
        </SortableContext>
      ) : null}
    </section>
  )
}

function UnboundSection({
  active,
  channels,
  channelActiveId,
  onGuardedClick,
  onCreate,
}: {
  readonly active: boolean
  readonly channels: readonly ChannelSummary[]
  readonly channelActiveId: string | undefined
  readonly onGuardedClick: (event: MouseEvent<HTMLAnchorElement>) => void
  readonly onCreate: () => void
}) {
  const { setNodeRef } = useDroppable({ id: UNBOUND_DROP_ID })
  const channelIds = channels.map((item) => channelSortId(item.id))
  return (
    <section
      ref={setNodeRef}
      className={[styles.channelGroup, active ? styles.dropTarget : ''].filter(Boolean).join(' ')}
    >
      <div className={[styles.channelGroupHeader, active ? styles.dropTarget : ''].filter(Boolean).join(' ')}>
        <span className={styles.agentAvatar}>?</span>
        <span className={styles.treeCopy}>
          <strong>未绑定频道</strong>
          <small>{channels.length > 0 ? `${channels.length} 个频道` : '把频道拖到这里以解除绑定'}</small>
        </span>
        <IconButton
          label="新建内置频道"
          className={shell.treeAdd}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onCreate}
        >
          <Plus size={14} aria-hidden="true" />
        </IconButton>
      </div>
      {channelIds.length > 0 ? (
        <SortableContext items={channelIds} strategy={verticalListSortingStrategy}>
          {channels.map((item) => (
            <SortableChannelLink
              key={item.id}
              item={item}
              active={item.id === channelActiveId}
              onGuardedClick={onGuardedClick}
            />
          ))}
        </SortableContext>
      ) : null}
    </section>
  )
}

function WorkTree() {
  const { agentId, channelId } = useParams()
  const location = useLocation()
  const host = useProductStore((state) => state.host)
  const agents = useProductStore((state) => state.agents)
  const channels = useProductStore((state) => state.channels)
  const workTreeOrder = useProductStore((state) => state.workTreeOrder)
  const [overId, setOverId] = useState('')
  const [activeId, setActiveId] = useState('')
  const [intent, setIntent] = useState<BindingChangeIntent>()
  const [createWebOpen, setCreateWebOpen] = useState(false)
  const [webChannelName, setWebChannelName] = useState('内置频道')
  const treeBodyRef = useRef<HTMLDivElement>(null)
  const suppressClickRef = useRef(false)
  const keyboardDragRef = useRef(false)
  const channelOwnerRef = useRef<Readonly<Record<string, string>>>({})
  const focusChannelAfterDialogRef = useRef('')
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: workTreeKeyboardCoordinates }),
  )
  const tree = buildWorkTree(agents, channels, workTreeOrder)
  const channelOwnerById = Object.fromEntries(channels.map((item) => [item.id, item.agentId]))
  channelOwnerRef.current = channelOwnerById
  const dragLists = {
    agentIds: tree.agents.map((group) => group.agent.id),
    channelIdsByAgent: Object.fromEntries(
      tree.agents.map((group) => [group.agent.id, group.channels.map((item) => item.id)]),
    ),
    unboundChannelIds: tree.unbound.map((item) => item.id),
    channelAgentId: channelOwnerById,
  }
  const collisionDetection = useMemo<CollisionDetection>(
    () => (args) => {
      const active = String(args.active.id)
      const pointerHits = pointerWithin(args)
      const picked = pickWorkTreeCollision({
        activeId: active,
        pointerHits: pointerHits.map((hit) => String(hit.id)),
        channelOwnerById: channelOwnerRef.current,
      })
      if (parsePrefixedId(active, AGENT_SORT_PREFIX)) {
        if (picked) {
          const hit = pointerHits.find((candidate) => String(candidate.id) === picked)
          if (hit) return [hit]
        }
        return closestCenter({
          ...args,
          droppableContainers: args.droppableContainers.filter(
            (container) =>
              String(container.id).startsWith(AGENT_SORT_PREFIX) &&
              (!keyboardDragRef.current || String(container.id) !== active),
          ),
        })
      }
      if (picked) {
        const hit = pointerHits.find((candidate) => String(candidate.id) === picked)
        if (hit) return [hit]
        const container = args.droppableContainers.find((candidate) => String(candidate.id) === picked)
        return container ? [{ id: container.id }] : []
      }
      const sourceChannelId = parsePrefixedId(active, CHANNEL_SORT_PREFIX)
      if (!sourceChannelId) return []
      const sourceOwner = channelOwnerRef.current[sourceChannelId] ?? ''
      if (keyboardDragRef.current) {
        return closestCenter({
          ...args,
          droppableContainers: args.droppableContainers.filter((container) => {
            const channelId = parsePrefixedId(String(container.id), CHANNEL_SORT_PREFIX)
            return (
              channelId !== undefined &&
              String(container.id) !== active &&
              (channelOwnerRef.current[channelId] ?? '') === sourceOwner
            )
          }),
        })
      }
      const sourceGroupId = sourceOwner ? agentSortId(sourceOwner) : UNBOUND_DROP_ID
      const sourceGroup = args.droppableContainers.find((container) => String(container.id) === sourceGroupId)
      const pointer = args.pointerCoordinates
      const sourceRect = sourceGroup?.rect.current
      const inSourceGroup = Boolean(
        sourceRect && pointer && pointer.y >= sourceRect.top && pointer.y <= sourceRect.bottom,
      )
      if (inSourceGroup) {
        return closestCenter({
          ...args,
          droppableContainers: args.droppableContainers.filter((container) => {
            const channelId = parsePrefixedId(String(container.id), CHANNEL_SORT_PREFIX)
            return channelId !== undefined && (channelOwnerRef.current[channelId] ?? '') === sourceOwner
          }),
        })
      }
      return closestCenter({
        ...args,
        droppableContainers: args.droppableContainers.filter(
          (container) => String(container.id).startsWith(AGENT_SORT_PREFIX) || String(container.id) === UNBOUND_DROP_ID,
        ),
      })
    },
    [],
  )
  const onAgent = location.pathname.startsWith('/work/agents/')
  const onCreator = location.pathname.startsWith('/work/creator')
  const channelActiveId = onAgent || onCreator ? undefined : channelId
  const activeChannel = parsePrefixedId(activeId, CHANNEL_SORT_PREFIX)
    ? channels.find((item) => item.id === parsePrefixedId(activeId, CHANNEL_SORT_PREFIX))
    : undefined
  const activeAgent = parsePrefixedId(activeId, AGENT_SORT_PREFIX)
    ? tree.agents.find((group) => group.agent.id === parsePrefixedId(activeId, AGENT_SORT_PREFIX))
    : undefined
  const overAgentId = parsePrefixedId(overId, AGENT_SORT_PREFIX)
  const dropActiveAgentId =
    activeChannel && overAgentId && overAgentId !== (channelOwnerById[activeChannel.id] ?? '') ? overAgentId : ''
  const dropUnbound = Boolean(activeChannel && overId === UNBOUND_DROP_ID && activeChannel.agentId)
  const persistOrder = (next: typeof workTreeOrder): void => {
    void useProductStore
      .getState()
      .putWorkTreeOrder(next)
      .catch((error: unknown) => {
        notify(error instanceof Error ? error.message : String(error), 'error', 'work-tree-order')
      })
  }
  const openBindingIntent = (nextIntent: BindingChangeIntent): void => {
    focusChannelAfterDialogRef.current = nextIntent.channelId
    setIntent(nextIntent)
  }
  const restoreChannelActionFocus = (): void => {
    const channelId = focusChannelAfterDialogRef.current
    focusChannelAfterDialogRef.current = ''
    if (!channelId) return
    window.setTimeout(() => {
      treeBodyRef.current?.querySelector<HTMLButtonElement>(`[data-work-tree-drag="channel:${channelId}"]`)?.focus()
    }, 0)
  }
  const guardClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (!suppressClickRef.current) return
    event.preventDefault()
    suppressClickRef.current = false
  }
  const onDragEnd = (event: DragEndEvent): void => {
    const nextActiveId = String(event.active.id)
    const nextOverId = event.over ? String(event.over.id) : ''
    setOverId('')
    setActiveId('')
    keyboardDragRef.current = false
    const resolution = resolveWorkTreeDragEnd({
      activeId: nextActiveId,
      overId: nextOverId,
      lists: dragLists,
    })
    if (resolution.kind === 'bind' || resolution.kind === 'replace') {
      openBindingIntent({ kind: resolution.kind, channelId: resolution.channelId, agentId: resolution.agentId })
      window.setTimeout(() => {
        suppressClickRef.current = false
      }, 0)
      return
    }
    if (resolution.kind === 'unbind') {
      openBindingIntent({ kind: 'clear', channelId: resolution.channelId })
      window.setTimeout(() => {
        suppressClickRef.current = false
      }, 0)
      return
    }
    const nextOrder = applyWorkTreeDragResolution(
      {
        agentIds: dragLists.agentIds,
        channelIdsByAgent: { ...workTreeOrder.channelIdsByAgent, ...dragLists.channelIdsByAgent },
        unboundChannelIds: dragLists.unboundChannelIds,
      },
      resolution,
    )
    if (nextOrder) persistOrder(nextOrder)
    window.setTimeout(() => {
      suppressClickRef.current = false
    }, 0)
  }

  const agentIds = tree.agents.map((group) => agentSortId(group.agent.id))

  return (
    <>
      <div className={shell.treeHead}>
        <span>
          <MessageSquare size={14} aria-hidden="true" /> 频道与智能体
        </span>
        <NxtLink className={shell.treeAdd} to="/work/agents/new" aria-label="创建智能体">
          <Plus size={14} aria-hidden="true" />
        </NxtLink>
      </div>
      <div className={shell.treeBody} ref={treeBodyRef}>
        {channels.length === 0 && agents.length === 0 ? (
          <div className={styles.railEmpty}>{host.status === 'initializing' ? '正在读取…' : '还没有智能体'}</div>
        ) : (
          <NavMarkGroup id="work-nav">
            <DndContext
              sensors={sensors}
              collisionDetection={collisionDetection}
              modifiers={[restrictToVerticalAxis]}
              accessibility={{
                screenReaderInstructions: {
                  draggable:
                    '按空格开始排序，使用上、下方向键移动；再次按空格放下，按 Escape 取消。绑定、换绑和解绑也可在频道或智能体管理页面完成。',
                },
              }}
              autoScroll={{
                canScroll: (element) => element === treeBodyRef.current,
                layoutShiftCompensation: false,
              }}
              onDragStart={(event) => {
                suppressClickRef.current = true
                keyboardDragRef.current = event.activatorEvent instanceof KeyboardEvent
                setActiveId(String(event.active.id))
              }}
              onDragOver={(event) => {
                const current = event.over ? String(event.over.id) : ''
                const bindTarget =
                  parsePrefixedId(String(event.active.id), CHANNEL_SORT_PREFIX) &&
                  (current.startsWith(AGENT_SORT_PREFIX) || current === UNBOUND_DROP_ID)
                setOverId(bindTarget ? current : '')
              }}
              onDragCancel={() => {
                setOverId('')
                setActiveId('')
                keyboardDragRef.current = false
                window.setTimeout(() => {
                  suppressClickRef.current = false
                }, 0)
              }}
              onDragEnd={onDragEnd}
            >
              <div className={styles.channelGroups}>
                <SortableContext items={agentIds} strategy={verticalListSortingStrategy}>
                  {tree.agents.map((group) => (
                    <SortableAgentSection
                      key={group.agent.id}
                      agent={group.agent}
                      channels={group.channels}
                      to={`/work/agents/${group.agent.id}`}
                      active={onAgent && agentId === group.agent.id}
                      dropActive={dropActiveAgentId === group.agent.id}
                      channelActiveId={channelActiveId}
                      onGuardedClick={guardClick}
                    />
                  ))}
                </SortableContext>
                <UnboundSection
                  active={dropUnbound}
                  channels={tree.unbound}
                  channelActiveId={channelActiveId}
                  onGuardedClick={guardClick}
                  onCreate={() => {
                    setWebChannelName('内置频道')
                    setCreateWebOpen(true)
                  }}
                />
              </div>
              <DragOverlay dropAnimation={null}>
                {activeAgent ? (
                  <div className={[styles.channelGroupHeader, styles.dragOverlay].join(' ')}>
                    <AgentHeaderBody
                      agent={activeAgent.agent}
                      hint={
                        activeAgent.channels.length > 0 ? `${activeAgent.channels.length} 个频道` : '还没有绑定频道'
                      }
                    />
                  </div>
                ) : activeChannel ? (
                  <div className={[styles.channelLink, styles.dragOverlay].join(' ')}>
                    <ChannelRowBody item={activeChannel} />
                  </div>
                ) : null}
              </DragOverlay>
            </DndContext>
          </NavMarkGroup>
        )}
      </div>
      <BindingChangeDialog
        intent={intent}
        onClose={() => {
          setIntent(undefined)
          restoreChannelActionFocus()
        }}
        onCloseAutoFocus={(event) => event.preventDefault()}
      />
      <ConfirmDialog
        open={createWebOpen}
        onOpenChange={setCreateWebOpen}
        title="新建内置频道"
        description="在 NekroNXT 中新建一个未绑定的内置频道，再拖到智能体上交给它响应。"
        confirmLabel="创建内置频道"
        onConfirm={async () => {
          const name = webChannelName.trim()
          if (!name) return false
          try {
            await useProductStore.getState().createWebChannel({ displayName: name })
            notify('内置频道已创建。', 'success', 'web-channel-create')
            return true
          } catch (error) {
            notify(error instanceof Error ? error.message : String(error), 'error', 'web-channel-create')
            return false
          }
        }}
      >
        <Field label="频道名称">
          <Input value={webChannelName} onChange={(event) => setWebChannelName(event.target.value)} maxLength={120} />
        </Field>
      </ConfirmDialog>
    </>
  )
}

function ConnectionTree() {
  const { connectionId } = useParams()
  const connections = useProductStore((state) => state.connections)
  const host = useProductStore((state) => state.host)
  const descriptors = useProductStore((state) => state.connectionAdapters)
  const canCreate = descriptors.some((descriptor) => descriptor.userCreatable)
  return (
    <>
      <div className={shell.treeHead}>
        <span>
          <Cable size={14} aria-hidden="true" /> 平台账号
        </span>
        {canCreate ? (
          <Tooltip.Root>
            <Tooltip.Trigger asChild>
              <NxtLink className={shell.treeAdd} to="/connections?create=1" aria-label="添加平台连接">
                <Plus size={14} aria-hidden="true" />
              </NxtLink>
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content sideOffset={6}>添加平台连接</Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>
        ) : null}
      </div>
      <div className={shell.treeBody}>
        {connections.length === 0 ? (
          host.status === 'initializing' ? (
            <div className={styles.railEmpty}>正在读取…</div>
          ) : null
        ) : (
          <NavMarkGroup id="connection-nav">
            <div className={styles.connectionNavList}>
              {connections.map((connection) => {
                const active = connectionId === connection.id
                return (
                  <NxtNavLink
                    key={connection.id}
                    to={`/connections/${connection.id}`}
                    className={() =>
                      [styles.connectionNavItem, active ? styles.connectionNavItemActive : ''].filter(Boolean).join(' ')
                    }
                    data-nav-active={active ? '' : undefined}
                  >
                    <NavGlyph active={active}>
                      <Cable size={16} aria-hidden="true" />
                    </NavGlyph>
                    <span className={styles.navCopy}>
                      <strong>{connectionDisplayName(connection)}</strong>
                      <small>
                        {connection.state} · {connection.channels} 个频道
                      </small>
                    </span>
                    <i data-tone={connection.state === '已连接' ? 'success' : 'neutral'} aria-hidden="true" />
                  </NxtNavLink>
                )
              })}
            </div>
          </NavMarkGroup>
        )}
      </div>
    </>
  )
}

function ExtensionTree() {
  const { extensionId } = useParams()
  const extensions = useProductStore((state) => state.extensions)
  const host = useProductStore((state) => state.host)
  return (
    <>
      <div className={shell.treeHead}>
        <span>
          <PackageOpen size={14} aria-hidden="true" /> 本地扩展
        </span>
      </div>
      <div className={shell.treeBody}>
        {extensions.length === 0 ? (
          host.status === 'initializing' ? (
            <div className={styles.railEmpty}>正在读取…</div>
          ) : null
        ) : (
          <NavMarkGroup id="extension-nav">
            <div className={styles.extensionNavList}>
              {extensions.map((extension) => {
                const active = extensionId === extension.id
                return (
                  <NxtNavLink
                    key={extension.id}
                    to={`/extensions/${extension.id}`}
                    className={() =>
                      [styles.extensionNavItem, active ? styles.extensionNavItemActive : ''].filter(Boolean).join(' ')
                    }
                    data-nav-active={active ? '' : undefined}
                  >
                    <NavGlyph active={active}>
                      <PackageOpen size={17} aria-hidden="true" />
                    </NavGlyph>
                    <span className={styles.navCopy}>
                      <strong>{extension.name}</strong>
                      <small>版本 {extension.revision}</small>
                    </span>
                    <em>{extension.activations.length > 0 ? `${extension.activations.length} 个智能体` : '未启用'}</em>
                  </NxtNavLink>
                )
              })}
            </div>
          </NavMarkGroup>
        )}
      </div>
    </>
  )
}

function SettingsTree() {
  const location = useLocation()
  const tab = new URLSearchParams(location.search).get('tab')
  const items = [
    { to: '/settings', id: 'models', label: '模型供应商', hint: '密钥与可用模型', icon: Cpu },
    {
      to: '/settings?tab=system-extensions',
      id: 'system-extensions',
      label: '系统扩展',
      hint: '适配器与内置能力',
      icon: Cable,
    },
    {
      to: '/settings?tab=dsh-extensions',
      id: 'dsh-extensions',
      label: 'DSH 扩展',
      hint: '模型侧能力配置',
      icon: Puzzle,
    },
    { to: '/settings?tab=appearance', id: 'appearance', label: '外观', hint: '主题与动效', icon: Palette },
    { to: '/settings?tab=about', id: 'about', label: '关于', hint: '版本、仓库与版权', icon: CircleHelp },
  ]
  const active =
    tab === 'appearance' || tab === 'dsh-extensions' || tab === 'system-extensions' || tab === 'about' ? tab : 'models'
  return (
    <>
      <div className={shell.treeHead}>
        <span>
          <Settings size={14} aria-hidden="true" /> 设置分类
        </span>
      </div>
      <div className={shell.treeBody}>
        <NavMarkGroup id="settings-nav">
          <nav className={styles.settingsNav} aria-label="设置分类">
            {items.map((item) => {
              const Icon = item.icon
              return (
                <NxtNavLink
                  key={item.id}
                  to={item.to}
                  className={() =>
                    [styles.settingsNavItem, active === item.id ? styles.settingsNavItemActive : '']
                      .filter(Boolean)
                      .join(' ')
                  }
                  data-nav-active={active === item.id ? '' : undefined}
                >
                  <NavGlyph active={active === item.id}>
                    <Icon size={17} aria-hidden="true" />
                  </NavGlyph>
                  <span className={styles.navCopy}>
                    <strong>{item.label}</strong>
                    <small>{item.hint}</small>
                  </span>
                </NxtNavLink>
              )
            })}
          </nav>
        </NavMarkGroup>
      </div>
    </>
  )
}

function UsersTree() {
  const location = useLocation()
  const selectedAdapter = new URLSearchParams(location.search).get('adapter') ?? ''
  const facets = useProductStore((state) => state.platformUserFacets)
  const total = facets.adapters.reduce((sum, adapter) => sum + adapter.userCount, 0)
  const items = [
    { key: '', label: '全部用户', count: total },
    ...facets.adapters.map((adapter) => ({
      key: adapter.key,
      label: adapter.displayName,
      count: adapter.userCount,
    })),
  ]
  return (
    <>
      <div className={shell.treeHead}>
        <span>
          <UsersRound size={14} aria-hidden="true" /> 平台用户
        </span>
      </div>
      <div className={shell.treeBody}>
        <NavMarkGroup id="platform-user-nav">
          <nav className={styles.settingsNav} aria-label="平台用户分类">
            {items.map((item) => {
              const active = selectedAdapter === item.key
              return (
                <NxtNavLink
                  key={item.key || 'all'}
                  to={item.key ? `/users?adapter=${encodeURIComponent(item.key)}` : '/users'}
                  className={() =>
                    [styles.settingsNavItem, active ? styles.settingsNavItemActive : ''].filter(Boolean).join(' ')
                  }
                  data-nav-active={active ? '' : undefined}
                >
                  <NavGlyph active={active}>
                    <UsersRound size={17} aria-hidden="true" />
                  </NavGlyph>
                  <span className={styles.navCopy}>
                    <strong>{item.label}</strong>
                    <small>{item.count} 位用户</small>
                  </span>
                </NxtNavLink>
              )
            })}
          </nav>
        </NavMarkGroup>
      </div>
    </>
  )
}

export function ObjectPane() {
  const location = useLocation()
  const mode = location.pathname.startsWith('/connections')
    ? 'connections'
    : location.pathname.startsWith('/users')
      ? 'users'
      : location.pathname.startsWith('/extensions')
        ? 'extensions'
        : location.pathname.startsWith('/settings')
          ? 'settings'
          : 'work'
  const tree =
    mode === 'connections' ? (
      <ConnectionTree />
    ) : mode === 'users' ? (
      <UsersTree />
    ) : mode === 'extensions' ? (
      <ExtensionTree />
    ) : mode === 'settings' ? (
      <SettingsTree />
    ) : (
      <WorkTree />
    )
  return <div className={shell.treeFill}>{tree}</div>
}
