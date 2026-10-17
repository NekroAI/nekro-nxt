import { StepScale } from '../../ui-kit/index.js'
import styles from './effort-slider.module.css'

/** Names and one-line meanings for the thinking levels DSH offers; an unknown level keeps its own name. */
const LEVELS: Readonly<Record<string, { readonly name: string; readonly hint: string }>> = {
  off: { name: '关闭', hint: '不思考，直接回答' },
  minimal: { name: '最少', hint: '只做最必要的思考' },
  low: { name: '低', hint: '回答快，思考较少' },
  medium: { name: '中', hint: '兼顾速度和深度' },
  high: { name: '高', hint: '复杂问题想得更深' },
  xhigh: { name: '很高', hint: '适合很复杂的问题，回答更慢' },
  max: { name: '最高', hint: '想得最深，回答最慢，用量最多' },
}

export const effortName = (effort: { readonly id: string; readonly name: string }): string =>
  LEVELS[effort.id]?.name ?? effort.name

/**
 * Thinking level on one scale: the model's default first, then the levels it offers from least to most, deepening
 * the accent towards the deeper levels. At the deepest level the fill turns into a current flowing towards the knob,
 * for how quickly that level spends tokens; `material` turns this off where another scale on the page already shows
 * it.
 */
export function EffortSlider({
  efforts,
  defaultEffort,
  value,
  onChange,
  disabled = false,
  material = true,
}: {
  readonly efforts: readonly { readonly id: string; readonly name: string }[]
  readonly defaultEffort?: string | undefined
  /** An offered level id, or empty for the model's default. */
  readonly value: string
  readonly onChange: (value: string) => void
  readonly disabled?: boolean
  readonly material?: boolean
}) {
  const fallback = efforts.find((effort) => effort.id === defaultEffort)
  const stops = [
    {
      id: '',
      label: '默认',
      hint: fallback ? `使用模型的默认强度（${effortName(fallback)}）` : '使用模型自己的默认强度',
    },
    ...efforts.map((effort) => ({ id: effort.id, label: effortName(effort), hint: LEVELS[effort.id]?.hint ?? '' })),
  ]
  const last = stops.length - 1
  const selected = Math.max(
    0,
    stops.findIndex((stop) => stop.id === value),
  )
  return (
    <StepScale
      label="思考强度"
      stops={stops}
      value={selected}
      onChange={(index) => onChange(stops[index]?.id ?? '')}
      disabled={disabled}
      tone={(index) => ({
        from: 'color-mix(in srgb, var(--accent) 50%, var(--surface))',
        to: `color-mix(in srgb, var(--accent) ${Math.round(70 + (last > 0 ? index / last : 0) * 30)}%, var(--surface))`,
      })}
      material={
        material && efforts.length > 0
          ? (index) => (index === last ? { kind: 'flow', strength: 1, halo: 'var(--focus)' } : undefined)
          : undefined
      }
      summary={(index) => {
        const stop = stops[index ?? 0]
        return (
          <>
            <span className={styles.chip}>{stop?.label}</span>
            <span className={styles.summaryText}>{stop?.hint}</span>
          </>
        )
      }}
    />
  )
}
