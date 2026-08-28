import { useEffect, useId, useLayoutEffect, useMemo, useState, type KeyboardEvent, type RefObject } from 'react'
import { Activity, ChevronDown, Link2, Trash2 } from 'lucide-react'
import { useNxtNavigate } from '../shell/nxt-link.js'
import { Cell, Pie, PieChart } from 'recharts'
import { notify } from '../components/notifications.js'
import { InlineFeedback } from '../components/product-feedback.js'
import { useProductStore, type AgentSummary, type ChannelRuntimeView, type ChannelSummary } from '../product-store.js'
import {
  ChannelInspectorAgentExtensionSlots,
  ConversationToolCardExtensionSlots,
} from '../persistent-extension-client.js'
import { AdapterChannelInspectorExtensionSlots } from '../adapter-host-client.js'
import {
  Button,
  Disclosure,
  Enter,
  Field,
  IconButton,
  Input,
  Presence,
  SelectField,
  StatusBadge,
  SwitchField,
  Tabs,
} from '../ui-kit/index.js'
import { isTriggerPolicy, TRIGGER_POLICY_OPTIONS } from './binding-task.js'
import styles from './product-pages.module.css'

const VIEW_KEY = 'nekro-nxt.channel-view'

type ChannelActivityType = ChannelSummary['bindings'][number]['eventTriggers'][number]

const CHANNEL_ACTIVITY_OPTIONS: readonly {
  readonly value: ChannelActivityType
  readonly label: string
  readonly description: string
}[] = [
  { value: 'member-poked', label: '戳一戳', description: '成员戳一戳时允许触发智能体。' },
  { value: 'profile-liked', label: '资料卡点赞', description: '成员资料卡收到点赞时允许触发。' },
  { value: 'member-joined', label: '成员加入', description: '新成员加入频道时允许触发。' },
  { value: 'member-left', label: '成员离开', description: '成员退出或被移出频道时允许触发。' },
  { value: 'member-muted', label: '成员被禁言', description: '成员被禁言时允许触发。' },
  { value: 'member-unmuted', label: '解除禁言', description: '成员解除禁言时允许触发。' },
  { value: 'member-admin-set', label: '设为管理员', description: '成员成为管理员时允许触发。' },
  { value: 'member-admin-unset', label: '取消管理员', description: '成员不再是管理员时允许触发。' },
  { value: 'member-card-changed', label: '成员名片变化', description: '成员的频道名片变化时允许触发。' },
  { value: 'member-title-changed', label: '成员头衔变化', description: '成员头衔变化时允许触发。' },
  { value: 'channel-name-changed', label: '频道名称变化', description: '外部平台频道名称变化时允许触发。' },
  { value: 'message-recalled', label: '消息撤回', description: '频道消息被撤回时允许触发。' },
  { value: 'message-reaction-added', label: '添加消息回应', description: '消息收到新的表情回应时允许触发。' },
  { value: 'message-reaction-removed', label: '移除消息回应', description: '消息回应被移除时允许触发。' },
  { value: 'file-uploaded', label: '文件上传', description: '频道中上传文件时允许触发。' },
  { value: 'essence-added', label: '设为精华', description: '消息被设为精华时允许触发。' },
  { value: 'essence-removed', label: '取消精华', description: '消息被取消精华时允许触发。' },
  { value: 'friend-added', label: '新增好友', description: '连接账号新增好友时允许触发。' },
  { value: 'conversation-entered', label: '进入会话', description: '成员进入与机器人账号的会话时允许触发。' },
  { value: 'card-action-invoked', label: '卡片操作', description: '成员操作交互式卡片时允许触发。' },
  { value: 'message-feedback-positive', label: '正向反馈', description: '成员认可一条回复时允许触发。' },
  { value: 'message-feedback-negative', label: '负向反馈', description: '成员反馈回复不准确时允许触发。' },
  { value: 'message-feedback-withdrawn', label: '撤销反馈', description: '成员撤销回复反馈时允许触发。' },
]

export type ChannelCanvasView = 'chat' | 'trajectory'

type RuntimeTurn = ChannelRuntimeView['turns'][number]
type RuntimeTool = RuntimeTurn['steps'][number]['tools'][number]
type RuntimeCache = NonNullable<ChannelRuntimeView['cache']>
type RuntimeCacheSample = RuntimeCache['recent']['samples'][number]
type RuntimePerformance = NonNullable<ChannelRuntimeView['performance']>
type RuntimePerformanceSample = RuntimePerformance['recent']['samples'][number]

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
  readonly toolName?: string
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
  if (value < 1000) return `${Math.round(value)}ms`
  if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0).replace(/\.0$/u, '')}s`
  const totalSeconds = Math.round(value / 1000)
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`
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

