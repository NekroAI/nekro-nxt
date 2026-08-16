import * as Dialog from '@radix-ui/react-dialog'
import * as Select from '@radix-ui/react-select'
import * as Switch from '@radix-ui/react-switch'
import * as Tooltip from '@radix-ui/react-tooltip'
import { Check, ChevronDown, X } from 'lucide-react'
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react'
import styles from './ui.module.css'

export type StatusTone = 'neutral' | 'success' | 'warning' | 'error' | 'info' | 'unknown'

export function Button({
  variant = 'secondary',
  size = 'normal',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  readonly size?: 'normal' | 'small'
}) {
  return (
    <button
      className={[styles.button, styles[variant], size === 'small' ? styles.small : '', className]
        .filter(Boolean)
        .join(' ')}
      {...props}
    />
  )
}

export function IconButton({
  label,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly label: string
  readonly children: ReactNode
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button className={styles.iconButton} aria-label={label} {...props}>
          {children}
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className={styles.tooltipContent} sideOffset={6}>
          {label}
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

export function Field({
  label,
  hint,
  children,
}: {
  readonly label: string
  readonly hint?: string
  readonly children: ReactNode
}) {
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      {children}
      {hint ? <span className={styles.fieldHint}>{hint}</span> : null}
    </label>
  )
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={styles.input} {...props} />
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={styles.textarea} {...props} />
}

export function SwitchField({
  label,
  description,
  checked,
  onCheckedChange,
}: {
  readonly label: string
  readonly description: string
  readonly checked: boolean
  readonly onCheckedChange: (checked: boolean) => void
}) {
  return (
    <div className={styles.switchRow}>
      <div className={styles.switchCopy}>
        <div className={styles.switchLabel}>{label}</div>
        <div className={styles.switchDescription}>{description}</div>
      </div>
      <Switch.Root className={styles.switchRoot} checked={checked} onCheckedChange={onCheckedChange}>
        <Switch.Thumb className={styles.switchThumb} />
      </Switch.Root>
    </div>
  )
}

export function SelectField({
  value,
  onValueChange,
  options,
  label,
}: {
  readonly value: string
  readonly onValueChange: (value: string) => void
  readonly options: readonly { readonly value: string; readonly label: string }[]
  readonly label: string
}) {
  return (
    <Field label={label}>
      <Select.Root value={value} onValueChange={onValueChange}>
        <Select.Trigger className={styles.selectTrigger}>
          <Select.Value />
          <Select.Icon>
            <ChevronDown size={14} />
          </Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Content className={styles.selectContent} position="popper" sideOffset={5}>
            <Select.Viewport>
              {options.map((option) => (
                <Select.Item className={styles.selectItem} value={option.value} key={option.value}>
                  <Select.ItemText>{option.label}</Select.ItemText>
                  <Select.ItemIndicator>
                    <Check size={13} />
                  </Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.Viewport>
          </Select.Content>
        </Select.Portal>
      </Select.Root>
    </Field>
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
  readonly onConfirm: () => void
  readonly children?: ReactNode
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.dialogOverlay} />
        <Dialog.Content className={styles.dialogContent}>
          <Dialog.Title className={styles.dialogTitle}>{title}</Dialog.Title>
          <Dialog.Description className={styles.dialogDescription}>{description}</Dialog.Description>
          {children}
          <div className={styles.dialogActions}>
            <Dialog.Close asChild>
              <Button variant="ghost">
                <X size={14} /> 取消
              </Button>
            </Dialog.Close>
            <Button
              variant="primary"
              onClick={() => {
                onConfirm()
                onOpenChange(false)
              }}
            >
              {confirmLabel}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export { Tooltip }
