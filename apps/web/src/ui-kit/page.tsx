import { ChevronLeft, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Button, IconButton } from './primitives.js'
import styles from './page.module.css'

/**
 * Page layouts (Decision 2026-10-06 §4, width rules in docs/05 §6.1). Every space renders exactly one of these;
 * panes are never nested.
 *
 * Width rules, so switching between menus never makes the page jump:
 * - Width-limited content is centred in the space the list leaves, so a wide screen keeps even margins instead of
 *   leaning towards the list.
 * - A page picks one of three widths and never sets its own: `readable` (`--reader-width`) for forms and every
 *   settings section, `wide` (`--content-width`) for object pages built from tables and groups, `full` only for
 *   canvases (wiring board, task preview with its side column, conversations) and card grids that add columns as
 *   the space grows (community discover and personas).
 * - A list whose items open a detail uses `MasterDetail`: on a wide main area the list stays on the left and the
 *   detail opens to its right with a close button (Escape closes it too); on a narrow one the detail replaces the list
 *   and going back restores the list's position. Clicking an item never jumps away from the list when there is room
 *   to keep it.
 */

/**
 * Header of a view page (05 §6.1): the title, an optional one-line subtitle and at most two actions. Object pages use
 * `ObjectHeader`; search, filters and statistics go below the header, never on the title line.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  readonly title: ReactNode
  readonly subtitle?: ReactNode
  readonly actions?: ReactNode
}) {
  return (
    <header className={styles.pageHead}>
      <div className={styles.pageHeading}>
        <h1 className={styles.pageTitle}>{title}</h1>
        {subtitle ? <p className={styles.pageSubtitle}>{subtitle}</p> : null}
      </div>
      {actions ? <div className={styles.pageActions}>{actions}</div> : null}
    </header>
  )
}

/** Standalone forms without a collection list (e.g. adding an account): one centred column. */
export function ReaderPage({
  title,
  actions,
  children,
}: {
  readonly title: ReactNode
  readonly actions?: ReactNode
  readonly children: ReactNode
}) {
  return (
    <div className={styles.scroll} data-layout="reader">
      <div className={styles.reader}>
        <PageHeader title={title} actions={actions} />
        {children}
      </div>
    </div>
  )
}

/** The live board: a full-width responsive grid. */
export function BoardPage({ children }: { readonly children: ReactNode }) {
  return (
    <div className={styles.scroll} data-layout="board">
      <div className={styles.board}>{children}</div>
    </div>
  )
}

/**
 * Object workbenches: an optional collection list, the main area filling the remaining width, and an optional detail
 * pane. Below 1100px the list collapses so the main area keeps its room.
 */
export function WorkbenchPage({
  list,
  detail,
  narrowPane,
  back,
  children,
}: {
  readonly list?: ReactNode
  readonly detail?: ReactNode
  /** Explicit navigation for spaces that replace their list with an object on narrow screens. */
  readonly narrowPane?: 'list' | 'main' | 'detail'
  readonly back?: { readonly label: string; readonly onBack: () => void }
  readonly children: ReactNode
}) {
  return (
    <div
      className={styles.workbench}
      data-layout="workbench"
      data-list={list ? '' : undefined}
      data-detail={detail ? '' : undefined}
      data-narrow-pane={narrowPane}
    >
      {list}
      <div className={styles.main}>
        {back ? (
          <div className={styles.narrowBack}>
            <Button variant="ghost" size="small" icon={<ChevronLeft size={15} />} onClick={back.onBack}>
              {back.label}
            </Button>
          </div>
        ) : null}
        {children}
      </div>
      {detail}
    </div>
  )
}

/** The collection column of a workbench: title, actions, an optional toolbar (search, filters) and the list. */
export function ListPane({
  title,
  actions,
  toolbar,
  label,
  children,
}: {
  readonly title: ReactNode
  readonly actions?: ReactNode
  readonly toolbar?: ReactNode
  readonly label?: string
  readonly children: ReactNode
}) {
  return (
    <aside className={styles.list} aria-label={label}>
      <div className={styles.listHead}>
        <h2 className={styles.listTitle}>{title}</h2>
        {actions ? <div className={styles.listActions}>{actions}</div> : null}
      </div>
      {toolbar ? <div className={styles.listToolbar}>{toolbar}</div> : null}
      <div className={styles.listBody}>{children}</div>
    </aside>
  )
}

/**
 * The scrolling content of a workbench's main area (see the width rules above): `readable` for forms and settings and
 * `wide` for object pages, both centred in the space left by the list; `full` for canvases and card grids.
 */
export function MainContent({
  width = 'wide',
  fill = false,
  contained = false,
  children,
}: {
  readonly width?: 'readable' | 'wide' | 'full'
  /** The last child stretches to the bottom of the pane (canvases whose background must not jump with content). */
  readonly fill?: boolean
  /** Constrain the canvas to the pane; children own their scroll areas. */
  readonly contained?: boolean
  readonly children: ReactNode
}) {
  return (
    <div className={styles.mainScroll} data-contained={contained || undefined}>
      <div className={[styles.mainInner, styles[width], fill ? styles.fill : ''].join(' ')} data-width={width}>
        {children}
      </div>
    </div>
  )
}

/** Escape already means something here: typing, a picker, a menu or a dialog closes first. */
const escapeTaken = (target: EventTarget | null): boolean =>
  (target instanceof Element &&
    target.closest(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="combobox"], [role="listbox"], [role="menu"], [role="dialog"], [role="alertdialog"]',
    ) !== null) ||
  document.querySelector(
    ':is([role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"])[data-state="open"]',
  ) !== null

