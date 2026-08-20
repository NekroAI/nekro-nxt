import { useEffect, useId, useLayoutEffect, useMemo, useState, type KeyboardEvent, type RefObject } from 'react'
import { useNavigate } from 'react-router-dom'
import { Cell, Pie, PieChart, Tooltip as ChartTooltip } from 'recharts'
import { notify } from '../components/notifications.js'
import { InlineFeedback } from '../components/product-feedback.js'
import {
  useProductStore,
  type AgentRuntimeState,
  type AgentSummary,
  type ChannelRuntimeView,
  type ChannelSummary,
} from '../product-store.js'
import { Button, Field, IconButton, Input, SelectField, StatusBadge, Tabs, type StatusTone } from '../ui-kit/index.js'
import { isTriggerPolicy, TRIGGER_POLICY_OPTIONS } from './binding-task.js'
import styles from './product-pages.module.css'

const VIEW_KEY = 'nekro-nxt.channel-view'

export type ChannelCanvasView = 'chat' | 'trajectory'

type RuntimeTurn = ChannelRuntimeView['turns'][number]
type RuntimeTool = RuntimeTurn['steps'][number]['tools'][number]

export type TrajectoryLane = 'internal' | 'tool' | 'send'

export interface TrajectoryRecord {
  readonly id: string
  readonly turn: number
  readonly turnStart: boolean
  readonly kind: 'message' | 'tool'
  readonly kindLabel: 'MESSAGE' | 'TOOL'
  readonly name: string
  readonly summary: string
  readonly input?: string
  readonly output?: string
  readonly state?: RuntimeTool['state']
  readonly wroteToChannel?: boolean
  readonly durationMs?: number
  readonly firstTokenMs?: number
  readonly usage?: NonNullable<RuntimeTurn['steps'][number]['usage']>
}

export const recordLane = (record: TrajectoryRecord): TrajectoryLane => {
  if (record.kind === 'message') return 'internal'
  if (record.wroteToChannel) return 'send'
  return 'tool'
}

export const formatTokenCount = (value: number): string => {
  if (value < 1000) return String(value)
  if (value < 10_000) return `${(value / 1000).toFixed(1).replace(/\.0$/u, '')}k`
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/u, '')}M`
}

export const formatDurationMs = (value: number): string => {
  if (value < 1000) return `${value}ms`
  if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0).replace(/\.0$/u, '')}s`
  const minutes = Math.floor(value / 60_000)
  const seconds = Math.round((value % 60_000) / 1000)
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

export interface ContextUsageProjection {
  readonly used: number
  readonly remaining: number
  readonly usedPercent: number
  readonly composition: readonly { readonly name: string; readonly value: number; readonly color: string }[]
  readonly estimated: boolean
}

export const projectContextUsage = (
  occupancy: NonNullable<ChannelRuntimeView['occupancy']>,
): ContextUsageProjection => {
  const used = Math.min(occupancy.projectedTokens, occupancy.contextWindow)
  const remaining = Math.max(occupancy.contextWindow - used, 0)
  const system = occupancy.breakdown?.systemTokens ?? 0
  const tools = occupancy.breakdown?.toolsTokens ?? 0
  const messages = occupancy.breakdown?.messageTokens ?? 0
  const known = system + tools + messages
  const estimated = known > used
  const other = Math.max((estimated ? known : used) - known, 0)
  return {
    used,
    remaining,
    usedPercent: occupancy.contextWindow > 0 ? Math.min(100, Math.round((used / occupancy.contextWindow) * 100)) : 0,
    composition: [
      { name: '系统', value: system, color: 'var(--nxt-accent)' },
      { name: '工具', value: tools, color: 'var(--nxt-warning)' },
      { name: '对话', value: messages, color: 'var(--nxt-success)' },
      { name: '其他', value: other, color: 'var(--nxt-text-disabled)' },
    ].filter((item) => item.value > 0),
    estimated,
  }
}

