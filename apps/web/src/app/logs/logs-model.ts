import type { HostLogEntry, HostLogQuery } from '@nekro-nxt/contracts'

export interface LogGroup {
  entry: HostLogEntry
  entries: HostLogEntry[]
}
const signatures = new WeakMap<HostLogEntry, string>()
const sizes = new WeakMap<HostLogEntry, number>()
/** Show native line breaks for errors, while keeping the full JSON available separately. */
export function logStacks(value: HostLogEntry['details']): string[] {
  const stacks = new Set<string>()
  const visit = (item: HostLogEntry['details'], depth: number): void => {
    if (depth > 7 || stacks.size >= 8 || item === null || typeof item !== 'object') return
    if (Array.isArray(item)) {
      item.forEach((child) => visit(child, depth + 1))
      return
    }
    for (const [key, child] of Object.entries(item)) {
      if (key === 'stack' && typeof child === 'string') stacks.add(child)
      else visit(child, depth + 1)
    }
  }
  visit(value, 0)
  return [...stacks]
}
export function groupLogs(entries: readonly HostLogEntry[]): LogGroup[] {
  const result: LogGroup[] = []
  let previous = ''
  for (const entry of entries) {
    const signature =
      signatures.get(entry) ??
      JSON.stringify([entry.runId, entry.level, entry.source, entry.scope, entry.message, entry.details, entry.code])
    signatures.set(entry, signature)
    if (signature === previous && result.length) result.at(-1)!.entries.push(entry)
    else {
      result.push({ entry, entries: [entry] })
      previous = signature
    }
  }
  return result
}
export function relatedLogQuery(entry: HostLogEntry): HostLogQuery {
  if (entry.scope?.operationId)
    return { levels: ['debug', 'info', 'warn', 'error'], scope: { operationId: entry.scope.operationId } }
  const time = Date.parse(entry.timestamp)
  return {
    levels: ['debug', 'info', 'warn', 'error'],
    sources: [{ kind: entry.source.kind, id: entry.source.id }],
    from: new Date(time - 120_000).toISOString(),
    to: new Date(time + 120_000).toISOString(),
  }
}
export function mergeLogEntries(
  previous: readonly HostLogEntry[],
  next: readonly HostLogEntry[],
  older = false,
): HostLogEntry[] {
  const seen = new Set<string>()
  const all = (older ? [...next, ...previous] : [...previous, ...next]).filter((entry) => {
    if (seen.has(entry.id)) return false
    seen.add(entry.id)
    return true
  })
  const ordered = older ? all.slice(0, 5000) : all.slice(-5000).reverse()
  const bounded: HostLogEntry[] = []
  let bytes = 0
  for (const entry of ordered) {
    const size = sizes.get(entry) ?? JSON.stringify(entry).length * 2
    sizes.set(entry, size)
    if (bytes + size > 16 * 1024 * 1024 && bounded.length) break
    bounded.push(entry)
    bytes += size
  }
  return older ? bounded : bounded.reverse()
}