const cacheSampleObserved = (sample: RuntimeCacheSample): boolean =>
  sample.cacheReadTokens !== undefined || sample.cacheWriteTokens !== undefined

export const cacheInputTokens = (sample: RuntimeCacheSample): number =>
  sample.uncachedInputTokens + (sample.cacheReadTokens ?? 0) + (sample.cacheWriteTokens ?? 0)

export const cacheReadShare = (sample: RuntimeCacheSample): number | undefined => {
  if (!cacheSampleObserved(sample)) return undefined
  const inputTokens = cacheInputTokens(sample)
  return inputTokens > 0 ? (sample.cacheReadTokens ?? 0) / inputTokens : undefined
}

export const weightedCacheReadShare = (samples: readonly RuntimeCacheSample[]): number | undefined => {
  let inputTokens = 0
  let cacheReadTokens = 0
  for (const sample of samples) {
    if (!cacheSampleObserved(sample)) continue
    inputTokens += cacheInputTokens(sample)
    cacheReadTokens += sample.cacheReadTokens ?? 0
  }
  return inputTokens > 0 ? cacheReadTokens / inputTokens : undefined
}

const formatShare = (share: number | undefined): string =>
  share === undefined ? '暂无' : `${Math.min(100, Math.round(share * 100))}%`

export const sampleTokenRate = (sample: RuntimePerformanceSample): number | undefined =>
  sample.decodeMs !== undefined && sample.decodeMs > 0 && sample.outputTokens !== undefined
    ? sample.outputTokens / (sample.decodeMs / 1000)
    : undefined

export const formatTokenRate = (value: number | undefined): string => {
  if (value === undefined || !Number.isFinite(value)) return '暂无'
  return value < 10 ? value.toFixed(1).replace(/\.0$/u, '') : String(Math.round(value))
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
  const total = data.reduce((sum, item) => sum + item.value, 0)
  const [hover, setHover] = useState<{ readonly index: number; readonly x: number; readonly y: number }>()
  const active = hover ? data[hover.index] : undefined
  const activeRatio = active && total > 0 ? Math.round((active.value / total) * 100) : 0
  return (
    <figure
      className={styles.contextFigure}
      tabIndex={0}
      aria-label={label}
      onFocus={() => setHover((current) => current ?? { index: 0, x: 82, y: 20 })}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setHover(undefined)
      }}
    >
      <div
        className={styles.contextRing}
        onPointerMove={(event) => {
          const path =
            event.target instanceof Element ? event.target.closest<SVGPathElement>('[data-recharts-item-index]') : null
          const index = Number(path?.dataset['rechartsItemIndex'])
          if (!Number.isInteger(index) || index < 0 || index >= data.length) {
            setHover(undefined)
            return
          }
          const rect = event.currentTarget.getBoundingClientRect()
          setHover({ index, x: event.clientX - rect.left, y: event.clientY - rect.top })
        }}
        onPointerLeave={() => setHover(undefined)}
      >
        <PieChart width={112} height={112}>
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            innerRadius={34}
            outerRadius={48}
            stroke="none"
            isAnimationActive={false}
          >
            {data.map((item, index) => (
              <Cell
                key={item.name}
                className={[styles.contextSector, hover?.index === index ? styles.contextSectorActive : '']
                  .filter(Boolean)
                  .join(' ')}
                fill={item.color}
                stroke="none"
              />
            ))}
          </Pie>
        </PieChart>
        <strong>{center}</strong>
        <Presence>
          {active && hover ? (
            <Enter
              kind="fade"
              className={styles.contextTooltip}
              data-side={hover.x > 56 ? 'left' : 'right'}
              data-pointer-x={Math.round(hover.x)}
              data-pointer-y={Math.round(hover.y)}
              role="tooltip"
              style={{ left: hover.x, top: hover.y }}
            >
              {active.name} · {formatTokenCount(active.value)} · {activeRatio}%
            </Enter>
          ) : null}
        </Presence>
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
    </div>
  )
}

