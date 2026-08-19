import { MessageSquare, Plus, UsersRound } from 'lucide-react'
import { Link, NavLink, useLocation, useParams } from 'react-router-dom'
import { useProductStore, type AgentRuntimeState, type ChannelSummary } from '../product-store.js'
import { StatusBadge, type StatusTone } from '../ui-kit/index.js'
import styles from '../pages/product-pages.module.css'
import shell from '../app.module.css'

const agentTone = (state: AgentRuntimeState): StatusTone => {
  if (state === '思考中' || state === '使用工具') return 'info'
  if (state === '等待输入') return 'warning'
  if (state === '不可用') return 'error'
  return 'neutral'
}

const connectionLabel = (adapterKey: string, value: string): string =>
  adapterKey === 'web' || value === '本地 Web' ? '网页聊天' : value

function ChannelLink({ item, active }: { readonly item: ChannelSummary; readonly active: boolean }) {
  return (
    <Link
      to={`/channels/${item.id}`}
      className={[styles.channelLink, active ? styles.channelLinkActive : ''].filter(Boolean).join(' ')}
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

function WorkTree() {
  const { agentId, channelId } = useParams()
  const location = useLocation()
  const host = useProductStore((state) => state.host)
  const agents = useProductStore((state) => state.agents)
  const channels = useProductStore((state) => state.channels)
  const channelGroups = (() => {
    const boundIds = new Set<string>()
    const groups = agents.flatMap((agent) => {
      const items = channels.filter((item) => item.bindings.some((binding) => binding.agentId === agent.id))
      for (const item of items) boundIds.add(item.id)
      return items.length > 0 ? [{ agent, channels: items }] : []
    })
    const unbound = channels.filter((item) => !boundIds.has(item.id))
    const idle = agents.filter((agent) => !groups.some((group) => group.agent.id === agent.id))
    return { groups, unbound, idle }
  })()
  const onAgent = location.pathname.startsWith('/agents/')
  const onCreator = location.pathname.startsWith('/creator')

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
          <div className={styles.channelGroups}>
            {channelGroups.groups.map((group) => (
              <section className={styles.channelGroup} key={group.agent.id}>
                <Link
                  className={[
                    styles.channelGroupHeader,
                    onAgent && agentId === group.agent.id ? styles.channelGroupHeaderActive : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  to={`/agents/${group.agent.id}`}
                >
                  <span className={styles.agentAvatar}>{group.agent.name.slice(0, 1)}</span>
                  <span>
                    <strong>{group.agent.name}</strong>
                    <small>{group.channels.length} 个频道</small>
                  </span>
                  {group.agent.state !== '空闲' ? (
                    <StatusBadge tone={agentTone(group.agent.state)}>{group.agent.state}</StatusBadge>
                  ) : null}
                </Link>
                {group.channels.map((item) => (
                  <ChannelLink
                    key={`${group.agent.id}-${item.id}`}
                    item={item}
                    active={!onAgent && !onCreator && item.id === channelId}
                  />
                ))}
              </section>
            ))}
            {channelGroups.idle.map((agent) => (
              <section className={styles.channelGroup} key={agent.id}>
                <Link
                  className={[
                    styles.channelGroupHeader,
                    onAgent && agentId === agent.id ? styles.channelGroupHeaderActive : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  to={`/agents/${agent.id}`}
                >
                  <span className={styles.agentAvatar}>{agent.name.slice(0, 1)}</span>
                  <span>
                    <strong>{agent.name}</strong>
                    <small>还没有绑定频道</small>
                  </span>
                </Link>
              </section>
            ))}
            {channelGroups.unbound.length > 0 ? (
              <section className={styles.channelGroup}>
                <div className={styles.channelGroupHeader}>
                  <span className={styles.agentAvatar}>?</span>
                  <span>
                    <strong>未绑定频道</strong>
                    <small>{channelGroups.unbound.length} 个频道</small>
                  </span>
                </div>
                {channelGroups.unbound.map((item) => (
                  <ChannelLink key={item.id} item={item} active={!onAgent && item.id === channelId} />
                ))}
              </section>
            ) : null}
          </div>
        )}
      </div>
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
