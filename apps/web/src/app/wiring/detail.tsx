import { Cable, MessagesSquare, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { configFields } from '@nekro-nxt/contracts'
import { PanelSlot } from '../../extension-ui/index.js'
import { connectionDisplayName, useProductStore, type ConnectionSummary } from '../../product-runtime.js'
import {
  AgentAvatar,
  Button,
  Chip,
  ConfirmDialog,
  DetailPane,
  Diagnostics,
  InlineEdit,
  MemberAvatar,
  ObjectHeader,
  Pressable,
  PropertyGroup,
  PropertyList,
  PropertyRow,
  SearchField,
  Select,
  StatusDot,
  Switch,
  SwitchRow,
  toast,
} from '../../ui-kit/index.js'
import { BindDialog, type BindIntent } from '../channels/bind-dialog.js'
import { connectionStatus, testOutcome } from '../model/connection-status.js'
import { agentHue, agentPhase, connectionFullLabel, triggerLabel } from '../model/identity.js'
import { useGo } from '../model/nav.js'
import { useProductApi } from '../model/store.js'
import { useMemberDirectory } from './member-directory.js'
import type { WiringSelection } from './patch-bay.js'
import styles from './wiring.module.css'

/** Platform account ids are personal identifiers: show only the last four characters. */
export const maskedAccount = (reference: string): string => {
  const trimmed = reference.trim()
  return trimmed.length <= 4 ? '已提供' : `尾号 ${trimmed.slice(-4)}`
}

const failure = (error: unknown) => toast(error instanceof Error ? error.message : String(error), { tone: 'bad' })

function ObjectIcon({ kind }: { readonly kind: 'connection' | 'channel' }) {
  return <span className={styles.objectIcon}>{kind === 'connection' ? <Cable /> : <MessagesSquare />}</span>
}

function MemberList({ connectionId }: { readonly connectionId: string }) {
  const { query, setQuery, page, loadingMore, loadMore } = useMemberDirectory(connectionId)
  return (
    <PropertyGroup title={`成员 ${page ? page.total : ''}`.trim()}>
      <SearchField value={query} onChange={setQuery} placeholder="查找成员" label="查找成员" />
      {page && page.items.length > 0 ? (
        <PropertyList>
          {page.items.map((user) => (
            <div key={user.identityId} className={styles.member}>
              <MemberAvatar name={user.displayName ?? '?'} size="sm" />
              <span className={styles.memberName}>{user.displayName ?? '未命名'}</span>
              <span className={styles.memberMeta}>
                {user.historicalOnly ? '仅历史' : `${user.activeChannelCount} 个频道`}
              </span>
            </div>
          ))}
        </PropertyList>
      ) : page ? (
        <p className={styles.quiet}>{query ? '没有匹配的成员' : '还没有成员'}</p>
      ) : null}
      {page && page.total > 0 ? (
        <div className={styles.paging}>
          <span>
            已显示 {page.items.length} / {page.total}
          </span>
          {page.nextCursor !== undefined ? (
            <Button size="small" variant="ghost" busy={loadingMore} onClick={() => void loadMore()}>
              加载更多
            </Button>
          ) : null}
        </div>
      ) : null}
    </PropertyGroup>
  )
}

function ConnectionDetail({ connection }: { readonly connection: ConnectionSummary }) {
  const api = useProductApi()
  const go = useGo()
  const descriptors = useProductStore((state) => state.connectionAdapters)
  const channels = useProductStore((state) => state.channels)
  const agents = useProductStore((state) => state.agents)
  const descriptor = descriptors.find((item) => item.key === connection.adapterKey)
  const [testChannel, setTestChannel] = useState(connection.knownChannels[0]?.id ?? '')
  const [testing, setTesting] = useState<'receive' | 'send' | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [purge, setPurge] = useState(false)
  const [settingPending, setSettingPending] = useState(false)
  useEffect(() => {
    if (!connection.knownChannels.some((channel) => channel.id === testChannel))
      setTestChannel(connection.knownChannels[0]?.id ?? '')
  }, [connection.knownChannels, testChannel])

  const status = connectionStatus(connection)
  // Boolean adapter options are safe to change on a live account; each switch saves immediately.
  const settings = useMemo(
    () => (descriptor ? configFields(descriptor.configSchema).filter((field) => field.kind === 'boolean') : []),
    [descriptor],
  )
  const own = channels.filter((channel) => channel.connectionId === connection.id)
  const activities = useMemo(
    () =>
      (descriptor?.activities ?? []).filter((activity) => {
        const capability = connection.activityCapabilities[activity.key]
        return (
          activity.scope === 'channel' &&
          activity.triggerable &&
          capability?.state !== 'disabled' &&
          capability?.state !== 'unsupported'
        )
      }),
    [descriptor, connection.activityCapabilities],
  )

  const saveSetting = async (key: string, enabled: boolean) => {
    setSettingPending(true)
    try {
      await api.getState().updateConnectionConfiguration(connection.id, { [key]: enabled })
      toast('连接设置已保存')
    } catch (error) {
      failure(error)
    } finally {
      setSettingPending(false)
    }
  }
  const saveAlias = async (alias: string) => {
    try {
      await api.getState().updateConnectionAlias(connection.id, alias)
      toast(alias ? '名称已保存' : '已恢复默认名称')
    } catch (error) {
      failure(error)
      throw error
    }
  }
  const setActivity = async (key: string, enabled: boolean) => {
    const next = enabled
      ? [...new Set([...connection.activityTriggerDefaults, key])]
      : connection.activityTriggerDefaults.filter((item) => item !== key)
    try {
      await api.getState().updateConnectionActivityTriggerDefaults(connection.id, next)
    } catch (error) {
      failure(error)
    }
  }
  const runTest = async (direction: 'receive' | 'send') => {
    setTesting(direction)
    try {
      await api.getState().runConnectionTest(connection.id, direction, direction === 'send' ? testChannel : undefined)
    } catch (error) {
      failure(error)
    } finally {
      setTesting(null)
    }
  }
  const receive = testOutcome(connection.receiveTest)
  const send = testOutcome(connection.sendTest)
  const testDetails = [receive.detail, send.detail].filter((value): value is string => value !== undefined)

  return (
    <DetailPane
      label="详情"
      header={
        <ObjectHeader
          size="compact"
          visual={<ObjectIcon kind="connection" />}
          title={connectionDisplayName(connection)}
          status={
            <Chip tone={status.tone} dot>
              {status.label}
            </Chip>
          }
          meta={
            <>
              <span>{!connection.userManaged ? '内置' : connection.alias ? connection.adapter : '平台账号'}</span>
              {connection.accountReference ? <span>{maskedAccount(connection.accountReference)}</span> : null}
            </>
          }
        />
      }
    >
      <PropertyGroup title="状态">
        <PropertyList>
          <PropertyRow label="连接" description={status.reason}>
            <span className={styles.stateValue}>
              <StatusDot tone={status.tone} pulse={status.health === 'connecting'} />
              {status.label}
            </span>
          </PropertyRow>
          {status.action ? <PropertyRow label="建议" description={status.action} /> : null}
          <PropertyRow label="最近消息">
            <span className={styles.value}>{connection.lastEvent}</span>
          </PropertyRow>
        </PropertyList>
        <PanelSlot anchor={{ kind: 'connection', id: connection.id }} density="full" role="status" />
      </PropertyGroup>

      {connection.userManaged && descriptor?.aliasEditable !== false ? (
        <PropertyGroup title="名称">
          <PropertyList>
            <PropertyRow label="显示名称" description="用来区分同一平台的多个账号" layout="stacked">
              <InlineEdit
                value={connection.alias ?? ''}
                label="名称"
                placeholder={connection.adapter}
                maxLength={80}
                onSave={saveAlias}
              />
            </PropertyRow>
          </PropertyList>
        </PropertyGroup>
      ) : null}

      {connection.userManaged && settings.length > 0 ? (
        <PropertyGroup title="连接设置">
          <PropertyList>
            {settings.map((field) => (
              <PropertyRow key={field.key} label={field.title} description={field.hint}>
                <Switch
                  label={field.title}
                  checked={
                    typeof connection.configuration?.[field.key] === 'boolean'
                      ? connection.configuration[field.key] === true
                      : field.default === true
                  }
                  disabled={settingPending}
                  onCheckedChange={(checked) => void saveSetting(field.key, checked)}
                />
              </PropertyRow>
            ))}
          </PropertyList>
        </PropertyGroup>
      ) : null}

      {activities.length ? (
        <PropertyGroup title="默认触发的活动" description="各频道可在频道设置里单独调整">
          <PropertyList>
            {activities.map((activity) => (
              <PropertyRow
                key={activity.key}
                label={activity.displayName}
                description={connection.activityCapabilities[activity.key]?.reason ?? activity.description}
              >
                <Switch
                  label={activity.displayName}
                  checked={connection.activityTriggerDefaults.includes(activity.key)}
                  onCheckedChange={(checked) => void setActivity(activity.key, checked)}
                />
              </PropertyRow>
            ))}
          </PropertyList>
        </PropertyGroup>
      ) : null}

      <PropertyGroup title={`频道 ${own.length}`}>
        {own.length > 0 ? (
          <PropertyList>
            {own.map((channel) => {
              const agent = agents.find((item) => item.id === channel.agentId)
              return (
                <Pressable
                  key={channel.id}
                  className={styles.listRow}
                  onClick={() => go(`/wiring/channels/${channel.id}`)}
                >
                  <MessagesSquare className={styles.listIcon} aria-hidden="true" />
                  <span className={styles.listName}>{channel.name}</span>
                  {agent ? (
                    <span className={styles.listAgent}>
                      <AgentAvatar name={agent.name} hue={agentHue(agent)} size="xs" />
                      <span>{agent.name}</span>
                    </span>
                  ) : (
                    <span className={styles.listMeta}>未接线</span>
                  )}
                </Pressable>
              )
            })}
          </PropertyList>
        ) : (
          <p className={styles.quiet}>还没有发现频道。从平台发一条消息后会出现在这里。</p>
        )}
      </PropertyGroup>

      {connection.userManaged ? <MemberList connectionId={connection.id} /> : null}

      {connection.userManaged ? (
        <PropertyGroup title="诊断">
          {descriptor && (descriptor.diagnostics.receive || descriptor.diagnostics.send) ? (
            <PropertyList>
              {descriptor.diagnostics.receive ? (
                <PropertyRow label="接收" description={receive.label}>
                  <Button size="small" busy={testing === 'receive'} onClick={() => void runTest('receive')}>
                    测试接收
                  </Button>
                </PropertyRow>
              ) : null}
              {descriptor.diagnostics.send && connection.knownChannels.length ? (
                <PropertyRow label="发送" description={send.label} layout="stacked">
                  <div className={styles.testSend}>
                    <Select
                      value={testChannel}
                      onValueChange={(value) => setTestChannel(value)}
                      options={connection.knownChannels.map((channel) => ({ value: channel.id, label: channel.name }))}
                      aria-label="测试频道"
                    />
                    <Button size="small" busy={testing === 'send'} onClick={() => void runTest('send')}>
                      测试发送
                    </Button>
                  </div>
                </PropertyRow>
              ) : null}
            </PropertyList>
          ) : null}
          <PanelSlot anchor={{ kind: 'connection', id: connection.id }} density="full" role="diagnostics" />
          <Diagnostics
            items={[
              ...(status.detail ? [{ label: '平台消息', value: status.detail }] : []),
              ...testDetails.map((value, index) => ({ label: `测试结果 ${index + 1}`, value })),
              { label: '运行状态', value: connection.runtimeState },
              { label: '连接标识', value: connection.id },
              { label: '适配器', value: connection.adapterKey },
            ]}
          />
        </PropertyGroup>
      ) : null}

      {connection.userManaged ? (
        <PropertyGroup title="危险操作">
          <div className={styles.actions}>
            {descriptor?.creation?.mode === 'qr-login' ? (
              <Button
                size="small"
                onClick={() =>
                  go(
                    `/wiring/new?adapter=${encodeURIComponent(descriptor.key)}&reauth=${encodeURIComponent(connection.id)}`,
                  )
                }
              >
                重新扫码登录
              </Button>
            ) : null}
            <Button variant="danger" size="small" icon={<Trash2 />} onClick={() => setDeleting(true)}>
              删除连接
            </Button>
          </div>
        </PropertyGroup>
      ) : null}

      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`删除「${connectionDisplayName(connection)}」？`}
        confirmLabel={purge ? '永久删除' : '删除'}
        danger
        onConfirm={async () => {
          await api.getState().deleteConnection(connection.id, purge)
          toast(purge ? '连接和频道数据已删除' : '连接已删除，可以恢复')
          go('/wiring')
        }}
      >
        <SwitchRow
          title="同时删除频道数据"
          description={purge ? '频道、消息和成员会被永久删除，无法恢复。' : '保留频道与消息，之后可以恢复这个连接。'}
          checked={purge}
          onCheckedChange={setPurge}
        />
      </ConfirmDialog>
    </DetailPane>
  )
}

