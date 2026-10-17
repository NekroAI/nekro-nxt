import { useRef, useState, type ReactNode } from 'react'
import { Input } from './form.js'
import styles from './damped-slider.module.css'

const keyValue = (key: string, value: number, max: number): number | undefined => {
  if (key === 'Home') return 0
  if (key === 'End') return max
  if (['ArrowRight', 'ArrowUp', 'PageUp'].includes(key)) return Math.min(max, Math.round(value) + 1)
  if (['ArrowLeft', 'ArrowDown', 'PageDown'].includes(key)) return Math.max(0, Math.round(value) - 1)
  return undefined
}

/** Continuous pointer feedback with discrete commits; native range semantics keep keyboard and assistive input. */
export function DampedSlider({
  value,
  max,
  label,
  valueText,
  disabled,
  showMarks = true,
  onValueChange,
  onValueCommit,
  onValueCancel,
  children,
}: {
  readonly value: number
  readonly max: number
  readonly label: string
  readonly valueText: string
  readonly disabled?: boolean
  readonly showMarks?: boolean
  readonly onValueChange: (value: number) => void
  readonly onValueCommit: (value: number) => void
  readonly onValueCancel: () => void
  readonly children?: ReactNode
}) {
  const [draft, setDraft] = useState<number>()
  const [mode, setMode] = useState<'pointer' | 'keyboard'>('pointer')
  const pending = useRef<number>()
  const pointer = useRef<number>()
  const position = Math.max(0, Math.min(1, (draft ?? value) / Math.max(1, max)))
  const shift = { transform: `translateX(${position * 100}%)` }
  const preview = (next: number) => {
    pending.current = next
    setDraft(next)
    onValueChange(Math.round(next))
  }
  const commit = (next: number) => {
    pending.current = undefined
    pointer.current = undefined
    setDraft(undefined)
    onValueCommit(Math.round(next))
  }
  const cancel = () => {
    pending.current = undefined
    pointer.current = undefined
    setDraft(undefined)
    onValueCancel()
  }
  return (
    <div
      className={styles.slider}
      data-input={mode}
      data-disabled={disabled || undefined}
      data-marks={showMarks || undefined}
    >
      <div className={styles.rail} data-part="rail" aria-hidden="true">
        <div className={styles.fillPosition} style={shift}>
          <div className={styles.fill} data-part="fill">
            {children}
          </div>
        </div>
        <div className={styles.marks}>
          {Array.from({ length: max + 1 }, (_, index) => (
            <i key={index} />
          ))}
        </div>
      </div>
      <div className={styles.position} style={shift} aria-hidden="true">
        <span className={styles.thumb} data-part="thumb" />
      </div>
      <Input
        bare
        className={styles.input}
        type="range"
        min={0}
        max={max}
        step="any"
        value={draft ?? value}
        aria-label={label}
        aria-valuetext={valueText}
        aria-valuenow={Math.round(draft ?? value)}
        disabled={disabled || max === 0}
        onPointerDown={(event) => {
          if (pointer.current !== undefined || event.button !== 0) {
            event.preventDefault()
            return
          }
          pointer.current = event.pointerId
          setMode('pointer')
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onChange={(event) => {
          const next = Number(event.currentTarget.value)
          preview(next)
          if (pointer.current === undefined) {
            setMode('keyboard')
            commit(next)
          }
        }}
        onPointerUp={(event) => {
          if (pointer.current === event.pointerId) commit(Number(event.currentTarget.value))
        }}
        onPointerCancel={cancel}
        onLostPointerCapture={(event) => {
          if (pointer.current === event.pointerId) cancel()
        }}
        onKeyDown={(event) => {
          const next = keyValue(event.key, pending.current ?? value, max)
          if (next === undefined) return
          event.preventDefault()
          setMode('keyboard')
          preview(next)
        }}
        onKeyUp={(event) => {
          if (keyValue(event.key, value, max) !== undefined && pending.current !== undefined) commit(pending.current)
        }}
        onBlur={() => {
          if (pending.current !== undefined) commit(pending.current)
        }}
      />
    </div>
  )
}
