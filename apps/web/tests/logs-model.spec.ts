import { describe, expect, it } from 'vitest'
import type { HostLogEntry } from '@nekro-nxt/contracts'
import { groupLogs, logStacks, mergeLogEntries, relatedLogQuery } from '../src/app/logs/logs-model.js'

const entry = (sequence: number, operationId = 'operation-demo'): HostLogEntry => ({
  id: `epoch:${sequence}`,
  sequence,
  timestamp: '2026-10-14T00:00:00.000Z',
  runId: 'fictional-run',
  level: 'warn',
  message: '虚构连接重试',
  source: { kind: 'extension', id: 'ext_demo', name: '虚构扩展' },
  scope: { operationId },
  redacted: false,
  truncated: false,
})
describe('log reader semantics', () => {
  it('keeps stack line breaks and finds nested causes without duplicating the same stack', () => {
    expect(
      logStacks({
        error: { stack: 'Error: demo\n    at demo.ts:1', cause: { stack: 'Error: cause' } },
        parameters: [{ stack: 'Error: cause' }],
      }),
    ).toEqual(['Error: demo\n    at demo.ts:1', 'Error: cause'])
    expect(logStacks(undefined)).toEqual([])
  })
  it('folds only consecutive entries of the same operation without losing originals', () => {
    const original = [entry(1), entry(2), entry(3, 'other'), entry(4)]
    const groups = groupLogs(original)
    expect(groups.map((group) => group.entries.length)).toEqual([2, 1, 1])
    expect(groups.flatMap((group) => group.entries)).toEqual(original)
  })
  it('deduplicates replay and bounds either end of a reading window', () => {
    expect(mergeLogEntries([entry(1), entry(2)], [entry(2), entry(3)]).map((row) => row.sequence)).toEqual([1, 2, 3])
    const records = Array.from({ length: 5005 }, (_, index) => entry(index))
    expect(mergeLogEntries([], records)[0]?.sequence).toBe(5)
    expect(mergeLogEntries([], records, true).at(-1)?.sequence).toBe(4999)
  })
  it('removes masking filters when opening related operations or source context', () => {
    expect(relatedLogQuery(entry(1))).toEqual({
      levels: ['debug', 'info', 'warn', 'error'],
      scope: { operationId: 'operation-demo' },
    })
    const item = entry(1)
    delete item.scope
    const query = relatedLogQuery(item)
    expect(query.sources).toEqual([{ kind: 'extension', id: 'ext_demo' }])
    expect(Date.parse(query.to!) - Date.parse(query.from!)).toBe(240_000)
  })
})
