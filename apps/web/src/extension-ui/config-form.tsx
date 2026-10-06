import {
  configFields,
  configSecretKeys,
  parseJsonValue,
  validateConfigValue,
  type ConfigField,
  type ConfigSchemaDocument,
  type ConfigValidationIssue,
  type JsonValue,
} from '@nekro-nxt/contracts'
import { ChevronDown } from 'lucide-react'
import { useId, useMemo, useState, type ReactNode } from 'react'
import { Disclosure, Field, Input, Pressable, SecretInput, Select, SwitchRow, Textarea } from '../ui-kit/next/index.js'
import styles from './config-form.module.css'

export type ConfigValue = Readonly<Record<string, JsonValue>>

/** Declared defaults of the non-secret fields; the starting value of a new configuration. */
export const configDefaults = (schema: ConfigSchemaDocument): ConfigValue =>
  Object.fromEntries(
    configFields(schema).flatMap((field) =>
      field.kind === 'secret' || field.default === undefined ? [] : [[field.key, field.default] as const],
    ),
  )

/** Validation issues of a draft, keyed by top-level field; secrets are validated separately by `secretIssues`. */
export const configIssues = (schema: ConfigSchemaDocument, value: ConfigValue): Readonly<Record<string, string>> => {
  const result = validateConfigValue(schema, value, { skipKeys: configSecretKeys(schema) })
  return issuesByField(result.issues)
}

