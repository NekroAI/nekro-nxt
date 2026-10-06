import { cssVars } from './css-vars.js'
import { Info, OctagonAlert, TriangleAlert } from 'lucide-react'
import { useEffect, useRef, type ElementType, type ReactNode } from 'react'
import styles from './layout.module.css'

export function Panel({
  children,
  className,
  as: Tag = 'div',
}: {
  readonly children: ReactNode
  readonly className?: string
  readonly as?: ElementType
}) {
  return <Tag className={[styles.panel, className ?? ''].join(' ')}>{children}</Tag>
}

/** A titled block of a page. Titles only; explanations belong in the controls themselves. */
export function Section({
  title,
  actions,
  children,
  small = false,
  className,
}: {
  readonly title: ReactNode
  readonly actions?: ReactNode
  readonly children: ReactNode
  readonly small?: boolean
  readonly className?: string
}) {
  return (
    <section className={[styles.section, className ?? ''].join(' ')}>
      <div className={styles.sectionHead}>
        <h2 className={[styles.sectionTitle, small ? styles.small : ''].join(' ')}>{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  )
}

const bannerIcon = { warn: TriangleAlert, bad: OctagonAlert, info: Info } as const

/** A state that needs the user's action, with the action inline. */
export function Banner({
  tone = 'warn',
  children,
  action,
}: {
  readonly tone?: 'warn' | 'bad' | 'info'
  readonly children: ReactNode
  readonly action?: ReactNode
}) {
  const Icon = bannerIcon[tone]
  return (
    <div className={[styles.banner, styles[tone]].join(' ')} role={tone === 'info' ? 'status' : 'alert'}>
      <Icon aria-hidden="true" />
      <span className={styles.bannerText}>{children}</span>
      {action}
    </div>
  )
}

export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  readonly icon?: ReactNode
  readonly title: ReactNode
  readonly children?: ReactNode
  readonly action?: ReactNode
}) {
  return (
    <div className={styles.empty}>
      {icon ? <span className={styles.emptyIcon}>{icon}</span> : null}
      <p className={styles.emptyTitle}>{title}</p>
      {children ? <p className={styles.emptyText}>{children}</p> : null}
      {action}
    </div>
  )
}

/** Height-animated reveal that keeps the content mounted (no layout jump, no remount). */
export function Disclosure({
  open,
  children,
  id,
}: {
  readonly open: boolean
  readonly children: ReactNode
  readonly id?: string
}) {
  const inner = useRef<HTMLDivElement>(null)
  useEffect(() => {
    inner.current?.toggleAttribute('inert', !open)
  }, [open])
  return (
    <div className={styles.disclosure} data-open={open} id={id} aria-hidden={!open}>
      <div ref={inner} className={styles.disclosureInner}>
        {children}
      </div>
    </div>
  )
}

export function Skeleton({
  width,
  height = 14,
  radius,
}: {
  readonly width?: number | string
  readonly height?: number
  readonly radius?: number
}) {
  return (
    <span
      className={styles.skeleton}
      style={{ display: 'block', width: width ?? '100%', height, borderRadius: radius }}
      aria-hidden="true"
    />
  )
}

/** Lifecycle progress: done steps fill green, the current step is outlined in the accent color. */
/** Linear progress; `failed` marks the current step as the one that stopped the flow. */
export function Stepper({
  steps,
  current,
  failed = false,
}: {
  readonly steps: readonly string[]
  readonly current: number
  readonly failed?: boolean
}) {
  const count = steps.length
  const fill = count <= 1 ? 0 : Math.min(1, current / (count - 1))
  return (
    <ol className={styles.stepper} aria-label="进度">
      <span className={styles.stepTrack} style={{ right: `calc(${100 / count}% - 12px)` }} aria-hidden="true">
        <span className={styles.stepFill} style={{ width: `${fill * 100}%` }} />
      </span>
      {steps.map((step, index) => {
        const done = index < current
        const now = index === current
        return (
          <li
            key={step}
            className={[
              styles.step,
              done ? styles.stepDone : '',
              now ? (failed ? styles.stepFailed : styles.stepNow) : '',
            ].join(' ')}
            aria-current={now ? 'step' : undefined}
          >
            <span className={styles.stepKey}>{done ? '✓' : now && failed ? '!' : index + 1}</span>
            {step}
          </li>
        )
      })}
    </ol>
  )
}

