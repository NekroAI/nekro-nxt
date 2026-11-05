import {
  COMPACTION_THRESHOLD,
  clampCompactionThreshold,
  compactionThresholdSteps,
  formatThresholdPercent,
  formatTokensInWan,
} from '@nekro-nxt/contracts'
import { StepScale } from '../../ui-kit/index.js'
import styles from './compaction-threshold.module.css'

/** Labels for the ends and every 10 %, leaving out a round value that would crowd an end. */
const isMinor = (steps: readonly number[], index: number): boolean => {
  const last = steps.length - 1
  if (index === 0 || index === last) return false
  const percent = Math.round((steps[index] ?? 0) * 100)
  return percent % 10 !== 0 || index < 2 || last - index < 2
}

/**
 * When the agent's conversations compact, as a share of the main model's window, in 5 % steps. The lowest step leaves
 * room for the summary and fixed prompt on small windows. A saved value the current model does not allow shows as the
 * nearest bound; the default is stored as no choice.
 */
export function CompactionThresholdSlider({
  value,
  contextWindow,
  onChange,
}: {
  /** The saved share; undefined is the default. */
  readonly value: number | undefined
  readonly contextWindow: number | undefined
  readonly onChange: (value: number | undefined) => void
}) {
  const steps = compactionThresholdSteps(contextWindow)
  const last = steps.length - 1
  const shown = clampCompactionThreshold(value ?? COMPACTION_THRESHOLD.default, contextWindow).ratio
  const selected = Math.max(
    0,
    steps.findIndex((ratio) => ratio === shown),
  )
  return (
    <StepScale
      label="压缩阈值"
      stops={steps.map((ratio, index) => ({
        label: formatThresholdPercent(ratio),
        minor: isMinor(steps, index),
      }))}
      value={selected}
      onChange={(index) => {
        const ratio = steps[index]
        if (ratio !== undefined) onChange(ratio === COMPACTION_THRESHOLD.default ? undefined : ratio)
      }}
      tone={(index) => ({
        from: 'color-mix(in srgb, var(--accent) 50%, var(--surface))',
        to: `color-mix(in srgb, var(--accent) ${Math.round(70 + (last > 0 ? index / last : 0) * 30)}%, var(--surface))`,
      })}
      summary={(index) => {
        const ratio = steps[index ?? selected] ?? shown
        return (
          <>
            <span className={styles.chip}>{formatThresholdPercent(ratio)}</span>
            <span className={styles.summaryText}>
              {contextWindow === undefined
                ? `对话累计到上下文的 ${formatThresholdPercent(ratio)} 时压缩`
                : `约 ${formatTokensInWan(contextWindow * ratio)} 万 token 时压缩（当前模型窗口 ${formatTokensInWan(contextWindow)} 万）`}
            </span>
          </>
        )
      }}
    />
  )
}