function ChannelDetail({ channelId }: { readonly channelId: string }) {
  const go = useGo()
  const channel = useProductStore((state) => state.channels.find((item) => item.id === channelId))
  const agents = useProductStore((state) => state.agents)
  const connection = useProductStore((state) =>
    channel ? state.connections.find((item) => item.id === channel.connectionId) : undefined,
  )
  const [intent, setIntent] = useState<BindIntent | null>(null)
  if (!channel) return null
  const agent = agents.find((item) => item.id === channel.agentId)
  const trigger = channel.bindings[0] ? triggerLabel[channel.bindings[0].triggerPolicy] : undefined
  return (
    <DetailPane
      label="详情"
      header={
        <ObjectHeader
          size="compact"
          visual={<ObjectIcon kind="channel" />}
          title={channel.name}
          status={agent ? <Chip tone="ok">已接线</Chip> : <Chip>未接线</Chip>}
          meta={<span>{connection ? connectionFullLabel(connection) : channel.connectionName}</span>}
        />
      }
      footer={
        <Button variant="primary" size="small" icon={<MessagesSquare />} onClick={() => go(`/channels/${channel.id}`)}>
          打开频道
        </Button>
      }
    >
      <PropertyGroup title="响应">
        <PropertyList>
          <PropertyRow label="智能体" description={agent ? undefined : '还没有智能体响应这个频道'}>
            <Select
              aria-label={`${channel.name} 的响应智能体`}
              value={channel.agentId}
              options={[
                { value: '', label: '未接线' },
                ...agents.map((item) => ({ value: item.id, label: item.name })),
              ]}
              onValueChange={(value) => {
                const next = value
                if (next === channel.agentId) return
                if (!next) setIntent({ kind: 'unbind', channelId: channel.id })
                else setIntent({ kind: channel.agentId ? 'replace' : 'bind', channelId: channel.id, agentId: next })
              }}
            />
          </PropertyRow>
          {agent ? (
            <PropertyRow label="触发方式" description="在频道设置里调整">
              <span className={styles.value}>{trigger}</span>
            </PropertyRow>
          ) : null}
        </PropertyList>
      </PropertyGroup>
      {connection ? (
        <PropertyGroup title="来源">
          <PropertyList>
            <Pressable className={styles.listRow} onClick={() => go(`/wiring/connections/${connection.id}`)}>
              <StatusDot tone={connectionStatus(connection).tone} />
              <span className={styles.listName}>{connectionDisplayName(connection)}</span>
              <span className={styles.listMeta}>{connection.userManaged ? connection.adapter : '内置'}</span>
            </Pressable>
          </PropertyList>
        </PropertyGroup>
      ) : null}
      <BindDialog intent={intent} onClose={() => setIntent(null)} />
    </DetailPane>
  )
}

