import * as RadixDialog from '@radix-ui/react-dialog'
import * as RadixDropdownMenu from '@radix-ui/react-dropdown-menu'
import * as Select from '@radix-ui/react-select'
import * as Switch from '@radix-ui/react-switch'
import * as RadixTabs from '@radix-ui/react-tabs'
import * as RadixTooltip from '@radix-ui/react-tooltip'
import { Check, ChevronDown, LoaderCircle, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import {
  cloneElement,
  createContext,
  forwardRef,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type AriaAttributes,
  type ButtonHTMLAttributes,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type ElementRef,
  type InputHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react'
import { canCloseDialog, type DialogCloseReason } from './dialog-policy.js'
import { useFloatingLayer, useModalLayer } from './layers.js'
import { useMeasuredSelection, type MeasuredSelectionBox } from './measured-selection.js'
import {
  dialogVariants,
  nxtDuration,
  nxtEase,
  overlayVariants,
  popoverVariants,
  tooltipVariants,
  tween,
} from './motion.js'
import { useNxtReducedMotion } from './presence.js'
import styles from './ui.module.css'

const MotionDialogOverlay = motion.create(RadixDialog.Overlay)
const MotionDialogContent = motion.create(RadixDialog.Content)
const MotionTooltipContent = motion.create(RadixTooltip.Content)
const MotionSelectContent = motion.create(Select.Content)

export {
  AgentStateRing,
  Disclosure,
  Enter,
  NavGlyph,
  NavMark,
  NavMarkGroup,
  NxtMotionProvider,
  Presence,
  RouteTransition,
  SidePane,
  Spinner,
  StageCrossfade,
  ThemeIconSwap,
  useNxtReducedMotion,
  type AgentVisualState,
  type EnterKind,
} from './presence.js'

export type StatusTone = 'neutral' | 'success' | 'warning' | 'error' | 'info' | 'unknown'

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  readonly size?: 'normal' | 'small'
  readonly loading?: boolean
  readonly loadingLabel?: string
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'normal',
    type = 'button',
    className,
    disabled,
    loading = false,
    loadingLabel,
    children,
    ...props
  },
  ref,
) {
  return (
    <button
      ref={ref}
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
})

export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    readonly label: string
    readonly loading?: boolean
    readonly loadingLabel?: string
    readonly tooltip?: boolean
    readonly children: ReactNode
  }
>(function IconButton(
  { label, loadingLabel, loading = false, tooltip = true, type = 'button', className, disabled, children, ...props },
  ref,
) {
  const accessibleLabel = loading ? (loadingLabel ?? `${label}，处理中`) : label
  const control = (
    <button
      ref={ref}
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
  )
  if (!tooltip) return control
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{control}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className={styles.tooltipContent} sideOffset={6}>
          {accessibleLabel}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
})

