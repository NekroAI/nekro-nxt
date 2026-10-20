import type { HostLogEntry, HostLogInput, JsonValue } from '@nekro-nxt/contracts'
import { formatLogMessage } from '@nekro-nxt/contracts'
import { isNativeError, isProxy } from 'node:util/types'
import { formatWithOptions } from 'node:util'

const secretKey = /(?:password|passwd|secret|token|authorization|cookie|api[-_]?key|credential)/iu
const payloadKey = /^(?:messages|prompt|reasoning|body|requestBody|responseBody|arguments|input|output|content)$/iu
const nativeStack = Object.getOwnPropertyDescriptor(new Error(), 'stack')
const initialStackFormatter = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace')

/**
 * Hides registered secrets, bearer tokens, credential-looking assignments, URL credentials and queries, personal
 * directories and terminal control characters in one line of log text.
 */
export function redactLogText(input: string, secrets: readonly string[] = []): string {
  let value = input
  for (const secret of secrets) if (secret.length >= 4) value = value.split(secret).join('[已隐藏]')
  return (
    value
      // eslint-disable-next-line no-control-regex -- ANSI escapes are deliberately removed from untrusted logs.
      .replace(/\u001b\[[0-9;]*[A-Za-z]/gu, '')
      // eslint-disable-next-line no-control-regex -- Preserve tabs/newlines while removing other terminal controls.
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
      .replace(/\bBearer\s+[^\s,;"']+/giu, 'Bearer [已隐藏]')
      .replace(
        /((?:access[_-]?token|client[_-]?secret|api[_-]?key|authorization|password|token|secret|cookie)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/giu,
        '$1[已隐藏]',
      )
      .replace(/(?:https?|wss?):\/\/[^\s<>"']+/giu, (url) => {
        try {
          const parsed = new URL(url)
          parsed.username = ''
          parsed.password = ''
          parsed.search = ''
          parsed.hash = ''
          return parsed.toString()
        } catch {
          return '[地址已隐藏]'
        }
      })
      .replace(/\/(?:Users|home)\/[^/\s]+/gu, '/[个人目录]')
      .replace(/[a-z]:\\Users\\[^\\\s]+/giu, '[个人目录]')
  )
}

/** Bounded formatting never invokes getters, custom inspectors or toJSON on plugin values. */
export function normalizeLog(input: HostLogInput, runId: string, now: number, secrets: readonly string[] = []) {
  let redacted = false
  let truncated = false
  const text = (input: string): string => {
    let value = input.slice(0, 32_768)
    if (input.length > 32_768) truncated = true
    value = redactLogText(value, secrets)
    if (value !== input) redacted = true
    if (value.length > 16_384) {
      value = `${value.slice(0, 16_384)}…`
      truncated = true
    }
    return value
  }
  const seen = new WeakSet<object>()
  let visited = 0
  let detailBudget = 16_384
  const visit = (value: unknown, depth = 0): JsonValue => {
    if (++visited > 512 || depth > 7) {
      truncated = true
      return '[已截断]'
    }
    if (typeof value === 'string') {
      if (detailBudget <= 0) {
        truncated = true
        return '[已截断]'
      }
      const safe = text(value)
      const result = safe.slice(0, detailBudget)
      if (result.length < safe.length) truncated = true
      detailBudget -= result.length
      return result
    }
    if (value === null || typeof value === 'boolean') return value
    if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
    if (typeof value === 'bigint') return String(value)
    if (typeof value !== 'object') return `[${typeof value}]`
    if (isProxy(value)) return '[代理对象已略过]'
    if (seen.has(value)) return '[循环引用]'
    seen.add(value)
    if (Array.isArray(value)) {
      if (value.length > 100) truncated = true
      return Array.from({ length: Math.min(value.length, 100) }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        return descriptor && 'value' in descriptor ? visit(descriptor.value, depth + 1) : '[访问器已略过]'
      })
    }
    const result: Record<string, JsonValue> = {}
    Object.setPrototypeOf(result, null)
    const keys = isNativeError(value)
      ? ['name', 'message', 'stack', 'cause', 'errors']
      : Object.keys(value).slice(0, 100)
    for (const key of keys) {
      if (secretKey.test(key) || payloadKey.test(key)) {
        result[key] = '[已隐藏]'
        redacted = true
        continue
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined) continue
      if (
        key === 'stack' &&
        isNativeError(value) &&
        descriptor.get &&
        descriptor.get === nativeStack?.get &&
        Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace')?.value === initialStackFormatter?.value
      ) {
        const stack: unknown = descriptor.get.call(value)
        result[key] = visit(stack, depth + 1)
        continue
      }
      result[key] = 'value' in descriptor ? visit(descriptor.value, depth + 1) : '[访问器已略过]'
    }
    return result
  }
  const parameters = input.formatArgs === undefined ? undefined : visit(input.formatArgs)
  const entry: Omit<HostLogEntry, 'id' | 'sequence'> = {
    runId,
    timestamp: new Date(now).toISOString(),
    level: input.level,
    message: text(
      Array.isArray(parameters)
        ? formatWithOptions(
            { customInspect: false, getters: false, colors: false, depth: 6 },
            text(input.message),
            ...parameters,
          )
        : input.message,
    ),
    source: {
      ...input.source,
      name: text(input.source.name),
      ...(input.source.component === undefined ? {} : { component: text(input.source.component) }),
    },
    ...(input.scope === undefined ? {} : { scope: input.scope }),
    ...(input.code === undefined ? {} : { code: text(input.code) }),
    ...(input.details === undefined
      ? parameters === undefined
        ? {}
        : { details: { parameters } }
      : { details: visit(input.details) }),
    redacted: false,
    truncated: false,
  }
  if (Buffer.byteLength(JSON.stringify(entry)) > 63 * 1024) {
    entry.details = '[详情超过单条日志上限]'
    truncated = true
    entry.message = entry.message.slice(0, 4000)
  }
  entry.redacted = redacted
  entry.message = formatLogMessage(entry.message)
  entry.truncated = truncated
  return entry
}
