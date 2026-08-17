import * as RadixDialog from '@radix-ui/react-dialog'
import * as Select from '@radix-ui/react-select'
import * as Switch from '@radix-ui/react-switch'
import * as RadixTabs from '@radix-ui/react-tabs'
import * as RadixTooltip from '@radix-ui/react-tooltip'
import { Check, ChevronDown, LoaderCircle, X } from 'lucide-react'
import {
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type AriaAttributes,
  type ButtonHTMLAttributes,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react'
import { canCloseDialog, type DialogCloseReason } from './dialog-policy.js'
import { useFloatingLayer, useModalLayer } from './layers.js'
import styles from './ui.module.css'

export type StatusTone = 'neutral' | 'success' | 'warning' | 'error' | 'info' | 'unknown'

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  readonly size?: 'normal' | 'small'
  readonly loading?: boolean
  readonly loadingLabel?: string
}

export function Button({
  variant = 'secondary',
  size = 'normal',
  type = 'button',
  className,
  disabled,
  loading = false,
  loadingLabel,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={[styles.button, styles[variant], size === 'small' ? styles.small : '', className]
        .filter(Boolean)
        .join(' ')}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      data-loading={loading ? '' : undefined}
      {...props}
    >
      {loading ? <LoaderCircle className={styles.loadingSpinner} size={14} aria-hidden="true" /> : null}
      {loading ? (loadingLabel ?? children) : children}
    </button>
  )
}

export function IconButton({
  label,
  loadingLabel,
  loading = false,
  type = 'button',
  className,
  disabled,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly label: string
  readonly loading?: boolean
  readonly loadingLabel?: string
  readonly children: ReactNode
}) {
  const accessibleLabel = loading ? (loadingLabel ?? `${label}，处理中`) : label
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button
          type={type}
          className={[styles.iconButton, className].filter(Boolean).join(' ')}
          aria-label={accessibleLabel}
          aria-busy={loading || undefined}
          data-loading={loading ? '' : undefined}
          disabled={disabled || loading}
          {...props}
        >
          {loading ? <LoaderCircle className={styles.loadingSpinner} size={15} aria-hidden="true" /> : children}
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className={styles.tooltipContent} sideOffset={6}>
          {accessibleLabel}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}

export function Panel({
  className,
  children,
}: {
  readonly className?: string | undefined
  readonly children: ReactNode
}) {
  return <section className={[styles.panel, className].filter(Boolean).join(' ')}>{children}</section>
}

export function StatusBadge({
  tone = 'neutral',
  children,
}: {
  readonly tone?: StatusTone
  readonly children: ReactNode
}) {
  return (
    <span className={[styles.badge, tone === 'neutral' ? '' : styles[tone]].filter(Boolean).join(' ')}>{children}</span>
  )
}

interface FieldContextValue {
  readonly controlId: string
  readonly labelId: string
  readonly hintId?: string | undefined
  readonly errorId?: string | undefined
}

const FieldContext = createContext<FieldContextValue | null>(null)

const joinIds = (...ids: readonly (string | undefined)[]): string | undefined => {
  const unique = [...new Set(ids.flatMap((id) => id?.split(/\s+/u).filter(Boolean) ?? []))]
  return unique.length > 0 ? unique.join(' ') : undefined
}

function nativeFieldChild(children: ReactNode, field: FieldContextValue): ReactNode {
  if (!isValidElement(children) || typeof children.type !== 'string') return children
  if (!['input', 'select', 'textarea'].includes(children.type)) return children
  const child = children as ReactElement<{
    id?: string | undefined
    'aria-labelledby'?: string | undefined
    'aria-describedby'?: string | undefined
    'aria-errormessage'?: string | undefined
    'aria-invalid'?: AriaAttributes['aria-invalid'] | undefined
  }>
  return cloneElement(child, {
    id: child.props.id ?? field.controlId,
    'aria-labelledby': joinIds(field.labelId, child.props['aria-labelledby']),
    'aria-describedby': joinIds(child.props['aria-describedby'], field.hintId, field.errorId),
    'aria-errormessage': child.props['aria-errormessage'] ?? field.errorId,
    'aria-invalid': child.props['aria-invalid'] ?? (field.errorId ? true : undefined),
  })
}

