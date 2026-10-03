import { z } from 'zod'
import { JsonValueSchema, type JsonValue } from './domain.js'

/**
 * The single configuration format: serialized Schemastery (`Schema.toJSON()`), restricted to the subset the
 * product form can render and the Host can validate without executing Schema callbacks.
 *
 * Supported nodes: object (dict), string, number, natural, percent, boolean, const, union of consts (enum) and
 * array of primitives. `meta.role: 'secret'` marks a write-only credential. NekroNXT reads three extra meta keys:
 * `hint` (help text), `advanced` (collapsed by default) and `visibleWhen` (show only when a sibling equals a value).
 */
export const CONFIG_SCHEMA_MAX_BYTES = 64 * 1024

const DescriptionSchema = z.union([z.string(), z.record(z.string(), z.string())])

export const ConfigSchemaMetaSchema = z
  .object({
    description: DescriptionSchema.optional(),
    hint: z.string().max(500).optional(),
    required: z.boolean().optional(),
    default: JsonValueSchema.optional(),
    role: z.string().max(32).optional(),
    hidden: z.boolean().optional(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    step: z.number().finite().positive().optional(),
    pattern: z.object({ source: z.string().max(500), flags: z.string().max(8).optional() }).optional(),
    advanced: z.boolean().optional(),
    group: z.string().max(40).optional(),
    visibleWhen: z
      .object({ key: z.string().min(1).max(64), equals: JsonValueSchema })
      .strict()
      .optional(),
  })
  .loose()

export type ConfigSchemaMeta = z.output<typeof ConfigSchemaMetaSchema>

export type ConfigSchemaNode =
  | {
      readonly type: 'object'
      readonly dict: Readonly<Record<string, ConfigSchemaNode>>
      readonly meta?: ConfigSchemaMeta | undefined
    }
  | {
      readonly type: 'string' | 'number' | 'natural' | 'percent' | 'boolean'
      readonly meta?: ConfigSchemaMeta | undefined
    }
  | { readonly type: 'const'; readonly value: JsonValue; readonly meta?: ConfigSchemaMeta | undefined }
  | { readonly type: 'union'; readonly list: readonly ConfigSchemaNode[]; readonly meta?: ConfigSchemaMeta | undefined }
  | { readonly type: 'array'; readonly inner: ConfigSchemaNode; readonly meta?: ConfigSchemaMeta | undefined }

const SAFE_KEY = /^(?!__proto__$|prototype$|constructor$)[A-Za-z_$][\w$-]{0,63}$/u

export const ConfigSchemaNodeSchema: z.ZodType<ConfigSchemaNode> = z.lazy(() =>
  z.union([
    z
      .object({
        type: z.literal('object'),
        dict: z.record(z.string().regex(SAFE_KEY), ConfigSchemaNodeSchema),
        meta: ConfigSchemaMetaSchema.optional(),
      })
      .loose(),
    z
      .object({
        type: z.enum(['string', 'number', 'natural', 'percent', 'boolean']),
        meta: ConfigSchemaMetaSchema.optional(),
      })
      .loose(),
    z.object({ type: z.literal('const'), value: JsonValueSchema, meta: ConfigSchemaMetaSchema.optional() }).loose(),
    z
      .object({
        type: z.literal('union'),
        list: z.array(ConfigSchemaNodeSchema).min(1).max(64),
        meta: ConfigSchemaMetaSchema.optional(),
      })
      .loose(),
    z
      .object({ type: z.literal('array'), inner: ConfigSchemaNodeSchema, meta: ConfigSchemaMetaSchema.optional() })
      .loose(),
  ]),
)

/** A whole configuration document: always an object at the root. */
export const ConfigSchemaDocumentSchema = ConfigSchemaNodeSchema.refine(
  (node) => node.type === 'object',
  '配置 Schema 的根节点必须是 object。',
).refine((node) => new TextEncoder().encode(JSON.stringify(node)).length <= CONFIG_SCHEMA_MAX_BYTES, {
  message: `配置 Schema 不能超过 ${CONFIG_SCHEMA_MAX_BYTES} 字节。`,
})

export type ConfigSchemaDocument = Extract<ConfigSchemaNode, { readonly type: 'object' }>

export const EMPTY_CONFIG_SCHEMA: ConfigSchemaDocument = { type: 'object', dict: {} }

export type ConfigFieldKind = 'string' | 'number' | 'boolean' | 'enum' | 'secret' | 'array' | 'object'

export interface ConfigField {
  readonly key: string
  readonly kind: ConfigFieldKind
  readonly title: string
  readonly hint?: string
  readonly required: boolean
  readonly default?: JsonValue
  readonly advanced: boolean
  readonly group?: string
  readonly options?: readonly { readonly value: JsonValue; readonly label: string }[]
  readonly node: ConfigSchemaNode
}

export const configDescription = (meta: ConfigSchemaMeta | undefined): string | undefined => {
  const description = meta?.description
  if (typeof description === 'string') return description
  if (description) return description['zh-CN'] ?? description['zh'] ?? Object.values(description)[0]
  return undefined
}

const isEnumUnion = (node: ConfigSchemaNode): node is Extract<ConfigSchemaNode, { readonly type: 'union' }> =>
  node.type === 'union' && node.list.every((option) => option.type === 'const')

export const configFieldKind = (node: ConfigSchemaNode): ConfigFieldKind => {
  if (node.meta?.role === 'secret') return 'secret'
  if (node.type === 'string') return 'string'
  if (node.type === 'number' || node.type === 'natural' || node.type === 'percent') return 'number'
  if (node.type === 'boolean') return 'boolean'
  if (node.type === 'array') return 'array'
  if (node.type === 'object') return 'object'
  if (node.type === 'const' || isEnumUnion(node)) return 'enum'
  throw new TypeError('配置 Schema 只支持常量组成的 union。')
}

/** Flattens the top level of a document into product form fields (order preserved). */
export const configFields = (document: ConfigSchemaDocument): readonly ConfigField[] =>
  Object.entries(document.dict).map(([key, node]) => {
    const kind = configFieldKind(node)
    const title = configDescription(node.meta) ?? key
    const options =
      node.type === 'union' && isEnumUnion(node)
        ? node.list.map((option) => ({
            value: option.type === 'const' ? option.value : null,
            label: configDescription(option.meta) ?? String(option.type === 'const' ? option.value : ''),
          }))
        : node.type === 'const'
          ? [{ value: node.value, label: configDescription(node.meta) ?? String(node.value) }]
          : undefined
    return {
      key,
      kind,
      title,
      ...(node.meta?.hint === undefined ? {} : { hint: node.meta.hint }),
      required: node.meta?.required === true,
      ...(node.meta?.default === undefined ? {} : { default: node.meta.default }),
      advanced: node.meta?.advanced === true,
      ...(node.meta?.group === undefined ? {} : { group: node.meta.group }),
      ...(options === undefined ? {} : { options }),
      node,
    }
  })

export const configSecretKeys = (document: ConfigSchemaDocument): readonly string[] =>
  configFields(document)
    .filter((field) => field.kind === 'secret')
    .map((field) => field.key)

export interface ConfigValidationIssue {
  readonly path: string
  readonly message: string
}

const isRecord = (value: unknown): value is Readonly<Record<string, JsonValue>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const sameJson = (left: JsonValue, right: JsonValue): boolean => JSON.stringify(left) === JSON.stringify(right)

const validateNode = (
  node: ConfigSchemaNode,
  value: JsonValue | undefined,
  path: string,
  label: string,
  issues: ConfigValidationIssue[],
): JsonValue | undefined => {
  const resolved = value ?? node.meta?.default
  if (resolved === undefined || resolved === null) {
    if (node.meta?.required === true) issues.push({ path, message: `请填写${label}。` })
    if (node.type === 'object') return validateNode(node, {}, path, label, issues)
    return undefined
  }
  switch (node.type) {
    case 'object': {
      if (!isRecord(resolved)) {
        issues.push({ path, message: `${label}必须是对象。` })
        return undefined
      }
      const output: Record<string, JsonValue> = {}
      for (const key of Object.keys(resolved)) {
        if (!Object.hasOwn(node.dict, key))
          issues.push({ path: path ? `${path}.${key}` : key, message: `未知配置项：${key}` })
      }
      for (const [key, child] of Object.entries(node.dict)) {
        const childPath = path ? `${path}.${key}` : key
        const next = validateNode(child, resolved[key], childPath, configDescription(child.meta) ?? key, issues)
        if (next !== undefined) output[key] = next
      }
      return output
    }
    case 'string': {
      if (typeof resolved !== 'string') {
        issues.push({ path, message: `${label}必须是文本。` })
        return undefined
      }
      if (node.meta?.required === true && resolved.trim().length === 0)
        issues.push({ path, message: `请填写${label}。` })
      const pattern = node.meta?.pattern
      if (pattern && resolved.length > 0 && !new RegExp(pattern.source, pattern.flags ?? '').test(resolved)) {
        issues.push({ path, message: `${label}的格式不正确。` })
      }
      return resolved
    }
    case 'number':
    case 'natural':
    case 'percent': {
      if (typeof resolved !== 'number' || !Number.isFinite(resolved)) {
        issues.push({ path, message: `${label}必须是数字。` })
        return undefined
      }
      if (node.type === 'natural' && (!Number.isInteger(resolved) || resolved < 0)) {
        issues.push({ path, message: `${label}必须是非负整数。` })
      }
      if (node.type === 'percent' && (resolved < 0 || resolved > 1))
        issues.push({ path, message: `${label}必须在 0 到 1 之间。` })
      if (node.meta?.min !== undefined && resolved < node.meta.min)
        issues.push({ path, message: `${label}不能小于 ${node.meta.min}。` })
      if (node.meta?.max !== undefined && resolved > node.meta.max)
        issues.push({ path, message: `${label}不能大于 ${node.meta.max}。` })
      return resolved
    }
    case 'boolean':
      if (typeof resolved !== 'boolean') {
        issues.push({ path, message: `${label}必须是开关值。` })
        return undefined
      }
      return resolved
    case 'const':
      if (!sameJson(resolved, node.value)) issues.push({ path, message: `${label}的取值无效。` })
      return resolved
    case 'union':
      if (!node.list.some((option) => option.type === 'const' && sameJson(option.value, resolved))) {
        issues.push({ path, message: `${label}的取值无效。` })
      }
      return resolved
    case 'array': {
      if (!Array.isArray(resolved)) {
        issues.push({ path, message: `${label}必须是列表。` })
        return undefined
      }
      return resolved.flatMap((item, index) => {
        const next = validateNode(node.inner, item, `${path}[${index}]`, `${label}第 ${index + 1} 项`, issues)
        return next === undefined ? [] : [next]
      })
    }
  }
}

/**
 * Validates a configuration value against a document and fills declared defaults. Secret fields are not part of the
 * stored value; callers pass them through the credential store instead.
 */
export const validateConfigValue = (
  document: ConfigSchemaDocument,
  value: JsonValue | undefined,
  options: { readonly skipKeys?: readonly string[] } = {},
): { readonly value: Readonly<Record<string, JsonValue>>; readonly issues: readonly ConfigValidationIssue[] } => {
  const skip = new Set(options.skipKeys ?? [])
  const issues: ConfigValidationIssue[] = []
  const input = isRecord(value) ? value : value === undefined || value === null ? {} : undefined
  if (input === undefined) return { value: {}, issues: [{ path: '', message: '配置必须是对象。' }] }
  const filtered: ConfigSchemaDocument = {
    ...document,
    dict: Object.fromEntries(Object.entries(document.dict).filter(([key]) => !skip.has(key))),
  }
  const output = validateNode(filtered, input, '', '配置', issues)
  return { value: isRecord(output) ? output : {}, issues }
}

/** Throws the first validation issue as a user-readable error. */
export const parseConfigValue = (
  document: ConfigSchemaDocument,
  value: JsonValue | undefined,
  options: { readonly skipKeys?: readonly string[] } = {},
): Readonly<Record<string, JsonValue>> => {
  const result = validateConfigValue(document, value, options)
  const first = result.issues[0]
  if (first) throw new TypeError(first.message)
  return result.value
}

interface FieldOptions<Value extends JsonValue> {
  readonly hint?: string
  readonly default?: Value
  readonly required?: boolean
  readonly advanced?: boolean
  readonly group?: string
}

const fieldMeta = <Value extends JsonValue>(title: string, options: FieldOptions<Value> = {}): ConfigSchemaMeta => ({
  description: title,
  ...(options.hint === undefined ? {} : { hint: options.hint }),
  ...(options.default === undefined ? {} : { default: options.default }),
  ...(options.required === undefined ? {} : { required: options.required }),
  ...(options.advanced === undefined ? {} : { advanced: options.advanced }),
  ...(options.group === undefined ? {} : { group: options.group }),
})

/** Builds serialized Schemastery documents without depending on the Schemastery runtime. */
export const configSchema = {
  object: (dict: Readonly<Record<string, ConfigSchemaNode>>): ConfigSchemaDocument => ({ type: 'object', dict }),
  string: (title: string, options: FieldOptions<string> & { readonly multiline?: boolean } = {}): ConfigSchemaNode => ({
    type: 'string',
    meta: { ...fieldMeta(title, options), ...(options.multiline ? { role: 'textarea' } : {}) },
  }),
  secret: (title: string, options: Omit<FieldOptions<string>, 'default'> = {}): ConfigSchemaNode => ({
    type: 'string',
    meta: { ...fieldMeta(title, options), role: 'secret' },
  }),
  number: (
    title: string,
    options: FieldOptions<number> & { readonly min?: number; readonly max?: number; readonly integer?: boolean } = {},
  ): ConfigSchemaNode => ({
    type: options.integer ? 'natural' : 'number',
    meta: {
      ...fieldMeta(title, options),
      ...(options.min === undefined ? {} : { min: options.min }),
      ...(options.max === undefined ? {} : { max: options.max }),
    },
  }),
  boolean: (title: string, options: FieldOptions<boolean> = {}): ConfigSchemaNode => ({
    type: 'boolean',
    meta: fieldMeta(title, options),
  }),
  enum: (
    title: string,
    choices: readonly { readonly value: string | number; readonly label: string }[],
    options: FieldOptions<string | number> = {},
  ): ConfigSchemaNode => ({
    type: 'union',
    list: choices.map((choice) => ({ type: 'const', value: choice.value, meta: { description: choice.label } })),
    meta: fieldMeta(title, options),
  }),
} as const
