import * as RadixSelect from '@radix-ui/react-select'
import * as RadixSwitch from '@radix-ui/react-switch'
import { Check, ChevronDown } from 'lucide-react'
import {
  cloneElement,
  forwardRef,
  isValidElement,
  useId,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type ButtonHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'
import { InfoTip } from './overlay.js'
import styles from './form.module.css'

/** Label, control, hint and error with consistent spacing. The single child receives the generated id. */
export function Field({
  label,
  hint,
  tip,
  error,
  children,
  className,
}: {
  readonly label: ReactNode
  /** Always visible under the control; keep it short. */
  readonly hint?: ReactNode
  /** Background the user needs once, behind the help mark beside the label. */
  readonly tip?: ReactNode
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
      {tip ? (
        <span className={styles.labelLine}>
          <label className={styles.label} htmlFor={children.props.id ?? id}>
            {label}
          </label>
          <InfoTip label={typeof label === 'string' ? label : '说明'}>{tip}</InfoTip>
        </span>
      ) : (
        <label className={styles.label} htmlFor={children.props.id ?? id}>
          {label}
        </label>
      )}
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

// Radix reserves the empty value for "nothing selected"; an option whose value is '' travels under this key instead.
const EMPTY = '\u0000empty'
const toKey = (value: string) => (value === '' ? EMPTY : value)
const fromKey = (key: string) => (key === EMPTY ? '' : key)

/** Single choice from a short list, drawn with the product's own popup instead of the browser's. */
export const Select = forwardRef<
  HTMLButtonElement,
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'value' | 'defaultValue' | 'onChange' | 'children'> & {
    readonly options: readonly SelectOption[]
    readonly value?: string | undefined
    readonly defaultValue?: string | undefined
    readonly onValueChange?: (value: string) => void
    readonly placeholder?: string
    readonly name?: string
    readonly required?: boolean
  }
>(function Select(
  { className, options, placeholder, value, defaultValue, onValueChange, name, required, disabled, ...trigger },
  ref,
) {
  // An unknown value would render as blank; show the placeholder instead.
  const known = (candidate: string | undefined) =>
    candidate !== undefined && options.some((option) => option.value === candidate) ? toKey(candidate) : undefined
  const controlled = value === undefined ? {} : { value: known(value) ?? '' }
  const selected = value === undefined ? undefined : options.find((option) => option.value === value)
  const initial = defaultValue === undefined ? {} : { defaultValue: known(defaultValue) ?? '' }
  return (
    <RadixSelect.Root
      {...controlled}
      {...initial}
      {...(onValueChange ? { onValueChange: (key: string) => onValueChange(fromKey(key)) } : {})}
      {...(name === undefined ? {} : { name })}
      {...(required === undefined ? {} : { required })}
      {...(disabled === undefined ? {} : { disabled })}
    >
      <RadixSelect.Trigger
        ref={ref}
        className={[styles.control, styles.select, className ?? ''].join(' ')}
        {...trigger}
      >
        {/* The chosen label is rendered here, so it shows on the first paint instead of after the list mounts. */}
        <span className={styles.selectValue}>
          <RadixSelect.Value placeholder={placeholder ?? '请选择'}>{selected?.label}</RadixSelect.Value>
        </span>
        <RadixSelect.Icon className={styles.selectIcon}>
          <ChevronDown aria-hidden="true" />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content className={styles.selectContent} position="popper" sideOffset={4} collisionPadding={12}>
          <RadixSelect.Viewport className={styles.selectViewport}>
            {options.map((option) => (
              <RadixSelect.Item
                key={option.value}
                value={toKey(option.value)}
                disabled={option.disabled ?? false}
                className={styles.selectItem}
              >
                <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
                <RadixSelect.ItemIndicator className={styles.selectCheck}>
                  <Check aria-hidden="true" />
                </RadixSelect.ItemIndicator>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
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
  tip,
  checked,
  onCheckedChange,
  disabled,
  trailing,
}: {
  readonly title: ReactNode
  readonly description?: ReactNode
  /** Background the user needs once, behind the help mark beside the title. */
  readonly tip?: ReactNode
  readonly checked: boolean
  readonly onCheckedChange: (checked: boolean) => void
  readonly disabled?: boolean | undefined
  readonly trailing?: ReactNode
}) {
  const id = useId()
  return (
    <div className={styles.switchRow}>
      <div className={styles.switchText}>
        <span className={styles.labelLine}>
          <label className={styles.switchTitle} htmlFor={id}>
            {title}
          </label>
          {tip ? <InfoTip label={typeof title === 'string' ? title : '说明'}>{tip}</InfoTip> : null}
        </span>
        {description ? <span className={styles.hint}>{description}</span> : null}
      </div>
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