function AgentDetail({ agentId }: { readonly agentId: string }) {
  const go = useGo()
  const agent = useProductStore((state) => state.agents.find((item) => item.id === agentId))
  const channels = useProductStore((state) => state.channels)
  if (!agent) return null
  const own = channels.filter((channel) => channel.agentId === agent.id)
  const phase = agentPhase[agent.state]
  return (
    <DetailPane
      label="详情"
      header={
        <ObjectHeader
          size="compact"
          visual={<AgentAvatar name={agent.name} hue={agentHue(agent)} size="md" />}
          title={agent.name}
          status={
            <Chip tone={phase.tone} dot>
              {phase.label}
            </Chip>
          }
          meta={<span>{agent.model}</span>}
        />
      }
      footer={
        <Button variant="primary" size="small" onClick={() => go(`/agents/${agent.id}`)}>
          打开智能体
        </Button>
      }
    >
      <PropertyGroup title={`响应的频道 ${own.length}`}>
        {own.length > 0 ? (
          <PropertyList>
            {own.map((channel) => (
              <Pressable
                key={channel.id}
                className={styles.listRow}
                onClick={() => go(`/wiring/channels/${channel.id}`)}
              >
                <MessagesSquare className={styles.listIcon} aria-hidden="true" />
                <span className={styles.listName}>{channel.name}</span>
                <span className={styles.listMeta}>
                  {channel.bindings[0] ? triggerLabel[channel.bindings[0].triggerPolicy] : ''}
                </span>
              </Pressable>
            ))}
          </PropertyList>
        ) : (
          <p className={styles.quiet}>还没有频道。把频道的端口拖到这个智能体上即可接线。</p>
        )}
      </PropertyGroup>
    </DetailPane>
  )
}

export function WiringDetail({ selected }: { readonly selected: WiringSelection | undefined }) {
  const connection = useProductStore((state) =>
    selected?.kind === 'connection' ? state.connections.find((item) => item.id === selected.id) : undefined,
  )
  if (connection) return <ConnectionDetail key={connection.id} connection={connection} />
  if (selected?.kind === 'channel') return <ChannelDetail key={selected.id} channelId={selected.id} />
  if (selected?.kind === 'agent') return <AgentDetail key={selected.id} agentId={selected.id} />
  return null
}
