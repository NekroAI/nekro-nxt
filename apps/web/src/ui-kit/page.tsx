import { ChevronLeft } from 'lucide-react'
import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { Button } from './primitives.js'
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
 *   detail opens to its right; on a narrow one the detail replaces the list and going back restores the list's
 *   position. Clicking an item never jumps away from the list when there is room to keep it.
 */

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
        <header className={styles.pageHead}>
          <h1 className={styles.pageTitle}>{title}</h1>
          {actions ? <div className={styles.pageActions}>{actions}</div> : null}
        </header>
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
  children,
}: {
  readonly list?: ReactNode
  readonly detail?: ReactNode
  readonly children: ReactNode
}) {
  return (
    <div
      className={styles.workbench}
      data-layout="workbench"
      data-list={list ? '' : undefined}
      data-detail={detail ? '' : undefined}
    >
      {list}
      <div className={styles.main}>{children}</div>
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
  children,
}: {
  readonly width?: 'readable' | 'wide' | 'full'
  /** The last child stretches to the bottom of the pane (canvases whose background must not jump with content). */
  readonly fill?: boolean
  readonly children: ReactNode
}) {
  return (
    <div className={styles.mainScroll}>
      <div className={[styles.mainInner, styles[width], fill ? styles.fill : ''].join(' ')} data-width={width}>
        {children}
      </div>
    </div>
  )
}

/**
 * A list whose rows open a detail, inside a workbench's main area. Without a selection the list takes the readable
 * width. With one, a main area of at least 1080px keeps the list as a column on the left (`--pane-master`) and shows
 * the detail to its right; a narrower one shows only the detail with a way back, and going back returns the list to
 * where it was and brings the opened row into view. Rows must carry `data-key` (DataTable does) so the opened row
 * can be found again; the address stays the source of truth for the selection.
 */
export function MasterDetail({
  list,
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
  /** The open item's detail; undefined shows the list alone. */
  readonly detail?: ReactNode
  readonly selectedKey?: string | undefined
  /** Shown above the detail only while the list is hidden. */
  readonly back: { readonly label: string; readonly onBack: () => void }
  readonly label: string
}) {
  const master = useRef<HTMLDivElement>(null)
  const savedScroll = useRef(0)
  const lastKey = useRef(selectedKey)
  if (selectedKey) lastKey.current = selectedKey
  const open = detail !== undefined && detail !== null
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
  return (
    <div className={styles.split}>
      <div className={styles.splitGrid} data-open={open ? '' : undefined}>
        <div
          ref={master}
          className={styles.master}
          role="region"
          aria-label={label}
          onScroll={(event) => {
            savedScroll.current = event.currentTarget.scrollTop
          }}
        >
          <div className={styles.masterInner}>{list}</div>
        </div>
        {open ? (
          <div className={styles.detailColumn} data-master-detail="">
            <div className={styles.detailInner}>
              {lead}
              <Button
                size="small"
                variant="ghost"
                icon={<ChevronLeft size={15} />}
                className={styles.splitBack}
                onClick={back.onBack}
              >
                {back.label}
              </Button>
              {detail}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
