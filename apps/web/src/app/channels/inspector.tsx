import { useGo } from '../model/nav.js'
import { PanelSlot } from '../../extension-ui/index.js'
import { Cable, ChevronRight, Trash2 } from 'lucide-react'
import { useState } from 'react'

import {
  connectionDisplayName,
  useProductStore,
  type AgentSummary,
  type ChannelSummary,
  type ConnectionSummary,
} from '../../product-runtime.js'
import {
  AgentAvatar,
  Button,
  Chip,
  ConfirmDialog,
  DetailPane,
  Diagnostics,
  Disclosure,
  Gauge,
  InlineEdit,
  PropertyGroup,
  PropertyList,
  PropertyRow,
  Pressable,
  Select,
  StatusDot,
  Switch,
  toast,
} from '../../ui-kit/next/index.js'
import { agentHue, isAgentWorking, triggerLabel, isTriggerPolicy, type TriggerPolicy } from '../model/identity.js'
import { connectionStatus } from '../model/connection-status.js'
import { BindDialog, type BindIntent } from './bind-dialog.js'
import { useProductApi } from '../model/store.js'
import styles from './channels.module.css'
import { formatTokens } from './timeline-model.js'

const TRIGGERS = ['mentioned-or-replied', 'always', 'command', 'observe-only'] as const

const kindLabel: Record<ChannelSummary['kind'], string> = { internal: '内置频道', group: '群聊', direct: '私聊' }

const failure = (error: unknown) => toast(error instanceof Error ? error.message : String(error), { tone: 'bad' })