export interface TimelineEntry {
  readonly key: string
  readonly tag: ReactNode
  readonly text: ReactNode
  readonly meta?: ReactNode
}

export function Timeline({
  entries,
  accent,
}: {
  readonly entries: readonly TimelineEntry[]
  readonly accent?: string
}) {
  return (
    <ol className={styles.timeline} style={accent ? cssVars({ '--timeline-accent': accent }) : undefined}>
      {entries.map((entry, index) => (
        <li key={entry.key} className={[styles.timelineItem, index === 0 ? styles.timelineCurrent : ''].join(' ')}>
          <span className={styles.timelineTag}>{entry.tag}</span>
          {entry.text}
          {entry.meta ? <span className={styles.timelineMeta}>{entry.meta}</span> : null}
        </li>
      ))}
    </ol>
  )
}

export interface GaugeSegment {
  readonly label: string
  readonly value: number
  readonly color: string
}

/** Context window occupancy: segments by source, value and total beside the ring. */
export function Gauge({
  segments,
  total,
  capacity,
  format,
}: {
  readonly segments: readonly GaugeSegment[]
  readonly total: number
  readonly capacity: number
  readonly format: (value: number) => string
}) {
  const radius = 31
  const circumference = 2 * Math.PI * radius
  const share = capacity > 0 ? Math.min(1, total / capacity) : 0
  const visible = Math.max(share, total > 0 ? 0.04 : 0)
  let offset = 0
  return (
    <div className={styles.gauge}>
      <svg viewBox="0 0 78 78" aria-hidden="true">
        <circle className={styles.gaugeTrack} cx="39" cy="39" r={radius} />
        {segments.map((segment) => {
          const portion = total > 0 ? (segment.value / total) * visible * circumference : 0
          const node = (
            <circle
              key={segment.label}
              cx="39"
              cy="39"
              r={radius}
              style={{ stroke: segment.color }}
              strokeDasharray={`${Math.max(portion - 3, 0.5)} ${circumference}`}
              strokeDashoffset={-offset}
            />
          )
          offset += portion
          return node
        })}
      </svg>
      <div>
        <div className={styles.gaugeValue}>
          {format(total)} <small>/ {format(capacity)}</small>
        </div>
        <div className={styles.gaugeLegend}>
          {segments.map((segment) => (
            <span key={segment.label}>
              <i style={{ background: segment.color }} />
              {segment.label} {format(segment.value)}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Smooth path through points (Catmull-Rom converted to cubic Bézier). */
export function smoothPath(points: readonly (readonly [number, number])[]): string {
  if (points.length === 0) return ''
  const [first] = points
  let path = `M${first![0].toFixed(1)},${first![1].toFixed(1)}`
  for (let index = 0; index < points.length - 1; index++) {
    const p0 = points[index - 1] ?? points[index]!
    const p1 = points[index]!
    const p2 = points[index + 1]!
    const p3 = points[index + 2] ?? p2
    const c1x = p1[0] + (p2[0] - p0[0]) / 6
    const c1y = p1[1] + (p2[1] - p0[1]) / 6
    const c2x = p2[0] - (p3[0] - p1[0]) / 6
    const c2y = p2[1] - (p3[1] - p1[1]) / 6
    path += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`
  }
  return path
}

export function Sparkline({
  values,
  color,
  fill,
  height = 36,
  className,
}: {
  readonly values: readonly number[]
  readonly color: string
  readonly fill: string
  readonly height?: number
  readonly className?: string
}) {
  const width = 300
  if (values.length < 2) return null
  const max = Math.max(...values, 1) * 1.2
  const line = smoothPath(
    values.map((value, index) => [(index / (values.length - 1)) * width, height - (value / max) * (height - 4)]),
  )
  return (
    <svg
      className={className}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      style={{ display: 'block', width: '100%', height }}
    >
      <path d={`${line} L${width},${height} L0,${height} Z`} style={{ fill }} />
      <path
        d={line}
        style={{ fill: 'none', stroke: color, strokeWidth: 1.5, opacity: 0.8 }}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}
