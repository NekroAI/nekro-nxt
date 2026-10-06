import { useGo } from '../model/nav.js'
import { CompatibilityNotices } from '../system/compatibility.js'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { ChannelActivitySeries } from '@nekro-nxt/contracts'
import { workspaceApi } from '../../host-api-client.js'
import {
  connectionDisplayName,
  useProductRuntime,
  useProductStore,
  type ChannelSummary,
} from '../../product-runtime.js'
import { AgentAvatar, BoardPage, Chip, MemberAvatar, Panel, Sparkline, cssVars, Pressable } from '../../ui-kit/index.js'
import { relativeTime } from '../channels/timeline-model.js'
import { AttentionList } from '../attention/attention-list.js'
import { useAttention } from '../model/attention.js'
import { agentHue, agentPhase, channelHue, distinctChannelHues, isAgentWorking } from '../model/identity.js'
import { useCrumb } from '../shell/crumb.js'
import { ActivityChart, channelColor } from './activity-chart.js'
import styles from './live.module.css'

const WINDOWS = [
  { window: '2h', bucket: '5m', label: '近 2 小时' },
  { window: '24h', bucket: '1h', label: '近 24 小时' },
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
    // New messages arrive as channel facts over SSE; coalesce a burst into one refetch so the chart follows within
    // a couple of seconds. The minute timer only rolls the window forward when nothing is happening.
    let burst: number | undefined
    const soon = () => {
      if (burst !== undefined) return
      burst = window.setTimeout(() => {
        burst = undefined
        void load()
      }, 1_500)
    }
    void load()
    const timer = window.setInterval(() => void load(), 60_000)
    const unsubscribe = runtime.events.subscribe({ open: () => void load(), 'channel-fact': soon })
    return () => {
      current = false
      window.clearInterval(timer)
      window.clearTimeout(burst)
      unsubscribe()
    }
  }, [runtime])
  return state
}

/** Channels whose latest activity changed while the page was open, for a short highlight. */
function useFreshChannels(channels: readonly ChannelSummary[]): ReadonlySet<string> {
  const seen = useRef<Map<string, number | undefined> | null>(null)
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set())
  useEffect(() => {
    const previous = seen.current
    seen.current = new Map(channels.map((channel) => [channel.id, channel.lastActivityAt]))
    if (!previous) return
    const changed = channels
      .filter((channel) => previous.has(channel.id) && previous.get(channel.id) !== channel.lastActivityAt)
      .map((channel) => channel.id)
    if (!changed.length) return
    setFresh((current) => new Set([...current, ...changed]))
    const timer = window.setTimeout(
      () => setFresh((current) => new Set([...current].filter((id) => !changed.includes(id)))),
      1_600,
    )
    return () => window.clearTimeout(timer)
  }, [channels])
  return fresh
}

/** Re-render every half minute so relative times ("3 分钟前") keep moving on a quiet page. */
function useRelativeTimeTick() {
  const [, setTick] = useState(0)
  useEffect(() => {
    const timer = window.setInterval(() => setTick((tick) => tick + 1), 30_000)
    return () => window.clearInterval(timer)
  }, [])
}

export default function LiveSpace() {
  useCrumb('概览')
  const navigate = useGo()
  const agents = useProductStore((state) => state.agents)
  const channels = useProductStore((state) => state.channels)
  const connections = useProductStore((state) => state.connections)
  const attention = useAttention()
  const activity = useActivitySeries()
  // One colour per channel across the chart, the legend and the cards.
  const hues = useMemo(() => distinctChannelHues(channels.map((channel) => channel.id)), [channels])
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

  const firstWorking = working[0]
  const fresh = useFreshChannels(channels)
  useRelativeTimeTick()
  return (
    <BoardPage>
      <div className={[styles.inner, styles.enter].join(' ')}>
        <CompatibilityNotices showContextReset />
        <section style={cssVars({ '--i': 0 })}>
          <div className={styles.head}>
            <h1>概览</h1>
            <div className={styles.stats}>
              <Pressable
                className={styles.stat}
                onClick={() =>
                  navigate(working.length === 1 && firstWorking ? `/agents/${firstWorking.id}` : '/agents')
                }
              >
                <b>{working.length}</b>
                <span>正在工作</span>
              </Pressable>
              <Pressable
                className={[styles.stat, attention.some((item) => item.severity === 'bad') ? styles.hot : ''].join(' ')}
                onClick={() => document.getElementById('live-attention')?.scrollIntoView({ behavior: 'smooth' })}
              >
                <b>{attention.length}</b>
                <span>需要关注</span>
              </Pressable>
              <Pressable className={styles.stat} onClick={() => navigate('/channels')}>
                <b>{totalMessages}</b>
                <span>{option.label}消息</span>
              </Pressable>
            </div>
          </div>
          <div className={styles.tideWrap}>
            {activity ? (
              <ActivityChart series={activity.series} channels={channels} hues={hues} />
            ) : (
              <Panel className={styles.placeholder}>{null}</Panel>
            )}
          </div>
        </section>

        <section style={cssVars({ '--i': 1 })} id="live-attention">
          <h2 className={styles.sectionTitle}>需要关注</h2>
          <Panel className={styles.attention}>
            <AttentionList />
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
                const hue = hues.get(channel.id) ?? channelHue(channel.id)
                return (
                  <Link
                    key={channel.id}
                    to={`/channels/${channel.id}`}
                    className={styles.card}
                    data-fresh={fresh.has(channel.id) || undefined}
                    style={cssVars({ '--card-accent': channelColor(hue) })}
                  >
                    <div className={styles.cardHead}>
                      <div className={styles.cardIdentity}>
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
                      <div key={channel.lastActivityAt} className={styles.preview}>
                        <b>{channel.lastMessage.author}</b>：{channel.lastMessage.text}
                      </div>
                    ) : null}
                    {channel.unread ? (
                      <div className={styles.chips}>
                        <Chip tone="accent">{`${channel.unread} 条未读`}</Chip>
                      </div>
                    ) : null}
                    {series && series.total > 0 ? (
                      <Sparkline
                        className={styles.spark}
                        height={22}
                        values={series.counts}
                        color={channelColor(hue)}
                        fill={`hsl(${hue} 70% 60% / 0.12)`}
                      />
                    ) : null}
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
    </BoardPage>
  )
}
