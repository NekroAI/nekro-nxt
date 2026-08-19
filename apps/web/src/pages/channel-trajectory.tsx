import { Activity, ChevronDown, ChevronRight, PanelRightClose, PanelRightOpen, Wrench } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { notify } from '../components/notifications.js'
import { InlineFeedback } from '../components/product-feedback.js'
import {
  useProductStore,
  type AgentRuntimeState,
  type AgentSummary,
  type ChannelRuntimeView,
  type ChannelSummary,
} from '../product-store.js'
import { Button, Field, Input, SelectField, StatusBadge, type StatusTone } from '../ui-kit/index.js'
import { isTriggerPolicy, TRIGGER_POLICY_OPTIONS } from './binding-task.js'
import styles from './product-pages.module.css'

const TRAJECTORY_PREFERENCE_KEY = 'nekro-nxt.trajectory-expanded'
const WIDE_TRAJECTORY_QUERY = '(min-width: 1440px)'

const agentTone = (state: AgentRuntimeState): StatusTone => {
  if (state === '思考中' || state === '使用工具') return 'info'
  if (state === '等待输入') return 'warning'
  if (state === '不可用') return 'error'
  return 'neutral'
}

const readPreference = (): 'auto' | 'open' | 'closed' => {
  if (typeof window === 'undefined') return 'auto'
  const stored = window.localStorage.getItem(TRAJECTORY_PREFERENCE_KEY)
  return stored === 'open' || stored === 'closed' ? stored : 'auto'
}

const shouldExpand = (phase: AgentRuntimeState, preference: 'auto' | 'open' | 'closed'): boolean => {
  if (preference === 'open') return true
  if (preference === 'closed') return false
  if (typeof window !== 'undefined' && !window.matchMedia(WIDE_TRAJECTORY_QUERY).matches) return false
  return phase !== '空闲'
}

const turnConclusion = (runtime: ChannelRuntimeView): string | undefined => {
  const latest = runtime.turns.at(-1)
  if (!latest || latest.state === 'in-progress') return undefined
  if (latest.state === 'error') return latest.error?.message ?? '本轮执行失败。'
  if (latest.state === 'max-tokens') return '本轮达到输出上限。'
  if (latest.state === 'aborted' || latest.state === 'interrupted') return '本轮已中断。'
  if (!latest.producedReply) return '本轮未产生回复。'
  return '本轮已完成。'
}