export function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  readonly id?: string | undefined
  readonly label: ReactNode
  readonly hint?: ReactNode | undefined
  readonly error?: ReactNode | undefined
  readonly children: ReactNode
}) {
  const generatedId = useId()
  const controlId = id ?? `nxt-field-${generatedId}`
  const field: FieldContextValue = {
    controlId,
    labelId: `${controlId}-label`,
    hintId: hint ? `${controlId}-hint` : undefined,
    errorId: error ? `${controlId}-error` : undefined,
  }
  return (
    <FieldContext.Provider value={field}>
      <div className={styles.field} data-invalid={error ? '' : undefined}>
        <label className={styles.fieldLabel} id={field.labelId} htmlFor={controlId}>
          {label}
        </label>
        {nativeFieldChild(children, field)}
        {hint ? (
          <span className={styles.fieldHint} id={field.hintId}>
            {hint}
          </span>
        ) : null}
        {error ? (
          <span className={styles.fieldError} id={field.errorId} role="alert">
            {error}
          </span>
        ) : null}
      </div>
    </FieldContext.Provider>
  )
}

function useFieldA11y({
  id,
  labelledBy,
  describedBy,
  errorMessage,
  invalid,
}: {
  readonly id?: string | undefined
  readonly labelledBy?: string | undefined
  readonly describedBy?: string | undefined
  readonly errorMessage?: string | undefined
  readonly invalid?: AriaAttributes['aria-invalid'] | undefined
}) {
  const field = useContext(FieldContext)
  return {
    id: id ?? field?.controlId,
    labelledBy: joinIds(field?.labelId, labelledBy),
    describedBy: joinIds(describedBy, field?.hintId, field?.errorId),
    errorMessage: errorMessage ?? field?.errorId,
    invalid: invalid ?? (field?.errorId ? true : undefined),
  }
}

