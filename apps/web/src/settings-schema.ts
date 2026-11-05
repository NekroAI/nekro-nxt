import Schema from '@deepseek-ai/schemastery'
import { DshCredentialRefSchema, parseJsonValue, type JsonValue } from '@nekro-nxt/contracts'

/** NXT's data-only form model. Validation uses Schemastery's public API. */
export interface SchemaNode {
  readonly type: string
  readonly meta: Schema<unknown>['meta']
  readonly value?: JsonValue
  readonly inner?: SchemaNode
  readonly list?: readonly SchemaNode[]
  readonly dict?: Readonly<Record<string, SchemaNode>>
  readonly parse: (value: unknown) => unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const own = (record: Record<string, unknown>, key: string): unknown =>
  Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined

const safeKey = (key: string): void => {
  if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error(`不支持的配置路径：${key}`)
}

const readMeta = (value: unknown): Schema<unknown>['meta'] => {
  if (value === undefined) return {}
  if (!isRecord(value)) throw new Error('配置 Schema 的元数据无效。')
  const meta: Schema<unknown>['meta'] = {}
  for (const key of ['required', 'disabled', 'collapse', 'hidden', 'loose'] as const) {
    if (typeof value[key] === 'boolean') meta[key] = value[key]
  }
  for (const key of ['role', 'comment'] as const) {
    if (typeof value[key] === 'string') meta[key] = value[key]
  }
  for (const key of ['min', 'max', 'step'] as const) {
    if (typeof value[key] === 'number' && Number.isFinite(value[key])) meta[key] = value[key]
  }
  if (Object.prototype.hasOwnProperty.call(value, 'default')) meta.default = parseJsonValue(value['default'])
  const description = value['description']
  if (typeof description === 'string') meta.description = description
  else if (isRecord(description)) {
    meta.description = Object.fromEntries(
      Object.entries(description).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    )
  }
  const link = value['link']
  if (typeof link === 'string' && /^https?:\/\//u.test(link)) meta.link = link
  const pattern = value['pattern']
  if (isRecord(pattern) && typeof pattern['source'] === 'string') {
    const flags = typeof pattern['flags'] === 'string' ? pattern['flags'] : ''
    // Validate syntax before the form is exposed; never evaluate Schema callbacks.
    new RegExp(pattern['source'], flags)
    meta.pattern = { source: pattern['source'], flags }
  }
  const badges = value['badges']
  if (Array.isArray(badges)) {
    meta.badges = badges.flatMap((badge: unknown) =>
      isRecord(badge) && typeof badge['text'] === 'string' && typeof badge['type'] === 'string'
        ? [{ text: badge['text'], type: badge['type'] }]
        : [],
    )
  }
  return meta
}

const VALIDATED_TYPES = new Set([
  'any',
  'never',
  'string',
  'number',
  'boolean',
  'const',
  'object',
  'dict',
  'array',
  'tuple',
  'union',
  'intersect',
])

/** Decode the public Schemastery wire graph, never its executable callbacks. */
export const rehydrateSchema = (input: unknown): SchemaNode => {
  const wire = parseJsonValue(input)
  if (!isRecord(wire)) throw new Error('配置 Schema 不是对象。')
  const refs = wire['refs']
  if (refs !== undefined && !isRecord(refs)) throw new Error('配置 Schema 引用表无效。')
  const visiting = new Set<unknown>()
  const cache = new Map<unknown, { node: SchemaNode; validator: Schema<unknown> }>()
  const decode = (source: unknown, depth: number): { node: SchemaNode; validator: Schema<unknown> } => {
    if (depth > 64 || cache.size > 2_000) throw new Error('配置 Schema 过于复杂。')
    const identity = source
    if (visiting.has(identity)) throw new Error('递归配置 Schema 暂不支持在线编辑。')
    const cached = cache.get(identity)
    if (cached) return cached
    if (typeof source === 'number') {
      if (!Number.isSafeInteger(source) || !isRecord(refs)) throw new Error('配置 Schema 引用无效。')
      source = own(refs, String(source))
    }
    if (!isRecord(source) || typeof source['type'] !== 'string') throw new Error('配置 Schema 节点无效。')
    visiting.add(identity)
    const type = source['type']
    const meta = readMeta(source['meta'])
    const inner = source['inner'] === undefined ? undefined : decode(source['inner'], depth + 1)
    const sKey = source['sKey'] === undefined ? undefined : decode(source['sKey'], depth + 1)
    const rawList = source['list']
    if (rawList !== undefined && !Array.isArray(rawList)) throw new Error('配置 Schema 列表无效。')
    const list = Array.isArray(rawList) ? rawList.map((child: unknown) => decode(child, depth + 1)) : undefined
    const rawDict = source['dict']
    if (rawDict !== undefined && !isRecord(rawDict)) throw new Error('配置 Schema 字段表无效。')
    const dict = isRecord(rawDict)
      ? Object.fromEntries(
          Object.entries(rawDict).map(([key, child]) => {
            safeKey(key)
            return [key, decode(child, depth + 1)]
          }),
        )
      : undefined
    if ((type === 'array' || type === 'dict') && !inner) throw new Error('集合 Schema 缺少元素定义。')
    if (['tuple', 'union', 'intersect'].includes(type) && !list) throw new Error('配置 Schema 缺少选项。')
    if (type === 'object' && !dict) throw new Error('对象 Schema 缺少字段定义。')
    const value = source['value'] === undefined ? undefined : parseJsonValue(source['value'])
    // Custom/transform schemas remain advanced JSON fields. The server remains
    // authoritative for their validation; browser input cannot supply code here.
    const validator = new Schema<unknown>({
      type: VALIDATED_TYPES.has(type) ? type : 'any',
      meta,
      ...(inner ? { inner: inner.validator } : {}),
      ...(sKey ? { sKey: sKey.validator } : {}),
      ...(list ? { list: list.map((child) => child.validator) } : {}),
      ...(dict ? { dict: Object.fromEntries(Object.entries(dict).map(([key, child]) => [key, child.validator])) } : {}),
      ...(value === undefined ? {} : { value }),
    })
    const node: SchemaNode = {
      type,
      meta,
      ...(inner ? { inner: inner.node } : {}),
      ...(list ? { list: list.map((child) => child.node) } : {}),
      ...(dict ? { dict: Object.fromEntries(Object.entries(dict).map(([key, child]) => [key, child.node])) } : {}),
      ...(value === undefined ? {} : { value }),
      parse: (draft) =>
        validator(structuredClone(draft), {
          // Secrets omitted by Host redaction are not edits; unset remains an
          // explicit path operation and Host validation owns its final meaning.
          ignore: (data: unknown, candidate: Schema<unknown>) => candidate.meta.role === 'secret' && data == null,
        }),
    }
    const result = { node, validator }
    visiting.delete(identity)
    cache.set(identity, result)
    return result
  }
  return decode(refs === undefined ? wire : wire['uid'], 0).node
}

type PathSegment = string | number

/** `providers.example.models[2].contextWindow`; the whole value is “配置”. */
const displayPath = (path: readonly PathSegment[]): string =>
  path.reduce<string>(
    (text, segment) =>
      typeof segment === 'number' ? `${text}[${segment}]` : text === '' ? segment : `${text}.${segment}`,
    '',
  ) || '配置'

const VALIDATION_WORDING: readonly (readonly [RegExp, (match: RegExpExecArray) => string])[] = [
  [/^missing required value$/u, () => '需要填写'],
  [/^expected number multiple of 1 but got /u, () => '需要是整数'],
  [/^expected number multiple of (\S+) but got /u, (match) => `需要是 ${match[1]} 的整数倍`],
  [/^expected number >= (\S+) but got /u, (match) => `不能小于 ${match[1]}`],
  [/^expected number <= (\S+) but got /u, (match) => `不能大于 ${match[1]}`],
  [/^expected string length >= (\S+) but got /u, (match) => `至少 ${match[1]} 个字符`],
  [/^expected string length <= (\S+) but got /u, (match) => `最多 ${match[1]} 个字符`],
  [/^expect string to match regexp /u, () => '格式不正确'],
  [/^expected number but got /u, () => '需要是数字'],
  [/^expected string but got /u, () => '需要是文本'],
  [/^expected boolean but got /u, () => '需要是 true 或 false'],
  [/^expected array but got /u, () => '需要是列表'],
  [/^expected object but got /u, () => '需要是对象'],
  [/^expected .+ but got /u, () => '取值无效'],
]

/** Schemastery's `$.a.b[0] expected …` as `a.b[0]：…`; wording it does not know stays as it is. */
const describeValidationError = (error: unknown): string => {
  if (!(error instanceof Error)) return '配置值无效。'
  const options: unknown = Reflect.get(error, 'options')
  const rawPath: unknown = options !== null && typeof options === 'object' ? Reflect.get(options, 'path') : undefined
  const path = Array.isArray(rawPath)
    ? rawPath.filter((segment): segment is PathSegment => typeof segment === 'string' || typeof segment === 'number')
    : undefined
  if (!path) return error.message
  const prefix = path.reduce<string>(
    (text, segment) => (typeof segment === 'number' ? `${text}[${segment}]` : `${text}.${segment}`),
    '$',
  )
  const message =
    prefix !== '$' && error.message.startsWith(`${prefix} `) ? error.message.slice(prefix.length + 1) : error.message
  for (const [pattern, wording] of VALIDATION_WORDING) {
    const match = pattern.exec(message)
    if (match) return `${displayPath(path)}：${wording(match)}`
  }
  return `${displayPath(path)}：${message}`
}

/** A credential-ref field holds the name of a credential, never the secret itself. */
const credentialRefIssue = (root: SchemaNode, value: unknown): string | undefined => {
  const visit = (node: SchemaNode, current: unknown, path: readonly PathSegment[]): string | undefined => {
    if (node.meta?.role === 'credential-ref') {
      if (current === undefined || current === null || current === '') return undefined
      return DshCredentialRefSchema.safeParse(current).success
        ? undefined
        : `${displayPath(path)}：需要是凭据名称，只能包含字母、数字和下划线`
    }
    const children: (readonly [SchemaNode, unknown, readonly PathSegment[]])[] = []
    if (node.type === 'object' && isRecord(current)) {
      for (const [key, child] of Object.entries(node.dict ?? {}))
        children.push([child, own(current, key), [...path, key]])
    } else if (node.type === 'dict' && node.inner && isRecord(current)) {
      for (const [key, entry] of Object.entries(current)) children.push([node.inner, entry, [...path, key]])
    } else if (node.type === 'array' && node.inner && Array.isArray(current)) {
      const entries: readonly unknown[] = current
      entries.forEach((entry, index) => children.push([node.inner!, entry, [...path, index]]))
    } else if (node.type === 'tuple' && Array.isArray(current)) {
      const entries: readonly unknown[] = current
      node.list?.forEach((child, index) => children.push([child, entries[index], [...path, index]]))
    } else if (node.type === 'union' || node.type === 'intersect') {
      for (const child of node.list ?? []) children.push([child, current, path])
    } else if (node.type === 'transform' && node.inner) {
      children.push([node.inner, current, path])
    }
    for (const [child, entry, childPath] of children) {
      const issue = visit(child, entry, childPath)
      if (issue) return issue
    }
    return undefined
  }
  return visit(root, value, [])
}

export const validateDraft = (node: SchemaNode, value: unknown): string | undefined => {
  try {
    node.parse(value)
  } catch (error) {
    return describeValidationError(error)
  }
  return credentialRefIssue(node, value)
}

export type DraftChange =
  | { readonly op: 'set'; readonly path: readonly string[]; readonly value: unknown }
  | { readonly op: 'unset'; readonly path: readonly string[] }

const sameValue = (left: unknown, right: unknown): boolean => {
  if (Array.isArray(left) && Array.isArray(right)) {
    const before: readonly unknown[] = left
    const after: readonly unknown[] = right
    return before.length === after.length && before.every((entry, index) => sameValue(entry, after[index]))
  }
  if (isRecord(left) && isRecord(right)) {
    const keys = Object.keys(left)
    return (
      keys.length === Object.keys(right).length &&
      keys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && sameValue(left[key], right[key]))
    )
  }
  return Object.is(left, right)
}

/** Field edits that turn `before` into `after`: objects compare key by key, anything else is replaced whole. */
export const diffDraft = (before: unknown, after: unknown, path: readonly string[] = []): readonly DraftChange[] => {
  if (!isRecord(before) || !isRecord(after)) return sameValue(before, after) ? [] : [{ op: 'set', path, value: after }]
  const changes: DraftChange[] = []
  for (const key of Object.keys(before)) {
    if (!Object.prototype.hasOwnProperty.call(after, key)) changes.push({ op: 'unset', path: [...path, key] })
  }
  for (const [key, next] of Object.entries(after)) {
    if (Object.prototype.hasOwnProperty.call(before, key)) changes.push(...diffDraft(before[key], next, [...path, key]))
    else changes.push({ op: 'set', path: [...path, key], value: next })
  }
  return changes
}

export const getPath = (value: unknown, path: readonly string[]): unknown => {
  for (const key of path) {
    safeKey(key)
    if (Array.isArray(value)) value = /^(0|[1-9]\d*)$/u.test(key) ? value[Number(key)] : undefined
    else if (isRecord(value)) value = own(value, key)
    else return undefined
  }
  return value
}

const updatePath = (value: unknown, path: readonly string[], replacement: unknown, remove: boolean): unknown => {
  const [key, ...rest] = path
  if (key === undefined) return remove ? undefined : replacement
  safeKey(key)
  if (Array.isArray(value)) {
    if (!/^(0|[1-9]\d*)$/u.test(key) || Number(key) > value.length) throw new Error('配置数组下标无效。')
    const elements: readonly unknown[] = value
    const result: unknown[] = [...elements]
    if (remove && rest.length === 0) result.splice(Number(key), 1)
    else result[Number(key)] = updatePath(value[Number(key)], rest, replacement, remove)
    return result
  }
  const result: Record<string, unknown> = isRecord(value) ? { ...value } : {}
  if (remove && rest.length === 0) delete result[key]
  else if (!remove || own(result, key) !== undefined)
    result[key] = updatePath(own(result, key), rest, replacement, remove)
  return result
}

export const setPath = (value: unknown, path: readonly string[], replacement: unknown): unknown =>
  updatePath(value, path, replacement, false)

export const deletePath = (value: unknown, path: readonly string[]): unknown => updatePath(value, path, undefined, true)