function ContextRing({
  label,
  center,
  data,
}: {
  readonly label: string
  readonly center: string
  readonly data: readonly { readonly name: string; readonly value: number; readonly color: string }[]
}) {
  return (
    <figure className={styles.contextFigure} tabIndex={0} aria-label={label}>
      <div className={styles.contextRing}>
        <PieChart width={112} height={112} accessibilityLayer>
          <Pie data={data} dataKey="value" nameKey="name" innerRadius={34} outerRadius={48} isAnimationActive={false}>
            {data.map((item) => (
              <Cell key={item.name} fill={item.color} />
            ))}
          </Pie>
          <ChartTooltip formatter={(value) => formatTokenCount(Number(value))} />
        </PieChart>
        <strong>{center}</strong>
      </div>
      <figcaption>{label}</figcaption>
      <ul>
        {data.map((item) => (
          <li key={item.name}>
            <span style={{ background: item.color }} />
            {item.name} {formatTokenCount(item.value)}
          </li>
        ))}
      </ul>
    </figure>
  )
}

function ContextUsageCard({ occupancy }: { readonly occupancy: NonNullable<ChannelRuntimeView['occupancy']> }) {
  const projected = projectContextUsage(occupancy)
  const occupancyData = [
    { name: '已用', value: projected.used, color: 'var(--nxt-accent)' },
    { name: '剩余', value: projected.remaining, color: 'var(--nxt-border-default)' },
  ].filter((item) => item.value > 0)
  return (
    <div className={styles.contextUsageCard}>
      <div className={styles.contextCharts}>
        <ContextRing label="上下文占用" center={`${projected.usedPercent}%`} data={occupancyData} />
        {projected.composition.length > 0 ? (
          <ContextRing
            label={projected.estimated ? '估算组成' : '上下文组成'}
            center={formatTokenCount(projected.used)}
            data={projected.composition}
          />
        ) : null}
      </div>
      {occupancy.cacheReadTokens !== undefined ? (
        <dl className={styles.facts}>
          <dt>缓存读取</dt>
          <dd>{formatTokenCount(occupancy.cacheReadTokens)}</dd>
        </dl>
      ) : null}
    </div>
  )
}

const recordStateLabel = (record: TrajectoryRecord): string => {
  const duration = record.durationMs === undefined ? '' : formatDurationMs(record.durationMs)
  if (record.state === 'running') return duration ? `进行中 · ${duration}` : '进行中'
  if (record.state === 'failed') return duration ? `失败 · ${duration}` : '失败'
  if (record.state) return duration ? `完成 · ${duration}` : '完成'
  return duration
}

const usageCaption = (usage: NonNullable<TrajectoryRecord['usage']>): string => {
  const parts = [`输入 ${formatTokenCount(usage.inputTokens)}`, `输出 ${formatTokenCount(usage.outputTokens)}`]
  if (usage.cacheReadTokens !== undefined && usage.cacheReadTokens > 0) {
    parts.push(`缓存读取 ${formatTokenCount(usage.cacheReadTokens)}`)
  }
  return `本步 ${parts.join(' · ')}`
}

const agentTone = (state: AgentRuntimeState): StatusTone => {
  if (state === '思考中' || state === '使用工具') return 'info'
  if (state === '等待输入') return 'warning'
  if (state === '不可用') return 'error'
  return 'neutral'
}

export const readChannelCanvasView = (): ChannelCanvasView => {
  if (typeof window === 'undefined') return 'chat'
  return window.localStorage.getItem(VIEW_KEY) === 'trajectory' ? 'trajectory' : 'chat'
}

export const writeChannelCanvasView = (view: ChannelCanvasView): void => {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(VIEW_KEY, view)
}

export const flattenRuntimeRecords = (runtime: ChannelRuntimeView | undefined): TrajectoryRecord[] => {
  if (!runtime) return []
  const rows: TrajectoryRecord[] = []
  for (const turn of runtime.turns) {
    let turnStart = true
    for (const step of turn.steps) {
      const internal = step.internalOutput
      const text = [internal?.reasoning, internal?.text].filter(Boolean).join('\n').trim()
      if (text) {
        rows.push({
          id: `${turn.turn}:${step.step}:internal`,
          turn: turn.turn,
          turnStart,
          kind: 'message',
          kindLabel: 'MESSAGE',
          name: '内部输出',
          summary: text.split('\n')[0] ?? text,
          output: text,
          ...(step.durationMs === undefined ? {} : { durationMs: step.durationMs }),
          ...(step.firstTokenMs === undefined ? {} : { firstTokenMs: step.firstTokenMs }),
          ...(step.usage === undefined ? {} : { usage: step.usage }),
        })
        turnStart = false
      }
      for (const tool of step.tools) {
        rows.push({
          id: tool.callId,
          turn: turn.turn,
          turnStart,
          kind: 'tool',
          kindLabel: 'TOOL',
          name: tool.displayName,
          summary: tool.inputPreview ?? tool.resultPreview ?? tool.displayName,
          ...(tool.inputPreview === undefined ? {} : { input: tool.inputPreview }),
          ...(tool.resultPreview === undefined ? {} : { output: tool.resultPreview }),
          state: tool.state,
          ...(tool.wroteToChannel === undefined ? {} : { wroteToChannel: tool.wroteToChannel }),
          ...(tool.durationMs === undefined ? {} : { durationMs: tool.durationMs }),
        })
        turnStart = false
      }
    }
  }
  return rows
}