export function Input({ className, id, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  const a11y = useFieldA11y({
    id,
    labelledBy: props['aria-labelledby'],
    describedBy: props['aria-describedby'],
    errorMessage: props['aria-errormessage'],
    invalid: props['aria-invalid'],
  })
  return (
    <input
      {...props}
      id={a11y.id}
      className={[styles.input, className].filter(Boolean).join(' ')}
      aria-labelledby={a11y.labelledBy}
      aria-describedby={a11y.describedBy}
      aria-errormessage={a11y.errorMessage}
      aria-invalid={a11y.invalid}
    />
  )
}

export function Textarea({ className, id, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const a11y = useFieldA11y({
    id,
    labelledBy: props['aria-labelledby'],
    describedBy: props['aria-describedby'],
    errorMessage: props['aria-errormessage'],
    invalid: props['aria-invalid'],
  })
  return (
    <textarea
      {...props}
      id={a11y.id}
      className={[styles.textarea, className].filter(Boolean).join(' ')}
      aria-labelledby={a11y.labelledBy}
      aria-describedby={a11y.describedBy}
      aria-errormessage={a11y.errorMessage}
      aria-invalid={a11y.invalid}
    />
  )
}

export function SwitchField({
  id,
  label,
  description,
  checked,
  onCheckedChange,
  disabled = false,
}: {
  readonly id?: string | undefined
  readonly label: ReactNode
  readonly description: ReactNode
  readonly checked: boolean
  readonly onCheckedChange: (checked: boolean) => void
  readonly disabled?: boolean | undefined
}) {
  const generatedId = useId()
  const controlId = id ?? `nxt-switch-${generatedId}`
  const labelId = `${controlId}-label`
  const descriptionId = `${controlId}-description`
  return (
    <div className={styles.switchRow} data-disabled={disabled ? '' : undefined}>
      <div className={styles.switchCopy}>
        <label className={styles.switchLabel} id={labelId} htmlFor={controlId}>
          {label}
        </label>
        <div className={styles.switchDescription} id={descriptionId}>
          {description}
        </div>
      </div>
      <Switch.Root
        id={controlId}
        className={styles.switchRoot}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        aria-labelledby={labelId}
        aria-describedby={descriptionId}
      >
        <Switch.Thumb className={styles.switchThumb} />
      </Switch.Root>
    </div>
  )
}

interface SelectFieldProps {
  readonly id?: string | undefined
  readonly value: string
  readonly onValueChange: (value: string) => void
  readonly options: readonly { readonly value: string; readonly label: string; readonly disabled?: boolean }[]
  readonly label: ReactNode
  readonly disabled?: boolean | undefined
  readonly placeholder?: string | undefined
  readonly helper?: ReactNode | undefined
  readonly error?: ReactNode | undefined
}

function SelectControl({
  value,
  onValueChange,
  options,
  disabled,
  placeholder,
}: Omit<SelectFieldProps, 'id' | 'label' | 'helper' | 'error'>) {
  const field = useFieldA11y({})
  const floatingLayer = useFloatingLayer()
  return (
    <Select.Root value={value} onValueChange={onValueChange} disabled={disabled ?? false}>
      <Select.Trigger
        id={field.id}
        className={styles.selectTrigger}
        aria-labelledby={field.labelledBy}
        aria-describedby={field.describedBy}
        aria-errormessage={field.errorMessage}
        aria-invalid={field.invalid}
      >
        <Select.Value placeholder={placeholder} />
        <Select.Icon>
          <ChevronDown size={14} aria-hidden="true" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          className={styles.selectContent}
          position="popper"
          sideOffset={5}
          style={{ zIndex: floatingLayer }}
          data-nxt-floating-layer={floatingLayer}
        >
          <Select.Viewport className={styles.selectViewport}>
            {options.map((option) => (
              <Select.Item
                className={styles.selectItem}
                value={option.value}
                key={option.value}
                disabled={option.disabled ?? false}
              >
                <Select.ItemText>{option.label}</Select.ItemText>
                <Select.ItemIndicator>
                  <Check size={13} aria-hidden="true" />
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  )
}

export function SelectField({ id, label, helper, error, ...props }: SelectFieldProps) {
  return (
    <Field id={id} label={label} hint={helper} error={error}>
      <SelectControl {...props} />
    </Field>
  )
}

type DialogContentProps = ComponentPropsWithoutRef<typeof RadixDialog.Content>

export interface DialogLayoutProps {
  readonly title: ReactNode
  readonly description?: ReactNode | undefined
  readonly closeButton: ReactNode
  readonly children: ReactNode
  readonly footer?: ReactNode | undefined
}

function DialogBody({ children }: { readonly children: ReactNode }) {
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const [scrollable, setScrollable] = useState(false)

  useEffect(() => {
    const body = bodyRef.current
    if (!body) return undefined
    const update = (): void => {
      const nextScrollable = body.scrollHeight > body.clientHeight + 1
      setScrollable((current) => (current === nextScrollable ? current : nextScrollable))
    }
    const resizeObserver =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(() => {
            update()
          })
    const observeSize = (): void => {
      resizeObserver?.observe(body)
      for (const child of body.children) resizeObserver?.observe(child)
    }
    const mutationObserver =
      typeof MutationObserver === 'undefined'
        ? undefined
        : new MutationObserver(() => {
            observeSize()
            update()
          })

    observeSize()
    mutationObserver?.observe(body, { childList: true, subtree: true, characterData: true })
    window.addEventListener('resize', update)
    update()
    return () => {
      resizeObserver?.disconnect()
      mutationObserver?.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [children])

  return (
    <div
      ref={bodyRef}
      className={styles.dialogBody}
      data-nxt-dialog-region="body"
      data-scrollable={scrollable ? '' : undefined}
      tabIndex={scrollable ? 0 : undefined}
      role={scrollable ? 'region' : undefined}
      aria-label={scrollable ? '对话框内容' : undefined}
    >
      {children}
    </div>
  )
}

export function DialogLayout({ title, description, closeButton, children, footer }: DialogLayoutProps) {
  return (
    <>
      <header className={styles.dialogHeader} data-nxt-dialog-region="header">
        <div className={styles.dialogHeading}>
          {title}
          {description}
        </div>
        {closeButton}
      </header>
      <DialogBody>{children}</DialogBody>
      {footer ? (
        <footer className={styles.dialogFooter} data-nxt-dialog-region="footer">
          {footer}
        </footer>
      ) : null}
    </>
  )
}

export interface DialogProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly title: ReactNode
  readonly description?: ReactNode
  readonly children: ReactNode
  readonly footer?: ReactNode
  readonly pending?: boolean
  readonly closeLabel?: string
  readonly className?: string
  readonly onOpenAutoFocus?: DialogContentProps['onOpenAutoFocus']
  readonly onCloseAutoFocus?: DialogContentProps['onCloseAutoFocus']
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  pending = false,
  closeLabel = '关闭对话框',
  className,
  onOpenAutoFocus,
  onCloseAutoFocus,
}: DialogProps) {
  const layer = useModalLayer(open)
  const closeReason = useRef<DialogCloseReason>('close-button')
  const previouslyFocused = useRef<HTMLElement | null>(null)
  const requestClose = (reason: DialogCloseReason): void => {
    closeReason.current = reason
    if (canCloseDialog(pending, reason)) onOpenChange(false)
  }
  const layerVariables = {
    '--nxt-dialog-overlay-layer': layer.overlay,
    '--nxt-dialog-content-layer': layer.content,
    '--nxt-dialog-floating-layer': layer.floating,
  } as CSSProperties

  return (
    <RadixDialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) onOpenChange(true)
        else requestClose(closeReason.current)
      }}
    >
      <RadixDialog.Portal>
        <RadixDialog.Overlay
          className={styles.dialogOverlay}
          style={layerVariables}
          data-nxt-modal-order={layer.order}
        />
        <RadixDialog.Content
          className={[styles.dialogContent, className].filter(Boolean).join(' ')}
          style={layerVariables}
          data-nxt-modal-order={layer.order}
          onEscapeKeyDown={(event) => {
            closeReason.current = 'escape'
            if (!canCloseDialog(pending, 'escape')) event.preventDefault()
          }}
          onPointerDownOutside={(event) => {
            closeReason.current = 'outside'
            if (!canCloseDialog(pending, 'outside')) event.preventDefault()
          }}
          onOpenAutoFocus={(event) => {
            previouslyFocused.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
            onOpenAutoFocus?.(event)
          }}
          onCloseAutoFocus={(event) => {
            onCloseAutoFocus?.(event)
            if (!event.defaultPrevented && previouslyFocused.current?.isConnected) {
              event.preventDefault()
              previouslyFocused.current.focus()
            }
          }}
        >
          <DialogLayout
            title={<RadixDialog.Title className={styles.dialogTitle}>{title}</RadixDialog.Title>}
            description={
              description ? (
                <RadixDialog.Description className={styles.dialogDescription}>{description}</RadixDialog.Description>
              ) : undefined
            }
            closeButton={
              <RadixDialog.Close asChild>
                <button
                  type="button"
                  className={styles.dialogClose}
                  aria-label={closeLabel}
                  disabled={pending}
                  onClick={() => {
                    closeReason.current = 'close-button'
                  }}
                >
                  <X size={17} aria-hidden="true" />
                </button>
              </RadixDialog.Close>
            }
            footer={footer}
          >
            {children}
          </DialogLayout>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
  children,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly title: string
  readonly description: string
  readonly confirmLabel: string
  readonly onConfirm: () => boolean | void | Promise<boolean | void>
  readonly children?: ReactNode
}) {
  const [pending, setPending] = useState(false)
  const confirm = async (): Promise<void> => {
    if (pending) return
    setPending(true)
    try {
      if ((await onConfirm()) !== false) onOpenChange(false)
    } finally {
      setPending(false)
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      pending={pending}
      footer={
        <>
          <Button variant="ghost" disabled={pending} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button variant="primary" loading={pending} loadingLabel="处理中…" onClick={() => void confirm()}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  )
}

type TabsListProps = ComponentPropsWithoutRef<typeof RadixTabs.List>
type TabsTriggerProps = ComponentPropsWithoutRef<typeof RadixTabs.Trigger>
type TabsContentProps = ComponentPropsWithoutRef<typeof RadixTabs.Content>

function TabsList({ className, ...props }: TabsListProps) {
  return <RadixTabs.List className={[styles.tabsList, className].filter(Boolean).join(' ')} {...props} />
}

function TabsTrigger({ className, ...props }: TabsTriggerProps) {
  return <RadixTabs.Trigger className={[styles.tabsTrigger, className].filter(Boolean).join(' ')} {...props} />
}

function TabsContent({ className, ...props }: TabsContentProps) {
  return <RadixTabs.Content className={[styles.tabsContent, className].filter(Boolean).join(' ')} {...props} />
}

export const Tabs = {
  Root: RadixTabs.Root,
  List: TabsList,
  Trigger: TabsTrigger,
  Content: TabsContent,
}

type TooltipContentProps = ComponentPropsWithoutRef<typeof RadixTooltip.Content>

function TooltipContent({ className, style, ...props }: TooltipContentProps) {
  const floatingLayer = useFloatingLayer()
  return (
    <RadixTooltip.Content
      className={[styles.tooltipContent, className].filter(Boolean).join(' ')}
      style={{ ...style, zIndex: floatingLayer }}
      data-nxt-floating-layer={floatingLayer}
      {...props}
    />
  )
}

export const Tooltip = {
  Provider: RadixTooltip.Provider,
  Root: RadixTooltip.Root,
  Trigger: RadixTooltip.Trigger,
  Portal: RadixTooltip.Portal,
  Content: TooltipContent,
  Arrow: RadixTooltip.Arrow,
}