const issuesByField = (issues: readonly ConfigValidationIssue[]): Readonly<Record<string, string>> => {
  const byField: Record<string, string> = {}
  for (const issue of issues) {
    const key = issue.path.split(/[.[]/u)[0] ?? ''
    byField[key] ??= issue.message
  }
  return byField
}

/** Required secrets left empty; `configured` lists secrets the Host already stores. */
export const secretIssues = (
  schema: ConfigSchemaDocument,
  secrets: Readonly<Record<string, string>>,
  configured: ReadonlySet<string> = new Set(),
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    configFields(schema)
      .filter(
        (field) =>
          field.kind === 'secret' && field.required && !configured.has(field.key) && !secrets[field.key]?.trim(),
      )
      .map((field) => [field.key, `请填写${field.title}。`]),
  )

export interface ConfigFormProps {
  readonly schema: ConfigSchemaDocument
  /** Non-secret values. */
  readonly value: ConfigValue
  readonly onChange: (value: ConfigValue) => void
  /** Write-only secret drafts; omit to hide secret fields (e.g. when only editing public settings). */
  readonly secrets?: {
    readonly value: Readonly<Record<string, string>>
    readonly onChange: (value: Readonly<Record<string, string>>) => void
    /** Secrets already stored by the Host: shown as configured, an empty draft keeps them. */
    readonly configured?: ReadonlySet<string>
  }
  /** Show validation messages (typically after the first submit attempt). */
  readonly showIssues?: boolean
  readonly disabled?: boolean
}

const visible = (field: ConfigField, value: ConfigValue): boolean => {
  const condition = field.node.meta?.visibleWhen
  return condition === undefined || JSON.stringify(value[condition.key]) === JSON.stringify(condition.equals)
}

/**
 * The single configuration form (Decision §6): renders serialized Schemastery for Adapter connections and extension
 * configuration alike. Fields keep schema order within their group; `advanced` fields start collapsed; secrets are
 * write-only and never echo a stored value.
 */
export function ConfigForm({
  schema,
  value,
  onChange,
  secrets,
  showIssues = false,
  disabled = false,
}: ConfigFormProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const advancedId = useId()
  const fields = useMemo(() => configFields(schema), [schema])
  const issues = useMemo(
    () =>
      showIssues
        ? {
            ...configIssues(schema, value),
            ...(secrets ? secretIssues(schema, secrets.value, secrets.configured) : {}),
          }
        : {},
    [schema, secrets, showIssues, value],
  )
  const shown = fields.filter((field) => (field.kind !== 'secret' || secrets !== undefined) && visible(field, value))
  const render = (field: ConfigField) => (
    <ConfigFieldControl
      key={field.key}
      field={field}
      value={value[field.key]}
      secret={secrets?.value[field.key] ?? ''}
      configured={secrets?.configured?.has(field.key) ?? false}
      error={issues[field.key]}
      disabled={disabled}
      onValue={(next) => {
        const copy: Record<string, JsonValue> = { ...value }
        if (next === undefined) delete copy[field.key]
        else copy[field.key] = next
        onChange(copy)
      }}
      onSecret={(next) => secrets?.onChange({ ...secrets.value, [field.key]: next })}
    />
  )
  const groups = new Map<string, ConfigField[]>()
  for (const field of shown.filter((candidate) => !candidate.advanced)) {
    const group = groups.get(field.group ?? '') ?? []
    group.push(field)
    groups.set(field.group ?? '', group)
  }
  const advanced = shown.filter((field) => field.advanced)
  // An error inside the collapsed section must be visible.
  const advancedHasIssue = advanced.some((field) => issues[field.key] !== undefined)
  return (
    <div className={styles.form} data-config-form="">
      {[...groups].map(([group, members]) => (
        <fieldset key={group || 'default'} className={styles.group} disabled={disabled}>
          {group ? <legend className={styles.legend}>{group}</legend> : null}
          {members.map(render)}
        </fieldset>
      ))}
      {advanced.length > 0 ? (
        <div className={styles.advanced}>
          <Pressable
            className={styles.advancedToggle}
            aria-expanded={advancedOpen || advancedHasIssue}
            aria-controls={advancedId}
            onClick={() => setAdvancedOpen((open) => !open)}
          >
            <ChevronDown size={14} aria-hidden="true" />
            高级设置
          </Pressable>
          <Disclosure open={advancedOpen || advancedHasIssue} id={advancedId}>
            <fieldset className={styles.group} disabled={disabled}>
              {advanced.map(render)}
            </fieldset>
          </Disclosure>
        </div>
      ) : null}
    </div>
  )
}

function ConfigFieldControl({
  field,
  value,
  secret,
  configured,
  error,
  disabled,
  onValue,
  onSecret,
}: {
  readonly field: ConfigField
  readonly value: JsonValue | undefined
  readonly secret: string
  readonly configured: boolean
  readonly error: string | undefined
  readonly disabled: boolean
  readonly onValue: (value: JsonValue | undefined) => void
  readonly onSecret: (value: string) => void
}): ReactNode {
  const label = field.required ? `${field.title} *` : field.title
  const current = value ?? field.default
  switch (field.kind) {
    case 'boolean':
      return (
        <div className={styles.switch} data-invalid={error !== undefined}>
          <SwitchRow
            title={field.title}
            description={error ?? field.hint}
            checked={current === true}
            disabled={disabled}
            onCheckedChange={(checked) => onValue(checked)}
          />
        </div>
      )
    case 'secret':
      return (
        <Field label={label} hint={field.hint} error={error}>
          <SecretInput
            configured={configured}
            value={secret}
            autoComplete="off"
            disabled={disabled}
            onChange={(event) => onSecret(event.target.value)}
          />
        </Field>
      )
    case 'enum': {
      const options = field.options ?? []
      const index = options.findIndex((option) => JSON.stringify(option.value) === JSON.stringify(current))
      return (
        <Field label={label} hint={field.hint} error={error}>
          <Select
            value={index < 0 ? '' : String(index)}
            disabled={disabled}
            placeholder="请选择"
            options={options.map((option, position) => ({ value: String(position), label: option.label }))}
            onChange={(event) => onValue(options[Number(event.target.value)]?.value)}
          />
        </Field>
      )
    }
    case 'number': {
      const integer = field.node.type === 'natural'
      return (
        <Field label={label} hint={field.hint} error={error}>
          <Input
            type="number"
            inputMode={integer ? 'numeric' : 'decimal'}
            step={field.node.meta?.step ?? (integer ? 1 : 'any')}
            min={field.node.meta?.min}
            max={field.node.meta?.max}
            value={typeof current === 'number' ? String(current) : ''}
            disabled={disabled}
            onChange={(event) => {
              const raw = event.target.value
              if (raw.trim() === '') onValue(undefined)
              else onValue(Number(raw))
            }}
          />
        </Field>
      )
    }
    case 'array':
      return (
        <Field label={label} hint={field.hint ?? '每行一项'} error={error}>
          <Textarea
            rows={3}
            disabled={disabled}
            value={
              Array.isArray(current)
                ? current.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join('\n')
                : ''
            }
            onChange={(event) => {
              const inner = field.node.type === 'array' ? field.node.inner.type : 'string'
              const numeric = inner === 'number' || inner === 'natural' || inner === 'percent'
              const items = event.target.value
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean)
              onValue(numeric ? items.map(Number) : items)
            }}
          />
        </Field>
      )
    case 'object':
      return (
        <Field label={label} hint={field.hint ?? 'JSON 对象'} error={error}>
          <Textarea
            rows={4}
            spellCheck={false}
            disabled={disabled}
            defaultValue={current === undefined ? '' : JSON.stringify(current, null, 2)}
            onBlur={(event) => {
              const raw = event.target.value.trim()
              if (!raw) return onValue(undefined)
              try {
                onValue(parseJsonValue(JSON.parse(raw)))
              } catch {
                onValue(raw)
              }
            }}
          />
        </Field>
      )
    case 'string':
      return (
        <Field label={label} hint={field.hint} error={error}>
          {field.node.meta?.role === 'textarea' ? (
            <Textarea
              rows={4}
              disabled={disabled}
              value={typeof current === 'string' ? current : ''}
              onChange={(event) => onValue(event.target.value)}
            />
          ) : (
            <Input
              spellCheck={false}
              disabled={disabled}
              value={typeof current === 'string' ? current : ''}
              onChange={(event) => onValue(event.target.value)}
            />
          )}
        </Field>
      )
  }
}