export function ChannelTrajectoryPane({
  channel,
  agent,
  onBind,
  onReassign,
}: {
  readonly channel: ChannelSummary
  readonly agent: AgentSummary | undefined
  readonly onBind: () => void
  readonly onReassign: () => void
}) {
  const navigate = useNavigate()
  const runtime = useProductStore((state) => state.channelRuntimes[channel.id])
  const phase = runtime?.phase ?? channel.runtimePhase
  const [preference, setPreference] = useState<'auto' | 'open' | 'closed'>(readPreference)
  const [renamePending, setRenamePending] = useState(false)
  const [triggerPending, setTriggerPending] = useState(false)
  const [channelName, setChannelName] = useState(channel.name)
  const currentTrigger = channel.bindings[0]?.triggerPolicy ?? 'mentioned-or-replied'
  const expanded = shouldExpand(phase, preference)
  const currentTools = useMemo(
    () => runtime?.turns.at(-1)?.steps.flatMap((step) => step.tools.filter((tool) => tool.state === 'running')) ?? [],
    [runtime],
  )
  const conclusion = runtime ? turnConclusion(runtime) : undefined

  useEffect(() => {
    setChannelName(channel.name)
  }, [channel.id, channel.name])

  useEffect(() => {
    void useProductStore
      .getState()
      .loadChannelRuntime(channel.id)
      .catch(() => undefined)
  }, [channel.id])

  const setExpanded = (next: boolean): void => {
    const value = next ? 'open' : 'closed'
    setPreference(value)
    window.localStorage.setItem(TRAJECTORY_PREFERENCE_KEY, value)
  }

  const rename = async (): Promise<void> => {
    if (!channelName.trim() || channelName.trim() === channel.name || renamePending) return
    setRenamePending(true)
    try {
      await useProductStore.getState().renameChannel(channel.id, channelName)
      notify('频道名称已保存。', 'success', `channel-rename:${channel.id}`)
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error', `channel-rename:${channel.id}`)
    } finally {
      setRenamePending(false)
    }
  }

  const updateTrigger = async (triggerPolicy: (typeof TRIGGER_POLICY_OPTIONS)[number]['value']): Promise<void> => {
    if (!agent || triggerPending || triggerPolicy === currentTrigger) return
    setTriggerPending(true)
    try {
      await useProductStore.getState().createBinding({
        agentId: agent.id,
        channelId: channel.id,
        triggerPolicy,
      })
      notify('响应方式已更新。', 'success', `channel-trigger:${channel.id}`)
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error', `channel-trigger:${channel.id}`)
    } finally {
      setTriggerPending(false)
    }
  }

  return (
    <aside className={[styles.inspector, expanded ? styles.inspectorExpanded : styles.inspectorCollapsed].join(' ')}>
      <section>
        <div className={styles.trajectoryHeader}>
          <div>
            <h2>运行轨迹</h2>
            <p>{agent ? `由“${agent.name}”响应` : '尚未绑定智能体'}</p>
          </div>
          <Button
            size="small"
            variant="ghost"
            aria-expanded={expanded}
            aria-label={expanded ? '收起运行轨迹' : '展开运行轨迹'}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? (
              <PanelRightClose size={14} aria-hidden="true" />
            ) : (
              <PanelRightOpen size={14} aria-hidden="true" />
            )}
            {expanded ? '收起' : '展开'}
          </Button>
        </div>
        {agent ? <StatusBadge tone={agentTone(phase)}>{phase}</StatusBadge> : null}
        <p className={styles.trajectorySummary}>
          {runtime?.summary ?? (agent ? '智能体当前空闲。' : '绑定智能体后才能自动响应消息。')}
        </p>
      </section>

      {expanded ? (
        <>
          <section>
            <h2>当前轮次</h2>
            {currentTools.length > 0 ? (
              <ul className={styles.trajectoryTools}>
                {currentTools.map((tool) => (
                  <li key={tool.callId}>
                    <Wrench size={14} aria-hidden="true" />
                    <span>
                      <strong>{tool.displayName}</strong>
                      {tool.inputPreview ? <small>{tool.inputPreview}</small> : null}
                    </span>
                    <StatusBadge tone="info">进行中</StatusBadge>
                  </li>
                ))}
              </ul>
            ) : (
              <div className={styles.trajectoryIdleRow}>
                <Activity size={14} aria-hidden="true" />
                <span>
                  {phase === '空闲' ? '当前没有进行中的工具调用。' : (runtime?.summary ?? '智能体正在处理当前消息。')}
                </span>
              </div>
            )}
            {runtime && runtime.pendingInjectCount > 0 ? (
              <InlineFeedback tone="info">
                {runtime.pendingInjectCount} 条新消息已收录，将在安全间隙进入后续处理。
              </InlineFeedback>
            ) : null}
            {conclusion ? (
              <InlineFeedback tone={runtime?.turns.at(-1)?.state === 'error' ? 'error' : 'info'}>
                {conclusion}
              </InlineFeedback>
            ) : null}
            {runtime?.turns.at(-1)?.steps.some((step) => step.tools.length > 0) ? (
              <ol className={styles.trajectorySteps}>
                {runtime.turns.at(-1)?.steps.map((step) =>
                  step.tools.map((tool) => (
                    <li key={tool.callId}>
                      <span className={styles.trajectoryStepMark} data-state={tool.state} />
                      <span>
                        <strong>{tool.displayName}</strong>
                        <small>
                          {tool.state === 'running' ? '进行中' : tool.state === 'failed' ? '失败' : '完成'}
                          {tool.wroteToChannel ? ' · 已写入频道' : ''}
                        </small>
                      </span>
                    </li>
                  )),
                )}
              </ol>
            ) : null}
          </section>

          <section>
            <h2>频道绑定</h2>
            <dl className={styles.facts}>
              <dt>智能体</dt>
              <dd>{agent?.name ?? '未绑定'}</dd>
              <dt>来源</dt>
              <dd>{channel.kind === 'web' ? '网页聊天' : 'QQ 机器人账号'}</dd>
            </dl>
            {agent ? (
              <SelectField
                label="响应方式"
                value={currentTrigger}
                disabled={triggerPending}
                onValueChange={(value) => {
                  if (isTriggerPolicy(value)) void updateTrigger(value)
                }}
                options={TRIGGER_POLICY_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
              />
            ) : (
              <InlineFeedback tone="warning">绑定智能体后才能自动响应这个频道的消息。</InlineFeedback>
            )}
            <div className={styles.inspectorActions}>
              {agent ? (
                <>
                  <Button size="small" onClick={onReassign}>
                    改由其他智能体响应
                  </Button>
                  <Button size="small" variant="ghost" onClick={() => void navigate(`/agents/${agent.id}`)}>
                    管理智能体
                  </Button>
                </>
              ) : (
                <Button size="small" variant="primary" onClick={onBind}>
                  绑定智能体
                </Button>
              )}
            </div>
            <details className={styles.channelDetails}>
              <summary>频道显示名称</summary>
              <div className={styles.channelRename}>
                <Field
                  label="频道名称"
                  hint={channel.kind === 'web' ? '用于消息列表显示。' : 'QQ 不提供群名称时，可在此设置本地名称。'}
                >
                  <Input value={channelName} onChange={(event) => setChannelName(event.target.value)} maxLength={120} />
                </Field>
                <Button
                  size="small"
                  loading={renamePending}
                  loadingLabel="保存中…"
                  disabled={!channelName.trim() || channelName.trim() === channel.name}
                  onClick={() => void rename()}
                >
                  保存名称
                </Button>
              </div>
            </details>
          </section>
        </>
      ) : (
        <section>
          <button className={styles.trajectoryExpandHint} type="button" onClick={() => setExpanded(true)}>
            {currentTools[0] ? <Wrench size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
            <span>{currentTools[0] ? currentTools[0].displayName : '展开运行轨迹'}</span>
            <ChevronDown size={14} aria-hidden="true" />
          </button>
        </section>
      )}
    </aside>
  )
}
