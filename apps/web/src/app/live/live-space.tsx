import { useGo } from '../model/nav.js'
import { CompatibilityNotices } from '../system/compatibility.js'
import { Bot, CheckCircle2, Plug, TriangleAlert, Wrench, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { ChannelActivitySeries } from '@nekro-nxt/contracts'
import { workspaceApi } from '../../host-api-client.js'
import {
  connectionDisplayName,
  useProductRuntime,
  useProductStore,
  type AgentSummary,
  type ChannelSummary,
} from '../../product-runtime.js'
import {
  AgentAvatar,
  Button,
  Chip,
  IconButton,
  MemberAvatar,
  Panel,
  Sparkline,
  smoothPath,
  cssVars,
} from '../../ui-kit/next/index.js'
import { relativeTime } from '../channels/timeline-model.js'
import { attentionSource, useAttention, type AttentionItem } from '../model/attention.js'
import { agentAccent, agentHue, agentPhase, isAgentWorking } from '../model/identity.js'
import { useCrumb } from '../shell/crumb.js'
import styles from './live.module.css'

const WINDOWS = [
  { window: '2h', bucket: '5m', ticks: ['−2H', '−90M', '−60M', '−30M', 'NOW'], label: '近 2 小时' },
  { window: '24h', bucket: '1h', ticks: ['−24H', '−18H', '−12H', '−6H', 'NOW'], label: '近 24 小时' },
] as const

/** Activity series with an adaptive window: two hours, or a day when the last two hours were quiet. */
function useActivitySeries() {
  const runtime = useProductRuntime()
  const [state, setState] = useState<{ readonly series: ChannelActivitySeries; readonly index: number } | null>(null)
  useEffect(() => {
    let current = true
    const load = async () => {
      for (const [index, option] of WINDOWS.entries()) {
        const series = await workspaceApi
          .getChannelActivity({ window: option.window, bucket: option.bucket })
          .catch(() => undefined)
        if (!current || !series) return
        if (series.channels.some((channel) => channel.total > 0) || index === WINDOWS.length - 1) {
          setState({ series, index })
          return
        }
      }
    }
    void load()
    const timer = window.setInterval(() => void load(), 60_000)
    const unsubscribe = runtime.events.subscribe({ open: () => void load() })
    return () => {
      current = false
      window.clearInterval(timer)
      unsubscribe()
    }
  }, [runtime])
  return state
}

function Tide({
  series,
  windowIndex,
  channels,
  agents,
}: {
  readonly series: ChannelActivitySeries
  readonly windowIndex: number
  readonly channels: readonly ChannelSummary[]
  readonly agents: readonly AgentSummary[]
}) {
  const [hover, setHover] = useState<number | null>(null)
  const plot = useRef<HTMLDivElement>(null)
  const top = useMemo(
    () =>
      [...series.channels]
        .filter((item) => item.total > 0)
        .sort((a, b) => b.total - a.total)
        .slice(0, 5),
    [series],
  )
  const width = 1000
  const height = 116
  const buckets = Math.max(2, ...top.map((item) => item.counts.length))
  const max = Math.max(1, ...top.flatMap((item) => item.counts)) * 1.15
  const x = (index: number) => (index / (buckets - 1)) * width
  const y = (value: number) => height - (value / max) * height
  const color = (channelId: string) => {
    const agent = agents.find((item) => item.id === channels.find((channel) => channel.id === channelId)?.agentId)
    return agent
      ? { line: agentAccent(agent), fill: `hsl(${agentHue(agent)} 74% 77%)` }
      : { line: 'var(--faint)', fill: 'var(--line-3)' }
  }
  const lastY = top.length ? y(Math.max(...top.map((item) => item.counts.at(-1) ?? 0))) : height
  const option = WINDOWS[windowIndex] ?? WINDOWS[0]
  const bucketMinutes = series.bucketMs / 60_000

  return (
    <>
      <Panel className={styles.tide}>
        {top.length === 0 ? (
          <>
            <div className={styles.flat} />
            <div className={styles.tideEmpty}>近一天没有新消息</div>
          </>
        ) : (
          <div
            ref={plot}
            className={styles.plot}
            onPointerMove={(event) => {
              const rect = plot.current?.getBoundingClientRect()
              if (!rect) return
              setHover(Math.round(Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) * (buckets - 1)))
            }}
            onPointerLeave={() => setHover(null)}
          >
            <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
              <defs>
                {top.map((item) => (
                  <linearGradient key={item.channelId} id={`tide-${item.channelId}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" style={{ stopColor: color(item.channelId).fill }} />
                    <stop offset="1" style={{ stopColor: color(item.channelId).line, stopOpacity: 0 }} />
                  </linearGradient>
                ))}
              </defs>
              <g className={styles.grid}>
                {[0.25, 0.5, 0.75].map((fraction) => (
                  <line
                    key={fraction}
                    x1="0"
                    x2={width}
                    y1={height * fraction}
                    y2={height * fraction}
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
              </g>
              {top.map((item, index) => {
                const line = smoothPath(item.counts.map((value, bucket) => [x(bucket), y(value)] as const))
                return (
                  <g key={item.channelId}>
                    <path
                      className={styles.area}
                      d={`${line} L${width},${height} L0,${height} Z`}
                      fill={`url(#tide-${item.channelId})`}
                    />
                    <path
                      className={styles.stroke}
                      pathLength={1}
                      style={{ stroke: color(item.channelId).line, animationDelay: `${0.15 + index * 0.12}s` }}
                      d={line}
                    />
                  </g>
                )
              })}
              {hover !== null ? (
                <line
                  className={styles.hoverLine}
                  x1={x(hover)}
                  x2={x(hover)}
                  y1="0"
                  y2={height}
                  vectorEffect="non-scaling-stroke"
                />
              ) : null}
              <line
                className={styles.nowLine}
                x1={width}
                x2={width}
                y1="0"
                y2={height}
                vectorEffect="non-scaling-stroke"
              />
            </svg>
            <span className={styles.nowDot} style={{ top: `${(lastY / height) * 100}%` }} />
            {hover !== null ? (
              <div
                className={styles.tip}
                style={{ left: `${Math.min(88, Math.max(12, (hover / (buckets - 1)) * 100))}%` }}
              >
                <span>
                  {hover === buckets - 1
                    ? '现在'
                    : `${(buckets - 1 - hover) * bucketMinutes >= 60 ? `${Math.round(((buckets - 1 - hover) * bucketMinutes) / 60)} 小时前` : `${(buckets - 1 - hover) * bucketMinutes} 分钟前`}`}
                </span>
                {top.map((item) => (
                  <div key={item.channelId}>
                    <i style={{ background: color(item.channelId).line }} />
                    {channels.find((channel) => channel.id === item.channelId)?.name ?? '频道'}
                    <b>{item.counts[hover] ?? 0}</b>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        )}
        <div className={styles.axis}>
          {option.ticks.map((tick) => (
            <span key={tick}>{tick}</span>
          ))}
        </div>
      </Panel>
      {top.length ? (
        <div className={styles.legend}>
          {top.map((item) => {
            const channel = channels.find((candidate) => candidate.id === item.channelId)
            return (
              <span key={item.channelId}>
                <i
                  style={{
                    background: `linear-gradient(90deg, ${color(item.channelId).line}, ${color(item.channelId).fill})`,
                  }}
                />
                {channel?.name ?? '频道'}
                {channel ? ` · ${channel.connectionName}` : ''}
              </span>
            )
          })}
        </div>
      ) : null}
    </>
  )
}

/** Three or more items of the same agent-level kind collapse into one row so a single cause does not drown the rest. */
function groupAttention(items: readonly AttentionItem[]): readonly AttentionItem[] {
  const groupable = new Set<AttentionItem['kind']>([
    'agent-model-unavailable',
    'agent-vision-unavailable',
    'delivery-unconfirmed',
  ])
  const counts = new Map<AttentionItem['kind'], number>()
  for (const item of items) if (groupable.has(item.kind)) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1)
  const emitted = new Set<AttentionItem['kind']>()
  const result: AttentionItem[] = []
  for (const item of items) {
    const count = counts.get(item.kind) ?? 0
    if (count < 3) {
      result.push(item)
      continue
    }
    if (emitted.has(item.kind)) continue
    emitted.add(item.kind)
    const summary =
      item.kind === 'agent-model-unavailable'
        ? {
            title: `${count} 个智能体无法回复`,
            detail: '它们的主模型当前不可用',
            actionLabel: '查看智能体',
            href: '/agents',
          }
        : item.kind === 'agent-vision-unavailable'
          ? {
              title: `${count} 个智能体看不懂图片`,
              detail: '群里的图片会被跳过',
              actionLabel: '查看智能体',
              href: '/agents',
            }
          : {
              title: `${count} 条消息未确认送达`,
              detail: '可以在对应频道里重发或确认',
              actionLabel: '查看',
              href: item.href,
            }
    result.push({ ...item, id: `group:${item.kind}`, ...summary })
  }
  return result
}

const attentionIcon = (item: AttentionItem) => {
  if (item.kind === 'connection-unhealthy') return <Plug />
  if (item.kind === 'authoring-approval') return <Wrench />
  if (item.kind === 'agent-model-unavailable' || item.kind === 'agent-vision-unavailable') return <Bot />
  return <TriangleAlert />
}

export default function LiveSpace() {
  useCrumb('现场')
  const navigate = useGo()
  const runtime = useProductRuntime()
  const agents = useProductStore((state) => state.agents)
  const channels = useProductStore((state) => state.channels)
  const connections = useProductStore((state) => state.connections)
  const rawAttention = useAttention()
  const attention = useMemo(() => groupAttention(rawAttention), [rawAttention])
  const activity = useActivitySeries()
  const working = agents.filter(isAgentWorking)
  const totals = new Map<string, ChannelActivitySeries['channels'][number]>(
    activity?.series.channels.map((item) => [item.channelId, item]) ?? [],
  )
  const totalMessages = activity?.series.channels.reduce((sum, item) => sum + item.total, 0) ?? 0
  const option = WINDOWS[activity?.index ?? 0] ?? WINDOWS[0]

  const active = [...channels]
    .filter(
      (channel) =>
        channel.agentId &&
        ((totals.get(channel.id)?.total ?? 0) > 0 ||
          channel.runtimePhase === 'thinking' ||
          channel.runtimePhase === 'using-tool'),
    )
    .sort((left, right) => (right.lastActivityAt ?? 0) - (left.lastActivityAt ?? 0))
    .slice(0, 9)
  const quiet = [...channels]
    .filter((channel) => !active.includes(channel))
    .sort((left, right) => (right.lastActivityAt ?? 0) - (left.lastActivityAt ?? 0))
    .slice(0, 12)

  return (
    <div className={styles.live}>
      <div className={[styles.inner, styles.enter].join(' ')}>
        <CompatibilityNotices showContextReset />
        <section style={cssVars({ '--i': 0 })}>
          <div className={styles.head}>
            <h1>现场</h1>
            <div className={styles.stats}>
              <div className={styles.stat}>
                <b>{working.length}</b>
                <span>正在工作</span>
              </div>
              <div
                className={[styles.stat, attention.some((item) => item.severity === 'bad') ? styles.hot : ''].join(' ')}
              >
                <b>{rawAttention.length}</b>
                <span>需要关注</span>
              </div>
              <div className={styles.stat}>
                <b>{totalMessages}</b>
                <span>{option.label}消息</span>
              </div>
            </div>
          </div>
          <div style={{ marginTop: 14 }}>
            {activity ? (
              <Tide series={activity.series} windowIndex={activity.index} channels={channels} agents={agents} />
            ) : (
              <Panel className={styles.tide}>{null}</Panel>
            )}
          </div>
        </section>

        <section style={cssVars({ '--i': 1 })}>
          <h2 className={styles.sectionTitle}>需要关注</h2>
          <Panel className={styles.attention}>
            {attention.length === 0 ? (
              <div className={styles.calm}>
                <CheckCircle2 aria-hidden="true" />
                现在没有需要处理的事情
              </div>
            ) : (
              attention.map((item) => (
                <div key={item.id} className={[styles.attentionRow, styles[item.severity]].join(' ')}>
                  <span className={styles.bar} />
                  <span className={styles.icon}>{attentionIcon(item)}</span>
                  <div>
                    <div className={styles.what}>{item.title}</div>
                    <div className={styles.why}>{item.detail}</div>
                  </div>
                  <Button
                    size="small"
                    variant={item.severity === 'bad' ? 'primary' : 'default'}
                    onClick={() => navigate(item.href)}
                  >
                    {item.actionLabel}
                  </Button>
                  <IconButton
                    label="忽略"
                    size="small"
                    onClick={() => {
                      const ids = item.id.startsWith('group:')
                        ? rawAttention.filter((entry) => entry.kind === item.kind).map((entry) => entry.id)
                        : [item.id]
                      for (const id of ids) void attentionSource(runtime).dismiss(id)
                    }}
                  >
                    <X size={14} />
                  </IconButton>
                </div>
              ))
            )}
          </Panel>
        </section>

        {active.length ? (
          <section style={cssVars({ '--i': 2 })}>
            <h2 className={styles.sectionTitle}>正在发生</h2>
            <div className={styles.board}>
              {active.map((channel) => {
                const agent = agents.find((item) => item.id === channel.agentId)
                const connection = connections.find((item) => item.id === channel.connectionId)
                const series = totals.get(channel.id)
                const phase = agent ? agentPhase[channel.runtimePhase ?? agent.state] : undefined
                const live = channel.runtimePhase === 'thinking' || channel.runtimePhase === 'using-tool'
                return (
                  <Link
                    key={channel.id}
                    to={`/channels/${channel.id}`}
                    className={styles.card}
                    style={agent ? cssVars({ '--card-accent': agentAccent(agent) }) : undefined}
                  >
                    <div className={styles.cardHead}>
                      <div style={{ minWidth: 0 }}>
                        <div className={styles.cardTitle}>{channel.name}</div>
                        <div className={styles.cardSource}>
                          {connection
                            ? connection.alias
                              ? `${connection.alias} · ${connection.adapter}`
                              : connectionDisplayName(connection)
                            : channel.connectionName}
                        </div>
                      </div>
                      <span className={styles.cardTime}>{relativeTime(channel.lastActivityAt)}</span>
                    </div>
                    {agent && phase ? (
                      <div className={styles.who}>
                        <AgentAvatar name={agent.name} hue={agentHue(agent)} size="md" live={live} />
                        {agent.name}
                        <Chip tone={phase.tone} dot>
                          {phase.label}
                        </Chip>
                      </div>
                    ) : null}
                    {channel.lastMessage ? (
                      <div className={styles.preview}>
                        <b>{channel.lastMessage.author}</b>：{channel.lastMessage.text}
                      </div>
                    ) : null}
                    <div className={styles.chips}>
                      {channel.unread ? <Chip tone="accent">{`${channel.unread} 条未读`}</Chip> : null}
                    </div>
                    {series && agent ? (
                      <Sparkline
                        className={styles.spark}
                        values={series.counts}
                        color={agentAccent(agent)}
                        fill={`hsl(${agentHue(agent)} 70% 60% / 0.12)`}
                      />
                    ) : (
                      <div style={{ height: 16 }} />
                    )}
                  </Link>
                )
              })}
            </div>
          </section>
        ) : null}

        {quiet.length ? (
          <section style={cssVars({ '--i': 3 })}>
            <h2 className={styles.sectionTitle}>其他频道</h2>
            <div className={styles.quiet}>
              {quiet.map((channel) => {
                const agent = agents.find((item) => item.id === channel.agentId)
                return (
                  <Link key={channel.id} to={`/channels/${channel.id}`}>
                    {agent ? (
                      <AgentAvatar name={agent.name} hue={agentHue(agent)} size="sm" />
                    ) : (
                      <MemberAvatar name="?" size="sm" />
                    )}
                    {channel.name}
                    <small>{channel.connectionName}</small>
                  </Link>
                )
              })}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  )
}
