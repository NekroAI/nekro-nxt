import { useMemo, useState } from 'react'
import type { ChannelActivitySeries } from '@nekro-nxt/contracts'
import type { ChannelSummary } from '../../product-runtime.js'
import { Panel, Pressable, cssVars } from '../../ui-kit/next/index.js'
import styles from './activity-chart.module.css'

const SHOWN = 5
const OTHERS = 'others'

/** Round up to 1, 2 or 5 × 10ⁿ so the scale reads as whole numbers. */
function niceCeil(value: number): number {
  if (value <= 4) return Math.max(2, Math.ceil(value / 2) * 2)
  const power = 10 ** Math.floor(Math.log10(value))
  const step = [1, 2, 5, 10].find((candidate) => candidate * power >= value) ?? 10
  return step * power
}

const clock = (at: number) =>
  new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })

export const channelColor = (hue: number) => `hsl(${hue} 62% 56%)`

/**
 * Messages per time bucket, stacked by channel. Bars instead of smoothed curves: counts are discrete, a bar never
 * dips below zero, and the newest bucket can grow in place when a message arrives.
 */
export function ActivityChart({
  series,
  channels,
  hues,
}: {
  readonly series: ChannelActivitySeries
  readonly channels: readonly ChannelSummary[]
  readonly hues: ReadonlyMap<string, number>
}) {
  const [hover, setHover] = useState<number | null>(null)
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
  const ranked = useMemo(
    () =>
      [...series.channels]
        .filter((item) => item.total > 0)
        .sort((a, b) => b.total - a.total)
        .slice(0, SHOWN),
    [series],
  )
  const buckets = Math.max(1, ...series.channels.map((item) => item.counts.length))
  // Quieter channels are summed into one neutral segment so each bar still shows the whole count.
  const others = useMemo(() => {
    const shown = new Set(ranked.map((item) => item.channelId))
    const counts = Array.from({ length: buckets }, () => 0)
    for (const item of series.channels)
      if (!shown.has(item.channelId))
        item.counts.forEach((value, index) => (counts[index] = (counts[index] ?? 0) + value))
    return counts
  }, [buckets, ranked, series])
  const hasOthers = others.some((value) => value > 0)
  const layers = [
    ...ranked
      .filter((item) => !hidden.has(item.channelId))
      .map((item) => ({
        id: item.channelId,
        counts: item.counts,
        color: channelColor(hues.get(item.channelId) ?? 220),
      })),
    ...(hasOthers && !hidden.has(OTHERS) ? [{ id: OTHERS, counts: others, color: 'var(--line-3)' }] : []),
  ]
  const totals = Array.from({ length: buckets }, (_, index) =>
    layers.reduce((sum, layer) => sum + (layer.counts[index] ?? 0), 0),
  )
  const scale = niceCeil(Math.max(1, ...totals))
  const nameOf = (id: string) =>
    id === OTHERS ? '其他频道' : (channels.find((channel) => channel.id === id)?.name ?? '频道')
  const startOf = (index: number) => series.from + index * series.bucketMs
  const ticks = [0, Math.round((buckets - 1) / 3), Math.round(((buckets - 1) * 2) / 3)]
  const toggle = (id: string) =>
    setHidden((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else if (ranked.length + (hasOthers ? 1 : 0) - next.size > 1) next.add(id)
      return next
    })

  if (ranked.length === 0)
    return (
      <Panel className={styles.chart}>
        <div className={styles.empty}>近一天没有新消息</div>
      </Panel>
    )

  return (
    <>
      <Panel className={styles.chart}>
        <div className={styles.scale} aria-hidden="true">
          <span>{scale}</span>
          <span>{scale / 2}</span>
          <span>0</span>
        </div>
        <div
          className={styles.plot}
          role="img"
          aria-label={`每 ${series.bucketMs / 60_000} 分钟的消息数，最多 ${Math.max(...totals)} 条`}
          onPointerLeave={() => setHover(null)}
        >
          <div className={styles.grid} aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
          <div className={styles.bars} style={cssVars({ '--buckets': buckets })}>
            {totals.map((total, index) => (
              <div
                key={index}
                className={styles.column}
                data-now={index === buckets - 1 || undefined}
                data-hover={hover === index || undefined}
                onPointerEnter={() => setHover(index)}
              >
                <div className={styles.stack} style={cssVars({ '--h': `${(total / scale) * 100}%`, '--i': index })}>
                  {layers.map((layer) =>
                    layer.counts[index] ? (
                      <span key={layer.id} style={{ flexGrow: layer.counts[index], background: layer.color }} />
                    ) : null,
                  )}
                </div>
              </div>
            ))}
          </div>
          {hover !== null ? (
            <div
              className={styles.tip}
              style={{ left: `${Math.min(84, Math.max(16, ((hover + 0.5) / buckets) * 100))}%` }}
            >
              <span>
                {clock(startOf(hover))} – {hover === buckets - 1 ? '现在' : clock(startOf(hover + 1))}
              </span>
              {layers
                .filter((layer) => layer.counts[hover])
                .map((layer) => (
                  <div key={layer.id}>
                    <i style={{ background: layer.color }} />
                    {nameOf(layer.id)}
                    <b>{layer.counts[hover]}</b>
                  </div>
                ))}
              <div className={styles.tipTotal}>
                合计<b>{totals[hover]}</b>
              </div>
            </div>
          ) : null}
        </div>
        <div className={styles.axis} aria-hidden="true">
          {ticks.map((index) => (
            <span key={index} style={cssVars({ '--at': (index + 0.5) / buckets })}>
              {clock(startOf(index))}
            </span>
          ))}
          <span className={styles.now} style={cssVars({ '--at': (buckets - 0.5) / buckets })}>
            现在
          </span>
        </div>
      </Panel>
      <div className={styles.legend} role="group" aria-label="显示的频道">
        {[...ranked.map((item) => item.channelId), ...(hasOthers ? [OTHERS] : [])].map((id) => {
          const channel = channels.find((candidate) => candidate.id === id)
          return (
            <Pressable key={id} className={styles.legendItem} aria-pressed={!hidden.has(id)} onClick={() => toggle(id)}>
              <i style={{ background: id === OTHERS ? 'var(--line-3)' : channelColor(hues.get(id) ?? 220) }} />
              {nameOf(id)}
              {channel ? <small>{channel.connectionName}</small> : null}
            </Pressable>
          )
        })}
      </div>
    </>
  )
}
