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

/**
 * The light copy of the labels that shows only inside the capsule. It is clipped to the capsule's own geometry and
 * moves with it, so text over the fill is always light and text over the groove always dark, in every frame.
 */
function LitLabels<Value extends string>({
  options,
  geometry,
  animated,
}: {
  readonly options: readonly Option<Value>[]
  readonly geometry: IndicatorGeometry
  readonly animated: boolean
}) {
  const right = geometry.x + geometry.width
  const bottom = geometry.y + geometry.height
  return (
    <span
      className={[styles.tabsLit, animated ? styles.animatedClip : ''].join(' ')}
      style={{
        opacity: geometry.visible ? 1 : 0,
        clipPath: `inset(${geometry.y}px calc(100% - ${right}px) calc(100% - ${bottom}px) ${geometry.x}px round 999px)`,
      }}
      aria-hidden="true"
    >
      {options.map((option) =>
        // Text labels are drawn by a pseudo-element: this copy is decoration, not content to read or audit twice.
        typeof option.label === 'string' ? (
          <span key={option.value} className={styles.tabLit} data-label={option.label} />
        ) : (
          <span key={option.value} className={styles.tabLit}>
            {option.label}
          </span>
        ),
      )}
    </span>
  )
}

/**
 * Tab strip: a raised capsule slides under the labels inside a groove (05 §7.2). The caller renders the panel so it
 * can keep its own scroll and state.
 */
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
      // Tabs never wrap; on a narrow screen the strip scrolls sideways (05 §6.2).
      data-scroll-x=""
      onKeyDown={(event) => moveSelection(event, options, value, onChange)}
    >
      <span
        className={[styles.tabIndicator, ready ? styles.animated : ''].join(' ')}
        style={boxStyle(geometry)}
        aria-hidden="true"
      />
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
      <LitLabels options={options} geometry={geometry} animated={ready} />
    </div>
  )
}

/**
 * In-page section navigation (anchors to sections further down). Same capsule as `TabStrip`; `active` follows the
 * section in view and `onJump` scrolls to one.
 */
export function SectionNav<Value extends string>({
  options,
  active,
  onJump,
  label,
  className,
}: {
  readonly options: readonly Option<Value>[]
  readonly active: Value | undefined
  readonly onJump: (value: Value) => void
  readonly label: string
  readonly className?: string
}) {
  const ref = useRef<HTMLElement>(null)
  const { geometry, ready } = useIndicator(ref, '[aria-current="true"]', active)
  return (
    <nav ref={ref} aria-label={label} className={[styles.tabs, className ?? ''].join(' ')} data-scroll-x="">
      <span
        className={[styles.tabIndicator, ready ? styles.animated : ''].join(' ')}
        style={boxStyle(geometry)}
        aria-hidden="true"
      />
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-current={option.value === active ? 'true' : undefined}
          className={styles.tab}
          onClick={() => onJump(option.value)}
        >
          {option.label}
        </button>
      ))}
      <LitLabels options={options} geometry={geometry} animated={ready} />
    </nav>
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