export function ResizeHandle({
  label,
  value,
  min,
  max,
  defaultValue,
  className,
  side = 'before',
  disabled = false,
  onChange,
  onCommit,
}: {
  readonly label: string
  readonly value: number
  readonly min: number
  readonly max: number
  readonly defaultValue: number
  readonly className?: string
  readonly side?: 'before' | 'after'
  readonly disabled?: boolean
  readonly onChange: (value: number) => void
  readonly onCommit: (value: number) => void
}) {
  const dragStart = useRef<{ readonly x: number; readonly value: number }>()
  const currentValue = useRef(value)
  currentValue.current = value
  const clamp = (next: number): number => Math.min(max, Math.max(min, Math.round(next)))
  const change = (next: number): void => {
    const clamped = clamp(next)
    currentValue.current = clamped
    onChange(clamped)
  }
  const commit = (next: number): void => {
    const clamped = clamp(next)
    currentValue.current = clamped
    onChange(clamped)
    onCommit(clamped)
  }
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (disabled) return
    const step = event.shiftKey ? 10 : 1
    const direction = side === 'before' ? 1 : -1
    if (event.key === 'ArrowLeft') change(value - step * direction)
    else if (event.key === 'ArrowRight') change(value + step * direction)
    else if (event.key === 'Home') change(min)
    else if (event.key === 'End') change(max)
    else if (event.key === 'Enter' || event.key === ' ') commit(defaultValue)
    else return
    event.preventDefault()
    if (event.key !== 'Enter' && event.key !== ' ') onCommit(currentValue.current)
  }
  const finishPointer = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragStart.current) return
    dragStart.current = undefined
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
    onCommit(currentValue.current)
  }
  return (
    <div
      className={[styles.resizeHandle, className].filter(Boolean).join(' ')}
      role="separator"
      tabIndex={disabled ? -1 : 0}
      aria-hidden={disabled || undefined}
      data-disabled={disabled ? '' : undefined}
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      onKeyDown={onKeyDown}
      onDoubleClick={() => commit(defaultValue)}
      onPointerDown={(event) => {
        if (disabled || event.button !== 0) return
        dragStart.current = { x: event.clientX, value }
        currentValue.current = value
        event.currentTarget.setPointerCapture(event.pointerId)
        event.preventDefault()
      }}
      onPointerMove={(event) => {
        if (!dragStart.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return
        const direction = side === 'before' ? 1 : -1
        change(dragStart.current.value + (event.clientX - dragStart.current.x) * direction)
      }}
      onPointerUp={finishPointer}
      onLostPointerCapture={() => {
        if (!dragStart.current) return
        dragStart.current = undefined
        onCommit(currentValue.current)
      }}
    />
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

interface NativeFieldProps {
  readonly id?: string | undefined
  readonly 'aria-labelledby'?: string | undefined
  readonly 'aria-describedby'?: string | undefined
  readonly 'aria-errormessage'?: string | undefined
  readonly 'aria-invalid'?: AriaAttributes['aria-invalid'] | undefined
}

const isNativeFieldElement = (value: ReactNode): value is ReactElement<NativeFieldProps> => {
  if (!isValidElement(value) || typeof value.type !== 'string') return false
  return value.type === 'input' || value.type === 'select' || value.type === 'textarea'
}

const joinIds = (...ids: readonly (string | undefined)[]): string | undefined => {
  const unique = [...new Set(ids.flatMap((id) => id?.split(/\s+/u).filter(Boolean) ?? []))]
  return unique.length > 0 ? unique.join(' ') : undefined
}

function nativeFieldChild(children: ReactNode, field: FieldContextValue): ReactNode {
  if (!isNativeFieldElement(children)) return children
  return cloneElement(children, {
    id: children.props.id ?? field.controlId,
    'aria-labelledby': joinIds(field.labelId, children.props['aria-labelledby']),
    'aria-describedby': joinIds(children.props['aria-describedby'], field.hintId, field.errorId),
    'aria-errormessage': children.props['aria-errormessage'] ?? field.errorId,
    'aria-invalid': children.props['aria-invalid'] ?? (field.errorId ? true : undefined),
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

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, id, ...props },
  ref,
) {
  const a11y = useFieldA11y({
    id,
    labelledBy: props['aria-labelledby'],
    describedBy: props['aria-describedby'],
    errorMessage: props['aria-errormessage'],
    invalid: props['aria-invalid'],
  })
  return (
    <input
      ref={ref}
      {...props}
      id={a11y.id}
      className={[styles.input, className].filter(Boolean).join(' ')}
      aria-labelledby={a11y.labelledBy}
      aria-describedby={a11y.describedBy}
      aria-errormessage={a11y.errorMessage}
      aria-invalid={a11y.invalid}
    />
  )
})

export const RangeInput = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>>(
  function RangeInput(props, ref) {
    return <input ref={ref} {...props} type="range" />
  },
)

type SecretInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'autoComplete' | 'spellCheck'>

/**
 * Write-only API keys and tokens are secrets, but they are not account passwords.
 * Keep native masking while opting out of browser and common password-manager credential heuristics.
 */
export const SecretInput = forwardRef<HTMLInputElement, SecretInputProps>(function SecretInput(props, ref) {
  return (
    <Input
      ref={ref}
      {...props}
      type="password"
      autoComplete="off"
      spellCheck={false}
      autoCapitalize="none"
      data-1p-ignore="true"
      data-lpignore="true"
      data-bwignore="true"
      data-protonpass-ignore="true"
    />
  )
})

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

export function SwitchControl({
  label,
  checked,
  onCheckedChange,
  disabled = false,
}: {
  readonly label: string
  readonly checked: boolean
  readonly onCheckedChange: (checked: boolean) => void
  readonly disabled?: boolean
}) {
  return (
    <Switch.Root
      className={styles.switchRoot}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={label}
    >
      <Switch.Thumb className={styles.switchThumb} />
    </Switch.Root>
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
  const reduce = useNxtReducedMotion()
  const field = useFieldA11y({})
  const floatingLayer = useFloatingLayer()
  const [open, setOpen] = useState(false)
  return (
    <Select.Root
      value={value}
      onValueChange={onValueChange}
      disabled={disabled ?? false}
      open={open}
      onOpenChange={setOpen}
    >
      <Select.Trigger
        id={field.id}
        className={styles.selectTrigger}
        aria-labelledby={field.labelledBy}
        aria-describedby={field.describedBy}
        aria-errormessage={field.errorMessage}
        aria-invalid={field.invalid}
      >
        <Select.Value placeholder={placeholder}>
          {options.find((option) => option.value === value)?.label ?? placeholder}
        </Select.Value>
        <Select.Icon>
          <ChevronDown size={14} aria-hidden="true" />
        </Select.Icon>
      </Select.Trigger>
      <AnimatePresence>
        {open ? (
          <Select.Portal forceMount key="select">
            <MotionSelectContent
              className={styles.selectContent}
              position="popper"
              sideOffset={5}
              style={{ zIndex: floatingLayer }}
              data-nxt-floating-layer={floatingLayer}
              forceMount
              variants={popoverVariants}
              initial={reduce ? false : 'hidden'}
              animate="visible"
              exit={reduce ? { opacity: 1, scale: 1, transition: { duration: 0 } } : 'exit'}
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
            </MotionSelectContent>
          </Select.Portal>
        ) : null}
      </AnimatePresence>
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

type DialogLayerVariables = CSSProperties & {
  readonly '--nxt-dialog-overlay-layer': number
  readonly '--nxt-dialog-content-layer': number
  readonly '--nxt-dialog-floating-layer': number
}

export interface DialogLayoutProps {
  readonly title: ReactNode
  readonly description?: ReactNode | undefined
  readonly closeButton: ReactNode
  readonly children?: ReactNode | undefined
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
      {children === undefined || children === null ? null : <DialogBody>{children}</DialogBody>}
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
  readonly dialogRole?: 'dialog' | 'alertdialog'
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
  dialogRole = 'dialog',
}: DialogProps) {
  const reduce = useNxtReducedMotion()
  const layer = useModalLayer(open)
  const closeReason = useRef<DialogCloseReason>('close-button')
  const previouslyFocused = useRef<HTMLElement | null>(null)
  const requestClose = (reason: DialogCloseReason): void => {
    closeReason.current = reason
    if (canCloseDialog(pending, reason)) onOpenChange(false)
  }
  const layerVariables: DialogLayerVariables = {
    '--nxt-dialog-overlay-layer': layer.overlay,
    '--nxt-dialog-content-layer': layer.content,
    '--nxt-dialog-floating-layer': layer.floating,
  }

  return (
    <RadixDialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) onOpenChange(true)
        else requestClose(closeReason.current)
      }}
    >
      <AnimatePresence>
        {open ? (
          <RadixDialog.Portal forceMount key="dialog">
            <div style={layerVariables}>
              <MotionDialogOverlay
                className={styles.dialogOverlay}
                data-nxt-modal-order={layer.order}
                variants={overlayVariants}
                initial={reduce ? false : 'hidden'}
                animate="visible"
                exit={reduce ? { opacity: 1, transition: { duration: 0 } } : 'exit'}
              />
              <MotionDialogContent
                forceMount
                role={dialogRole}
                className={[styles.dialogContent, className].filter(Boolean).join(' ')}
                data-nxt-modal-order={layer.order}
                variants={dialogVariants}
                initial={reduce ? false : 'hidden'}
                animate="visible"
                exit={reduce ? { opacity: 1, scale: 1, transition: { duration: 0 } } : 'exit'}
                onEscapeKeyDown={(event) => {
                  closeReason.current = 'escape'
                  if (!canCloseDialog(pending, 'escape')) event.preventDefault()
                }}
                onPointerDownOutside={(event) => {
                  closeReason.current = 'outside'
                  if (!canCloseDialog(pending, 'outside')) event.preventDefault()
                }}
                onOpenAutoFocus={(event) => {
                  previouslyFocused.current =
                    document.activeElement instanceof HTMLElement ? document.activeElement : null
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
                      <RadixDialog.Description className={styles.dialogDescription}>
                        {description}
                      </RadixDialog.Description>
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
              </MotionDialogContent>
            </div>
          </RadixDialog.Portal>
        ) : null}
      </AnimatePresence>
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
  backLabel,
  onBack,
  cancelLabel = '取消',
  confirmVariant = 'primary',
  confirmLoadingLabel = '处理中…',
  confirmDisabled = false,
  onCloseAutoFocus,
  children,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly title: string
  readonly description: string
  readonly confirmLabel: string
  readonly onConfirm: () => boolean | void | Promise<boolean | void>
  readonly backLabel?: string | undefined
  readonly onBack?: (() => void) | undefined
  readonly cancelLabel?: string
  readonly confirmVariant?: 'primary' | 'danger'
  readonly confirmLoadingLabel?: string
  readonly confirmDisabled?: boolean
  readonly onCloseAutoFocus?: DialogProps['onCloseAutoFocus']
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
      dialogRole={confirmVariant === 'danger' ? 'alertdialog' : 'dialog'}
      onCloseAutoFocus={onCloseAutoFocus}
      footer={
        <>
          <Button variant="ghost" disabled={pending} onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </Button>
          {backLabel && onBack ? (
            <Button variant="secondary" disabled={pending} onClick={onBack}>
              {backLabel}
            </Button>
          ) : null}
          <Button
            variant={confirmVariant}
            loading={pending}
            loadingLabel={confirmLoadingLabel}
            disabled={confirmDisabled}
            onClick={() => void confirm()}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  )
}

type TabsRootProps = ComponentPropsWithoutRef<typeof RadixTabs.Root>
type TabsListProps = ComponentPropsWithoutRef<typeof RadixTabs.List>
type TabsTriggerProps = ComponentPropsWithoutRef<typeof RadixTabs.Trigger>
type TabsContentProps = ComponentPropsWithoutRef<typeof RadixTabs.Content>

const TabsValueContext = createContext<{
  readonly activeValue: string | undefined
  readonly orientation: 'horizontal' | 'vertical'
}>({ activeValue: undefined, orientation: 'horizontal' })

const tabsMutationAttributes = ['data-state'] as const

const findActiveTab = (root: HTMLElement): HTMLElement | null =>
  root.querySelector<HTMLElement>('[role="tab"][data-state="active"]')

function TabsRoot({
  value,
  defaultValue,
  onValueChange,
  orientation = 'horizontal',
  children,
  ...props
}: TabsRootProps) {
  const [uncontrolledValue, setUncontrolledValue] = useState(defaultValue)
  const activeValue = value ?? uncontrolledValue

  return (
    <TabsValueContext.Provider value={{ activeValue, orientation }}>
      <RadixTabs.Root
        {...props}
        orientation={orientation}
        {...(value === undefined ? (defaultValue === undefined ? {} : { defaultValue }) : { value })}
        onValueChange={(nextValue) => {
          if (value === undefined) setUncontrolledValue(nextValue)
          onValueChange?.(nextValue)
        }}
      >
        {children}
      </RadixTabs.Root>
    </TabsValueContext.Provider>
  )
}

function TabsList({ className, children, ...props }: TabsListProps) {
  const { activeValue, orientation } = useContext(TabsValueContext)
  const reduce = useNxtReducedMotion()
  const listRef = useRef<HTMLDivElement>(null)
  const findTab = useCallback(
    (list: HTMLElement) =>
      Array.from(list.querySelectorAll<HTMLElement>('[role="tab"]')).find(
        (trigger) => trigger.dataset['nxtTabsValue'] === activeValue,
      ) ?? findActiveTab(list),
    [activeValue],
  )
  const measureTab = useCallback((list: HTMLElement, trigger: HTMLElement): MeasuredSelectionBox => {
    const listRect = list.getBoundingClientRect()
    const triggerRect = trigger.getBoundingClientRect()
    return {
      x: triggerRect.left - listRect.left,
      y: triggerRect.top - listRect.top,
      width: triggerRect.width,
      height: triggerRect.height,
    }
  }, [])
  const indicator = useMeasuredSelection({
    rootRef: listRef,
    activeKey: activeValue,
    candidateSelector: '[role="tab"]',
    mutationAttributeFilter: tabsMutationAttributes,
    findAnchor: findTab,
    measure: measureTab,
  })
  const box = indicator.box

  return (
    <RadixTabs.List ref={listRef} className={[styles.tabsList, className].filter(Boolean).join(' ')} {...props}>
      <motion.span
        className={styles.tabsIndicator}
        data-nxt-tabs-indicator=""
        data-ready={indicator.ready ? '' : undefined}
        initial={false}
        animate={
          orientation === 'vertical'
            ? { y: box?.y ?? 0, height: box?.height ?? 0, opacity: indicator.ready ? 1 : 0 }
            : { x: box?.x ?? 0, width: box?.width ?? 0, opacity: indicator.ready ? 1 : 0 }
        }
        transition={reduce || !indicator.animate ? { duration: 0 } : tween(nxtDuration.spatial, nxtEase.standard)}
        aria-hidden="true"
      />
      {children}
    </RadixTabs.List>
  )
}

function TabsTrigger({ className, children, value, ...props }: TabsTriggerProps) {
  return (
    <RadixTabs.Trigger
      className={[styles.tabsTrigger, className].filter(Boolean).join(' ')}
      value={value}
      data-nxt-tabs-value={value}
      {...props}
    >
      <span className={styles.tabsLabel}>{children}</span>
    </RadixTabs.Trigger>
  )
}

function TabsContent({ className, ...props }: TabsContentProps) {
  return <RadixTabs.Content className={[styles.tabsContent, className].filter(Boolean).join(' ')} {...props} />
}

export const Tabs = {
  Root: TabsRoot,
  List: TabsList,
  Trigger: TabsTrigger,
  Content: TabsContent,
}

type DropdownMenuRootProps = ComponentPropsWithoutRef<typeof RadixDropdownMenu.Root>
type DropdownMenuContentProps = ComponentPropsWithoutRef<typeof RadixDropdownMenu.Content>
type DropdownMenuItemProps = ComponentPropsWithoutRef<typeof RadixDropdownMenu.Item>

const MenuOpenContext = createContext(false)

function DropdownMenuRoot(props: DropdownMenuRootProps) {
  const { children, open: openProp, defaultOpen = false, ...rest } = props
  const [uncontrolled, setUncontrolled] = useState(defaultOpen)
  const open = openProp ?? uncontrolled
  return (
    <RadixDropdownMenu.Root
      {...rest}
      open={open}
      onOpenChange={(next) => {
        if (openProp === undefined) setUncontrolled(next)
        props.onOpenChange?.(next)
      }}
    >
      <MenuOpenContext.Provider value={open}>{children}</MenuOpenContext.Provider>
    </RadixDropdownMenu.Root>
  )
}

const DropdownMenuContent = forwardRef<ElementRef<typeof RadixDropdownMenu.Content>, DropdownMenuContentProps>(
  function DropdownMenuContent({ className, sideOffset = 6, children, ...props }, ref) {
    const reduce = useNxtReducedMotion()
    const open = useContext(MenuOpenContext)
    const floatingLayer = useFloatingLayer()
    return (
      <AnimatePresence>
        {open ? (
          <RadixDropdownMenu.Portal forceMount key="menu">
            <RadixDropdownMenu.Content
              ref={ref}
              forceMount
              className={[styles.dropdownMenuContent, className].filter(Boolean).join(' ')}
              sideOffset={sideOffset}
              style={{ zIndex: floatingLayer }}
              {...props}
            >
              <motion.div
                variants={popoverVariants}
                initial={reduce ? false : 'hidden'}
                animate="visible"
                exit={reduce ? { opacity: 1, scale: 1, transition: { duration: 0 } } : 'exit'}
                style={{ transformOrigin: 'inherit' }}
              >
                {children}
              </motion.div>
            </RadixDropdownMenu.Content>
          </RadixDropdownMenu.Portal>
        ) : null}
      </AnimatePresence>
    )
  },
)

const DropdownMenuItem = forwardRef<ElementRef<typeof RadixDropdownMenu.Item>, DropdownMenuItemProps>(
  function DropdownMenuItem({ className, ...props }, ref) {
    return (
      <RadixDropdownMenu.Item
        ref={ref}
        className={[styles.dropdownMenuItem, className].filter(Boolean).join(' ')}
        {...props}
      />
    )
  },
)

export const DropdownMenu = {
  Root: DropdownMenuRoot,
  Trigger: RadixDropdownMenu.Trigger,
  Content: DropdownMenuContent,
  Item: DropdownMenuItem,
  Label: RadixDropdownMenu.Label,
  Separator: RadixDropdownMenu.Separator,
}

type TooltipRootProps = ComponentPropsWithoutRef<typeof RadixTooltip.Root>
type TooltipContentProps = ComponentPropsWithoutRef<typeof RadixTooltip.Content>
type TooltipPortalProps = ComponentPropsWithoutRef<typeof RadixTooltip.Portal>

const TooltipOpenContext = createContext(false)

function TooltipRoot(props: TooltipRootProps) {
  const { children, open: openProp, defaultOpen = false, ...rest } = props
  const [uncontrolled, setUncontrolled] = useState(defaultOpen)
  const open = openProp ?? uncontrolled
  return (
    <RadixTooltip.Root
      {...rest}
      open={open}
      onOpenChange={(next) => {
        if (openProp === undefined) setUncontrolled(next)
        props.onOpenChange?.(next)
      }}
    >
      <TooltipOpenContext.Provider value={open}>{children}</TooltipOpenContext.Provider>
    </RadixTooltip.Root>
  )
}

function TooltipPortal({ children, ...props }: TooltipPortalProps) {
  const open = useContext(TooltipOpenContext)
  return (
    <AnimatePresence>
      {open ? (
        <RadixTooltip.Portal forceMount key="tooltip" {...props}>
          {children}
        </RadixTooltip.Portal>
      ) : null}
    </AnimatePresence>
  )
}

const TooltipContent = forwardRef<ElementRef<typeof RadixTooltip.Content>, TooltipContentProps>(function TooltipContent(
  { className, children, sideOffset = 6, side = 'top', align = 'center', alignOffset, collisionPadding },
  ref,
) {
  const reduce = useNxtReducedMotion()
  const floatingLayer = useFloatingLayer()
  return (
    <MotionTooltipContent
      ref={ref}
      forceMount
      side={side}
      align={align}
      {...(alignOffset === undefined ? {} : { alignOffset })}
      {...(collisionPadding === undefined ? {} : { collisionPadding })}
      sideOffset={sideOffset}
      className={[styles.tooltipContent, className].filter(Boolean).join(' ')}
      data-nxt-floating-layer={floatingLayer}
      variants={tooltipVariants}
      initial={reduce ? false : 'hidden'}
      animate="visible"
      exit={reduce ? { opacity: 1, y: 0, transition: { duration: 0 } } : 'exit'}
      style={{ zIndex: floatingLayer }}
    >
      {children}
    </MotionTooltipContent>
  )
})

export const Tooltip = {
  Provider: RadixTooltip.Provider,
  Root: TooltipRoot,
  Trigger: RadixTooltip.Trigger,
  Portal: TooltipPortal,
  Content: TooltipContent,
  Arrow: RadixTooltip.Arrow,
}