function CacheTrend({ samples }: { readonly samples: readonly RuntimeCacheSample[] }) {
  const [activeIndex, setActiveIndex] = useState(Math.max(0, samples.length - 1))
  const active = samples[Math.min(activeIndex, samples.length - 1)]
  const activeShare = active === undefined ? undefined : cacheReadShare(active)
  return (
    <figure className={styles.cacheTrend} aria-label={`最近 ${samples.length} 次模型请求的缓存读取趋势`}>
      <figcaption>
        <span>最近请求</span>
        {active ? (
          <span>
            第 {active.turn} 轮 · 第 {active.step} 步 · {formatShare(activeShare)}
          </span>
        ) : null}
      </figcaption>
      <div className={styles.cacheTrendPlot}>
        {samples.map((sample, index) => {
          const share = cacheReadShare(sample)
          const label =
            share === undefined
              ? `第 ${sample.turn} 轮第 ${sample.step} 步，模型未报告缓存统计`
              : `第 ${sample.turn} 轮第 ${sample.step} 步，缓存读取占输入 ${formatShare(share)}`
          return (
            <span
              key={`${sample.turn}:${sample.step}:${sample.at ?? index}`}
              role="img"
              className={[
                styles.cacheTrendBar,
                share === undefined ? styles.cacheTrendBarUnknown : '',
                index === activeIndex ? styles.cacheTrendBarActive : '',
              ]
                .filter(Boolean)
                .join(' ')}
              style={{ height: `${share === undefined ? 8 : Math.max(8, share * 100)}%` }}
              tabIndex={0}
              aria-label={label}
              onPointerEnter={() => setActiveIndex(index)}
              onFocus={() => setActiveIndex(index)}
            />
          )
        })}
      </div>
    </figure>
  )
}

