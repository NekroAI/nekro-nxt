import { Check, ChevronRight, Copy, Pencil, X } from 'lucide-react'
import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Input } from './form.js'
import { IconButton, Pressable } from './primitives.js'
import { Disclosure } from './layout.js'
import styles from './detail.module.css'

/** Heading level for object headers: the main area owns the page's h1, detail panes sit one level below. */
const HeadingLevel = createContext<1 | 2>(1)

/**
 * Header of any object page or pane: identity, state, a short meta line and its actions. The title is an h1 in the
 * main area and an h2 inside a DetailPane, unless `level` says otherwise.
 */
export function ObjectHeader({
  visual,
  title,
  status,
  meta,
  actions,
  size = 'default',
  level,
}: {
  readonly level?: 1 | 2
  readonly visual?: ReactNode
  readonly title: ReactNode
  readonly status?: ReactNode
  readonly meta?: ReactNode
  readonly actions?: ReactNode
  readonly size?: 'default' | 'compact'
}) {
  const contextLevel = useContext(HeadingLevel)
  const Heading = (level ?? contextLevel) === 1 ? 'h1' : 'h2'
  return (
    <header className={[styles.header, size === 'compact' ? styles.headerCompact : ''].join(' ')}>
      {visual ? <div className={styles.visual}>{visual}</div> : null}
      <div className={styles.identity}>
        <div className={styles.titleRow}>
          <Heading className={styles.title}>{title}</Heading>
          {status}
        </div>
        {meta ? <div className={styles.meta}>{meta}</div> : null}
      </div>
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </header>
  )
}

/**
 * The right-hand detail of a workbench: a fixed header and scrolling groups. Pass `onClose` when the pane can be
 * dismissed (it floats over the main area in narrow windows).
 */
export function DetailPane({
  header,
  children,
  footer,
  onClose,
  label,
}: {
  readonly header: ReactNode
  readonly children: ReactNode
  readonly footer?: ReactNode
  readonly onClose?: () => void
  readonly label: string
}) {
  return (
    <aside className={styles.pane} aria-label={label} data-detail-pane="">
      <div className={styles.paneHead}>
        <div className={styles.paneHeadMain}>
          <HeadingLevel.Provider value={2}>{header}</HeadingLevel.Provider>
        </div>
        {onClose ? (
          <IconButton label="关闭详情" size="small" onClick={onClose}>
            <X size={16} />
          </IconButton>
        ) : null}
      </div>
      <div className={styles.paneBody}>{children}</div>
      {footer ? <div className={styles.paneFoot}>{footer}</div> : null}
    </aside>
  )
}

/** A titled group of properties. */
export function PropertyGroup({
  title,
  description,
  actions,
  children,
  id,
}: {
  readonly title: ReactNode
  readonly description?: ReactNode
  readonly actions?: ReactNode
  readonly children: ReactNode
  readonly id?: string
}) {
  return (
    <section className={styles.group} id={id} aria-label={typeof title === 'string' ? title : undefined}>
      <div className={styles.groupHead}>
        <div className={styles.groupTitles}>
          <h3 className={styles.groupTitle}>{title}</h3>
          {description ? <p className={styles.groupDescription}>{description}</p> : null}
        </div>
        {actions ? <div className={styles.groupActions}>{actions}</div> : null}
      </div>
      <div className={styles.groupBody}>{children}</div>
    </section>
  )
}

/** Rows of label + value/control, separated by hairlines. */
export function PropertyList({ children, framed = true }: { readonly children: ReactNode; readonly framed?: boolean }) {
  return <div className={[styles.list, framed ? styles.framed : ''].join(' ')}>{children}</div>
}

/**
 * One property: label and optional description on the left, value or control on the right. `stacked` puts the
 * control under the label for wide controls (text areas, tables, long selects).
 */
export function PropertyRow({
  label,
  description,
  children,
  layout = 'inline',
  htmlFor,
  badge,
}: {
  readonly label: ReactNode
  readonly description?: ReactNode
  readonly children?: ReactNode
  readonly layout?: 'inline' | 'stacked'
  readonly htmlFor?: string
  readonly badge?: ReactNode
}) {
  const Label = htmlFor ? 'label' : 'div'
  return (
    <div className={[styles.row, layout === 'stacked' ? styles.stacked : ''].join(' ')}>
      <div className={styles.rowText}>
        <Label className={styles.rowLabel} {...(htmlFor ? { htmlFor } : {})}>
          {label}
          {badge}
        </Label>
        {description ? <div className={styles.rowDescription}>{description}</div> : null}
      </div>
      {children !== undefined ? <div className={styles.rowControl}>{children}</div> : null}
    </div>
  )
}

/** A technical value the user may need to copy (identifiers, keys, paths). */
export function KeyValueCopy({ label, value }: { readonly label: string; readonly value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className={styles.kv}>
      <span className={styles.kvLabel}>{label}</span>
      <code className={styles.kvValue} title={value}>
        {value}
      </code>
      <IconButton
        label={copied ? '已复制' : `复制${label}`}
        size="small"
        onClick={() =>
          void navigator.clipboard.writeText(value).then(() => {
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1200)
          })
        }
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </IconButton>
    </div>
  )
}

/** Technical details, collapsed by default (Decision 2026-10-06 §6). */
export function Diagnostics({
  items,
  children,
  title = '诊断信息',
}: {
  readonly items?: readonly { readonly label: string; readonly value: string }[]
  readonly children?: ReactNode
  readonly title?: string
}) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <div className={styles.diagnostics}>
      <Pressable
        className={styles.diagnosticsToggle}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        <ChevronRight size={14} className={styles.chevron} data-open={open} />
        {title}
      </Pressable>
      <Disclosure open={open} id={id}>
        <div className={styles.diagnosticsBody}>
          {items?.map((item) => (
            <KeyValueCopy key={item.label} label={item.label} value={item.value} />
          ))}
          {children}
        </div>
      </Disclosure>
    </div>
  )
}

/** A short text value edited in place: click to edit, Enter saves, Escape cancels. */
export function InlineEdit({
  value,
  label,
  onSave,
  placeholder,
  maxLength = 120,
}: {
  readonly value: string
  readonly label: string
  readonly onSave: (next: string) => Promise<void> | void
  readonly placeholder?: string
  readonly maxLength?: number
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!editing) setDraft(value)
  }, [editing, value])
  useEffect(() => {
    if (editing) input.current?.select()
  }, [editing])
  const commit = async () => {
    const next = draft.trim()
    if (next === value.trim()) {
      setEditing(false)
      return
    }
    setBusy(true)
    try {
      await onSave(next)
      setEditing(false)
    } finally {
      setBusy(false)
    }
  }
  if (!editing) {
    return (
      <Pressable className={styles.inlineView} onClick={() => setEditing(true)} aria-label={`修改${label}`}>
        <span className={value ? styles.inlineValue : styles.inlinePlaceholder}>
          {value || placeholder || '未设置'}
        </span>
        <Pencil size={13} className={styles.inlinePencil} />
      </Pressable>
    )
  }
  return (
    <form
      className={styles.inlineForm}
      onSubmit={(event) => {
        event.preventDefault()
        void commit()
      }}
    >
      <Input
        ref={input}
        aria-label={label}
        value={draft}
        maxLength={maxLength}
        placeholder={placeholder}
        disabled={busy}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            setEditing(false)
          }
        }}
        onBlur={() => void commit()}
      />
    </form>
  )
}
