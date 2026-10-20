import type { CredentialView } from '@nekro-nxt/contracts'
import { Select } from '../ui-kit/index.js'

/** Where a secret field takes its value from. */
export type SecretSource =
  { readonly kind: 'unset' } | { readonly kind: 'credential'; readonly id: string } | { readonly kind: 'private' }

const UNSET = '__unset__'
const PRIVATE = '__private__'
const NEW = '__new__'

/**
 * Chooses the named credential a secret field uses. `usable` filters the credentials that may be bound here; one
 * bound earlier but no longer usable stays listed under its name. `allowPrivate` offers a value typed only for this
 * field. Picking 「新建凭据」 calls `onCreate`, which binds the new credential once it exists.
 */
export function CredentialPicker({
  id,
  label,
  value,
  credentials,
  usable = () => true,
  allowPrivate = false,
  privateLabel = '单独填写',
  allowUnset = true,
  disabled = false,
  onChange,
  onCreate,
  ...aria
}: {
  readonly id?: string | undefined
  readonly label: string
  readonly value: SecretSource
  readonly credentials: readonly CredentialView[]
  readonly usable?: (credential: CredentialView) => boolean
  readonly allowPrivate?: boolean
  readonly privateLabel?: string
  readonly allowUnset?: boolean
  readonly disabled?: boolean
  readonly className?: string | undefined
  readonly onChange: (source: SecretSource) => void
  readonly onCreate?: (() => void) | undefined
  readonly 'aria-describedby'?: string | undefined
  readonly 'aria-invalid'?: boolean | undefined
}) {
  const listed = credentials.filter(usable)
  const bound = value.kind === 'credential' ? value.id : undefined
  const stale =
    bound === undefined || listed.some((credential) => credential.id === bound)
      ? []
      : [
          {
            value: bound,
            label: credentials.find((credential) => credential.id === bound)?.name ?? '已删除的凭据',
          },
        ]
  const options = [
    ...(allowUnset ? [{ value: UNSET, label: '不设置' }] : []),
    ...listed.map((credential) => ({ value: credential.id, label: credential.name })),
    ...stale,
    ...(allowPrivate ? [{ value: PRIVATE, label: privateLabel }] : []),
    ...(onCreate === undefined ? [] : [{ value: NEW, label: '新建凭据' }]),
  ]
  const current = value.kind === 'credential' ? value.id : value.kind === 'private' ? PRIVATE : undefined
  return (
    <Select
      id={id}
      aria-label={label}
      {...aria}
      disabled={disabled}
      placeholder="选择凭据"
      value={current ?? ''}
      options={options}
      onValueChange={(next) => {
        if (next === NEW) onCreate?.()
        else if (next === UNSET) onChange({ kind: 'unset' })
        else if (next === PRIVATE) onChange({ kind: 'private' })
        else onChange({ kind: 'credential', id: next })
      }}
    />
  )
}
