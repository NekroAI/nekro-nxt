import * as RadixDialog from '@radix-ui/react-dialog'
import * as RadixMenu from '@radix-ui/react-dropdown-menu'
import * as RadixTooltip from '@radix-ui/react-tooltip'
import { Check, TriangleAlert, X } from 'lucide-react'
import { useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react'
import { Button, IconButton } from './primitives.js'
import styles from './overlay.module.css'

export function Dialog({
  open,
  onOpenChange,
  title,
  children,
  actions,
  wide = false,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly title: ReactNode
  readonly children?: ReactNode
  readonly actions?: ReactNode
  readonly wide?: boolean
}) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={styles.scrim} />
        <RadixDialog.Content
          className={[styles.dialog, wide ? styles.wide : ''].join(' ')}
          aria-describedby={undefined}
        >
          <RadixDialog.Title className={styles.title}>{title}</RadixDialog.Title>
          {children ? <div className={styles.body}>{children}</div> : null}
          {actions ? <div className={styles.actions}>{actions}</div> : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}

/**
 * Confirmation for an action with consequences. The confirm button names the action, keeps the dialog open while
 * it runs and shows the failure inline instead of closing.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  children,
  confirmLabel,
  danger = false,
  onConfirm,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly title: ReactNode
  readonly children?: ReactNode
  readonly confirmLabel: string
  readonly danger?: boolean
  readonly onConfirm: () => Promise<void> | void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const change = (next: boolean) => {
    if (busy) return
    if (!next) setError('')
    onOpenChange(next)
  }
  const confirm = async () => {
    setBusy(true)
    setError('')
    try {
      await onConfirm()
      onOpenChange(false)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={change}
      title={title}
      actions={
        <>
          <Button onClick={() => change(false)} disabled={busy}>
            取消
          </Button>
          <Button variant={danger ? 'danger-solid' : 'primary'} busy={busy} onClick={() => void confirm()} autoFocus>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
      {error ? (
        <p role="alert" style={{ color: 'var(--bad)' }}>
          {error}
        </p>
      ) : null}
    </Dialog>
  )
}

/**
 * Modal surface without dialog chrome, for custom overlays such as the command palette. The caller styles the
 * panel; the kit provides the scrim, focus trap, escape handling and an accessible title.
 */
export function Overlay({
  open,
  onOpenChange,
  label,
  className,
  onKeyDown,
  children,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly label: string
  readonly className?: string
  readonly onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void
  readonly children: ReactNode
}) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={styles.scrim} />
        <RadixDialog.Content className={className} aria-describedby={undefined} onKeyDown={onKeyDown}>
          <RadixDialog.Title className={styles.srOnly}>{label}</RadixDialog.Title>
          {children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}

/** Side sheet for editing a secondary object without leaving the page. */
export function Sheet({
  open,
  onOpenChange,
  title,
  children,
  footer,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly title: ReactNode
  readonly children: ReactNode
  readonly footer?: ReactNode
}) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={styles.scrim} />
        <RadixDialog.Content className={styles.sheet} aria-describedby={undefined}>
          <div className={styles.sheetHead}>
            <RadixDialog.Title className={styles.title}>{title}</RadixDialog.Title>
            <RadixDialog.Close asChild>
              <IconButton label="关闭">
                <X size={16} />
              </IconButton>
            </RadixDialog.Close>
          </div>
          <div className={styles.sheetBody}>{children}</div>
          {footer ? <div className={styles.sheetFoot}>{footer}</div> : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}

export interface MenuEntry {
  readonly key: string
  readonly label: ReactNode
  readonly icon?: ReactNode
  readonly danger?: boolean
  readonly disabled?: boolean
  readonly onSelect: () => void
}

export function Menu({
  trigger,
  items,
  label,
  align = 'end',
}: {
  readonly trigger: ReactNode
  readonly items: readonly (MenuEntry | 'separator' | { readonly heading: string })[]
  readonly label?: string
  readonly align?: 'start' | 'end'
}) {
  return (
    <RadixMenu.Root modal={false}>
      <RadixMenu.Trigger asChild>{trigger}</RadixMenu.Trigger>
      <RadixMenu.Portal>
        <RadixMenu.Content className={styles.menu} align={align} sideOffset={6} aria-label={label}>
          {items.map((item, index) =>
            item === 'separator' ? (
              <RadixMenu.Separator key={`separator-${index}`} className={styles.menuSeparator} />
            ) : 'heading' in item ? (
              <RadixMenu.Label key={`heading-${index}`} className={styles.menuLabel}>
                {item.heading}
              </RadixMenu.Label>
            ) : (
              <RadixMenu.Item
                key={item.key}
                className={[styles.menuItem, item.danger ? styles.menuDanger : ''].join(' ')}
                disabled={item.disabled ?? false}
                onSelect={item.onSelect}
              >
                {item.icon}
                {item.label}
              </RadixMenu.Item>
            ),
          )}
        </RadixMenu.Content>
      </RadixMenu.Portal>
    </RadixMenu.Root>
  )
}

export function TooltipProvider({ children }: { readonly children: ReactNode }) {
  return (
    <RadixTooltip.Provider delayDuration={400} skipDelayDuration={200}>
      {children}
    </RadixTooltip.Provider>
  )
}

export function Tooltip({
  content,
  children,
  side = 'top',
}: {
  readonly content: ReactNode
  readonly children: ReactNode
  readonly side?: 'top' | 'right' | 'bottom' | 'left'
}) {
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content className={styles.tooltip} side={side} sideOffset={6}>
          {content}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  )
}

