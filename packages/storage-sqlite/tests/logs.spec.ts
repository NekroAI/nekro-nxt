import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { LogDatabase } from '../src/logs.js'
import type { HostLogEntry } from '@nekro-nxt/contracts'

const roots: string[] = []
const opened: LogDatabase[] = []
const settings = { retentionDays: 7, maxSizeMiB: 64, revision: 0 }
const record = (message = '虚构日志'): Omit<HostLogEntry, 'id' | 'sequence'> => ({
  runId: 'test',
  timestamp: new Date().toISOString(),
  level: 'info',
  message,
  source: { kind: 'extension', id: 'demo', name: '示例扩展' },
  scope: { agentId: 'demo-agent', operationId: 'demo-operation' },
  details: { safe: 'visible' },
  redacted: false,
  truncated: false,
})
const fixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'nxt-log-store-'))
  roots.push(root)
  const file = path.join(root, 'logs.sqlite')
  const db = new LogDatabase(file, settings)
  opened.push(db)
  return { db, file }
}
afterEach(async () => {
  for (const db of opened.splice(0)) db.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
describe('independent log storage', () => {
  it('retains identical messages while making retried committed batches idempotent', async () => {
    const { db } = await fixture()
    const entry = { ...record(), receipt: 'receipt-one' }
    db.append([entry])
    db.append([entry])
    db.append([{ ...entry, receipt: 'receipt-two' }])
    expect(db.stats().count).toBe(2)
    const all = db.query({})
    expect(db.get(all.entries[0]!.id)?.message).toBe('虚构日志')
    expect(db.get('unknown:1')).toBeUndefined()
    expect(db.sources()).toEqual([record().source])
    expect(db.bytes()).toBeGreaterThan(0)
  })
  it('combines source, scope, time and literal keyword conditions without SQL interpolation', async () => {
    const { db } = await fixture()
    db.append([record('A%_ literally'), { ...record('different'), level: 'error' }])
    expect(
      db.query({
        levels: ['info'],
        sourceKinds: ['extension'],
        sourceIds: ['demo'],
        sources: [{ kind: 'extension', id: 'demo' }],
        keyword: 'a%_',
        from: '2000-01-01T00:00:00.000Z',
        to: '2099-01-01T00:00:00.000Z',
        scope: { agentId: 'demo-agent' },
      }).entries,
    ).toHaveLength(1)
    expect(db.query({ keyword: "' OR 1=1 --" }).entries).toEqual([])
    for (const query of [{ levels: [] }, { sourceKinds: [] }, { sourceIds: [] }, { sources: [] }])
      expect(db.query(query).entries).toEqual([])
    const page = db.query({ limit: 1 })
    expect(db.query({ olderCursor: page.olderCursor! }).entries[0]?.message).toBe('A%_ literally')
    expect(db.query({ afterCursor: 'replacement:0' }).gap).toBe('reset')
    expect(() => db.query({ afterCursor: 'invalid' })).toThrow('位置无效')
  })
  it('exports a snapshot independently of visible pagination, and cancels without retaining a transaction', async () => {
    const { db } = await fixture()
    db.append(Array.from({ length: 300 }, (_, i) => record(`item-${i}`)))
    const jsonl = await db.export({ limit: 1 }, 'jsonl', () => false)
    expect(new TextDecoder().decode(jsonl).trim().split('\n')).toHaveLength(300)
    expect(new TextDecoder().decode(await db.export({ keyword: 'item-299' }, 'text', () => false))).toContain('visible')
    await expect(db.export({}, 'text', () => true)).rejects.toThrow('取消')
    db.append([record('after cancel')])
    expect(db.stats().count).toBe(301)
  })
  it('limits response bytes and preserves forward cursors through a large page', async () => {
    const { db } = await fixture()
    db.append(Array.from({ length: 80 }, () => record('x'.repeat(40_000))))
    const start = db.stats().headCursor.split(':')[0] + ':0'
    const first = db.query({ afterCursor: start })
    expect(first.hasMore).toBe(true)
    expect(first.entries.length).toBeLessThan(80)
    const second = db.query({ afterCursor: first.headCursor })
    expect(second.entries[0]!.sequence).toBe(first.entries.at(-1)!.sequence + 1)
    db.cleanup(Date.now(), true)
    expect(db.bytes()).toBeLessThan(64 * 1024 * 1024)
  })
  it('rejects future formats without replacing the file', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nxt-future-log-'))
    roots.push(root)
    const file = path.join(root, 'logs.sqlite')
    const future = new DatabaseSync(file)
    future.exec('PRAGMA user_version = 99')
    future.close()
    const before = await stat(file)
    expect(() => new LogDatabase(file, settings)).toThrow('更新的版本')
    expect((await stat(file)).ino).toBe(before.ino)
  })
})
