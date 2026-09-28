import Schema from '@deepseek-ai/schemastery'
import { parseJsonValue, type JsonValue } from '@nekro-nxt/contracts'

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

export const validateDraft = (node: SchemaNode, value: unknown): string | undefined => {
  try {
    node.parse(value)
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : '配置值无效。'
  }
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