const latestTurn = (runtime: ChannelRuntimeView | undefined): RuntimeTurn | undefined => runtime?.turns.at(-1)

const workTools = (turn: RuntimeTurn | undefined): RuntimeTool[] =>
  turn?.steps.flatMap((step) => step.tools.filter((tool) => tool.wroteToChannel !== true)) ?? []

const internalText = (turn: RuntimeTurn | undefined): string =>
  turn?.steps
    .map((step) => [step.internalOutput?.reasoning, step.internalOutput?.text].filter(Boolean).join('\n'))
    .filter(Boolean)
    .join('\n')
    .trim() ?? ''

export function ChannelViewSwitch() {
  return (
    <Tabs.List className={styles.viewSwitch} aria-label="频道视图">
      <Tabs.Trigger value="chat">会话</Tabs.Trigger>
      <Tabs.Trigger value="trajectory">工作轨迹</Tabs.Trigger>
    </Tabs.List>
  )
}

export function ChannelWorkStream({ runtime }: { readonly runtime: ChannelRuntimeView | undefined }) {
  const turn = latestTurn(runtime)
  const tools = workTools(turn)
  const text = internalText(turn)
  const [thinkOpen, setThinkOpen] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const running = turn?.state === 'in-progress'
  const completed = tools.filter((tool) => tool.state !== 'running')
  const current = tools.find((tool) => tool.state === 'running')
  const compact = !running && !toolsOpen && tools.length > 2
  const preview = running && !toolsOpen && completed.length > 2 ? completed.slice(-2) : completed
  const currentOpen = current !== undefined && openId === current.callId

  useEffect(() => {
    setThinkOpen(false)
    setToolsOpen(false)
    setOpenId(current?.callId ?? null)
  }, [runtime?.channelId, current?.callId])

  if (!turn || (tools.length === 0 && !text && (runtime?.pendingInjectCount ?? 0) === 0)) return null

  return (
    <div className={styles.workStream} data-work-stream>
      {runtime && runtime.pendingInjectCount > 0 ? (
        <div className={styles.sysLine}>{runtime.pendingInjectCount} 条新消息已收录，将在安全间隙进入后续处理。</div>
      ) : null}
      {text ? (
        <Button className={styles.thinkRow} type="button" onClick={() => setThinkOpen((open) => !open)}>
          <span className={styles.workRow}>
            <span
              className={[styles.workDot, running ? styles.workDotRun : styles.workDotOk].join(' ')}
              data-work-status-dot
            />
            <strong>内部输出</strong>
            {thinkOpen ? null : <em>{text.split('\n')[0]}</em>}
          </span>
          {thinkOpen ? <div className={styles.thinkBody}>{text}</div> : null}
        </Button>
      ) : null}
      {compact ? (
        <Button className={styles.toolsMore} type="button" onClick={() => setToolsOpen(true)}>
          {tools.length} 个工具
        </Button>
      ) : (
        <>
          {running && completed.length > 2 && !toolsOpen ? (
            <Button className={styles.toolsMore} type="button" onClick={() => setToolsOpen(true)}>
              {completed.length - 2} 个工具
            </Button>
          ) : null}
          {preview.map((tool) => (
            <WorkToolRow
              key={tool.callId}
              tool={tool}
              open={openId === tool.callId}
              onToggle={() => setOpenId((currentId) => (currentId === tool.callId ? null : tool.callId))}
            />
          ))}
          {current ? (
            <WorkToolRow
              tool={current}
              open={currentOpen}
              onToggle={() => setOpenId((currentId) => (currentId === current.callId ? null : current.callId))}
            />
          ) : null}
        </>
      )}
    </div>
  )
}

