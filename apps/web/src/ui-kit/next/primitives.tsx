import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { LoaderCircle } from 'lucide-react'
import styles from './primitives.module.css'

export type Tone = 'neutral' | 'ok' | 'warn' | 'bad' | 'accent'

const cx = (...names: readonly (string | false | undefined)[]): string => names.filter(Boolean).join(' ')

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: 'default' | 'primary' | 'ghost' | 'danger' | 'danger-solid'
  readonly size?: 'default' | 'small'
  readonly icon?: ReactNode
  readonly busy?: boolean
}

const variantClass = {
  default: undefined,
  primary: styles.primary,
  ghost: styles.ghost,
  danger: styles.danger,
  'danger-solid': styles.dangerSolid,
} as const

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'default', size = 'default', icon, busy = false, className, children, disabled, type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(styles.button, variantClass[variant], size === 'small' && styles.small, className)}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...props}
    >
      {busy ? <Spinner /> : icon}
      {children}
    </button>
  )
})

export interface IconButtonProps extends Omit<ButtonProps, 'icon' | 'children'> {
  readonly label: string
  readonly children: ReactNode
}

/** Icon-only control. `label` is the accessible name and the native tooltip. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, variant = 'ghost', size = 'default', className, children, title, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={title ?? label}
      className={cx(styles.button, styles.icon, variantClass[variant], size === 'small' && styles.small, className)}
      {...props}
    >
      {children}
    </button>
  )
})

const toneClass: Record<Tone, string | undefined> = {
  neutral: undefined,
  ok: styles.ok,
  warn: styles.warn,
  bad: styles.bad,
  accent: styles.accent,
}

export function Chip({
  tone = 'neutral',
  dot = false,
  icon,
  children,
  className,
}: {
  readonly tone?: Tone
  readonly dot?: boolean
  readonly icon?: ReactNode
  readonly children: ReactNode
  readonly className?: string
}) {
  return (
    <span className={cx(styles.chip, toneClass[tone], className)}>
      {dot ? <i className={styles.chipDot} aria-hidden="true" /> : icon}
      {children}
    </span>
  )
}

export function StatusDot({ tone = 'neutral', pulse = false, label }: { readonly tone?: Tone; readonly pulse?: boolean; readonly label?: string }) {
  return (
    <i
      className={cx(styles.dot, toneClass[tone], pulse && styles.ping)}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  )
}

export function Kbd({ children }: { readonly children: ReactNode }) {
  return <kbd className={styles.kbd}>{children}</kbd>
}

export function Spinner({ className }: { readonly className?: string }) {
  return <LoaderCircle className={cx(styles.spinner, className)} aria-hidden="true" />
}