function CacheUsageCard({ cache }: { readonly cache: RuntimeCache }) {
  const recentSamples = cache.recent.samples.slice(-8)
  const latest = cache.recent.samples.at(-1)
  const latestShare = latest === undefined ? undefined : cacheReadShare(latest)
  const latestInput = latest === undefined ? 0 : cacheInputTokens(latest)
  const recentShare = weightedCacheReadShare(recentSamples)
  const aggregate = cache.aggregate
  const aggregateInput = aggregate.uncachedInputTokens + aggregate.cacheReadTokens + aggregate.cacheWriteTokens
  const aggregateShare = aggregateInput > 0 ? aggregate.cacheReadTokens / aggregateInput : undefined
  const requestHitShare =
    aggregate.observedRequestCount > 0 ? aggregate.hitRequestCount / aggregate.observedRequestCount : undefined
  const coverageShare =
    aggregate.usageRequestCount > 0 ? aggregate.observedRequestCount / aggregate.usageRequestCount : undefined
  const latestObserved = latest !== undefined && cacheSampleObserved(latest)
  const latestSegments = latestObserved
    ? [
        { name: '缓存读取', value: latest.cacheReadTokens ?? 0, className: styles.cacheSegmentRead },
        { name: '未缓存', value: latest.uncachedInputTokens, className: styles.cacheSegmentMiss },
        { name: '缓存写入', value: latest.cacheWriteTokens ?? 0, className: styles.cacheSegmentWrite },
      ].filter((segment) => segment.value > 0)
    : []

  return (
    <section className={styles.cacheUsageCard} aria-label="缓存分析">
      <header className={styles.cacheHeader}>
        <h3>缓存</h3>
        <span>本次会话</span>
      </header>
      <div className={styles.runtimeDataSurface} data-runtime-data-surface="cache">
        <div className={styles.cacheLatest}>
          <strong data-known={latestShare !== undefined}>{formatShare(latestShare)}</strong>
          <span>{latestObserved ? '最近一次输入缓存覆盖' : '最近一次未报告缓存统计'}</span>
          {latest ? (
            <small>
              第 {latest.turn} 轮 · 第 {latest.step} 步
              {latestObserved
                ? ` · 缓存读取 ${formatTokenCount(latest.cacheReadTokens ?? 0)} / 输入 ${formatTokenCount(latestInput)}`
                : ''}
            </small>
          ) : null}
        </div>
        {latestSegments.length > 0 && latestInput > 0 ? (
          <div className={styles.cacheComposition}>
            <div className={styles.cacheCompositionTrack} aria-label="最近一次模型请求的输入组成">
              {latestSegments.map((segment) => (
                <span
                  key={segment.name}
                  className={segment.className}
                  style={{ width: `${(segment.value / latestInput) * 100}%` }}
                  title={`${segment.name} ${formatTokenCount(segment.value)}`}
                />
              ))}
            </div>
            <ul>
              {latestSegments.map((segment) => (
                <li key={segment.name}>
                  <span className={segment.className} />
                  {segment.name} {formatTokenCount(segment.value)}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className={styles.cacheMetrics}>
          <div>
            <span>最近 {recentSamples.length} 次</span>
            <strong>{formatShare(recentShare)}</strong>
          </div>
          <div>
            <span>会话加权覆盖</span>
            <strong>{formatShare(aggregateShare)}</strong>
          </div>
          <div>
            <span>每请求平均</span>
            <strong>{formatShare(aggregate.averageRequestReadShare)}</strong>
          </div>
          <div>
            <span>请求命中</span>
            <strong>{formatShare(requestHitShare)}</strong>
          </div>
        </div>
        {recentSamples.length > 1 ? <CacheTrend samples={recentSamples} /> : null}
        <p className={styles.cacheTotals}>
          累计读取 {formatTokenCount(aggregate.cacheReadTokens)} · 未缓存输入{' '}
          {formatTokenCount(aggregate.uncachedInputTokens)}
          {aggregate.cacheWriteTokens > 0 ? ` · 缓存写入 ${formatTokenCount(aggregate.cacheWriteTokens)}` : ''}
        </p>
        <p className={styles.cacheCoverage}>
          数据覆盖 {aggregate.observedRequestCount}/{aggregate.usageRequestCount} 次请求 · {formatShare(coverageShare)}
        </p>
      </div>
    </section>
  )
}

function PerformanceTrend({ samples }: { readonly samples: readonly RuntimePerformanceSample[] }) {
  const [activeIndex, setActiveIndex] = useState(Math.max(0, samples.length - 1))
  const active = samples[Math.min(activeIndex, samples.length - 1)]
  const rates = samples.map(sampleTokenRate)
  const maxRate = Math.max(0, ...rates.map((value) => value ?? 0))
  return (
    <figure className={styles.performanceTrend} aria-label={`最近 ${samples.length} 次模型请求的生成速度趋势`}>
      <figcaption>
        <span>最近 {samples.length} 次生成速度</span>
        {active ? (
          <span>
            第 {active.turn} 轮 · 首 Token{' '}
            {active.firstTokenMs === undefined ? '暂无' : formatDurationMs(active.firstTokenMs)} ·{' '}
            {formatTokenRate(sampleTokenRate(active))} tok/s
          </span>
        ) : null}
      </figcaption>
      <div className={styles.performanceTrendPlot}>
        {samples.map((sample, index) => {
          const rate = rates[index]
          const label = `第 ${sample.turn} 轮第 ${sample.step} 步，首 Token ${
            sample.firstTokenMs === undefined ? '暂无' : formatDurationMs(sample.firstTokenMs)
          }，生成速度 ${formatTokenRate(rate)} tok/s`
          return (
            <span
              key={`${sample.turn}:${sample.step}:${sample.at ?? index}`}
              role="img"
              className={[
                styles.performanceTrendBar,
                rate === undefined ? styles.performanceTrendBarUnknown : '',
                index === activeIndex ? styles.performanceTrendBarActive : '',
              ]
                .filter(Boolean)
                .join(' ')}
              style={{ height: `${rate === undefined || maxRate <= 0 ? 8 : Math.max(8, (rate / maxRate) * 100)}%` }}
              tabIndex={0}
              aria-label={label}
              onPointerEnter={() => setActiveIndex(index)}
              onFocus={() => setActiveIndex(index)}
            />
          )
        })}
      </div>
    </figure>
  )
}

function GenerationPerformanceCard({ performance }: { readonly performance: RuntimePerformance }) {
  const aggregate = performance.aggregate
  const recentSamples = performance.recent.samples.slice(-8)
  const latest = performance.recent.samples.at(-1)
  const latestRate = latest === undefined ? undefined : sampleTokenRate(latest)
  const averageFirstToken = aggregate.ttftSteps > 0 ? aggregate.ttftMs / aggregate.ttftSteps : undefined
  const weightedRate = aggregate.decodeMs > 0 ? aggregate.decodeTokens / (aggregate.decodeMs / 1000) : undefined

  return (
    <section className={styles.performanceCard} aria-label="生成表现">
      <header className={styles.performanceHeader}>
        <h3>生成表现</h3>
        <span>本次会话</span>
      </header>
      <div className={styles.runtimeDataSurface} data-runtime-data-surface="performance">
        <div className={styles.performancePrimary}>
          <div>
            <span>最近请求首 Token</span>
            <strong data-known={latest?.firstTokenMs !== undefined}>
              {latest?.firstTokenMs === undefined ? '暂无' : formatDurationMs(latest.firstTokenMs)}
            </strong>
            <small>{latest ? `第 ${latest.turn} 轮 · 第 ${latest.step} 步` : '暂无模型请求'}</small>
          </div>
          <div>
            <span>最近请求生成速度</span>
            <strong data-known={latestRate !== undefined}>{formatTokenRate(latestRate)}</strong>
            <small>{latestRate === undefined ? '暂无有效用量' : 'tok/s'}</small>
          </div>
        </div>
        <div className={styles.performanceMetrics}>
          <div>
            <span>会话平均首 Token</span>
            <strong>{averageFirstToken === undefined ? '暂无' : formatDurationMs(averageFirstToken)}</strong>
          </div>
          <div>
            <span>会话加权速度</span>
            <strong>
              {formatTokenRate(weightedRate)}
              {weightedRate === undefined ? '' : ' tok/s'}
            </strong>
          </div>
          <div>
            <span>模型处理累计</span>
            <strong>{formatDurationMs(aggregate.llmMs)}</strong>
          </div>
          <div>
            <span>工具调用累计</span>
            <strong>{formatDurationMs(aggregate.toolMs)}</strong>
          </div>
        </div>
        {recentSamples.length > 1 ? <PerformanceTrend samples={recentSamples} /> : null}
        <p className={styles.performanceTotals}>
          重试 {aggregate.retryCount} 次
          {aggregate.retryDelayMs > 0 ? ` · 等待 ${formatDurationMs(aggregate.retryDelayMs)}` : ''}
        </p>
        <p className={styles.performanceCoverage}>
          数据覆盖 首 Token {aggregate.ttftSteps}/{aggregate.steps} · 生成速度 {aggregate.decodeSteps}/{aggregate.steps}
        </p>
      </div>
    </section>
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
          toolName: tool.name,
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
  const [expanded, setExpanded] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const running = turn?.state === 'in-progress'
  const current = tools.find((tool) => tool.state === 'running')
  const latest = current ?? tools.at(-1)
  const liveSummary = latest
    ? `${latest.displayName}${latest.inputPreview ? ` · ${latest.inputPreview}` : ''}`
    : (text.split('\n')[0] ?? runtime?.summary ?? '')
  const hasDetails = Boolean(text || tools.length > 0)

  useEffect(() => {
    setExpanded(false)
    setOpenId(current?.callId ?? null)
  }, [runtime?.channelId, current?.callId])

  if (!turn || (tools.length === 0 && !text && (runtime?.pendingInjectCount ?? 0) === 0)) return null

  return (
    <div className={styles.workStream} data-work-stream>
      {runtime && runtime.pendingInjectCount > 0 ? (
        <div className={styles.sysLine}>{runtime.pendingInjectCount} 条新消息已收录，将在安全间隙进入后续处理。</div>
      ) : null}
      {hasDetails ? (
        <>
          <Button
            className={styles.workStreamSummary}
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((open) => !open)}
          >
            <span className={[styles.workRow, styles.workSummaryRow].join(' ')}>
              <span
                className={[styles.workDot, running ? styles.workDotRun : styles.workDotOk].join(' ')}
                data-work-status-dot
              />
              <strong>内部输出</strong>
              <em>{liveSummary}</em>
              <span className={styles.workToolCount}>{tools.length} 个工具</span>
              <ChevronDown
                className={styles.workStreamChevron}
                data-open={expanded ? '' : undefined}
                size={14}
                aria-hidden="true"
              />
            </span>
          </Button>
          <Disclosure open={expanded}>
            <div className={styles.workStreamDetails}>
              {text ? <div className={styles.thinkBody}>{text}</div> : null}
              {tools.map((tool) => (
                <WorkToolRow
                  key={tool.callId}
                  tool={tool}
                  open={openId === tool.callId}
                  onToggle={() => setOpenId((currentId) => (currentId === tool.callId ? null : tool.callId))}
                  {...(runtime?.agentId === undefined ? {} : { agentId: runtime.agentId })}
                  {...(runtime?.channelId === undefined ? {} : { channelId: runtime.channelId })}
                />
              ))}
            </div>
          </Disclosure>
        </>
      ) : current ? (
        <WorkToolRow
          tool={current}
          open={openId === current.callId}
          onToggle={() => setOpenId((currentId) => (currentId === current.callId ? null : current.callId))}
          {...(runtime?.agentId === undefined ? {} : { agentId: runtime.agentId })}
          {...(runtime?.channelId === undefined ? {} : { channelId: runtime.channelId })}
        />
      ) : null}
    </div>
  )
}

function WorkToolRow({
  tool,
  open,
  onToggle,
  agentId,
  channelId,
}: {
  readonly tool: RuntimeTool
  readonly open: boolean
  readonly onToggle: () => void
  readonly agentId?: string
  readonly channelId?: string
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
    return (
      <div className={styles.toolRow}>
        {row}
        {agentId && channelId ? (
          <ConversationToolCardExtensionSlots
            agentId={agentId}
            channelId={channelId}
            callId={tool.callId}
            toolName={tool.name}
            displayName={tool.displayName}
            state={tool.state}
            surface="stream"
            {...(tool.durationMs === undefined ? {} : { durationMs: tool.durationMs })}
            {...(tool.wroteToChannel === undefined ? {} : { wroteToChannel: tool.wroteToChannel })}
          />
        ) : null}
      </div>
    )
  }

  return (
    <div className={styles.toolRowGroup}>
      <Button
        className={styles.toolRowTrigger}
        type="button"
        aria-expanded={open}
        aria-controls={detailId}
        onClick={onToggle}
      >
        {row}
      </Button>
      <Disclosure open={open}>
        <div className={styles.toolCard} id={detailId}>
          {tool.inputPreview ? <pre>{tool.inputPreview}</pre> : null}
          {tool.resultPreview ? <pre>{tool.resultPreview}</pre> : null}
          {agentId && channelId ? (
            <ConversationToolCardExtensionSlots
              agentId={agentId}
              channelId={channelId}
              callId={tool.callId}
              toolName={tool.name}
              displayName={tool.displayName}
              state={tool.state}
              surface="stream"
              {...(tool.inputPreview === undefined ? {} : { inputPresentation: tool.inputPreview })}
              {...(tool.resultPreview === undefined ? {} : { resultPresentation: tool.resultPreview })}
              {...(tool.durationMs === undefined ? {} : { durationMs: tool.durationMs })}
              {...(tool.wroteToChannel === undefined ? {} : { wroteToChannel: tool.wroteToChannel })}
            />
          ) : null}
        </div>
      </Disclosure>
    </div>
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
        <div className={styles.trajBarCopy}>
          <strong>事件记录</strong>
          <small>{visible.length} 个事件</small>
        </div>
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
  onDelete,
}: {
  readonly channel: ChannelSummary
  readonly agent: AgentSummary | undefined
  readonly runtime: ChannelRuntimeView | undefined
  readonly onBind: () => void
  readonly onReassign: () => void
  readonly onDelete: () => void
}) {
  const navigate = useNxtNavigate()
  const connection = useProductStore((state) =>
    state.connections.find((candidate) => candidate.id === channel.connectionId),
  )
  const phase = runtime?.phase ?? channel.runtimePhase
  const [renamePending, setRenamePending] = useState(false)
  const [triggerPending, setTriggerPending] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [eventsOpen, setEventsOpen] = useState(false)
  const [channelName, setChannelName] = useState(channel.name)
  const currentBinding = channel.bindings[0]
  const currentTrigger = currentBinding?.triggerPolicy ?? 'mentioned-or-replied'
  const currentTool = workTools(latestTurn(runtime)).find((tool) => tool.state === 'running')
  const hasRuntimeDetails = Boolean(
    phase !== '空闲' ||
    currentTool ||
    (runtime?.pendingInjectCount ?? 0) > 0 ||
    runtime?.occupancy ||
    runtime?.performance ||
    runtime?.cache,
  )
  const runtimeEmpty = !agent
    ? {
        title: '尚未绑定智能体',
        description: '绑定后，这里会显示运行状态、上下文占用、生成表现和缓存情况。',
      }
    : runtime?.episodeId
      ? {
          title: '当前没有运行中的任务',
          description: '收到新消息或开始处理后，运行数据会在这里更新。',
        }
      : {
          title: '等待首次对话',
          description: '发送第一条消息后，这里会开始记录当前会话的运行数据。',
        }

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
        processingFeedback: currentBinding?.processingFeedback ?? 'auto',
        eventTriggers: currentBinding?.eventTriggers ?? [],
      })
      notify('响应方式已更新。', 'success', `channel-trigger:${channel.id}`)
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error', `channel-trigger:${channel.id}`)
    } finally {
      setTriggerPending(false)
    }
  }

  const updateBindingOptions = async (input: {
    readonly processingFeedback?: 'auto' | 'off'
    readonly eventTriggers?: readonly ChannelActivityType[]
  }): Promise<void> => {
    if (!agent || triggerPending) return
    setTriggerPending(true)
    try {
      await useProductStore.getState().createBinding({
        agentId: agent.id,
        channelId: channel.id,
        triggerPolicy: currentTrigger,
        processingFeedback: input.processingFeedback ?? currentBinding?.processingFeedback ?? 'auto',
        eventTriggers: [...(input.eventTriggers ?? currentBinding?.eventTriggers ?? [])],
      })
      notify('频道事件设置已更新。', 'success', `channel-events:${channel.id}`)
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error', `channel-events:${channel.id}`)
    } finally {
      setTriggerPending(false)
    }
  }

  return (
    <aside className={[styles.inspector, styles.channelSessionInspector].join(' ')} aria-label="频道">
      <section className={styles.inspectorPanel}>
        <div className={styles.inspectorSectionHead}>
          <h2>运行</h2>
        </div>
        {runtime?.summary && phase !== '空闲' ? <p className={styles.trajectorySummary}>{runtime.summary}</p> : null}
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
        {runtime?.cache ? <CacheUsageCard cache={runtime.cache} /> : null}
        {runtime?.performance ? <GenerationPerformanceCard performance={runtime.performance} /> : null}
        {!hasRuntimeDetails ? (
          <div className={styles.runtimeEmpty}>
            <span className={styles.runtimeEmptyIcon} aria-hidden="true">
              <Activity size={17} />
            </span>
            <span>
              <strong>{runtimeEmpty.title}</strong>
              <small>{runtimeEmpty.description}</small>
            </span>
          </div>
        ) : null}
      </section>
      {agent ? (
        <ChannelInspectorAgentExtensionSlots
          agentId={agent.id}
          channelId={channel.id}
          connectionId={channel.connectionId}
          {...(runtime?.episodeId === undefined ? {} : { episodeId: runtime.episodeId })}
          runtimePhase={
            phase === '思考中'
              ? 'thinking'
              : phase === '使用工具'
                ? 'using-tool'
                : phase === '等待输入'
                  ? 'waiting-input'
                  : phase === '空闲'
                    ? 'idle'
                    : 'unavailable'
          }
        />
      ) : null}
      {connection ? (
        <AdapterChannelInspectorExtensionSlots
          adapterKey={connection.adapterKey}
          connectionId={connection.id}
          channelId={channel.id}
          channelKind={channel.kind === 'web' ? 'web' : channel.kind === 'qq-group' ? 'group' : 'direct'}
        />
      ) : null}
      <section className={styles.inspectorPanel}>
        <div className={styles.inspectorSectionHead}>
          <h2>绑定</h2>
          <StatusBadge tone={agent ? 'success' : 'warning'}>{agent ? '已绑定' : '未绑定'}</StatusBadge>
        </div>
        {agent ? (
          <div className={styles.bindingInspector}>
            <div className={styles.bindingAgentRow}>
              <div className={styles.bindingAgentIdentity}>
                <span>智能体</span>
                <strong>{agent.name}</strong>
              </div>
              <div className={styles.bindingAgentActions}>
                <Button size="small" onClick={onReassign}>
                  更换
                </Button>
                <Button size="small" variant="ghost" onClick={() => void navigate(`/work/agents/${agent.id}`)}>
                  管理
                </Button>
              </div>
            </div>
            <div className={styles.bindingSettings}>
              <div className={styles.bindingSourceRow}>
                <span>频道来源</span>
                <strong>{channel.kind === 'web' ? '内置频道' : channel.connectionName}</strong>
              </div>
              <SelectField
                label="响应方式"
                value={currentTrigger}
                disabled={triggerPending}
                onValueChange={(value) => {
                  if (isTriggerPolicy(value)) void updateTrigger(value)
                }}
                options={TRIGGER_POLICY_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
              />
              {channel.kind === 'web' ? null : (
                <>
                  <SwitchField
                    label="显示处理中状态"
                    description="平台支持时，在智能体处理期间为触发消息添加临时回应，结束后自动移除。"
                    checked={(currentBinding?.processingFeedback ?? 'auto') === 'auto'}
                    disabled={triggerPending}
                    onCheckedChange={(checked) =>
                      void updateBindingOptions({ processingFeedback: checked ? 'auto' : 'off' })
                    }
                  />
                  <Button
                    size="small"
                    variant="ghost"
                    aria-expanded={eventsOpen}
                    onClick={() => setEventsOpen((open) => !open)}
                  >
                    {eventsOpen ? '收起特殊事件' : '设置特殊事件'}
                  </Button>
                  <Disclosure open={eventsOpen}>
                    <div className={styles.bindingEventSettings}>
                      <p className={styles.secondaryText}>特殊事件默认只记录。逐项开启的事件会触发智能体。</p>
                      {CHANNEL_ACTIVITY_OPTIONS.map((option) => (
                        <SwitchField
                          key={option.value}
                          label={option.label}
                          description={option.description}
                          checked={currentBinding?.eventTriggers.includes(option.value) ?? false}
                          disabled={triggerPending || currentTrigger === 'observe-only'}
                          onCheckedChange={(checked) => {
                            const current = currentBinding?.eventTriggers ?? []
                            void updateBindingOptions({
                              eventTriggers: checked
                                ? [...new Set([...current, option.value])]
                                : current.filter((value) => value !== option.value),
                            })
                          }}
                        />
                      ))}
                    </div>
                  </Disclosure>
                </>
              )}
            </div>
          </div>
        ) : (
          <div className={styles.bindingEmpty}>
            <span className={styles.bindingEmptyIcon} aria-hidden="true">
              <Link2 size={17} />
            </span>
            <div>
              <strong>选择响应这个频道的智能体</strong>
              <small>绑定后，频道消息可触发智能体处理。</small>
            </div>
            <Button size="small" variant="primary" onClick={onBind}>
              绑定智能体
            </Button>
          </div>
        )}
        <div className={styles.channelDetails}>
          <div className={styles.channelDetailRow}>
            <div>
              <div className={styles.secondaryText}>频道显示名称</div>
              <strong>{channel.name}</strong>
            </div>
            <Button
              variant="ghost"
              size="small"
              aria-expanded={renameOpen}
              onClick={() => setRenameOpen((open) => !open)}
            >
              {renameOpen ? '收起' : '修改'}
            </Button>
          </div>
          <Disclosure open={renameOpen}>
            <div className={styles.channelRename}>
              <Field
                label="频道名称"
                hint={channel.kind === 'web' ? '用于消息列表显示。' : '平台未提供频道名称时，可在此设置本地名称。'}
              >
                <Input value={channelName} onChange={(event) => setChannelName(event.target.value)} maxLength={120} />
              </Field>
              <p className={styles.secondaryText} id="channel-name-save-reason">
                {!channelName.trim()
                  ? '请输入频道名称。'
                  : channelName.trim() === channel.name
                    ? '当前名称没有改动。'
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
          </Disclosure>
        </div>
        <div className={styles.channelDangerRow}>
          <div>
            <strong>{channel.kind === 'web' ? '删除内置频道' : '从 NekroNXT 移除'}</strong>
            <span>
              {channel.kind === 'web'
                ? '解除绑定并移出频道列表；历史记录可在审计中查询。'
                : '解除绑定并移出 NekroNXT 频道列表。'}
            </span>
          </div>
          <Button size="small" variant="danger" onClick={onDelete}>
            <Trash2 size={13} aria-hidden="true" /> {channel.kind === 'web' ? '删除' : '移除'}
          </Button>
        </div>
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

export function ChannelTrajectoryInspector({
  record,
  agentId,
  channelId,
}: {
  readonly record: TrajectoryRecord | undefined
  readonly agentId?: string
  readonly channelId: string
}) {
  const lane = record ? recordLane(record) : undefined
  const sent = (record?.input ?? record?.summary ?? '').trim()
  const output = (record?.output ?? '').trim()

  return (
    <aside className={styles.inspector} aria-label="工作轨迹">
      <Enter kind="fade" key={record?.id ?? 'empty'}>
        {record ? (
          <>
            <section>
              <div className={styles.trajDetailHead}>
                <span
                  className={[styles.kindTag, record.kind === 'message' ? styles.kindMessage : styles.kindTool].join(
                    ' ',
                  )}
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
            {lane === 'tool' && agentId && record.toolName && record.state ? (
              <ConversationToolCardExtensionSlots
                agentId={agentId}
                channelId={channelId}
                callId={record.id}
                toolName={record.toolName}
                displayName={record.name}
                state={record.state}
                surface="trajectory"
                {...(record.input === undefined ? {} : { inputPresentation: record.input })}
                {...(record.output === undefined ? {} : { resultPresentation: record.output })}
                {...(record.durationMs === undefined ? {} : { durationMs: record.durationMs })}
                {...(record.wroteToChannel === undefined ? {} : { wroteToChannel: record.wroteToChannel })}
              />
            ) : null}
          </>
        ) : (
          <section>
            <h2>工作轨迹</h2>
            <p className={styles.secondaryText}>选择一条记录查看这条工作过程的详情。</p>
          </section>
        )}
      </Enter>
    </aside>
  )
}