/** The channel's detail pane: who answers it and how, its context, where it comes from (Decision 2026-10-06 §8). */
export function ChannelInspector({
  channel,
  agent,
  connection,
  onClose,
}: {
  readonly channel: ChannelSummary
  readonly agent: AgentSummary | undefined
  readonly connection: ConnectionSummary | undefined
  readonly onClose: () => void
}) {
  const navigate = useGo()
  const api = useProductApi()
  const agents = useProductStore((state) => state.agents)
  const runtime = useProductStore((state) => state.channelRuntimes[channel.id])
  const [intent, setIntent] = useState<BindIntent | null>(null)
  const [reset, setReset] = useState<'compact' | 'clear' | null>(null)
  const [removing, setRemoving] = useState(false)
  const [eventsOpen, setEventsOpen] = useState(false)
  const binding = channel.bindings[0]
  const occupancy = runtime?.occupancy
  const breakdown = occupancy?.breakdown
  const other =
    occupancy && breakdown
      ? Math.max(
          0,
          occupancy.projectedTokens - breakdown.systemTokens - breakdown.toolsTokens - breakdown.messageTokens,
        )
      : 0

  const descriptor = useProductStore((state) =>
    state.connectionAdapters.find((item) => item.key === connection?.adapterKey),
  )
  // Activities this adapter can trigger in this kind of channel and the connection has not disabled.
  const activities = (descriptor?.activities ?? []).filter((activity) => {
    const capability = connection?.activityCapabilities[activity.key]
    return (
      activity.scope === 'channel' &&
      activity.triggerable &&
      activity.channelKinds?.includes(channel.kind) === true &&
      capability?.state !== 'disabled' &&
      capability?.state !== 'unsupported'
    )
  })
  const feedbackCapability = connection?.processingFeedbackCapability
  const showFeedback =
    channel.kind !== 'internal' &&
    descriptor?.features.processingFeedback?.channelKinds.includes(channel.kind) === true &&
    feedbackCapability?.state !== 'disabled' &&
    feedbackCapability?.state !== 'unsupported'
  const overrides = binding ? Object.keys(binding.activityTriggerOverrides).length : 0

  const updateBinding = async (
    patch: Partial<Pick<NonNullable<typeof binding>, 'processingFeedback' | 'activityTriggerOverrides'>>,
  ) => {
    if (!agent || !binding) return
    try {
      await api.getState().createBinding({
        agentId: agent.id,
        channelId: channel.id,
        triggerPolicy: binding.triggerPolicy,
        processingFeedback: patch.processingFeedback ?? binding.processingFeedback,
        activityTriggerOverrides: patch.activityTriggerOverrides ?? binding.activityTriggerOverrides,
      })
    } catch (error) {
      failure(error)
    }
  }
  const changeTrigger = async (triggerPolicy: TriggerPolicy) => {
    if (!agent) return
    try {
      await api.getState().createBinding({ agentId: agent.id, channelId: channel.id, triggerPolicy })
      toast(`触发改为“${triggerLabel[triggerPolicy]}”`)
    } catch (error) {
      failure(error)
    }
  }

  return (
    <DetailPane
      label="频道信息"
      onClose={onClose}
      header={
        <div className={styles.paneHeader}>
          <InlineEdit
            label="频道名称"
            value={channel.name}
            onSave={async (next) => {
              if (!next) return
              try {
                await api.getState().renameChannel(channel.id, next)
                toast('频道名称已保存')
              } catch (error) {
                failure(error)
              }
            }}
          />
          <span className={styles.paneMeta}>
            {kindLabel[channel.kind]} · {connection ? connectionDisplayName(connection) : channel.connectionName}
          </span>
        </div>
      }
    >
      <PropertyGroup title="响应">
        {agent ? (
          <div className={styles.who}>
            <AgentAvatar name={agent.name} hue={agentHue(agent)} live={isAgentWorking(agent)} />
            <div className={styles.whoText}>
              <div className={styles.whoName}>{agent.name}</div>
              <div className={styles.whoMeta}>{agent.model}</div>
            </div>
            <Button size="small" variant="ghost" onClick={() => navigate(`/agents/${agent.id}`)}>
              打开
            </Button>
          </div>
        ) : null}
        <PropertyList framed={false}>
          <PropertyRow label="智能体">
            <Select
              aria-label="响应的智能体"
              value={agent?.id ?? ''}
              {...(agent ? {} : { placeholder: '选择智能体' })}
              options={agents.map((item) => ({ value: item.id, label: item.name }))}
              onChange={(event) => {
                const next = event.target.value
                if (next && next !== agent?.id)
                  setIntent({ kind: agent ? 'replace' : 'bind', channelId: channel.id, agentId: next })
              }}
            />
          </PropertyRow>
          {agent && binding ? (
            <PropertyRow label="触发">
              <Select
                aria-label="触发方式"
                value={binding.triggerPolicy}
                options={TRIGGERS.map((value) => ({ value, label: triggerLabel[value] ?? value }))}
                onChange={(event) => isTriggerPolicy(event.target.value) && void changeTrigger(event.target.value)}
              />
            </PropertyRow>
          ) : null}
        </PropertyList>
        {agent ? (
          <div className={styles.paneActions}>
            <Button size="small" variant="ghost" onClick={() => setIntent({ kind: 'unbind', channelId: channel.id })}>
              断开
            </Button>
          </div>
        ) : null}
      </PropertyGroup>

      {agent && binding && (showFeedback || activities.length > 0) ? (
        <PropertyGroup title="频道事件">
          <PropertyList framed={false}>
            {showFeedback ? (
              <PropertyRow
                label="处理中反馈"
                description={feedbackCapability?.reason ?? '处理期间给触发消息加临时回应，结束后移除'}
              >
                <Switch
                  label="处理中反馈"
                  checked={binding.processingFeedback === 'auto'}
                  onCheckedChange={(checked) => void updateBinding({ processingFeedback: checked ? 'auto' : 'off' })}
                />
              </PropertyRow>
            ) : null}
            {activities.length > 0 ? (
              <PropertyRow label="特殊事件" description={overrides > 0 ? `${overrides} 项单独设置` : '跟随账号'}>
                <Pressable
                  className={styles.expand}
                  aria-expanded={eventsOpen}
                  aria-controls="channel-activity-overrides"
                  aria-label={eventsOpen ? '收起特殊事件' : '展开特殊事件'}
                  onClick={() => setEventsOpen(!eventsOpen)}
                >
                  <ChevronRight size={16} data-open={eventsOpen} />
                </Pressable>
              </PropertyRow>
            ) : null}
          </PropertyList>
          {activities.length > 0 ? (
            <Disclosure open={eventsOpen} id="channel-activity-overrides">
              <PropertyList>
                {activities.map((activity) => {
                  const override = binding.activityTriggerOverrides[activity.key]
                  const inherited = connection?.activityTriggerDefaults.includes(activity.key) === true
                  return (
                    <PropertyRow key={activity.key} label={activity.displayName} layout="stacked">
                      <Select
                        aria-label={activity.displayName}
                        value={override === undefined ? 'inherit' : override ? 'on' : 'off'}
                        disabled={binding.triggerPolicy === 'observe-only'}
                        options={[
                          { value: 'inherit', label: `跟随账号（${inherited ? '触发' : '不触发'}）` },
                          { value: 'on', label: '触发' },
                          { value: 'off', label: '不触发' },
                        ]}
                        onChange={(event) => {
                          const next = { ...binding.activityTriggerOverrides }
                          if (event.target.value === 'inherit') delete next[activity.key]
                          else next[activity.key] = event.target.value === 'on'
                          void updateBinding({ activityTriggerOverrides: next })
                        }}
                      />
                    </PropertyRow>
                  )
                })}
              </PropertyList>
            </Disclosure>
          ) : null}
        </PropertyGroup>
      ) : null}

      {agent && (occupancy || runtime?.episodeId) ? (
        <PropertyGroup title="上下文">
          {occupancy ? (
            <Gauge
              total={occupancy.projectedTokens}
              capacity={occupancy.contextWindow}
              format={formatTokens}
              segments={
                breakdown
                  ? [
                      { label: '系统', value: breakdown.systemTokens, color: 'var(--accent)' },
                      { label: '工具', value: breakdown.toolsTokens, color: 'var(--brass)' },
                      { label: '对话', value: breakdown.messageTokens, color: 'var(--ok)' },
                      { label: '其他', value: other, color: 'var(--faint)' },
                    ].filter((segment) => segment.value > 0)
                  : [{ label: '已用', value: occupancy.projectedTokens, color: 'var(--accent)' }]
              }
            />
          ) : null}
          {runtime?.episodeId ? (
            <div className={styles.paneActions}>
              <Button size="small" onClick={() => setReset('compact')}>
                压缩
              </Button>
              <Button size="small" onClick={() => setReset('clear')}>
                清空
              </Button>
            </div>
          ) : null}
        </PropertyGroup>
      ) : null}

      <PanelSlot anchor={{ kind: 'channel', id: channel.id }} density="compact" />
      {agent ? <PanelSlot anchor={{ kind: 'agent', id: agent.id }} density="compact" /> : null}

      <PropertyGroup
        title="来源"
        actions={
          connection?.userManaged ? (
            <Button
              size="small"
              variant="ghost"
              icon={<Cable />}
              onClick={() => navigate(`/wiring/connections/${connection.id}`)}
            >
              接线
            </Button>
          ) : undefined
        }
      >
        <div className={styles.source}>
          {connection ? (
            <>
              <StatusDot tone={connectionStatus(connection).tone} />
              <b>{connectionDisplayName(connection)}</b>
              {connection.alias ? <span className={styles.paneMeta}>{connection.adapter}</span> : null}
              {connectionStatus(connection).health === 'ok' ? null : (
                <Chip tone={connectionStatus(connection).tone}>{connectionStatus(connection).label}</Chip>
              )}
            </>
          ) : (
            <span>{channel.connectionName}</span>
          )}
        </div>
      </PropertyGroup>

      <Diagnostics
        items={[
          { label: '频道 ID', value: channel.id },
          { label: '连接 ID', value: channel.connectionId },
          ...(runtime?.episodeId ? [{ label: '会话 ID', value: runtime.episodeId }] : []),
        ]}
      />

      <div className={styles.paneActions}>
        <Button size="small" variant="danger" icon={<Trash2 />} onClick={() => setRemoving(true)}>
          {channel.kind === 'internal' ? '删除频道' : '移除频道'}
        </Button>
      </div>

      <BindDialog intent={intent} onClose={() => setIntent(null)} />
      <ConfirmDialog
        open={reset !== null}
        onOpenChange={(open) => !open && setReset(null)}
        title={reset === 'clear' ? '清空上下文？' : '压缩上下文？'}
        confirmLabel={reset === 'clear' ? '清空' : '压缩'}
        danger={reset === 'clear'}
        onConfirm={async () => {
          if (!runtime?.episodeId || !reset) return
          await api.getState().resetChannelContext(channel.id, runtime.episodeId, reset)
          toast(reset === 'clear' ? '已清空上下文' : '已压缩上下文')
        }}
      >
        <p>
          {reset === 'clear' ? '当前任务会停止，从空白开始。聊天记录保留。' : '当前任务会停止，对话整理成摘要后继续。'}
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={`${channel.kind === 'internal' ? '删除' : '移除'}「${channel.name}」？`}
        confirmLabel={channel.kind === 'internal' ? '删除' : '移除'}
        danger
        onConfirm={async () => {
          await api.getState().deleteChannel(channel.id, channel.agentId || null)
          toast(`「${channel.name}」已${channel.kind === 'internal' ? '删除' : '移除'}`)
          navigate('/channels')
        }}
      >
        <p>{channel.kind === 'internal' ? '聊天记录保留在审计中。' : '聊天记录保留，群里有新消息时会重新出现。'}</p>
      </ConfirmDialog>
    </DetailPane>
  )
}
