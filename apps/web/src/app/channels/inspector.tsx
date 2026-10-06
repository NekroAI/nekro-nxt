import { useGo } from '../model/nav.js'
import { PanelSlot } from '../../extension-ui/index.js'
import { Cable, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'

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
  ConfirmDialog,
  Disclosure,
  Field,
  Gauge,
  Input,
  Select,
  StatusDot,
  SwitchRow,
  toast,
} from '../../ui-kit/next/index.js'
import {
  agentHue,
  connectionTone,
  isAgentWorking,
  triggerLabel,
  isTriggerPolicy,
  type TriggerPolicy,
} from '../model/identity.js'
import { BindDialog, type BindIntent } from './bind-dialog.js'
import { useProductApi } from '../model/store.js'
import styles from './channels.module.css'
import { formatTokens } from './timeline-model.js'

export function ChannelInspector({
  channel,
  agent,
  connection,
}: {
  readonly channel: ChannelSummary
  readonly agent: AgentSummary | undefined
  readonly connection: ConnectionSummary | undefined
}) {
  const navigate = useGo()
  const api = useProductApi()
  const agents = useProductStore((state) => state.agents)
  const runtime = useProductStore((state) => state.channelRuntimes[channel.id])
  const [intent, setIntent] = useState<BindIntent | null>(null)
  const [reset, setReset] = useState<'compact' | 'clear' | null>(null)
  const [removing, setRemoving] = useState(false)
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
  const [name, setName] = useState(channel.name)
  const [eventsOpen, setEventsOpen] = useState(false)
  useEffect(() => setName(channel.name), [channel.id, channel.name])

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
      toast(error instanceof Error ? error.message : String(error), { tone: 'bad' })
    }
  }
  const rename = async () => {
    try {
      await api.getState().renameChannel(channel.id, name.trim())
      toast('频道名称已保存')
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), { tone: 'bad' })
    }
  }

  const changeTrigger = async (triggerPolicy: TriggerPolicy) => {
    if (!agent) return
    try {
      await api.getState().createBinding({ agentId: agent.id, channelId: channel.id, triggerPolicy })
      toast(`触发改为“${triggerLabel[triggerPolicy]}”`)
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), { tone: 'bad' })
    }
  }

  return (
    <aside className={styles.inspector} aria-label="频道信息">
      <section>
        <h3 className={styles.inspectorTitle}>响应</h3>
        {agent ? (
          <div className={styles.who}>
            <AgentAvatar name={agent.name} hue={agentHue(agent)} live={isAgentWorking(agent)} />
            <div>
              <div className={styles.whoName}>{agent.name}</div>
              <div className={styles.whoMeta}>{agent.model}</div>
            </div>
            <Button size="small" variant="ghost" onClick={() => navigate(`/agents/${agent.id}`)}>
              打开
            </Button>
          </div>
        ) : null}
        <div className={styles.fields}>
          <Field label="智能体">
            <Select
              value={agent?.id ?? ''}
              {...(agent ? {} : { placeholder: '选择智能体' })}
              options={agents.map((item) => ({ value: item.id, label: item.name }))}
              onChange={(event) => {
                const next = event.target.value
                if (next && next !== agent?.id)
                  setIntent({ kind: agent ? 'replace' : 'bind', channelId: channel.id, agentId: next })
              }}
            />
          </Field>
          {agent && binding ? (
            <Field label="触发">
              <Select
                value={binding.triggerPolicy}
                options={(['mentioned-or-replied', 'always', 'command', 'observe-only'] as const).map((value) => ({
                  value,
                  label: triggerLabel[value] ?? value,
                }))}
                onChange={(event) => isTriggerPolicy(event.target.value) && void changeTrigger(event.target.value)}
              />
            </Field>
          ) : null}
        </div>
        {agent ? (
          <div className={styles.buttons}>
            <Button size="small" variant="ghost" onClick={() => setIntent({ kind: 'unbind', channelId: channel.id })}>
              断开
            </Button>
          </div>
        ) : null}
      </section>

      {agent && binding && (showFeedback || activities.length > 0) ? (
        <section>
          <h3 className={styles.inspectorTitle}>频道事件</h3>
          {showFeedback ? (
            <SwitchRow
              title="处理中反馈"
              description={feedbackCapability?.reason ?? '处理期间给触发消息加临时回应，结束后移除'}
              checked={binding.processingFeedback === 'auto'}
              onCheckedChange={(checked) => void updateBinding({ processingFeedback: checked ? 'auto' : 'off' })}
            />
          ) : null}
          {activities.length > 0 ? (
            <Button
              size="small"
              variant="ghost"
              aria-expanded={eventsOpen}
              aria-controls="channel-activity-overrides"
              onClick={() => setEventsOpen(!eventsOpen)}
            >
              {Object.keys(binding.activityTriggerOverrides).length > 0
                ? `特殊事件 · ${Object.keys(binding.activityTriggerOverrides).length} 项单独设置`
                : '特殊事件 · 跟随账号'}
            </Button>
          ) : null}
          {activities.length > 0 ? (
            <Disclosure open={eventsOpen} id="channel-activity-overrides">
              <div className={styles.fields}>
                {activities.map((activity) => {
                  const override = binding.activityTriggerOverrides[activity.key]
                  const inherited = connection?.activityTriggerDefaults.includes(activity.key) === true
                  return (
                    <Field key={activity.key} label={activity.displayName}>
                      <Select
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
                    </Field>
                  )
                })}
              </div>
            </Disclosure>
          ) : null}
        </section>
      ) : null}

      {agent && (occupancy || runtime?.episodeId) ? (
        <section>
          <h3 className={styles.inspectorTitle}>上下文</h3>
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
            <div className={styles.buttons}>
              <Button size="small" onClick={() => setReset('compact')}>
                压缩
              </Button>
              <Button size="small" onClick={() => setReset('clear')}>
                清空
              </Button>
            </div>
          ) : null}
        </section>
      ) : null}

      <PanelSlot anchor={{ kind: 'channel', id: channel.id }} density="compact" />
      {agent ? <PanelSlot anchor={{ kind: 'agent', id: agent.id }} density="compact" /> : null}

      <section>
        <h3 className={styles.inspectorTitle}>来源</h3>
        <form
          className={styles.renameRow}
          onSubmit={(event) => {
            event.preventDefault()
            void rename()
          }}
        >
          <Input aria-label="频道名称" value={name} maxLength={120} onChange={(event) => setName(event.target.value)} />
          {name.trim() && name.trim() !== channel.name ? (
            <Button size="small" type="submit">
              保存
            </Button>
          ) : null}
        </form>
        <div className={styles.facts}>
          {connection ? (
            <div>
              <StatusDot tone={connectionTone(connection.state)} />
              <b style={{ fontWeight: 600 }}>{connectionDisplayName(connection)}</b>
              {connection.alias ? <span style={{ color: 'var(--muted)' }}>{connection.adapter}</span> : null}
            </div>
          ) : (
            <div>{channel.connectionName}</div>
          )}
        </div>
        <div className={styles.buttons}>
          {connection?.userManaged ? (
            <Button size="small" icon={<Cable />} onClick={() => navigate(`/wiring/connections/${connection.id}`)}>
              接线
            </Button>
          ) : null}
          <Button size="small" variant="danger" icon={<Trash2 />} onClick={() => setRemoving(true)}>
            {channel.kind === 'internal' ? '删除频道' : '移除频道'}
          </Button>
        </div>
      </section>

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
    </aside>
  )
}