/**
 * A list whose rows open a detail, inside a workbench's main area. Without a selection the list takes the readable
 * width, followed by `overview` (summaries and related groups that only make sense beside the full list). With one,
 * a main area of at least 1080px narrows the list to a column on the left (`--pane-master`) and opens the detail to
 * its right with a close button; `overview` stays hidden until the detail closes. A narrower main area shows only
 * the detail with a way back. Escape, the close button and the back button all call `back.onBack`; going back
 * returns the list to where it was and focuses the opened row. Rows must carry `data-key` (DataTable does) so the
 * opened row can be found again; the address stays the source of truth for the selection.
 *
 * Motion (05 §6.1, §11): opening narrows the list while the detail fades in from a small offset; switching items
 * only fades the new detail in; closing runs faster and keeps the old detail on screen, inert, until it has faded.
 */
export function MasterDetail({
  list,
  overview,
  detail,
  selectedKey,
  back,
  label,
  lead,
}: {
  /** Shown above the detail while the list is hidden (e.g. a section picker that replaces a collapsed nav). */
  readonly lead?: ReactNode
  /** Heading, actions and the list itself. */
  readonly list: ReactNode
  /** Below the list, only while no detail is open. */
  readonly overview?: ReactNode
  /** The open item's detail; undefined shows the list alone. */
  readonly detail?: ReactNode
  readonly selectedKey?: string | undefined
  /** Closes the detail; the label names the way back shown above the detail while the list is hidden. */
  readonly back: { readonly label: string; readonly onBack: () => void }
  readonly label: string
}) {
  const master = useRef<HTMLDivElement>(null)
  const column = useRef<HTMLDivElement>(null)
  const detailScroll = useRef<HTMLDivElement>(null)
  const savedScroll = useRef(0)
  const lastKey = useRef(selectedKey)
  if (selectedKey) lastKey.current = selectedKey
  const open = detail !== undefined && detail !== null
  // The detail being closed stays rendered until it has faded out.
  const lastDetail = useRef<ReactNode>(null)
  if (open) lastDetail.current = detail
  const [previous, setPrevious] = useState({ open, key: selectedKey })
  const [leaving, setLeaving] = useState(false)
  const [switched, setSwitched] = useState(false)
  if (previous.open !== open || previous.key !== selectedKey) {
    setPrevious({ open, key: selectedKey })
    if (previous.open !== open) {
      setLeaving(!open)
      setSwitched(false)
    } else if (open) setSwitched(true)
  }
  const onBack = useRef(back.onBack)
  onBack.current = back.onBack

  useLayoutEffect(() => {
    const element = master.current
    if (!element) return
    if (!open && savedScroll.current > 0) element.scrollTop = savedScroll.current
    const key = lastKey.current
    if (!key || element.offsetParent === null) return
    const row = element.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)
    if (!row) return
    row.scrollIntoView({ block: 'nearest' })
    if (!open) row.focus({ preventScroll: true })
  }, [open])

  // A closing detail leaves the focus order and the accessibility tree at once.
  useLayoutEffect(() => {
    column.current?.toggleAttribute('inert', leaving)
  }, [leaving])

  useEffect(() => {
    if (!leaving) return
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      setLeaving(false)
    }
    const frame = requestAnimationFrame(() => {
      const running = column.current?.getAnimations() ?? []
      if (running.length === 0) finish()
      else void Promise.all(running.map((animation) => animation.finished)).then(finish, finish)
    })
    const fallback = window.setTimeout(finish, 600)
    return () => {
      settled = true
      cancelAnimationFrame(frame)
      window.clearTimeout(fallback)
    }
  }, [leaving])

  // Another item starts at its top.
  useLayoutEffect(() => {
    if (switched) detailScroll.current?.scrollTo({ top: 0 })
  }, [selectedKey, switched])

  useEffect(() => {
    if (!open) return
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || escapeTaken(event.target)) return
      event.preventDefault()
      onBack.current()
    }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [open])

  const shown = open ? detail : leaving ? lastDetail.current : null
  return (
    <div className={styles.split}>
      <div className={styles.splitGrid} data-open={open ? '' : undefined} data-leaving={leaving ? '' : undefined}>
        <div
          ref={master}
          className={styles.master}
          role="region"
          aria-label={label}
          onScroll={(event) => {
            savedScroll.current = event.currentTarget.scrollTop
          }}
        >
          <div className={styles.masterInner}>
            {list}
            {overview && !open ? (
              <div className={styles.overview} data-returning={leaving ? '' : undefined}>
                {overview}
              </div>
            ) : null}
          </div>
        </div>
        {shown !== null && shown !== undefined ? (
          <div ref={column} className={styles.detailColumn} data-master-detail="">
            <div className={styles.detailClose}>
              <IconButton label="关闭" onClick={() => onBack.current()}>
                <X size={16} />
              </IconButton>
            </div>
            <div ref={detailScroll} className={styles.detailScroll}>
              <div className={styles.detailInner}>
                {lead}
                <Button
                  size="small"
                  variant="ghost"
                  icon={<ChevronLeft size={15} />}
                  className={styles.splitBack}
                  onClick={() => onBack.current()}
                >
                  {back.label}
                </Button>
                <div key={lastKey.current} className={styles.detailBody} data-switched={switched ? '' : undefined}>
                  {shown}
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