/* ---------- Toast ---------- */

interface ToastItem {
  readonly id: number
  readonly message: string
  readonly tone: 'ok' | 'bad'
  readonly action?: { readonly label: string; readonly run: () => void } | undefined
  /** A newer toast of the same group replaces this one instead of stacking. */
  readonly group?: string | undefined
  readonly leaving: boolean
}

let toasts: readonly ToastItem[] = []
let nextId = 1
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((listener) => listener())

const dismissToast = (id: number): void => {
  if (!toasts.some((item) => item.id === id && !item.leaving)) return
  toasts = toasts.map((item) => (item.id === id ? { ...item, leaving: true } : item))
  emit()
  setTimeout(() => {
    toasts = toasts.filter((item) => item.id !== id)
    emit()
  }, 240)
}

/**
 * Short result feedback for an action. Failures are announced assertively and stay longer; a `group` keeps only
 * the latest result of the same action.
 */
export function toast(
  message: string,
  options: { readonly tone?: 'ok' | 'bad'; readonly action?: ToastItem['action']; readonly group?: string } = {},
): void {
  const id = nextId++
  const kept = options.group === undefined ? toasts : toasts.filter((item) => item.group !== options.group)
  toasts = [
    ...kept.slice(-2),
    { id, message, tone: options.tone ?? 'ok', action: options.action, group: options.group, leaving: false },
  ]
  emit()
  setTimeout(() => dismissToast(id), options.tone === 'bad' ? 5200 : 2600)
}

export function Toaster() {
  const items = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => toasts,
  )
  return (
    <div className={styles.toasts}>
      {items.map((item) => (
        <div
          key={item.id}
          className={styles.toast}
          data-leaving={item.leaving}
          role={item.tone === 'bad' ? 'alert' : 'status'}
        >
          <span className={[styles.toastIcon, item.tone === 'bad' ? styles.bad : ''].join(' ')}>
            {item.tone === 'bad' ? <TriangleAlert /> : <Check />}
          </span>
          {item.message}
          {item.action ? (
            <button type="button" className={styles.toastAction} onClick={item.action.run}>
              {item.action.label}
            </button>
          ) : null}
          <button
            type="button"
            className={styles.toastClose}
            aria-label="关闭通知"
            onClick={() => dismissToast(item.id)}
          >
            <X aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  )
}