function WorkToolRow({
  tool,
  open,
  onToggle,
}: {
  readonly tool: RuntimeTool
  readonly open: boolean
  readonly onToggle: () => void
}) {
  const detailId = useId()
  const hasDetails = Boolean(tool.inputPreview || tool.resultPreview)
  const row = (
    <span className={styles.workRow}>
      <span
        className={[
          styles.workDot,
          tool.state === 'running'
            ? styles.workDotRun
            : tool.state === 'failed'
              ? styles.workDotFail
              : styles.workDotOk,
        ].join(' ')}
        data-work-status-dot
      />
      <strong>{tool.displayName}</strong>
      <em>{tool.inputPreview ?? tool.resultPreview ?? ''}</em>
      <StatusBadge tone={tool.state === 'running' ? 'info' : tool.state === 'failed' ? 'error' : 'neutral'}>
        {tool.state === 'running' ? '进行中' : tool.state === 'failed' ? '失败' : '完成'}
      </StatusBadge>
    </span>
  )

  if (!hasDetails) {
    return <div className={styles.toolRow}>{row}</div>
  }

  return (
    <Button className={styles.toolRow} type="button" aria-expanded={open} aria-controls={detailId} onClick={onToggle}>
      {row}
      {open ? (
        <div className={styles.toolCard} id={detailId}>
          {tool.inputPreview ? <pre>{tool.inputPreview}</pre> : null}
          {tool.resultPreview ? <pre>{tool.resultPreview}</pre> : null}
        </div>
      ) : null}
    </Button>
  )
}

const PLOT_LANES: readonly { readonly id: TrajectoryLane; readonly label: string }[] = [
  { id: 'internal', label: '内部' },
  { id: 'tool', label: '工具' },
  { id: 'send', label: '发送' },
]

export const plotTurnStarts = (records: readonly Pick<TrajectoryRecord, 'turn'>[]): readonly number[] =>
  records.flatMap((record, index) => (index > 0 && record.turn !== records[index - 1]?.turn ? [index] : []))

const plotSegClass = (lane: TrajectoryLane): string => {
  if (lane === 'internal') return styles.plotSegInternal
  if (lane === 'send') return styles.plotSegSend
  return styles.plotSegTool
}

