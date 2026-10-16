import { CommandsSection } from '../settings/commands-section.js'
import { useGo } from '../model/nav.js'
import { PanelSlot } from '../../extension-ui/index.js'
import { ArrowUpRight, ChevronRight, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { promptDocumentPlainText } from '@nekro-nxt/contracts'

import {
  connectionDisplayName,
  useProductStore,
  type AgentSummary,
  type ChannelSummary,
  type ConnectionSummary,
} from '../../product-runtime.js'
import {
  Button,
  ConfirmDialog,
  DangerZone,
  DetailPane,
  Diagnostics,
  Disclosure,
  Gauge,
  IconButton,
  InlineEdit,
  PropertyGroup,
  PropertyList,
  PropertyRow,
  Pressable,
  Select,
  StatusDot,
  Switch,
  toast,
  Tooltip,
} from '../../ui-kit/index.js'
import { connectionStatus } from '../model/connection-status.js'
import { BindDialog, type BindIntent } from './bind-dialog.js'
import { BindingRows } from './binding-fields.js'
import { ChannelMemory } from './channel-memory.js'
import { ContextSheet } from './context-sheet.js'
import { ChannelPromptSheet, type ChannelPromptView } from './channel-prompt-sheet.js'
import { workspaceApi } from '../../host-api-client.js'
import { useProductApi } from '../model/store.js'
import styles from './channels.module.css'
import { formatTokens } from './timeline-model.js'
import { describeSchedule, sortTasks } from '../agents/scheduled-task-model.js'
import { nextRunText, TaskActions, useScheduledTaskActions } from '../agents/scheduled-tasks-section.js'

const INSPECTOR_TASKS = 3

const kindLabel: Record<ChannelSummary['kind'], string> = { internal: '内置频道', group: '群聊', direct: '私聊' }

/** A glimpse of the admin's instructions; the agent's notes show in the memory group. */
const channelPromptSummary = (view: ChannelPromptView | undefined): string | undefined => {
  if (view === undefined) return undefined
  const text = promptDocumentPlainText(view.instructions.document).replace(/\s+/gu, ' ').trim()
  return text ? (text.length > 18 ? `${text.slice(0, 17)}…` : text) : '还没有'
}

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
  const [contextOpen, setContextOpen] = useState(false)
  const [promptOpen, setPromptOpen] = useState<false | 'instructions' | 'notes'>(false)
  const [prompt, setPrompt] = useState<ChannelPromptView | undefined>()
  const boundAgentId = channel.bindings[0]?.agentId
  useEffect(() => {
    setPrompt(undefined)
    // The row only shows for a bound channel.
    if (boundAgentId === undefined) return
    const controller = new AbortController()
    workspaceApi
      .getChannelPrompt(channel.id, { signal: controller.signal })
      .then(setPrompt)
      .catch(() => undefined)
    return () => controller.abort()
    // A turn may have rewritten the prompt through the agent's tool.
  }, [channel.id, boundAgentId, runtime?.turns.at(-1)?.endedAt])
  const allTasks = useProductStore((state) => state.scheduledTasks)
  const tasks = sortTasks(
    allTasks.filter((task) => task.channelId === channel.id && task.agentId === agent?.id && task.state !== 'finished'),
  )
  const taskActions = useScheduledTaskActions()
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
  const localAgentNames = channel.localAgentIds.flatMap((agentId) => {
    const name = agents.find((candidate) => candidate.id === agentId)?.name
    return name === undefined ? [] : [name]
  })

  const updateBinding = async (
    patch: Partial<
      Pick<NonNullable<typeof binding>, 'processingFeedback' | 'localAgentMessages' | 'activityTriggerOverrides'>
    >,
  ) => {
    if (!agent || !binding) return
    try {
      await api.getState().createBinding({
        agentId: agent.id,
        channelId: channel.id,
        triggerPolicy: binding.triggerPolicy,
        processingFeedback: patch.processingFeedback ?? binding.processingFeedback,
        localAgentMessages: patch.localAgentMessages ?? binding.localAgentMessages,
        activityTriggerOverrides: patch.activityTriggerOverrides ?? binding.activityTriggerOverrides,
      })
    } catch (error) {
      failure(error)
    }
  }
  const changePaused = async (paused: boolean) => {
    try {
      await api.getState().setChannelPaused(channel.id, paused)
      toast(paused ? '已暂停这个频道的自动回应' : '已恢复自动回应')
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
          {channel.kind !== 'internal' && channel.platformName && channel.customName ? (
            <span className={styles.paneMeta}>
              平台名称：{channel.platformName}
              <Button
                size="small"
                variant="ghost"
                onClick={() => {
                  void api
                    .getState()
                    .renameChannel(channel.id, '')
                    .then(() => toast('已使用平台名称'))
                    .catch(failure)
                }}
              >
                改用平台名称
              </Button>
            </span>
          ) : null}
          <span className={styles.paneMeta}>
            {channel.kind === 'internal'
              ? kindLabel.internal
              : `${kindLabel[channel.kind]} · ${connection ? connectionDisplayName(connection) : channel.connectionName}`}
          </span>
        </div>
      }
    >
      <PropertyGroup title="谁来回复" description={agent ? undefined : '还没有智能体回复这个频道'}>
        <PropertyList>
          <BindingRows
            channel={channel}
            onIntent={setIntent}
            responderDescription={agent?.model}
            responderExtra={
              agent ? (
                <IconButton
                  label={`打开${agent.name}的资料`}
                  size="small"
                  onClick={() => navigate(`/agents/${agent.id}`)}
                >
                  <ArrowUpRight size={15} />
                </IconButton>
              ) : null
            }
          />
          {agent && binding ? (
            <PropertyRow
              label="暂停回应"
              description={binding.paused ? '暂停中：不会自动回应，上面的规则保留' : undefined}
              tip="临时停止这个频道的所有自动回应：消息、平台事件、定时任务和扩展唤醒都不再触发，并停止当前轮次；上面的「何时回复」不变，恢复后不重跑已停止的任务。长期只看不回请把「何时回复」设为仅观察。也可在频道里输入 /pause、/resume。"
            >
              <Switch
                label="暂停回应"
                checked={binding.paused}
                onCheckedChange={(checked) => void changePaused(checked)}
              />
            </PropertyRow>
          ) : null}
          {agent && binding ? (
            <PropertyRow
              label="频道说明"
              description={channelPromptSummary(prompt)}
              tip="只在这个频道生效的要求，例如群规、语气和称呼；不改变智能体的人设。"
            >
              <Button size="small" onClick={() => setPromptOpen('instructions')}>
                {prompt === undefined || prompt.instructions.revision === 0 ? '添加' : '编辑'}
              </Button>
            </PropertyRow>
          ) : null}
          {agent && binding && showFeedback ? (
            <PropertyRow
              label="处理中反馈"
              description={feedbackCapability?.reason}
              tip={feedbackCapability?.reason ? undefined : '处理期间给触发消息加临时回应，结束后移除'}
            >
              <Switch
                label="处理中反馈"
                checked={binding.processingFeedback === 'auto'}
                onCheckedChange={(checked) => updateBinding({ processingFeedback: checked ? 'auto' : 'off' })}
              />
            </PropertyRow>
          ) : null}
          {agent && binding && localAgentNames.length > 0 ? (
            <PropertyRow
              label="回应本机智能体"
              description={`${localAgentNames.join('、')}也在这个群`}
              tip="关闭时，本机其他智能体的发言只记入上下文；它 @ 或回复本智能体时仍会回应。打开后按上面的触发方式处理，两个智能体可能互相接话。"
            >
              <Switch
                label="回应本机智能体"
                checked={binding.localAgentMessages === 'trigger'}
                onCheckedChange={(checked) => updateBinding({ localAgentMessages: checked ? 'trigger' : 'observe' })}
              />
            </PropertyRow>
          ) : null}
          {agent && binding && activities.length > 0 ? (
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
        {agent && binding && activities.length > 0 ? (
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
                      onValueChange={(value) => {
                        const next = { ...binding.activityTriggerOverrides }
                        if (value === 'inherit') delete next[activity.key]
                        else next[activity.key] = value === 'on'
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

      {agent ? (
        <PropertyGroup title="记忆" description={`${agent.name}在这个频道里记住的内容`}>
          {occupancy || runtime?.episodeId ? (
            <div className={styles.contextCard}>
              <div className={styles.contextHead}>
                <span className={styles.contextTitle}>当前会话</span>
                {runtime?.episodeId ? (
                  <span className={styles.contextActions}>
                    <Tooltip content="模型实际收到的系统提示词、工具和对话">
                      <Button size="small" variant="ghost" onClick={() => setContextOpen(true)}>
                        查看
                      </Button>
                    </Tooltip>
                    <Tooltip content="把较早的对话整理成摘要，腾出空间">
                      <Button size="small" variant="ghost" onClick={() => setReset('compact')}>
                        压缩
                      </Button>
                    </Tooltip>
                  </span>
                ) : null}
              </div>
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
                          {
                            label: occupancy.imageCount ? `图片等（${occupancy.imageCount} 张）` : '其他',
                            value: other,
                            color: 'var(--faint)',
                          },
                        ].filter((segment) => segment.value > 0)
                      : [{ label: '已用', value: occupancy.projectedTokens, color: 'var(--accent)' }]
                  }
                />
              ) : null}
            </div>
          ) : null}
          <ChannelMemory
            channelId={channel.id}
            channelName={channel.name}
            prompt={prompt}
            refreshKey={runtime?.turns.at(-1)?.endedAt}
            activities={runtime?.memory}
            onEditNotes={() => setPromptOpen('notes')}
          />
        </PropertyGroup>
      ) : null}

      {agent && tasks.length > 0 ? (
        <PropertyGroup
          title="定时任务"
          actions={
            tasks.length > INSPECTOR_TASKS ? (
              <Button size="small" variant="ghost" onClick={() => navigate(`/agents/${agent.id}`)}>
                全部 {tasks.length} 个
              </Button>
            ) : undefined
          }
        >
          <PropertyList>
            {tasks.slice(0, INSPECTOR_TASKS).map((task) => (
              <PropertyRow
                key={task.id}
                label={task.label}
                description={`${describeSchedule(task)} · ${nextRunText(task)}`}
              >
                <span className={styles.rowActions}>
                  <TaskActions task={task} act={taskActions.act} />
                </span>
              </PropertyRow>
            ))}
          </PropertyList>
          {taskActions.dialog}
        </PropertyGroup>
      ) : null}

      <PanelSlot anchor={{ kind: 'channel', id: channel.id }} density="compact" />
      {agent ? <PanelSlot anchor={{ kind: 'agent', id: agent.id }} density="compact" /> : null}

      <CommandsSection key={channel.id} channelId={channel.id} />
      <PropertyGroup title="来源">
        <PropertyList>
          {connection && channel.kind !== 'internal' ? (
            <PropertyRow
              label={
                <span className={styles.sourceName}>
                  <StatusDot tone={connectionStatus(connection).tone} />
                  {connectionDisplayName(connection)}
                </span>
              }
              description={
                connectionStatus(connection).health === 'ok'
                  ? connection.alias
                    ? connection.adapter
                    : '平台账号'
                  : connectionStatus(connection).label
              }
            >
              {connection.userManaged ? (
                <Button size="small" variant="ghost" onClick={() => navigate(`/wiring/connections/${connection.id}`)}>
                  在接线中打开
                </Button>
              ) : null}
            </PropertyRow>
          ) : (
            <PropertyRow label="内置频道" description="智能体自带的频道，不来自外部平台" />
          )}
        </PropertyList>
      </PropertyGroup>

      <DangerZone>
        {agent && runtime?.episodeId ? (
          <PropertyRow label="清空上下文" description="当前任务停止，从空白开始；笔记和聊天记录保留。">
            <Button size="small" variant="danger" onClick={() => setReset('clear')}>
              清空
            </Button>
          </PropertyRow>
        ) : null}
        <PropertyRow
          label={channel.kind === 'internal' ? '删除频道' : '移除频道'}
          description={
            channel.kind === 'internal' ? '聊天记录保留在审计中。' : '聊天记录保留，群里有新消息时会重新出现。'
          }
        >
          <Button
            size="small"
            variant="danger"
            icon={<Trash2 />}
            aria-label={channel.kind === 'internal' ? '删除频道' : '移除频道'}
            onClick={() => setRemoving(true)}
          >
            {channel.kind === 'internal' ? '删除' : '移除'}
          </Button>
        </PropertyRow>
      </DangerZone>

      <Diagnostics
        items={[
          { label: '频道 ID', value: channel.id },
          { label: '连接 ID', value: channel.connectionId },
          ...(runtime?.episodeId ? [{ label: '会话 ID', value: runtime.episodeId }] : []),
        ]}
      />

      <BindDialog intent={intent} onClose={() => setIntent(null)} />
      <ChannelPromptSheet
        open={promptOpen !== false}
        onOpenChange={(open) => setPromptOpen(open ? promptOpen || 'instructions' : false)}
        focus={promptOpen || 'instructions'}
        channelId={channel.id}
        channelName={channel.name}
        agentId={agent?.id}
        onSaved={setPrompt}
      />
      {agent ? (
        <ContextSheet open={contextOpen} onOpenChange={setContextOpen} channelId={channel.id} agentName={agent.name} />
      ) : null}
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
