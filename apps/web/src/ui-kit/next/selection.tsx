import { cssVars } from './css-vars.js'
import { useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { useIndicator, type IndicatorGeometry } from './indicator.js'
import styles from './selection.module.css'

export interface Option<Value extends string> {
  readonly value: Value
  readonly label: ReactNode
}

function moveSelection<Value extends string>(
  event: KeyboardEvent,
  options: readonly Option<Value>[],
  value: Value,
  onChange: (value: Value) => void,
): void {
  const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown'
  const backward = event.key === 'ArrowLeft' || event.key === 'ArrowUp'
  if (!forward && !backward) return
  event.preventDefault()
  const index = options.findIndex((option) => option.value === value)
  const next = options[(index + (forward ? 1 : -1) + options.length) % options.length]
  if (!next) return
  onChange(next.value)
  const group = event.currentTarget
  if (group instanceof HTMLElement)
    requestAnimationFrame(() => group.querySelector<HTMLElement>('[tabindex="0"]')?.focus())
}

const boxStyle = (geometry: IndicatorGeometry): CSSProperties => ({
  opacity: geometry.visible ? 1 : 0,
  width: `${geometry.width}px`,
  height: `${geometry.height}px`,
  transform: `translate(${geometry.x}px, ${geometry.y}px)`,
})

/** Two to four mutually exclusive views. The thumb slides under the labels. */
export function Segmented<Value extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: {
  readonly options: readonly Option<Value>[]
  readonly value: Value
  readonly onChange: (value: Value) => void
  readonly label: string
  readonly className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const { geometry, ready } = useIndicator(ref, '[aria-checked="true"]', value)
  return (
    <div
      ref={ref}
      role="radiogroup"
      aria-label={label}
      className={[styles.segmented, className ?? ''].join(' ')}
      onKeyDown={(event) => moveSelection(event, options, value, onChange)}
    >
      <span
        className={[styles.segmentedIndicator, ready ? styles.animated : ''].join(' ')}
        style={boxStyle(geometry)}
        aria-hidden="true"
      />
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          tabIndex={option.value === value ? 0 : -1}
          className={styles.segmentedItem}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/** Tab strip; the caller renders the panel so it can keep its own scroll and state. */
export function TabStrip<Value extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: {
  readonly options: readonly Option<Value>[]
  readonly value: Value
  readonly onChange: (value: Value) => void
  readonly label: string
  readonly className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const { geometry, ready } = useIndicator(ref, '[aria-selected="true"]', value)
  return (
    <div
      ref={ref}
      role="tablist"
      aria-label={label}
      className={[styles.tabs, className ?? ''].join(' ')}
      onKeyDown={(event) => moveSelection(event, options, value, onChange)}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={option.value === value}
          tabIndex={option.value === value ? 0 : -1}
          className={styles.tab}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
      <span
        className={[styles.tabIndicator, ready ? styles.animated : ''].join(' ')}
        style={{
          opacity: geometry.visible ? 1 : 0,
          width: `${Math.max(0, geometry.width - 20)}px`,
          transform: `translateX(${geometry.x + 10}px)`,
        }}
        aria-hidden="true"
      />
    </div>
  )
}

/**
 * A list whose selected row is highlighted by one persistent surface that slides between rows, including rows
 * nested inside groups. Rows mark themselves with `data-selected="true"`; `accent` colors the leading bar.
 */
export function SelectionList({
  selectedKey,
  accent,
  children,
  className,
  label,
}: {
  readonly selectedKey: string | undefined
  readonly accent?: string | undefined
  readonly children: ReactNode
  readonly className?: string
  readonly label?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const { geometry, ready } = useIndicator(ref, '[data-selected="true"]', selectedKey)
  return (
    <div ref={ref} className={[styles.list, className ?? ''].join(' ')} aria-label={label}>
      <span
        className={[styles.listIndicator, ready ? styles.animated : ''].join(' ')}
        style={{ ...boxStyle(geometry), ...(accent ? cssVars({ '--indicator-accent': accent }) : {}) }}
        aria-hidden="true"
      />
      {children}
    </div>
  )
}
