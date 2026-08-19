import {
  DndContext,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { MessageSquare, Plus, UsersRound } from 'lucide-react'
import { useState, type CSSProperties, type ReactNode } from 'react'
import { Link, NavLink, useLocation, useParams } from 'react-router-dom'
import { BindingChangeDialog, type BindingChangeIntent } from '../pages/binding-change.js'
import { notify } from '../components/notifications.js'
import { useProductStore, type AgentRuntimeState, type ChannelSummary } from '../product-store.js'
import { ConfirmDialog, Field, IconButton, Input, StatusBadge, type StatusTone } from '../ui-kit/index.js'
import styles from '../pages/product-pages.module.css'
import shell from '../app.module.css'
import { orderByIds } from './work-tree-order.js'

const agentSortId = (id: string): string => `agent:${id}`
const channelSortId = (id: string): string => `channel:${id}`
const agentDropId = (id: string): string => `drop:${id}`
const UNBOUND_DROP = 'drop:unbound'

const parsePrefixedId = (value: string, prefix: string): string | undefined =>
  value.startsWith(prefix) ? value.slice(prefix.length) : undefined

const agentTone = (state: AgentRuntimeState): StatusTone => {
  if (state === '思考中' || state === '使用工具') return 'info'
  if (state === '等待输入') return 'warning'
  if (state === '不可用') return 'error'
  return 'neutral'
}

const connectionLabel = (adapterKey: string, value: string): string =>
  adapterKey === 'web' || value === '本地 Web' ? '网页聊天' : value

function SortableChannelLink({ item, active }: { readonly item: ChannelSummary; readonly active: boolean }) {
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: channelSortId(item.id),
  })
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  }
  return (
    <Link
      ref={setNodeRef}
      style={style}
      to={`/channels/${item.id}`}
      className={[styles.channelLink, active ? styles.channelLinkActive : ''].filter(Boolean).join(' ')}
      {...listeners}
    >
      {item.kind === 'web' ? (
        <MessageSquare size={15} aria-hidden="true" />
      ) : (
        <UsersRound size={15} aria-hidden="true" />
      )}
      <span>
        <strong>{item.name}</strong>
        <small>{item.connectionName}</small>
      </span>
      {item.runtimePhase !== '空闲' ? (
        <StatusBadge tone={agentTone(item.runtimePhase)}>{item.runtimePhase}</StatusBadge>
      ) : item.unread > 0 ? (
        <span className={styles.unread}>{item.unread}</span>
      ) : null}
    </Link>
  )
}

function SortableAgentHeader({
  to,
  active,
  dropActive,
  children,
  sortableId,
}: {
  readonly to: string
  readonly active: boolean
  readonly dropActive: boolean
  readonly children: ReactNode
  readonly sortableId: string
}) {
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: sortableId })
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  }
  return (
    <Link
      ref={setNodeRef}
      style={style}
      to={to}
      className={[
        styles.channelGroupHeader,
        active ? styles.channelGroupHeaderActive : '',
        dropActive ? styles.dropTarget : '',
      ]
        .filter(Boolean)
        .join(' ')}
      {...listeners}
    >
      {children}
    </Link>
  )
}

