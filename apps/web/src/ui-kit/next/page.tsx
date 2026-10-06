import type { ReactNode } from 'react'
import styles from './page.module.css'

/**
 * Page layouts (Decision 2026-10-06 §4). Every space renders exactly one of these; panes are never nested.
 */

/** Short settings and reading pages: one centred column. */
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
 * The scrolling content of a workbench's main area. `width="full"` uses all the room (tables, editors);
 * `width="readable"` caps line length for prose-heavy objects.
 */
export function MainContent({
  width = 'full',
  children,
}: {
  readonly width?: 'full' | 'readable'
  readonly children: ReactNode
}) {
  return (
    <div className={styles.mainScroll}>
      <div className={[styles.mainInner, width === 'readable' ? styles.readable : ''].join(' ')}>{children}</div>
    </div>
  )
}
