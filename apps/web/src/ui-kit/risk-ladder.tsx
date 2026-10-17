import { ChevronRight } from 'lucide-react'
import { useId, useState, type ReactNode } from 'react'
import { Disclosure } from './layout.js'
import { Pressable } from './primitives.js'
import styles from './risk-ladder.module.css'
import { StepScale, type StepScaleMaterial } from './step-scale.js'

export interface RiskStep {
  readonly label: string
  /** What this step adds on top of the previous one. */
  readonly adds: string
  /** 0 none … 3 full; selects the risk colour. */
  readonly risk: 0 | 1 | 2 | 3
  readonly riskLabel: string
}

/** From high risk on, heat rises inside the fill; full access also lights the knob (05 §11.5). */
const riskMaterial = (risk: RiskStep['risk']): StepScaleMaterial | undefined =>
  risk >= 3
    ? { kind: 'heat', strength: 0.6, halo: 'var(--risk-3)' }
    : risk === 2
      ? { kind: 'heat', strength: 0.32 }
      : undefined

/**
 * Cumulative permission levels on one scale (Decision 2026-10-06 §7). Each step only states what it adds; the fill
 * takes the step's risk colour. `value` is a step index or `'custom'` when the underlying switches match no step;
 * `manual` holds those switches behind a disclosure.
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
  const riskOf = (index: number) => steps[index]?.risk ?? 0
  return (
    <div className={styles.ladder}>
      <StepScale
        label={label}
        stops={steps}
        value={value === 'custom' ? undefined : value}
        onChange={onSelect}
        disabled={disabled}
        valueText="自定义"
        tone={(index) => ({
          from: `color-mix(in srgb, var(--risk-${riskOf(index)}) 55%, var(--surface))`,
          to: `var(--risk-${riskOf(index)})`,
        })}
        material={(index) => riskMaterial(riskOf(index))}
        summary={(index) => {
          const current = index === undefined ? undefined : steps[index]
          const included = index === undefined ? [] : steps.slice(1, index + 1).map((step) => step.adds)
          return (
            <>
              <span className={styles.riskChip}>{current ? current.riskLabel : '自定义'}</span>
              <span className={styles.summaryText}>
                {current
                  ? included.length > 0
                    ? `包含：${included.join('、')}`
                    : current.adds
                  : '与预设级别不一致，见下方手动调整'}
              </span>
            </>
          )
        }}
      />
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