function DroppableSection({
  id,
  active,
  children,
}: {
  readonly id: string
  readonly active: boolean
  readonly children: ReactNode
}) {
  const { setNodeRef } = useDroppable({ id })
  return (
    <section
      ref={setNodeRef}
      className={[styles.channelGroup, active ? styles.dropTarget : ''].filter(Boolean).join(' ')}
    >
      {children}
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
  const [intent, setIntent] = useState<BindingChangeIntent>()
  const [createWebOpen, setCreateWebOpen] = useState(false)
  const [webChannelName, setWebChannelName] = useState('网页频道')
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))
  const orderedAgents = orderByIds(agents, workTreeOrder.agentIds)
  const channelGroups = (() => {
    const boundIds = new Set<string>()
    const groups = orderedAgents.flatMap((agent) => {
      const items = orderByIds(
        channels.filter((item) => item.bindings.some((binding) => binding.agentId === agent.id)),
        workTreeOrder.channelIdsByAgent[agent.id] ?? [],
      )
      for (const item of items) boundIds.add(item.id)
      return items.length > 0 ? [{ agent, channels: items }] : []
    })
    const unbound = orderByIds(
      channels.filter((item) => !boundIds.has(item.id)),
      workTreeOrder.unboundChannelIds,
    )
    const idle = orderedAgents.filter((agent) => !groups.some((group) => group.agent.id === agent.id))
    return { groups, unbound, idle }
  })()
  const onAgent = location.pathname.startsWith('/agents/')
  const onCreator = location.pathname.startsWith('/creator')
  const persistOrder = (
    nextAgents: readonly { readonly id: string }[],
    nextGroups: readonly { readonly agent: { readonly id: string }; readonly channels: readonly ChannelSummary[] }[],
    nextUnbound: readonly ChannelSummary[],
  ): void => {
    void useProductStore.getState().putWorkTreeOrder({
      agentIds: nextAgents.map((item) => item.id),
      channelIdsByAgent: Object.fromEntries(
        nextGroups.map((group) => [group.agent.id, group.channels.map((item) => item.id)]),
      ),
      unboundChannelIds: nextUnbound.map((item) => item.id),
    })
  }
  const proposeChannelOnAgent = (channel: ChannelSummary, targetAgentId: string): void => {
    if (!channel.agentId) {
      setIntent({ kind: 'bind', channelId: channel.id, agentId: targetAgentId })
      return
    }
    if (channel.agentId !== targetAgentId) {
      setIntent({ kind: 'replace', channelId: channel.id, agentId: targetAgentId })
    }
  }
  const onDragEnd = (event: DragEndEvent): void => {
    setOverId('')
    const activeId = String(event.active.id)
    const overIdValue = event.over ? String(event.over.id) : ''
    if (!overIdValue || activeId === overIdValue) return
    const activeAgent = parsePrefixedId(activeId, 'agent:')
    const overAgent = parsePrefixedId(overIdValue, 'agent:')
    if (activeAgent && overAgent) {
      const ids = orderedAgents.map((item) => item.id)
      persistOrder(
        arrayMove(ids, ids.indexOf(activeAgent), ids.indexOf(overAgent)).map((id) => ({ id })),
        channelGroups.groups,
        channelGroups.unbound,
      )
      return
    }
    const activeChannelId = parsePrefixedId(activeId, 'channel:')
    if (!activeChannelId) return
    const channel = channels.find((item) => item.id === activeChannelId)
    if (!channel) return
    const dropTarget = parsePrefixedId(overIdValue, 'drop:')
    if (dropTarget === 'unbound') {
      if (channel.agentId) setIntent({ kind: 'clear', channelId: channel.id })
      return
    }
    if (dropTarget) {
      proposeChannelOnAgent(channel, dropTarget)
      return
    }
    if (overAgent) {
      proposeChannelOnAgent(channel, overAgent)
      return
    }
    const overChannelId = parsePrefixedId(overIdValue, 'channel:')
    if (!overChannelId) return
    const overChannel = channels.find((item) => item.id === overChannelId)
    if (!overChannel) return
    if (channel.agentId && overChannel.agentId && channel.agentId === overChannel.agentId) {
      const group = channelGroups.groups.find((item) => item.agent.id === channel.agentId)
      if (!group) return
      const ids = group.channels.map((item) => item.id)
      persistOrder(
        orderedAgents,
        channelGroups.groups.map((item) =>
          item.agent.id === group.agent.id
            ? {
                ...item,
                channels: arrayMove(ids, ids.indexOf(channel.id), ids.indexOf(overChannel.id)).flatMap((id) =>
                  item.channels.filter((entry) => entry.id === id),
                ),
              }
            : item,
        ),
        channelGroups.unbound,
      )
      return
    }
    if (!channel.agentId && !overChannel.agentId) {
      const ids = channelGroups.unbound.map((item) => item.id)
      persistOrder(
        orderedAgents,
        channelGroups.groups,
        arrayMove(ids, ids.indexOf(channel.id), ids.indexOf(overChannel.id)).flatMap((id) =>
          channelGroups.unbound.filter((entry) => entry.id === id),
        ),
      )
      return
    }
    if (overChannel.agentId) proposeChannelOnAgent(channel, overChannel.agentId)
  }

  const agentIds = orderedAgents.map((item) => agentSortId(item.id))
  const overDrop = parsePrefixedId(overId, 'drop:')

  return (
    <>
      <div className={shell.treeHead}>
        <span>工作</span>
        <Link className={shell.treeAdd} to="/agents?create=1" aria-label="创建智能体">
          <Plus size={14} aria-hidden="true" />
        </Link>
      </div>
      <div className={shell.treeBody}>
        {channels.length === 0 && agents.length === 0 ? (
          <div className={styles.railEmpty}>{host.status === 'initializing' ? '正在读取…' : '还没有智能体'}</div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCorners}
            onDragOver={(event) => setOverId(event.over ? String(event.over.id) : '')}
            onDragCancel={() => setOverId('')}
            onDragEnd={onDragEnd}
          >
            <div className={styles.channelGroups}>
              <SortableContext items={agentIds} strategy={verticalListSortingStrategy}>
                {channelGroups.groups.map((group) => (
                  <DroppableSection
                    key={group.agent.id}
                    id={agentDropId(group.agent.id)}
                    active={overDrop === group.agent.id}
                  >
                    <SortableAgentHeader
                      sortableId={agentSortId(group.agent.id)}
                      to={`/agents/${group.agent.id}`}
                      active={onAgent && agentId === group.agent.id}
                      dropActive={overDrop === group.agent.id}
                    >
                      <span className={styles.agentAvatar}>{group.agent.name.slice(0, 1)}</span>
                      <span>
                        <strong>{group.agent.name}</strong>
                        <small>{group.channels.length} 个频道</small>
                      </span>
                      {group.agent.state !== '空闲' ? (
                        <StatusBadge tone={agentTone(group.agent.state)}>{group.agent.state}</StatusBadge>
                      ) : null}
                    </SortableAgentHeader>
                    <SortableContext
                      items={group.channels.map((item) => channelSortId(item.id))}
                      strategy={verticalListSortingStrategy}
                    >
                      {group.channels.map((item) => (
                        <SortableChannelLink
                          key={`${group.agent.id}-${item.id}`}
                          item={item}
                          active={!onAgent && !onCreator && item.id === channelId}
                        />
                      ))}
                    </SortableContext>
                  </DroppableSection>
                ))}
                {channelGroups.idle.map((agent) => (
                  <DroppableSection key={agent.id} id={agentDropId(agent.id)} active={overDrop === agent.id}>
                    <SortableAgentHeader
                      sortableId={agentSortId(agent.id)}
                      to={`/agents/${agent.id}`}
                      active={onAgent && agentId === agent.id}
                      dropActive={overDrop === agent.id}
                    >
                      <span className={styles.agentAvatar}>{agent.name.slice(0, 1)}</span>
                      <span>
                        <strong>{agent.name}</strong>
                        <small>还没有绑定频道</small>
                      </span>
                    </SortableAgentHeader>
                  </DroppableSection>
                ))}
              </SortableContext>
              <DroppableSection id={UNBOUND_DROP} active={overDrop === 'unbound'}>
                <div
                  className={[styles.channelGroupHeader, overDrop === 'unbound' ? styles.dropTarget : '']
                    .filter(Boolean)
                    .join(' ')}
                >
                  <span className={styles.agentAvatar}>?</span>
                  <span>
                    <strong>未绑定频道</strong>
                    <small>
                      {channelGroups.unbound.length > 0
                        ? `${channelGroups.unbound.length} 个频道`
                        : '把频道拖到这里以解除绑定'}
                    </small>
                  </span>
                  <IconButton
                    label="新建网页频道"
                    className={shell.treeAdd}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => {
                      setWebChannelName('网页频道')
                      setCreateWebOpen(true)
                    }}
                  >
                    <Plus size={14} aria-hidden="true" />
                  </IconButton>
                </div>
                <SortableContext
                  items={channelGroups.unbound.map((item) => channelSortId(item.id))}
                  strategy={verticalListSortingStrategy}
                >
                  {channelGroups.unbound.map((item) => (
                    <SortableChannelLink key={item.id} item={item} active={!onAgent && item.id === channelId} />
                  ))}
                </SortableContext>
              </DroppableSection>
            </div>
          </DndContext>
        )}
      </div>
      <BindingChangeDialog intent={intent} onClose={() => setIntent(undefined)} />
      <ConfirmDialog
        open={createWebOpen}
        onOpenChange={setCreateWebOpen}
        title="新建网页频道"
        description="在本机网页聊天下新建一个未绑定频道，再拖到智能体上交给它响应。"
        confirmLabel="创建网页频道"
        onConfirm={async () => {
          const name = webChannelName.trim()
          if (!name) return false
          try {
            await useProductStore.getState().createWebChannel({ displayName: name })
            notify('网页频道已创建。', 'success', 'web-channel-create')
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
        <span>连接</span>
        {canCreate ? (
          <Link className={shell.treeAdd} to="/connections?create=1" aria-label="添加连接">
            <Plus size={14} aria-hidden="true" />
          </Link>
        ) : null}
      </div>
      <div className={shell.treeBody}>
        {connections.length === 0 ? (
          <div className={styles.railEmpty}>{host.status === 'initializing' ? '正在读取…' : '还没有连接'}</div>
        ) : (
          connections.map((connection) => (
            <NavLink
              key={connection.id}
              to={`/connections/${connection.id}`}
              className={({ isActive }) =>
                [
                  styles.channelGroupHeader,
                  isActive || connectionId === connection.id ? styles.channelGroupHeaderActive : '',
                ]
                  .filter(Boolean)
                  .join(' ')
              }
            >
              <span className={styles.agentAvatar}>
                {connectionLabel(connection.adapterKey, connection.name).slice(0, 1)}
              </span>
              <span>
                <strong>{connectionLabel(connection.adapterKey, connection.name)}</strong>
                <small>
                  {connection.state} · {connection.channels} 个频道
                </small>
              </span>
            </NavLink>
          ))
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
        <span>扩展</span>
      </div>
      <div className={shell.treeBody}>
        {extensions.length === 0 ? (
          <div className={styles.railEmpty}>{host.status === 'initializing' ? '正在读取…' : '还没有本地扩展'}</div>
        ) : (
          extensions.map((extension) => (
            <NavLink
              key={extension.id}
              to={`/extensions/${extension.id}`}
              className={({ isActive }) =>
                [
                  styles.channelGroupHeader,
                  isActive || extensionId === extension.id ? styles.channelGroupHeaderActive : '',
                ]
                  .filter(Boolean)
                  .join(' ')
              }
            >
              <span className={styles.agentAvatar}>{extension.name.slice(0, 1)}</span>
              <span>
                <strong>{extension.name}</strong>
                <small>
                  版本 {extension.revision} · {extension.activation === '已激活' ? '已启用' : '未启用'}
                </small>
              </span>
            </NavLink>
          ))
        )}
      </div>
    </>
  )
}

function SettingsTree() {
  const location = useLocation()
  const tab = new URLSearchParams(location.search).get('tab')
  const items = [
    { to: '/settings', id: 'models', label: '模型供应商', hint: '密钥与可用模型' },
    { to: '/settings?tab=dsh-extensions', id: 'dsh-extensions', label: 'DSH 扩展', hint: '能力插件配置' },
    { to: '/settings?tab=appearance', id: 'appearance', label: '外观', hint: '主题与动效' },
  ]
  const active = tab === 'appearance' || tab === 'dsh-extensions' ? tab : 'models'
  return (
    <>
      <div className={shell.treeHead}>
        <span>设置</span>
      </div>
      <div className={shell.treeBody}>
        {items.map((item) => (
          <NavLink
            key={item.id}
            to={item.to}
            className={() =>
              [styles.channelGroupHeader, active === item.id ? styles.channelGroupHeaderActive : '']
                .filter(Boolean)
                .join(' ')
            }
          >
            <span className={styles.agentAvatar}>{item.label.slice(0, 1)}</span>
            <span>
              <strong>{item.label}</strong>
              <small>{item.hint}</small>
            </span>
          </NavLink>
        ))}
      </div>
    </>
  )
}

export function ObjectPane() {
  const location = useLocation()
  if (location.pathname.startsWith('/connections')) return <ConnectionTree />
  if (location.pathname.startsWith('/extensions')) return <ExtensionTree />
  if (location.pathname.startsWith('/settings')) return <SettingsTree />
  return <WorkTree />
}
