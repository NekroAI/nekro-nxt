import { chmod, lstat, mkdir, readFile, readdir, readlink, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { dataLocationFiles, parseDataLocationPointer } from '../src/data-location.ts'
import {
  DATA_ROOT_MOVED_MARKER,
  createDataMoveRecord,
  decideStartup,
  moveOwnerAlive,
  readDataMoveRecord,
  rewriteJsonPaths,
  runDataMove,
  undoDataMove,
  writeDataMoveRecord,
  type DataMoveRecord,
} from '../src/data-move.ts'
import { runDataMoveMode } from '../src/data-move-mode.ts'
import { isRebuildable, listMoveUnits, preflightMove, type MovePlan } from '../src/data-move-plan.ts'
import { getDesktopDistribution } from '../src/distribution.ts'
import { checkSqliteIntegrity, createUserDataFixture, localStorageFacts } from './data-move-fixture.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await chmod(root, 0o700).catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})

const fixture = async () => {
  const created = await createUserDataFixture()
  roots.push(created.root)
  return created
}

/** A plan with a forced method: the temporary directory is one volume, so a copy is simulated by device id. */
const planFor = async (userData: string, target: string, method: 'move' | 'copy'): Promise<MovePlan> => {
  const result = await preflightMove(userData, target, {
    storage: localStorageFacts(),
    deviceOf: (directory) => Promise.resolve(method === 'copy' && directory !== userData ? 2 : 1),
    availableBytes: () => Promise.resolve(10 ** 12),
  })
  if (!result.ok) throw new Error(`preflight failed: ${JSON.stringify(result.problem)}`)
  return result.plan
}

const recordFor = (plan: MovePlan): DataMoveRecord => ({
  ...createDataMoveRecord(plan, 1_000, 4242),
  phase: 'moving',
})

const tree = async (root: string): Promise<readonly string[]> => {
  const entries: string[] = []
  const visit = async (relative: string) => {
    for (const name of (await readdir(path.join(root, relative))).sort()) {
      const child = path.join(relative, name)
      const info = await lstat(path.join(root, child))
      entries.push(child.split(path.sep).join('/'))
      if (info.isDirectory()) await visit(child)
    }
  }
  await visit('')
  return entries
}

const readJson = async (file: string): Promise<unknown> => JSON.parse(await readFile(file, 'utf8'))

const io = (records: DataMoveRecord[] = []) => ({
  writeRecord: (record: DataMoveRecord) => {
    records.push(record)
    return Promise.resolve()
  },
  checkSqlite: checkSqliteIntegrity,
  now: () => 2_000,
})

describe('data move preflight', () => {
  it('accepts an empty or missing target and reports method, size and time', async () => {
    const { root, userData } = await fixture()
    const target = path.join(root, 'new', 'NekroNXT')
    const result = await preflightMove(userData, target, { storage: localStorageFacts() })
    expect(result).toMatchObject({ ok: true, plan: { method: 'move', target } })
    if (!result.ok) return
    expect(result.plan.units).toContain('Local State')
    expect(result.plan.units).toContain('data/core.sqlite')
    expect(result.plan.units).not.toContain('data/backups')
    expect(result.plan.units).not.toContain('SingletonLock')
    expect(result.plan.estimatedSeconds).toBeGreaterThan(0)
    // An empty existing folder qualifies; the system's own hidden files do not count as content.
    await mkdir(target, { recursive: true })
    await writeFile(path.join(target, '.DS_Store'), '')
    await expect(preflightMove(userData, target, { storage: localStorageFacts() })).resolves.toMatchObject({ ok: true })
    // The write probe leaves nothing behind.
    expect(await readdir(target)).toEqual(['.DS_Store'])
  })

  it('rejects non-empty, nested, file and same targets', async () => {
    const { root, userData } = await fixture()
    const environment = { storage: localStorageFacts() }
    const busy = path.join(root, 'busy')
    await mkdir(busy)
    await writeFile(path.join(busy, 'keep.txt'), '虚构内容')
    await expect(preflightMove(userData, busy, environment)).resolves.toEqual({
      ok: false,
      problem: { code: 'not-empty' },
    })
    await expect(preflightMove(userData, path.join(userData, 'data', 'next'), environment)).resolves.toEqual({
      ok: false,
      problem: { code: 'inside-source' },
    })
    await expect(preflightMove(userData, path.join(root, 'old'), environment)).resolves.toEqual({
      ok: false,
      problem: { code: 'contains-source' },
    })
    await expect(preflightMove(userData, userData, environment)).resolves.toEqual({
      ok: false,
      problem: { code: 'same-directory' },
    })
    await expect(preflightMove(userData, path.join(busy, 'keep.txt'), environment)).resolves.toEqual({
      ok: false,
      problem: { code: 'not-directory' },
    })
    await expect(preflightMove(userData, 'relative/target', environment)).resolves.toEqual({
      ok: false,
      problem: { code: 'not-absolute' },
    })
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'rejects a location it cannot write to',
    async () => {
      const { root, userData } = await fixture()
      const locked = path.join(root, 'locked')
      await mkdir(locked)
      await chmod(locked, 0o500)
      roots.push(locked)
      await expect(
        preflightMove(userData, path.join(locked, 'NekroNXT'), { storage: localStorageFacts() }),
      ).resolves.toEqual({ ok: false, problem: { code: 'not-writable' } })
    },
  )

  it('rejects network and sync folders before anything is written', async () => {
    const { root, userData } = await fixture()
    const network = await preflightMove(userData, path.join(root, 'share', 'NXT'), {
      storage: {
        ...localStorageFacts(),
        mounts: () => Promise.resolve([{ mountPoint: path.join(root, 'share'), type: 'smbfs' }]),
      },
    })
    expect(network).toEqual({ ok: false, problem: { code: 'network' } })
    await expect(
      preflightMove(userData, path.join(root, 'BaiduSyncdisk', 'NXT'), { storage: localStorageFacts() }),
    ).resolves.toEqual({ ok: false, problem: { code: 'sync', provider: 'baidu' } })
  })

  it('requires the copied size plus 10% free for a copy, and nothing extra for a same-volume move', async () => {
    const { root, userData } = await fixture()
    const target = path.join(root, 'other-disk', 'NXT')
    const copy = await preflightMove(userData, target, {
      storage: localStorageFacts(),
      deviceOf: (directory) => Promise.resolve(directory === userData ? 1 : 2),
      availableBytes: () => Promise.resolve(1_000),
    })
    expect(copy).toMatchObject({ ok: false, problem: { code: 'insufficient-space', availableBytes: 1_000 } })
    if (copy.ok || copy.problem.code !== 'insufficient-space') return
    // Rebuildable content (logs, caches, runtimes) is not counted.
    expect(copy.problem.requiredBytes).toBeLessThan(150_000)
    expect(copy.problem.requiredBytes).toBeGreaterThan(70_000)
    await expect(
      preflightMove(userData, target, { storage: localStorageFacts(), availableBytes: () => Promise.resolve(0) }),
    ).resolves.toMatchObject({ ok: true, plan: { method: 'move' } })
  })

  it('on Windows rejects a longer target that would push files past 260 characters', async () => {
    const { root, userData } = await fixture()
    const longTarget = path.join(root, 'x'.repeat(240))
    await expect(
      preflightMove(userData, longTarget, { storage: { ...localStorageFacts(), platform: 'win32' } }),
    ).resolves.toMatchObject({ ok: false, problem: { code: 'path-too-long' } })
    await expect(
      preflightMove(userData, path.join(root, 'short'), { storage: { ...localStorageFacts(), platform: 'win32' } }),
    ).resolves.toMatchObject({ ok: true })
  })

  it('classifies rebuildable content the same way as upgrade backups, plus Electron caches', () => {
    expect(isRebuildable('data/logs/host.log')).toBe(true)
    expect(isRebuildable('data/dsh/pnpm-store')).toBe(true)
    expect(isRebuildable('Cache/Cache_Data/data_0')).toBe(true)
    expect(isRebuildable('Partitions/remote-1/Code Cache/js')).toBe(true)
    expect(isRebuildable('Partitions/remote-1/Cookies')).toBe(false)
    expect(isRebuildable('data/dsh/sessions/x')).toBe(false)
    expect(isRebuildable('data/logsheet')).toBe(false)
  })
})

describe('data move copy', () => {
  it('copies and verifies everything except recovery points and rebuildable content, then rewrites paths', async () => {
    const { root, userData } = await fixture()
    const target = path.join(root, 'new', 'NXT')
    const plan = await planFor(userData, target, 'copy')
    const records: DataMoveRecord[] = []
    const progress: number[] = []
    const result = await runDataMove(recordFor(plan), {
      ...io(records),
      onProgress: (step) => progress.push(step.completedBytes),
    })
    expect(result.createdTarget).toBe(true)
    const copied = await tree(target)
    expect(copied).toContain('Local State')
    expect(copied).toContain('instance-credentials.json')
    expect(copied).toContain('Local Storage/leveldb/000003.log')
    expect(copied).toContain('Partitions/remote-1/Cookies')
    expect(copied).toContain('data/core.sqlite')
    expect(copied).toContain('data/dsh/sessions/--example--/s1/events.jsonl')
    for (const skipped of ['data/backups', 'data/logs', 'data/runtimes', 'Cache', 'SingletonLock'])
      expect(copied).not.toContain(skipped)
    expect(copied).not.toContain('Partitions/remote-1/Code Cache')
    expect(await readlink(path.join(target, 'data/workspaces/agent-1/node_modules/notes-link'))).toBe('../notes.md')
    expect(await readFile(path.join(target, 'data/assets/a1/content.bin'))).toEqual(Buffer.alloc(70_000, 3))
    expect(progress.at(-1)).toBe(plan.bytes)
    const newData = path.join(target, 'data')
    const oldData = path.join(userData, 'data')
    expect(await readJson(path.join(target, 'data/dsh/session-storage.json'))).toMatchObject({
      sessionRoot: path.join(newData, 'dsh', 'sessions'),
    })
    expect(await readJson(path.join(target, 'data/sessions.sqlite.nekro-nxt-reset-required.json'))).toEqual({
      archivePath: path.join(newData, 'dsh', 'session-archives', 'schema17-abc'),
      manifest: {
        originalPath: path.join(newData, 'sessions.sqlite'),
        sessionRoot: path.join(newData, 'dsh', 'sessions'),
      },
    })
    expect(await readJson(path.join(target, 'data/dsh/session-archives/schema17-abc/manifest.json'))).toMatchObject({
      originalPath: path.join(newData, 'sessions.sqlite'),
      other: '/elsewhere/data',
    })
    expect(await readJson(path.join(target, DATA_ROOT_MOVED_MARKER))).toEqual({
      format: 'nxt.data-root-moved',
      version: 1,
      movedAt: 2_000,
    })
    // The source is untouched by a copy.
    expect(await readJson(path.join(userData, 'data/dsh/session-storage.json'))).toMatchObject({
      sessionRoot: path.join(oldData, 'dsh', 'sessions'),
    })
    // The originals were journaled before the rewrite.
    expect(
      records
        .at(-1)
        ?.rewrites?.map(({ file }) => file)
        .sort(),
    ).toEqual([
      'data/dsh/session-archives/schema17-abc/manifest.json',
      'data/dsh/session-storage.json',
      'data/sessions.sqlite.nekro-nxt-reset-required.json',
    ])
  })

  it('names the file that failed SQLite verification, and undo removes everything the copy created', async () => {
    const { root, userData } = await fixture()
    const target = path.join(root, 'new', 'NXT')
    const plan = await planFor(userData, target, 'copy')
    const records: DataMoveRecord[] = []
    const failing = runDataMove(recordFor(plan), {
      ...io(records),
      checkSqlite: () => {
        throw new Error('integrity_check: row 3 missing from index')
      },
    })
    await expect(failing).rejects.toMatchObject({
      name: 'DataMoveError',
      file: 'data/core.sqlite',
      message: '数据库检查未通过：integrity_check: row 3 missing from index',
    })
    await undoDataMove(records.at(-1)!)
    await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(path.join(root, 'new'))).resolves.toBeDefined()
    expect(await readFile(path.join(userData, 'Local State'), 'utf8')).toContain('encrypted_key')
  })

  it('detects a real SQLite corruption in the copy', async () => {
    const { root } = await fixture()
    const broken = path.join(root, 'broken.sqlite')
    await writeFile(broken, Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(4096, 0xff)]))
    expect(() => checkSqliteIntegrity(broken)).toThrow()
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'names an unreadable source file and keeps a target that already existed',
    async () => {
      const { root, userData } = await fixture()
      const target = path.join(root, 'existing-empty')
      await mkdir(target)
      const plan = await planFor(userData, target, 'copy')
      await chmod(path.join(userData, 'instance-credentials.json'), 0o000)
      const records: DataMoveRecord[] = []
      await expect(runDataMove(recordFor(plan), io(records))).rejects.toMatchObject({
        file: 'instance-credentials.json',
      })
      await chmod(path.join(userData, 'instance-credentials.json'), 0o600)
      expect(records.at(-1)?.createdTarget).toBe(false)
      await undoDataMove(records.at(-1)!)
      expect(await readdir(target)).toEqual([])
    },
  )
})

