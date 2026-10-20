import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HostLogService } from '../src/logs/service.js'
import { normalizeLog } from '../src/logs/redact.js'
import { LogDatabase } from '@nekro-nxt/storage-sqlite'
import { observedCredentialProvider, preloadCredentialDocument } from '../src/logs/credentials.js'

const roots: string[] = []
const services: HostLogService[] = []
const syntheticHome = path.posix.join('/', 'Users', 'synthetic-log-test')
const source = { kind: 'extension' as const, id: 'ext_demo', name: '示例扩展' }
const create = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'nxt-logs-'))
  roots.push(root)
  const service = await HostLogService.open({ dataRoot: root })
  services.push(service)
  return { root, service }
}
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('host operational logs', () => {
  it('does not reserve the export slot for a request cancelled before it starts', async () => {
    const { service } = await create()
    const controller = new AbortController()
    controller.abort()
    await expect(service.export({}, 'text', controller.signal)).rejects.toThrow('取消')
    await expect(service.export({}, 'jsonl')).resolves.toBeInstanceOf(Uint8Array)
  })
  it('does not prune saved evidence when a write fails for a reason other than capacity', async () => {
    const { service, root } = await create()
    service.write({ level: 'info', source, message: 'preserved evidence' })
    await service.flush()
    const inspector = new DatabaseSync(path.join(root, 'logs', 'logs.sqlite'))
    try {
      inspector.exec(
        "CREATE TRIGGER synthetic_failure BEFORE INSERT ON logs BEGIN SELECT RAISE(FAIL, 'synthetic write failure'); END",
      )
      service.write({ level: 'info', source, message: 'rejected write' })
      await service.flush()
      expect(service.currentStatus().state).toBe('degraded')
      expect(inspector.prepare('SELECT count(*) AS count FROM logs').get()).toMatchObject({ count: 1 })
      inspector.exec('DROP TRIGGER synthetic_failure')
    } finally {
      inspector.close()
    }
  })
  it('expires a debug lease and observes used credential values without scanning the store', async () => {
    const { root, service } = await create()
    const context = new Context()
    try {
      await context.plugin(
        observedCredentialProvider((value) => service.registerSecret(value)),
        { path: path.join(root, 'synthetic-credentials.yaml'), watch: false },
      )
      const ref = credentialRef('SYNTHETIC_LOG_TEST_CREDENTIAL')
      await context.credentials.set(ref, 'fictional-opaque-credential')
      const value = await context.credentials.resolve(ref)
      service.write({ level: 'error', source, message: `failed with ${value?.value}` })
      await service.flush()
      expect(JSON.stringify((await service.query()).entries)).not.toContain('fictional-opaque-credential')
      // Logs and model-facing redaction share one registry.
      expect(service.secrets.redact('key fictional-opaque-credential')).toBe('key [凭据已隐藏]')
      const preloaded: string[] = []
      await preloadCredentialDocument(path.join(root, 'synthetic-credentials.yaml'), (found) => preloaded.push(found))
      await preloadCredentialDocument(path.join(root, 'absent.yaml'), (found) => preloaded.push(found))
      expect(preloaded).toEqual(['fictional-opaque-credential'])
    } finally {
      await context.fiber.dispose()
    }
    let now = Date.now()
    const timedRoot = await mkdtemp(path.join(tmpdir(), 'nxt-timed-log-'))
    roots.push(timedRoot)
    const timed = await HostLogService.open({ dataRoot: timedRoot, now: () => now })
    services.push(timed)
    timed.startDebug({ durationMinutes: 5 })
    now += 6 * 60_000
    timed.write({ level: 'debug', source, message: 'expired debug' })
    expect(timed.currentStatus().debugLeases).toEqual([])
    await timed.flush()
    expect((await timed.query()).entries).toEqual([])
  })
  it('preserves an unsupported store and bounds queued diagnostics while unavailable', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nxt-unavailable-logs-'))
    roots.push(root)
    await mkdir(path.join(root, 'logs'))
    const file = path.join(root, 'logs', 'logs.sqlite')
    const db = new DatabaseSync(file)
    db.exec('PRAGMA user_version = 99')
    db.close()
    const original = await stat(file)
    const service = await HostLogService.open({ dataRoot: root })
    services.push(service)
    expect(service.currentStatus().state).toBe('degraded')
    for (let index = 0; index < 1000; index++) service.write({ level: 'info', source, message: 'x'.repeat(32_000) })
    expect(service.currentStatus().queuedBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
    expect(service.currentStatus().droppedCount).toBeGreaterThan(0)
    expect((await stat(file)).ino).toBe(original.ino)
  })
  it('keeps invalid settings untouched until the administrator saves a valid policy', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nxt-invalid-log-config-'))
    roots.push(root)
    await mkdir(path.join(root, 'host'))
    const file = path.join(root, 'host', 'logging.json')
    await writeFile(file, 'invalid synthetic settings')
    const service = await HostLogService.open({ dataRoot: root })
    services.push(service)
    expect(service.currentStatus().state).toBe('degraded')
    expect(await readFile(file, 'utf8')).toBe('invalid synthetic settings')
    await service.updateSettings({ retentionDays: 7, maxSizeMiB: 256, revision: 0 })
    expect(service.currentStatus().state).toBe('ready')
  })
  it('normalizes nested credentials, errors, circular values and accessors before storage', () => {
    const details: Record<string, unknown> = {
      token: 'fictional-private',
      requestBody: 'fictional conversation',
      url: 'https://example.test/api?token=fictional',
      error: new Error(`Bearer fictional-token ${syntheticHome}/work/file.ts`),
    }
    details['cycle'] = details
    Object.defineProperty(details, 'danger', {
      enumerable: true,
      get() {
        throw new Error('must not run')
      },
    })
    const entry = normalizeLog({ level: 'error', message: '示例错误', source, details }, 'test', Date.now())
    const serialized = JSON.stringify(entry)
    expect(serialized).not.toContain('fictional-private')
    expect(serialized).not.toContain('fictional conversation')
    expect(serialized).not.toContain('fictional-token')
    expect(serialized).not.toContain(syntheticHome)
    expect(serialized).toContain('循环引用')
    expect(serialized).toContain('访问器已略过')
    expect(entry.redacted).toBe(true)
  })
  it('bounds oversized records and retains the useful message', () => {
    const entry = normalizeLog(
      {
        level: 'info',
        message: 'a'.repeat(100_000),
        source,
        details: Array.from({ length: 500 }, () => '中'.repeat(10000)),
      },
      'test',
      Date.now(),
    )
    expect(Buffer.byteLength(JSON.stringify(entry))).toBeLessThan(64 * 1024)
    expect(entry.truncated).toBe(true)
  })
  it('persists through a real worker and restart, keeps filtered forward pagination gap-free', async () => {
    const { root, service } = await create()
    expect((await service.status()).state).toBe('ready')
    for (let i = 0; i < 620; i++)
      service.write({
        level: i % 2 ? 'warn' : 'info',
        source,
        message: `record ${i}`,
        scope: { operationId: `op-${i % 3}` },
      })
    await service.flush()
    const newest = await service.query({ limit: 10 })
    expect(newest.entries).toHaveLength(10)
    expect(newest.entries.at(-1)?.message).toBe('record 619')
    const earliest = await service.query({ afterCursor: `${newest.headCursor.split(':')[0]}:0`, limit: 500 })
    expect(earliest.entries).toHaveLength(500)
    const next = await service.query({ afterCursor: earliest.headCursor })
    expect(next.entries).toHaveLength(120)
    expect(next.entries[0]?.message).toBe('record 500')
    const selected = await service.query({ keyword: 'RECORD 61', levels: ['warn'], scope: { operationId: 'op-1' } })
    expect(selected.entries.every((entry) => entry.level === 'warn' && entry.scope?.operationId === 'op-1')).toBe(true)
    await service.close()
    const reopened = await HostLogService.open({ dataRoot: root })
    services.push(reopened)
    expect((await reopened.query({ limit: 1 })).headCursor).toBe(newest.headCursor)
    expect((await reopened.get(newest.entries[0]!.id))?.message).toBe('record 610')
    const bytes = await reopened.export({ keyword: 'record', limit: 1 }, 'jsonl')
    expect(new TextDecoder().decode(bytes).trim().split('\n')).toHaveLength(620)
  }, 30_000)
  it('separates Debug collection from query levels and closes leases on restart', async () => {
    const { service, root } = await create()
    service.write({ level: 'debug', message: 'not collected', source })
    const lease = service.startDebug({ source: { kind: source.kind, id: source.id }, durationMinutes: 5 })
    service.write({ level: 'debug', message: 'collected', source })
    service.write({ level: 'debug', message: 'other source', source: { ...source, id: 'ext_other' } })
    service.stopDebug(lease.id)
    await service.flush()
    expect((await service.query({ levels: ['debug'] })).entries.map((entry) => entry.message)).toEqual(['collected'])
    service.startDebug({ durationMinutes: 15 })
    await service.close()
    const reopened = await HostLogService.open({ dataRoot: root })
    services.push(reopened)
    expect((await reopened.status()).debugLeases).toEqual([])
  })
  it('persists settings with optimistic revision checking', async () => {
    const { service, root } = await create()
    const updated = await service.updateSettings({ retentionDays: 3, maxSizeMiB: 64, revision: 0 })
    expect(updated.revision).toBe(1)
    await expect(service.updateSettings({ retentionDays: 7, maxSizeMiB: 256, revision: 0 })).rejects.toThrow('已被修改')
    await service.close()
    const reopened = await HostLogService.open({ dataRoot: root })
    services.push(reopened)
    expect(reopened.settings()).toEqual(updated)
  })
  it('reports expired cursors and rejects future storage formats without removing the file', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nxt-log-db-'))
    roots.push(root)
    const database = new LogDatabase(path.join(root, 'logs.sqlite'), { retentionDays: 1, maxSizeMiB: 64, revision: 0 })
    try {
      const before = database.stats().headCursor
      database.append([normalizeLog({ level: 'info', source, message: 'old' }, 'test', Date.now() - 3 * 86400_000)])
      database.cleanup(Date.now())
      database.append([normalizeLog({ level: 'info', source, message: 'new' }, 'test', Date.now())])
      const page = database.query({ afterCursor: before })
      expect(page.gap).toBe('expired')
      expect(page.entries.map((entry) => entry.message)).toEqual(['new'])
    } finally {
      database.close()
    }
  })
})
