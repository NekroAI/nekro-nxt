import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { cssVars, Pressable } from '../../ui-kit/index.js'
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
 * Thinking level on one scale: the model's default first, then the levels it offers from least to most. Laid out
 * like the access ladder: a stop is chosen by clicking it, by arrow keys, or by dragging along the scale, and the
 * fill deepens towards the deeper levels.
 */
export function EffortSlider({
  efforts,
  defaultEffort,
  value,
  onChange,
  disabled = false,
}: {
  readonly efforts: readonly { readonly id: string; readonly name: string }[]
  readonly defaultEffort?: string | undefined
  /** An offered level id, or empty for the model's default. */
  readonly value: string
  readonly onChange: (value: string) => void
  readonly disabled?: boolean
}) {
  const [dragged, setDragged] = useState<number | undefined>(undefined)
  const dragPointer = useRef<number | undefined>(undefined)
  const fallback = efforts.find((effort) => effort.id === defaultEffort)
  const stops = [
    {
      id: '',
      name: '默认',
      hint: fallback ? `使用模型的默认强度（${effortName(fallback)}）` : '使用模型自己的默认强度',
    },
    ...efforts.map((effort) => ({ id: effort.id, name: effortName(effort), hint: LEVELS[effort.id]?.hint ?? '' })),
  ]
  const selected = Math.max(
    0,
    stops.findIndex((stop) => stop.id === value),
  )
  const level = dragged ?? selected
  const current = stops[level]!
  const fill = stops.length > 1 ? level / (stops.length - 1) : 0
  const choose = (index: number) => {
    const stop = stops[index]
    if (stop && index !== selected) onChange(stop.id)
  }
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const forward = event.key === 'ArrowRight' || event.key === 'ArrowUp'
    const backward = event.key === 'ArrowLeft' || event.key === 'ArrowDown'
    if (!forward && !backward) return
    event.preventDefault()
    const next = Math.max(0, Math.min(stops.length - 1, selected + (forward ? 1 : -1)))
    choose(next)
    // Focus follows the selection, as in any radio group.
    event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus()
  }
  // The track runs between the first and last stop centres, each stop owning an equal column.
  const stopAt = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    const column = box.width / stops.length
    const position = ((event.clientX - box.left - column / 2) / (box.width - column)) * (stops.length - 1)
    return Math.max(0, Math.min(stops.length - 1, Math.round(Number.isFinite(position) ? position : 0)))
  }
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return
    dragPointer.current = event.pointerId
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragged(stopAt(event))
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (dragPointer.current === event.pointerId) setDragged(stopAt(event))
  }
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (dragPointer.current !== event.pointerId) return
    dragPointer.current = undefined
    const next = stopAt(event)
    setDragged(undefined)
    choose(next)
  }
  const onPointerCancel = () => {
    dragPointer.current = undefined
    setDragged(undefined)
  }
  return (
    <div className={styles.slider} style={cssVars({ '--depth': `${Math.round(35 + fill * 65)}%` })}>
      <div
        className={styles.scale}
        role="radiogroup"
        aria-label="思考强度"
        aria-disabled={disabled || undefined}
        data-dragging={dragged !== undefined}
        onKeyDown={onKey}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        style={cssVars({ '--steps': stops.length })}
      >
        <span className={styles.track} aria-hidden="true">
          <span className={styles.fill} style={{ width: `${fill * 100}%` }} />
        </span>
        {stops.map((stop, index) => (
          <Pressable
            key={stop.id || 'default'}
            role="radio"
            aria-checked={index === selected}
            aria-description={stop.hint}
            tabIndex={index === selected ? 0 : -1}
            disabled={disabled}
            className={styles.stop}
            data-reached={index <= level}
            data-selected={index === level}
            // Pointer presses select through the scale's drag; this keeps Enter and Space working.
            onClick={(event) => {
              if (event.detail === 0) choose(index)
            }}
          >
            <span className={styles.dot} aria-hidden="true" />
            <span className={styles.stopLabel}>{stop.name}</span>
          </Pressable>
        ))}
      </div>
      <div className={styles.summary}>
        <span className={styles.chip}>{current.name}</span>
        <span className={styles.summaryText}>{current.hint}</span>
      </div>
    </div>
  )
}
