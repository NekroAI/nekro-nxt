import { useGo } from '../model/nav.js'
import { PanelSlot } from '../../extension-ui/index.js'
import { MessagesSquare, Trash2, Unplug, UsersRound } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { configFields } from '@nekro-nxt/contracts'
import { connectionDisplayName, useProductStore, type ConnectionSummary } from '../../product-runtime.js'
import {
  AgentAvatar,
  Button,
  ConfirmDialog,
  Field,
  Input,
  MemberAvatar,
  Select,
  StatusDot,
  SwitchRow,
  toast,
} from '../../ui-kit/next/index.js'
import { BindDialog, type BindIntent } from '../channels/bind-dialog.js'
import { agentHue, connectionTone, triggerLabel } from '../model/identity.js'
import { useProductApi } from '../model/store.js'
import { useMemberDirectory } from './member-directory.js'
import styles from './wiring.module.css'

/** Platform account ids are personal identifiers: show only the last four characters. */
export const maskedAccount = (reference: string): string => {
  const trimmed = reference.trim()
  return trimmed.length <= 4 ? '已提供' : `尾号 ${trimmed.slice(-4)}`
}

const failure = (error: unknown) => toast(error instanceof Error ? error.message : String(error), { tone: 'bad' })

function MemberList({ connectionId }: { readonly connectionId: string }) {
  const { query, setQuery, page, loadingMore, loadMore } = useMemberDirectory(connectionId)
  return (
    <section>
      <h3 className={styles.detailTitle}>成员 {page ? page.total : ''}</h3>
      <Input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="查找成员"
        aria-label="查找成员"
      />
      <div className={styles.members}>
        {page?.items.map((user) => (
          <div key={user.identityId} className={styles.member}>
            <MemberAvatar name={user.displayName ?? '?'} size="sm" />
            {user.displayName ?? '未命名'}
            <span className={styles.end}>{user.historicalOnly ? '仅历史' : `${user.activeChannelCount} 个频道`}</span>
          </div>
        ))}
      </div>
      {page && page.total > 0 ? (
        <div className={styles.memberPaging}>
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
    </section>
  )
}

function ConnectionDetail({ connection }: { readonly connection: ConnectionSummary }) {
  const api = useProductApi()
  const navigate = useGo()
  const descriptors = useProductStore((state) => state.connectionAdapters)
  const channels = useProductStore((state) => state.channels)
  const agents = useProductStore((state) => state.agents)
  const descriptor = descriptors.find((item) => item.key === connection.adapterKey)
  const [alias, setAlias] = useState(connection.alias ?? '')
  const [savingAlias, setSavingAlias] = useState(false)
  const [testChannel, setTestChannel] = useState(connection.knownChannels[0]?.id ?? '')
  const [testing, setTesting] = useState<'receive' | 'send' | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [purge, setPurge] = useState(false)
  useEffect(() => setAlias(connection.alias ?? ''), [connection.id, connection.alias])

  const tone = connectionTone(connection.state)
  // Boolean adapter options are safe to change on a live account; each switch saves immediately.
  const settings = useMemo(
    () => (descriptor ? configFields(descriptor.configSchema).filter((field) => field.kind === 'boolean') : []),
    [descriptor],
  )
  const [settingPending, setSettingPending] = useState(false)
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

  const saveAlias = async () => {
    setSavingAlias(true)
    try {
      await api.getState().updateConnectionAlias(connection.id, alias.trim())
      toast('名称已保存')
    } catch (error) {
      failure(error)
    } finally {
      setSavingAlias(false)
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

  return (
    <>
      <div className={styles.detailHead}>
        <h2>{connectionDisplayName(connection)}</h2>
        <div className={styles.detailSub}>{connection.userManaged ? connection.adapter : '内置'}</div>
      </div>
      <div className={styles.facts}>
        <div>
          <StatusDot tone={tone} pulse={tone === 'warn'} />
          {connection.state}
          {connection.lastEvent ? <span className={styles.end}>{connection.lastEvent}</span> : null}
        </div>
        {connection.accountReference ? (
          <div>
            平台账号
            <span className={styles.end}>{maskedAccount(connection.accountReference)}</span>
          </div>
        ) : null}
        {connection.lastError ? <div className={styles.error}>{connection.lastError}</div> : null}
      </div>

      {connection.userManaged && descriptor?.aliasEditable !== false ? (
        <Field label="名称">
          <div className={styles.inline}>
            <Input
              aria-label="名称"
              value={alias}
              onChange={(event) => setAlias(event.target.value)}
              placeholder={connection.adapter}
              maxLength={80}
            />
            <Button
              onClick={() => void saveAlias()}
              busy={savingAlias}
              disabled={alias.trim() === (connection.alias ?? '')}
            >
              保存
            </Button>
          </div>
        </Field>
      ) : null}

      {connection.userManaged && settings.length > 0 ? (
        <section>
          <h3 className={styles.detailTitle}>连接设置</h3>
          {settings.map((field) => (
            <SwitchRow
              key={field.key}
              title={field.title}
              description={field.hint}
              checked={
                typeof connection.configuration?.[field.key] === 'boolean'
                  ? connection.configuration[field.key] === true
                  : field.default === true
              }
              disabled={settingPending}
              onCheckedChange={(checked) => void saveSetting(field.key, checked)}
            />
          ))}
        </section>
      ) : null}

      <section>
        <h3 className={styles.detailTitle}>频道 {own.length}</h3>
        <div className={styles.facts}>
          {own.map((channel) => {
            const agent = agents.find((item) => item.id === channel.agentId)
            return (
              <div key={channel.id}>
                {agent ? (
                  <AgentAvatar name={agent.name} hue={agentHue(agent)} size="xs" />
                ) : (
                  <MemberAvatar name="?" size="xs" />
                )}
                {channel.name}
                <span className={styles.end}>{agent?.name ?? '未接线'}</span>
              </div>
            )
          })}
        </div>
      </section>

      {activities.length ? (
        <section>
          <h3 className={styles.detailTitle}>默认触发的活动</h3>
          <div className={styles.switches}>
            {activities.map((activity) => (
              <SwitchRow
                key={activity.key}
                title={activity.displayName}
                description={connection.activityCapabilities[activity.key]?.reason ?? activity.description}
                checked={connection.activityTriggerDefaults.includes(activity.key)}
                onCheckedChange={(checked) => void setActivity(activity.key, checked)}
              />
            ))}
          </div>
        </section>
      ) : null}

      {connection.userManaged && descriptor && (descriptor.diagnostics.receive || descriptor.diagnostics.send) ? (
        <section>
          <h3 className={styles.detailTitle}>诊断</h3>
          <div className={styles.switches}>
            {descriptor.diagnostics.receive ? (
              <div className={styles.inline}>
                <span className={styles.testResult}>{connection.receiveTest || '接收'}</span>
                <Button size="small" busy={testing === 'receive'} onClick={() => void runTest('receive')}>
                  测试接收
                </Button>
              </div>
            ) : null}
            {descriptor.diagnostics.send && connection.knownChannels.length ? (
              <>
                <Select
                  value={testChannel}
                  onChange={(event) => setTestChannel(event.target.value)}
                  options={connection.knownChannels.map((channel) => ({ value: channel.id, label: channel.name }))}
                  aria-label="测试频道"
                />
                <div className={styles.inline}>
                  <span className={styles.testResult}>{connection.sendTest || '发送'}</span>
                  <Button size="small" busy={testing === 'send'} onClick={() => void runTest('send')}>
                    测试发送
                  </Button>
                </div>
              </>
            ) : null}
          </div>
        </section>
      ) : null}

      <PanelSlot anchor={{ kind: 'connection', id: connection.id }} density="full" role="status" />
      <PanelSlot anchor={{ kind: 'connection', id: connection.id }} density="full" role="diagnostics" />

      {connection.userManaged ? <MemberList connectionId={connection.id} /> : null}

      {connection.userManaged ? (
        <section className={styles.detailActions}>
          {descriptor?.creation?.mode === 'qr-login' ? (
            <Button
              size="small"
              onClick={() =>
                navigate(
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
        </section>
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
          navigate('/wiring')
        }}
      >
        <SwitchRow
          title="同时删除频道数据"
          description={purge ? '频道、消息和成员会被永久删除，无法恢复。' : '保留频道与消息，之后可以恢复这个连接。'}
          checked={purge}
          onCheckedChange={setPurge}
        />
      </ConfirmDialog>
    </>
  )
}

function ChannelDetail({ channelId }: { readonly channelId: string }) {
  const navigate = useGo()
  const channel = useProductStore((state) => state.channels.find((item) => item.id === channelId))
  const agent = useProductStore((state) =>
    channel ? state.agents.find((item) => item.id === channel.agentId) : undefined,
  )
  const connection = useProductStore((state) =>
    channel ? state.connections.find((item) => item.id === channel.connectionId) : undefined,
  )
  const [intent, setIntent] = useState<BindIntent | null>(null)
  if (!channel) return null
  const trigger = channel.bindings[0] ? triggerLabel[channel.bindings[0].triggerPolicy] : undefined
  return (
    <>
      <div className={styles.detailHead}>
        <h2>{channel.name}</h2>
        <div className={styles.detailSub}>
          {connection
            ? connection.alias
              ? `${connection.alias} · ${connection.adapter}`
              : connection.adapter
            : channel.connectionName}
        </div>
      </div>
      <div className={styles.facts}>
        <div>
          {agent ? (
            <>
              <AgentAvatar name={agent.name} hue={agentHue(agent)} size="xs" />
              {agent.name}
              <span className={styles.end}>{trigger}</span>
            </>
          ) : (
            <span style={{ color: 'var(--muted)' }}>未接线</span>
          )}
        </div>
      </div>
      <div className={styles.buttons}>
        <Button size="small" icon={<MessagesSquare />} onClick={() => navigate(`/channels/${channel.id}`)}>
          打开频道
        </Button>
        {agent ? (
          <Button
            size="small"
            variant="ghost"
            icon={<Unplug />}
            onClick={() => setIntent({ kind: 'unbind', channelId: channel.id })}
          >
            断开
          </Button>
        ) : null}
        {connection?.userManaged ? (
          <Button
            size="small"
            variant="ghost"
            icon={<UsersRound />}
            onClick={() => navigate(`/wiring/connections/${connection.id}`)}
          >
            账号与成员
          </Button>
        ) : null}
      </div>
      <BindDialog intent={intent} onClose={() => setIntent(null)} />
    </>
  )
}

export function WiringDetail({
  selected,
}: {
  readonly selected: { readonly kind: 'connection' | 'channel' | 'agent'; readonly id: string } | undefined
}) {
  const connection = useProductStore((state) =>
    selected?.kind === 'connection' ? state.connections.find((item) => item.id === selected.id) : undefined,
  )
  return (
    <aside className={styles.detail} aria-label="详情">
      {connection ? (
        <ConnectionDetail key={connection.id} connection={connection} />
      ) : selected?.kind === 'channel' ? (
        <ChannelDetail key={selected.id} channelId={selected.id} />
      ) : null}
    </aside>
  )
}