describe('data move on one volume', () => {
  it('renames every unit except recovery points and lock files, and undo puts it all back', async () => {
    const { root, userData } = await fixture()
    const before = await tree(userData)
    const target = path.join(root, 'new', 'NXT')
    const plan = await planFor(userData, target, 'move')
    const records: DataMoveRecord[] = []
    await runDataMove(recordFor(plan), io(records))
    expect(await tree(userData)).toEqual([
      'SingletonLock',
      'data',
      'data/backups',
      'data/backups/runtime-a',
      'data/backups/runtime-a/manifest.json',
    ])
    const moved = await tree(target)
    // A move carries caches too; nothing is rebuilt.
    expect(moved).toContain('Cache/Cache_Data/data_0')
    expect(moved).toContain('data/logs/host.log')
    expect(await readJson(path.join(target, 'data/dsh/session-storage.json'))).toMatchObject({
      sessionRoot: path.join(target, 'data', 'dsh', 'sessions'),
    })
    await undoDataMove(records.at(-1)!)
    expect(await tree(userData)).toEqual(before)
    expect(await readJson(path.join(userData, 'data/dsh/session-storage.json'))).toMatchObject({
      sessionRoot: path.join(userData, 'data', 'dsh', 'sessions'),
    })
    await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('names the entry that could not be moved', async () => {
    const { root, userData } = await fixture()
    const target = path.join(root, 'new', 'NXT')
    const plan = await planFor(userData, target, 'move')
    // Something else created the destination of one unit after the check: rename onto a non-empty directory fails.
    await mkdir(path.join(target, 'data', 'workspaces', 'other'), { recursive: true })
    const records: DataMoveRecord[] = []
    await expect(runDataMove(recordFor(plan), io(records))).rejects.toMatchObject({ file: 'data/workspaces' })
  })
})

describe('crash recovery', () => {
  const files = dataLocationFiles('/application-data', getDesktopDistribution('preview'))
  const record = (phase: DataMoveRecord['phase']): DataMoveRecord => ({
    format: 'nxt.desktop-data-move',
    version: 1,
    id: 'move-1',
    phase,
    method: 'copy',
    source: '/old/NXT',
    target: '/new/NXT',
    units: ['Local State', 'data/core.sqlite'],
    bytes: 10,
    requestedAt: 1,
    pid: 99_999,
    heartbeatAt: 1,
  })
  const decide = (
    value: DataMoveRecord | undefined,
    change: { migrationFlag?: boolean; pointerRoot?: string; ownerAlive?: boolean } = {},
  ) =>
    decideStartup({
      record: value,
      migrationFlag: change.migrationFlag ?? false,
      pointerRoot: change.pointerRoot ?? '/old/NXT',
      ownerAlive: change.ownerAlive ?? false,
    }).kind

  it('decides from the record phase, the pointer and whether the owner still runs', () => {
    expect(files.record.endsWith('.data-move.json')).toBe(true)
    expect(decide(undefined)).toBe('normal')
    expect(decide(record('completed'))).toBe('normal')
    expect(decide(record('failed'))).toBe('normal')
    expect(decide(record('requested'), { migrationFlag: true, ownerAlive: true })).toBe('migrate')
    expect(decide(record('requested'), { ownerAlive: true })).toBe('busy')
    expect(decide(record('requested'))).toBe('abandon')
    expect(decide(record('moving'), { ownerAlive: true })).toBe('busy')
    expect(decide(record('moving'))).toBe('undo')
    expect(decide(record('moving'), { migrationFlag: true })).toBe('undo')
    expect(decide(record('moving'), { pointerRoot: '/new/NXT' })).toBe('finish')
    expect(decide(record('switched'))).toBe('finish')
  })

  it('treats an owner as alive only while it is another live process with a fresh heartbeat', () => {
    const value = { ...record('moving'), heartbeatAt: 10_000 }
    expect(moveOwnerAlive(value, 20_000, () => true)).toBe(true)
    expect(moveOwnerAlive(value, 50_000, () => true)).toBe(false)
    expect(moveOwnerAlive(value, 20_000, () => false)).toBe(false)
    expect(moveOwnerAlive({ ...value, pid: process.pid }, 20_000, () => true)).toBe(false)
  })

  it('ignores a damaged record so the pointer alone decides', async () => {
    const { root } = await fixture()
    const file = path.join(root, 'data-move.json')
    await writeFile(file, '{"format":"nxt.desktop-data-move"')
    await expect(readDataMoveRecord(file)).resolves.toBeUndefined()
    await writeFile(file, JSON.stringify({ ...record('moving'), units: ['../escape'] }))
    await expect(readDataMoveRecord(file)).resolves.toBeUndefined()
    await expect(readDataMoveRecord(path.join(root, 'missing.json'))).resolves.toBeUndefined()
  })

  it('undoes a copy that crashed halfway', async () => {
    const { root, userData } = await fixture()
    const target = path.join(root, 'new', 'NXT')
    const plan = await planFor(userData, target, 'copy')
    const records: DataMoveRecord[] = []
    const controller = new AbortController()
    await expect(
      runDataMove(recordFor(plan), {
        ...io(records),
        signal: controller.signal,
        onProgress: (step) => {
          if (step.completedBytes > 0) controller.abort(new Error('power lost'))
        },
      }),
    ).rejects.toThrow()
    expect((await tree(target)).length).toBeGreaterThan(0)
    await undoDataMove(records.at(-1)!)
    await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('undoes a same-volume move that crashed between renames and mid-rewrite', async () => {
    const { root, userData } = await fixture()
    const before = await tree(userData)
    const target = path.join(root, 'new', 'NXT')
    const plan = await planFor(userData, target, 'move')
    const records: DataMoveRecord[] = []
    await runDataMove(recordFor(plan), io(records))
    // Simulate the state after a crash: half the units back in place, rewrites applied, marker written.
    const last = records.at(-1)!
    for (const unit of last.units.slice(0, 3))
      await rename(path.join(target, unit), path.join(userData, unit)).catch(() => undefined)
    await undoDataMove(last)
    expect(await tree(userData)).toEqual(before)
    // A second undo after another crash is harmless.
    await undoDataMove(last)
    expect(await tree(userData)).toEqual(before)
  })
})

describe('migration mode', () => {
  it('moves, writes the pointer atomically, completes the record and relaunches', async () => {
    const { root, userData } = await fixture()
    const files = dataLocationFiles(path.join(root, 'app-data'), getDesktopDistribution('preview'))
    const target = path.join(root, 'new', 'NXT')
    const plan = await planFor(userData, target, 'copy')
    const requested = createDataMoveRecord(plan, 1_000, 4242)
    await writeDataMoveRecord(files.record, requested)
    const published: string[] = []
    let relaunched = 0
    await expect(
      runDataMoveMode({
        files,
        record: requested,
        kind: 'migrate',
        publish: (state) => published.push(state.mode),
        checkSqlite: checkSqliteIntegrity,
        relaunch: () => {
          relaunched += 1
        },
      }),
    ).resolves.toBe('relaunched')
    expect(relaunched).toBe(1)
    expect(parseDataLocationPointer(await readFile(files.pointer, 'utf8'))).toBe(target)
    const completed = await readDataMoveRecord(files.record)
    expect(completed).toMatchObject({ phase: 'completed', target, method: 'copy' })
    expect(completed?.rewrites).toBeUndefined()
    expect(published).toContain('moving')
    expect(published.at(-1)).toBe('switching')
    expect((await readdir(path.dirname(files.pointer))).filter((name) => name.includes('.tmp-'))).toEqual([])
  })

  it('on failure undoes the move, keeps the pointer and records which file failed', async () => {
    const { root, userData } = await fixture()
    const files = dataLocationFiles(path.join(root, 'app-data'), getDesktopDistribution('preview'))
    const target = path.join(root, 'new', 'NXT')
    const plan = await planFor(userData, target, 'copy')
    const requested = createDataMoveRecord(plan, 1_000, 4242)
    await writeDataMoveRecord(files.record, requested)
    const published: { mode: string; failure?: unknown }[] = []
    await expect(
      runDataMoveMode({
        files,
        record: requested,
        kind: 'migrate',
        publish: (state) => published.push(state),
        checkSqlite: () => {
          throw new Error('integrity_check: page 2 is never used')
        },
        relaunch: () => {
          throw new Error('must not relaunch on failure')
        },
      }),
    ).resolves.toBe('stopped')
    await expect(lstat(files.pointer)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readDataMoveRecord(files.record)).toMatchObject({
      phase: 'failed',
      failure: { file: 'data/core.sqlite', message: '数据库检查未通过：integrity_check: page 2 is never used' },
    })
    expect(published.at(-1)).toMatchObject({ mode: 'failed', failure: { file: 'data/core.sqlite' } })
  })

  it('undoes an interrupted move on the next launch and records it as failed', async () => {
    const { root, userData } = await fixture()
    const before = await tree(userData)
    const files = dataLocationFiles(path.join(root, 'app-data'), getDesktopDistribution('preview'))
    const target = path.join(root, 'new', 'NXT')
    const plan = await planFor(userData, target, 'move')
    const records: DataMoveRecord[] = []
    await runDataMove(recordFor(plan), io(records))
    const crashed = records.at(-1)!
    await writeDataMoveRecord(files.record, crashed)
    expect(
      decideStartup({ record: crashed, migrationFlag: false, pointerRoot: userData, ownerAlive: false }).kind,
    ).toBe('undo')
    const published: string[] = []
    await expect(
      runDataMoveMode({
        files,
        record: crashed,
        kind: 'undo',
        publish: (state) => published.push(state.mode),
        checkSqlite: checkSqliteIntegrity,
        relaunch: () => undefined,
      }),
    ).resolves.toBe('stopped')
    expect(await tree(userData)).toEqual(before)
    expect(published).toEqual(['undoing', 'interrupted'])
    expect(await readDataMoveRecord(files.record)).toMatchObject({ phase: 'failed' })
  })
})

describe('path rewrites', () => {
  it('replaces only whole-segment prefixes of the old data root', () => {
    expect(
      rewriteJsonPaths(
        { a: '/old/data', b: '/old/data/dsh', c: '/old/database', d: ['/old/data/x'], e: 3, f: '/other/old/data' },
        ['/old/data'],
        '/new/data',
      ),
    ).toEqual({
      a: '/new/data',
      b: '/new/data/dsh',
      c: '/old/database',
      d: ['/new/data/x'],
      e: 3,
      f: '/other/old/data',
    })
  })

  it('lists units from the userData root and data/ in a stable order', async () => {
    const { userData } = await fixture()
    expect(await listMoveUnits(userData)).toEqual([
      'Cache',
      'Local State',
      'Local Storage',
      'Partitions',
      'data/assets',
      'data/core.sqlite',
      'data/dsh',
      'data/logs',
      'data/runtimes',
      'data/sessions.sqlite.nekro-nxt-reset-required.json',
      'data/workspaces',
      'instance-credentials.json',
      'instance-profiles.json',
      'local-host-port.json',
    ])
  })
})
