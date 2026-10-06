import { cssVars } from './css-vars.js'
import { ChevronRight } from 'lucide-react'
import { useId, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Disclosure } from './layout.js'
import { Pressable } from './primitives.js'
import styles from './risk-ladder.module.css'

export interface RiskStep {
  readonly label: string
  /** What this step adds on top of the previous one. */
  readonly adds: string
  /** 0 none … 3 full; selects the risk colour. */
  readonly risk: 0 | 1 | 2 | 3
  readonly riskLabel: string
}

/**
 * Cumulative permission levels on one scale (Decision 2026-10-06 §7). Each step only states what it adds; the fill
 * deepens with risk. `value` is a step index or `'custom'` when the underlying switches match no step; `manual`
 * holds those switches behind a disclosure.
 */
export function RiskLadder({
  label,
  steps,
  value,
  onSelect,
  manual,
  disabled = false,
}: {
  readonly label: string
  readonly steps: readonly RiskStep[]
  readonly value: number | 'custom'
  readonly onSelect: (index: number) => void
  readonly manual?: ReactNode
  readonly disabled?: boolean
}) {
  const [manualOpen, setManualOpen] = useState(value === 'custom')
  const manualId = useId()
  const level = value === 'custom' ? -1 : value
  const current = level >= 0 ? steps[level] : undefined
  const included = steps.slice(1, level + 1).map((step) => step.adds)
  const fill = steps.length > 1 && level > 0 ? level / (steps.length - 1) : 0
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const forward = event.key === 'ArrowRight' || event.key === 'ArrowUp'
    const backward = event.key === 'ArrowLeft' || event.key === 'ArrowDown'
    if (!forward && !backward) return
    event.preventDefault()
    const next = Math.max(0, Math.min(steps.length - 1, (level < 0 ? 0 : level) + (forward ? 1 : -1)))
    if (next !== level) onSelect(next)
  }
  return (
    <div className={styles.ladder} style={cssVars({ '--ladder-color': `var(--risk-${current?.risk ?? 0})` })}>
      <div
        className={styles.scale}
        role="radiogroup"
        aria-label={label}
        onKeyDown={onKey}
        style={cssVars({ '--steps': steps.length })}
      >
        <span className={styles.track} aria-hidden="true">
          <span className={styles.fill} style={{ width: `${fill * 100}%` }} />
        </span>
        {steps.map((step, index) => {
          const reached = index <= level
          const selected = index === level
          return (
            <Pressable
              key={step.label}
              role="radio"
              aria-checked={selected}
              tabIndex={selected || (level < 0 && index === 0) ? 0 : -1}
              disabled={disabled}
              className={styles.stop}
              data-reached={reached}
              data-selected={selected}
              style={cssVars({ '--stop-color': `var(--risk-${step.risk})` })}
              onClick={() => onSelect(index)}
            >
              <span className={styles.dot} aria-hidden="true" />
              <span className={styles.stopLabel}>{step.label}</span>
            </Pressable>
          )
        })}
      </div>
      <div className={styles.summary}>
        <span className={styles.riskChip}>{current ? current.riskLabel : '自定义'}</span>
        <span className={styles.summaryText}>
          {current
            ? included.length > 0
              ? `包含：${included.join('、')}`
              : current.adds
            : '与预设级别不一致，见下方手动调整'}
        </span>
      </div>
      {manual ? (
        <>
          <Pressable
            className={styles.manualToggle}
            aria-expanded={manualOpen}
            aria-controls={manualId}
            onClick={() => setManualOpen(!manualOpen)}
          >
            <ChevronRight size={14} className={styles.chevron} data-open={manualOpen} />
            手动调整
          </Pressable>
          <Disclosure open={manualOpen} id={manualId}>
            <div className={styles.manual}>{manual}</div>
          </Disclosure>
        </>
      ) : null}
    </div>
  )
}