export function ChannelTrajectoryLedger({
  records,
  selectedId,
  onSelect,
  search,
  onSearchChange,
  scrollRef,
  onScroll,
}: {
  readonly records: readonly TrajectoryRecord[]
  readonly selectedId: string
  readonly onSelect: (id: string) => void
  readonly search: string
  readonly onSearchChange: (value: string) => void
  readonly scrollRef: RefObject<HTMLDivElement>
  readonly onScroll: () => void
}) {
  const visible = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return records
    return records.filter((record) =>
      `${record.kindLabel} ${record.name} ${record.summary} ${record.input ?? ''} ${record.output ?? ''}`
        .toLowerCase()
        .includes(query),
    )
  }, [records, search])
  const count = Math.max(visible.length, 1)
  const focusableId = visible.some((record) => record.id === selectedId) ? selectedId : (visible[0]?.id ?? '')

  const selectFromKeyboard = (event: KeyboardEvent<HTMLTableRowElement>, record: TrajectoryRecord): void => {
    const currentIndex = visible.findIndex((item) => item.id === record.id)
    let nextIndex = currentIndex
    if (event.key === 'ArrowDown') nextIndex = Math.min(currentIndex + 1, visible.length - 1)
    else if (event.key === 'ArrowUp') nextIndex = Math.max(currentIndex - 1, 0)
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = visible.length - 1
    else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onSelect(record.id)
      return
    } else return

    event.preventDefault()
    const next = visible[nextIndex]
    if (!next) return
    onSelect(next.id)
    requestAnimationFrame(() => {
      scrollRef.current?.querySelector<HTMLTableRowElement>(`[data-record-id="${CSS.escape(next.id)}"]`)?.focus()
    })
  }

  useLayoutEffect(() => {
    const wrap = scrollRef.current
    if (!wrap || !selectedId) return
    const row = wrap.querySelector(`[data-record-id="${CSS.escape(selectedId)}"]`)
    row?.scrollIntoView({ block: 'nearest' })
  }, [scrollRef, selectedId])

  return (
    <div className={styles.traj}>
      <div className={styles.trajBar}>
        <Input
          className={styles.trajSearch}
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="搜索"
          aria-label="搜索工作轨迹"
        />
      </div>
      <div className={styles.plot} aria-label="工作轨迹时间轴">
        <div className={styles.plotLabels} aria-hidden="true">
          {PLOT_LANES.map((lane) => (
            <span key={lane.id}>{lane.label}</span>
          ))}
        </div>
        <div className={styles.plotTrack}>
          {visible.map((record, index) => {
            const turnStart = index > 0 && record.turn !== visible[index - 1]?.turn
            return (
              <span key={record.id}>
                {turnStart ? (
                  <IconButton
                    label={`Turn ${record.turn}`}
                    className={styles.plotTurn}
                    style={{ left: `${(index / count) * 100}%` }}
                    onClick={() => onSelect(record.id)}
                  >
                    <span aria-hidden="true" />
                  </IconButton>
                ) : null}
                <IconButton
                  label={`${record.name} · Turn ${record.turn}`}
                  className={[
                    styles.plotSeg,
                    plotSegClass(recordLane(record)),
                    selectedId === record.id ? styles.plotSegSelected : '',
                  ].join(' ')}
                  style={{ left: `${(index / count) * 100}%`, width: `${100 / count}%` }}
                  aria-pressed={selectedId === record.id}
                  onClick={() => onSelect(record.id)}
                >
                  <span aria-hidden="true" />
                </IconButton>
              </span>
            )
          })}
        </div>
      </div>
      <div className={styles.trajTableWrap} ref={scrollRef} onScroll={onScroll} aria-label="工作轨迹记录">
        <div>
          <table className={styles.trajTable}>
            <thead>
              <tr>
                <th className={styles.trajEvent}>事件</th>
                <th>内容</th>
                <th className={styles.trajTime}>状态</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((record) => (
                <tr
                  key={record.id}
                  data-record-id={record.id}
                  data-selected={selectedId === record.id ? '' : undefined}
                  data-turn-start={record.turnStart ? '' : undefined}
                  tabIndex={focusableId === record.id ? 0 : -1}
                  aria-current={selectedId === record.id ? 'true' : undefined}
                  onClick={() => onSelect(record.id)}
                  onKeyDown={(event) => selectFromKeyboard(event, record)}
                >
                  <td className={styles.trajEventCell}>
                    <span className={styles.turnRail} />
                    {selectedId === record.id ? <span className={styles.selRail} /> : null}
                    {record.turnStart ? <span className={styles.turnChip}>Turn {record.turn}</span> : null}
                    <div className={styles.eventInner}>
                      <span
                        className={[
                          styles.kindTag,
                          record.kind === 'message' ? styles.kindMessage : styles.kindTool,
                        ].join(' ')}
                      >
                        {record.kindLabel}
                      </span>
                    </div>
                  </td>
                  <td className={styles.trajContent}>
                    {record.kind === 'tool' ? (
                      <span className={styles.toolLine}>
                        <span className={styles.toolName}>{record.name}</span>
                        <span className={styles.toolArgs}>{record.summary}</span>
                        {record.output ? (
                          <>
                            <span className={styles.toolArrow}>→</span>
                            <span className={styles.toolOut}>{record.output}</span>
                          </>
                        ) : null}
                      </span>
                    ) : (
                      <span className={styles.contentLine}>{record.summary}</span>
                    )}
                  </td>
                  <td className={styles.trajTimeCell}>{recordStateLabel(record)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {visible.length === 0 ? <div className={styles.trajEmpty}>还没有工作轨迹。</div> : null}
        </div>
      </div>
    </div>
  )
}

export function ChannelSessionInspector({
  channel,
  agent,
  runtime,
  onBind,
  onReassign,
}: {
  readonly channel: ChannelSummary
  readonly agent: AgentSummary | undefined
  readonly runtime: ChannelRuntimeView | undefined
  readonly onBind: () => void
  readonly onReassign: () => void
}) {
  const navigate = useNavigate()
  const phase = runtime?.phase ?? channel.runtimePhase
  const [renamePending, setRenamePending] = useState(false)
  const [triggerPending, setTriggerPending] = useState(false)
  const [channelName, setChannelName] = useState(channel.name)
  const currentTrigger = channel.bindings[0]?.triggerPolicy ?? 'mentioned-or-replied'
  const currentTool = workTools(latestTurn(runtime)).find((tool) => tool.state === 'running')

  useEffect(() => {
    setChannelName(channel.name)
  }, [channel.id, channel.name])

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
    <aside className={styles.inspector} aria-label="频道">
      <section>
        <h2>运行</h2>
        {agent ? <StatusBadge tone={agentTone(phase)}>{phase}</StatusBadge> : null}
        <p className={styles.trajectorySummary}>
          {runtime?.summary ?? (agent ? '智能体当前空闲。' : '绑定智能体后才能自动响应消息。')}
        </p>
        {currentTool ? (
          <p className={styles.secondaryText}>
            {currentTool.displayName}
            {currentTool.inputPreview ? ` · ${currentTool.inputPreview}` : ''}
          </p>
        ) : null}
        {runtime && runtime.pendingInjectCount > 0 ? (
          <InlineFeedback tone="info">{runtime.pendingInjectCount} 条新消息已收录。</InlineFeedback>
        ) : null}
        {runtime?.occupancy ? <ContextUsageCard occupancy={runtime.occupancy} /> : null}
      </section>
      <section>
        <h2>绑定</h2>
        <dl className={styles.facts}>
          <dt>智能体</dt>
          <dd>{agent?.name ?? '未绑定'}</dd>
          <dt>来源</dt>
          <dd>{channel.kind === 'web' ? '网页聊天' : channel.connectionName}</dd>
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
              <Button size="small" variant="ghost" onClick={() => void navigate(`/work/agents/${agent.id}`)}>
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
              hint={channel.kind === 'web' ? '用于消息列表显示。' : '平台未提供频道名称时，可在此设置本地名称。'}
            >
              <Input value={channelName} onChange={(event) => setChannelName(event.target.value)} maxLength={120} />
            </Field>
            <p className={styles.secondaryText} id="channel-name-save-reason">
              {!channelName.trim()
                ? '请输入频道名称后才能保存。'
                : channelName.trim() === channel.name
                  ? '修改频道名称后才能保存。'
                  : '保存后只改变本地显示名称。'}
            </p>
            <Button
              size="small"
              loading={renamePending}
              loadingLabel="保存中…"
              disabled={!channelName.trim() || channelName.trim() === channel.name}
              aria-describedby="channel-name-save-reason"
              onClick={() => void rename()}
            >
              保存名称
            </Button>
          </div>
        </details>
      </section>
    </aside>
  )
}

function InspectorRegion({ label, text }: { readonly label: string; readonly text: string }) {
  return (
    <section className={styles.inspectorRegion}>
      <h2>{label}</h2>
      <pre className={styles.inspectorRegionBody}>{text}</pre>
    </section>
  )
}

export function ChannelTrajectoryInspector({ record }: { readonly record: TrajectoryRecord | undefined }) {
  const lane = record ? recordLane(record) : undefined
  const sent = (record?.input ?? record?.summary ?? '').trim()
  const output = (record?.output ?? '').trim()

  return (
    <aside className={styles.inspector} aria-label="工作轨迹">
      {record ? (
        <>
          <section>
            <div className={styles.trajDetailHead}>
              <span
                className={[styles.kindTag, record.kind === 'message' ? styles.kindMessage : styles.kindTool].join(' ')}
              >
                {record.kindLabel}
              </span>
              <strong>{record.name}</strong>
            </div>
            <p className={styles.secondaryText}>
              Turn {record.turn}
              {recordStateLabel(record) ? ` · ${recordStateLabel(record)}` : ''}
            </p>
            {record.firstTokenMs !== undefined ? (
              <p className={styles.secondaryText}>首字 {formatDurationMs(record.firstTokenMs)}</p>
            ) : null}
            {record.usage ? <p className={styles.secondaryText}>{usageCaption(record.usage)}</p> : null}
          </section>
          {lane === 'internal' && (output || record.summary) ? (
            <InspectorRegion label="内部输出" text={output || record.summary} />
          ) : null}
          {lane === 'send' && sent ? <InspectorRegion label="发出的内容" text={sent} /> : null}
          {lane === 'send' && output && output !== sent ? <InspectorRegion label="发送结果" text={output} /> : null}
          {lane === 'tool' && record.input ? <InspectorRegion label="输入" text={record.input} /> : null}
          {lane === 'tool' && output ? <InspectorRegion label="输出" text={output} /> : null}
        </>
      ) : (
        <section>
          <h2>工作轨迹</h2>
          <p className={styles.secondaryText}>选择一条记录查看这条工作过程的详情。</p>
        </section>
      )}
    </aside>
  )
}
