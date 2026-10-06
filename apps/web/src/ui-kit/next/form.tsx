import * as RadixSwitch from '@radix-ui/react-switch'
import {
  cloneElement,
  forwardRef,
  isValidElement,
  useId,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'
import styles from './form.module.css'

/** Label, control, hint and error with consistent spacing. The single child receives the generated id. */
export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  readonly label: ReactNode
  readonly hint?: ReactNode
  readonly error?: ReactNode
  readonly children: ReactElement<{
    id?: string | undefined
    'aria-describedby'?: string | undefined
    'aria-invalid'?: boolean | undefined
  }>
  readonly className?: string
}) {
  const id = useId()
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined
  const extra: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean } = { id: children.props.id ?? id }
  if (describedBy) extra['aria-describedby'] = describedBy
  if (error) extra['aria-invalid'] = true
  const control = isValidElement(children) ? cloneElement(children, extra) : children
  return (
    <div className={[styles.field, className ?? ''].join(' ')}>
      <label className={styles.label} htmlFor={children.props.id ?? id}>
        {label}
      </label>
      {control}
      {error ? (
        <span id={`${id}-error`} className={styles.error} role="alert">
          {error}
        </span>
      ) : hint ? (
        <span id={`${id}-hint`} className={styles.hint}>
          {hint}
        </span>
      ) : null}
    </div>
  )
}

/** `bare` drops the field chrome for inputs embedded in a custom surface (search bars, composers). */
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { readonly bare?: boolean }>(
  function Input({ className, bare = false, ...props }, ref) {
    return <input ref={ref} className={[bare ? '' : styles.control, className ?? ''].join(' ')} {...props} />
  },
)

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement> & { readonly bare?: boolean }
>(function Textarea({ className, bare = false, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={[bare ? '' : `${styles.control} ${styles.textarea}`, className ?? ''].join(' ')}
      {...props}
    />
  )
})

/** Hidden file chooser; open it with `ref.current?.click()` from any trigger. The value resets after each pick. */
export const FileChooser = forwardRef<
  HTMLInputElement,
  { readonly accept?: string; readonly onFile: (file: File) => void }
>(function FileChooser({ accept, onFile }, ref) {
  return (
    <input
      ref={ref}
      type="file"
      hidden
      accept={accept}
      onChange={(event) => {
        const file = event.currentTarget.files?.[0]
        event.currentTarget.value = ''
        if (file) onFile(file)
      }}
    />
  )
})

export interface SelectOption {
  readonly value: string
  readonly label: string
  readonly disabled?: boolean
}

export const Select = forwardRef<
  HTMLSelectElement,
  Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'> & {
    readonly options: readonly SelectOption[]
    readonly placeholder?: string
  }
>(function Select({ className, options, placeholder, ...props }, ref) {
  return (
    <select ref={ref} className={[styles.control, styles.select, className ?? ''].join(' ')} {...props}>
      {placeholder !== undefined ? (
        <option value="" disabled>
          {placeholder}
        </option>
      ) : null}
      {options.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
    </select>
  )
})

export function Switch({
  checked,
  onCheckedChange,
  label,
  disabled,
  id,
}: {
  readonly checked: boolean
  readonly onCheckedChange: (checked: boolean) => void
  readonly label: string
  readonly disabled?: boolean | undefined
  readonly id?: string | undefined
}) {
  return (
    <RadixSwitch.Root
      id={id}
      className={styles.switch}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={label}
    >
      <RadixSwitch.Thumb className={styles.thumb} />
    </RadixSwitch.Root>
  )
}

/** A labelled switch with optional description; the whole row is the hit target via the label. */
export function SwitchRow({
  title,
  description,
  checked,
  onCheckedChange,
  disabled,
  trailing,
}: {
  readonly title: ReactNode
  readonly description?: ReactNode
  readonly checked: boolean
  readonly onCheckedChange: (checked: boolean) => void
  readonly disabled?: boolean | undefined
  readonly trailing?: ReactNode
}) {
  const id = useId()
  return (
    <div className={styles.switchRow}>
      <label className={styles.switchText} htmlFor={id}>
        <span className={styles.switchTitle}>{title}</span>
        {description ? <span className={styles.hint}>{description}</span> : null}
      </label>
      {trailing}
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        label={typeof title === 'string' ? title : '开关'}
      />
    </div>
  )
}

/** Write-only secret: never shows the stored value, only whether one exists. Empty input keeps the stored secret. */
export const SecretInput = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { readonly configured: boolean }
>(function SecretInput({ configured, placeholder, className, ...props }, ref) {
  return (
    <div className={styles.secret}>
      <input
        ref={ref}
        type="password"
        autoComplete="off"
        placeholder={placeholder ?? (configured ? '已保存，留空则不修改' : '')}
        className={[styles.control, className ?? ''].join(' ')}
        {...props}
      />
      {configured ? <span className={styles.secretState}>已配置</span> : null}
    </div>
  )
})
