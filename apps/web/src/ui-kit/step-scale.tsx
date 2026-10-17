import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { cssVars } from './css-vars.js'
import { Pressable } from './primitives.js'
import styles from './step-scale.module.css'

export interface StepScaleStop {
  readonly label: string
}

/** The fill's two ends for a level, as CSS colours (tokens or `color-mix`). */
export interface StepScaleTone {
  readonly from: string
  readonly to: string
}

/**
 * A living material inside the fill for levels that carry a cost or a risk (05 §11.5): `flow` runs towards the knob
 * (tokens being spent), `heat` rises (reach being granted). `strength` is 0…1; `halo` lights the knob in that colour.
 */
export interface StepScaleMaterial {
  readonly kind: 'flow' | 'heat'
  readonly strength: number
  readonly halo?: string
}

/**
 * Levels on one scale: a tall groove with the knob riding inside the fill, like a switch. The knob follows the pointer
 * while dragging and springs to the nearest stop on release; a click on the groove or a label, arrow keys, Home and
 * End select directly. `value` is a stop index, or undefined when the underlying state matches no stop. `summary`
 * renders below for the stop being shown, so a drag previews the nearest stop before it is chosen.
 */
export function StepScale({
  label,
  stops,
  value,
  onChange,
  tone,
  material,
  summary,
  valueText,
  disabled = false,
}: {
  readonly label: string
  readonly stops: readonly StepScaleStop[]
  readonly value: number | undefined
  readonly onChange: (index: number) => void
  readonly tone: (index: number) => StepScaleTone
  readonly material?: ((index: number) => StepScaleMaterial | undefined) | undefined
  readonly summary?: (index: number | undefined) => ReactNode
  /** Read out when `value` matches no stop. */
  readonly valueText?: string
  readonly disabled?: boolean
}) {
  const last = stops.length - 1
  const [drag, setDrag] = useState<{ readonly pointer: number; readonly position: number } | undefined>(undefined)
  const canvas = useRef<HTMLCanvasElement>(null)
  const position = drag?.position ?? (value === undefined || last <= 0 ? 0 : value / last)
  const shown = drag !== undefined ? Math.round(position * last) : value
  const colors = tone(shown ?? 0)
  const effect = shown === undefined ? undefined : material?.(shown)
  const effectRef = useRef(effect)
  effectRef.current = effect
  const wantsMaterial = material !== undefined

  useEffect(() => {
    const element = canvas.current
    if (!wantsMaterial || element === null) return
    let stop: (() => void) | undefined
    let cancelled = false
    void import('./step-scale-material.js').then(({ runMaterial }) => {
      if (!cancelled) stop = runMaterial(element, () => effectRef.current)
    })
    return () => {
      cancelled = true
      stop?.()
    }
  }, [wantsMaterial])

  const choose = (index: number) => {
    const next = Math.max(0, Math.min(last, index))
    if (next !== value) onChange(next)
  }
  // Knob centres run from half the groove height inside each end, so the knob never leaves the groove.
  const positionAt = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    const edge = box.height / 2
    const span = box.width - 2 * edge
    return span > 0 ? Math.max(0, Math.min(1, (event.clientX - box.left - edge) / span)) : 0
  }
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    setDrag({ pointer: event.pointerId, position: positionAt(event) })
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (drag?.pointer === event.pointerId) setDrag({ pointer: event.pointerId, position: positionAt(event) })
  }
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (drag?.pointer !== event.pointerId) return
    setDrag(undefined)
    choose(Math.round(positionAt(event) * last))
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return
    const from = value ?? -1
    const step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[event.key]
    if (step !== undefined) choose(from < 0 ? 0 : from + step)
    else if (event.key === 'Home') choose(0)
    else if (event.key === 'End') choose(last)
    else return
    event.preventDefault()
  }

  return (
    <div
      className={styles.root}
      data-dragging={drag !== undefined}
      data-empty={shown === undefined}
      style={cssVars({
        '--pos': position,
        '--stops': stops.length,
        '--scale-from': colors.from,
        '--scale-to': colors.to,
        ...(effect?.halo === undefined ? {} : { '--scale-halo': effect.halo }),
      })}
    >
      <div
        className={styles.groove}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={last}
        aria-valuenow={shown ?? 0}
        aria-valuetext={shown === undefined ? (valueText ?? '') : stops[shown]?.label}
        aria-disabled={disabled || undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setDrag(undefined)}
        onKeyDown={onKeyDown}
      >
        <span className={styles.clip} aria-hidden="true">
          <span className={styles.fill}>
            <canvas ref={canvas} className={styles.material} data-active={effect !== undefined} />
          </span>
        </span>
        {stops.map((stop, index) => (
          <span
            key={stop.label}
            className={styles.tick}
            aria-hidden="true"
            data-reached={shown !== undefined && last > 0 && index / last < position - 0.02}
            style={cssVars({ '--at': last > 0 ? index / last : 0 })}
          />
        ))}
        <span className={styles.knobTrack} aria-hidden="true">
          <span className={styles.knob} data-halo={effect?.halo !== undefined} />
        </span>
      </div>
      <div className={styles.labels}>
        {stops.map((stop, index) => (
          <Pressable
            key={stop.label}
            className={styles.label}
            tabIndex={-1}
            disabled={disabled}
            data-near={index === shown}
            style={cssVars({ '--at': last > 0 ? index / last : 0 })}
            onClick={() => choose(index)}
          >
            {stop.label}
          </Pressable>
        ))}
      </div>
      {summary ? <div className={styles.summary}>{summary(shown)}</div> : null}
    </div>
  )
}
