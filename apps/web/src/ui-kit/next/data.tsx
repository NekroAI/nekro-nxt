import { cssVars } from './css-vars.js'
import { Search, X } from 'lucide-react'
import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { Button, IconButton } from './primitives.js'
import styles from './data.module.css'

export interface Column<Row> {
  readonly key: string
  readonly header: ReactNode
  /** CSS track size, e.g. `minmax(160px, 2fr)` or `120px`. */
  readonly width?: string
  readonly align?: 'start' | 'end' | 'center'
  /** 1 always shows; 2 hides in narrow containers; 3 hides first. */
  readonly priority?: 1 | 2 | 3
  readonly render: (row: Row) => ReactNode
}

/**
 * Tabular data with stable column widths, a sticky header and container-width aware columns. Selecting a row is
 * optional; when `onSelect` is set rows are buttons in the keyboard order.
 */
export function DataTable<Row>({
  label,
  columns,
  rows,
  rowKey,
  selectedKey,
  onSelect,
  empty,
  footer,
}: {
  readonly label: string
  readonly columns: readonly Column<Row>[]
  readonly rows: readonly Row[]
  readonly rowKey: (row: Row) => string
  readonly selectedKey?: string | undefined
  readonly onSelect?: (row: Row) => void
  readonly empty?: ReactNode
  readonly footer?: ReactNode
}) {
  const template = columns.map((column) => column.width ?? 'minmax(0, 1fr)').join(' ')
  const onKey = (event: KeyboardEvent<HTMLDivElement>, row: Row) => {
    if (!onSelect) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onSelect(row)
    }
  }
  return (
    <div className={styles.tableWrap}>
      <div className={styles.table} role="table" aria-label={label} style={cssVars({ '--table-columns': template })}>
        <div className={styles.head} role="row">
          {columns.map((column) => (
            <div
              key={column.key}
              role="columnheader"
              className={styles.headCell}
              data-align={column.align ?? 'start'}
              data-priority={column.priority ?? 1}
            >
              {column.header}
            </div>
          ))}
        </div>
        {rows.length === 0 && empty ? <div className={styles.empty}>{empty}</div> : null}
        {rows.map((row) => {
          const key = rowKey(row)
          return (
            <div
              key={key}
              role="row"
              className={styles.row}
              data-selected={selectedKey === key}
              data-interactive={onSelect ? '' : undefined}
              aria-selected={onSelect ? selectedKey === key : undefined}
              tabIndex={onSelect ? 0 : undefined}
              onClick={onSelect ? () => onSelect(row) : undefined}
              onKeyDown={(event) => onKey(event, row)}
            >
              {columns.map((column) => (
                <div
                  key={column.key}
                  role="cell"
                  className={styles.cell}
                  data-align={column.align ?? 'start'}
                  data-priority={column.priority ?? 1}
                >
                  {column.render(row)}
                </div>
              ))}
            </div>
          )
        })}
      </div>
      {footer ? <div className={styles.footer}>{footer}</div> : null}
    </div>
  )
}

/** Search box for lists and tables; Escape clears it. */
export function SearchField({
  value,
  onChange,
  placeholder = '搜索',
  label,
}: {
  readonly value: string
  readonly onChange: (value: string) => void
  readonly placeholder?: string
  readonly label: string
}) {
  const input = useRef<HTMLInputElement>(null)
  const id = useId()
  return (
    <div className={styles.search}>
      <Search size={15} aria-hidden="true" className={styles.searchIcon} />
      <input
        ref={input}
        id={id}
        type="search"
        className={styles.searchInput}
        value={value}
        placeholder={placeholder}
        aria-label={label}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && value) {
            event.preventDefault()
            onChange('')
          }
        }}
      />
      {value ? (
        <IconButton
          label="清除搜索"
          size="small"
          onClick={() => {
            onChange('')
            input.current?.focus()
          }}
        >
          <X size={14} />
        </IconButton>
      ) : null}
    </div>
  )
}

/** A row of actions or filters above a list or table. */
export function Toolbar({ children, end }: { readonly children?: ReactNode; readonly end?: ReactNode }) {
  return (
    <div className={styles.toolbar}>
      <div className={styles.toolbarStart}>{children}</div>
      {end ? <div className={styles.toolbarEnd}>{end}</div> : null}
    </div>
  )
}

/**
 * Collects unsaved edits of one object into a single save (Decision 2026-10-06 §5). Renders nothing while clean.
 */
export function SaveBar({
  changes,
  busy = false,
  error,
  onSave,
  onDiscard,
}: {
  readonly changes: readonly string[]
  readonly busy?: boolean
  readonly error?: string | undefined
  readonly onSave: () => void
  readonly onDiscard: () => void
}) {
  if (changes.length === 0) return null
  return (
    <div className={styles.saveBar} role="region" aria-label="未保存的修改">
      <div className={styles.saveText}>
        <b>{changes.length} 项未保存的修改</b>
        <span className={error ? styles.saveError : styles.saveDetail}>{error ?? changes.join('、')}</span>
      </div>
      <Button variant="ghost" disabled={busy} onClick={onDiscard}>
        放弃
      </Button>
      <Button variant="primary" busy={busy} onClick={onSave}>
        保存
      </Button>
    </div>
  )
}
