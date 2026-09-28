import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  completeDshSessionStoragePreparation,
  DSH_SESSION_APPLICATION_ID,
  prepareDshSessionStorage,
  preflightDshSessionStorage,
} from '@nekro-nxt/storage-sqlite'

const directories: string[] = []
const archiveDate = new Date('2026-08-21T08:00:00.000Z')
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})
const fixture = async (schema?: number, applicationId = DSH_SESSION_APPLICATION_ID) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nxt-dsh-storage-'))
  directories.push(directory)
  const databasePath = path.join(directory, 'sessions.sqlite')
  const sessionRoot = path.join(directory, 'dsh', 'sessions')
  if (schema !== undefined) {
    const database = new DatabaseSync(databasePath)
    if (schema === 17 && applicationId === DSH_SESSION_APPLICATION_ID) {
      database.exec('PRAGMA foreign_keys = OFF')
      database.exec(await readFile(new URL('./fixtures/dsh-sqlite-schema17.sql', import.meta.url), 'utf8'))
      expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    } else {
      database.exec('CREATE TABLE synthetic_events (value TEXT NOT NULL)')
      database.prepare('INSERT INTO synthetic_events VALUES (?)').run('synthetic-session-event')
      database.exec(`PRAGMA application_id = ${applicationId}; PRAGMA user_version = ${schema}`)
    }
    database.close()
  }
  return { directory, databasePath, sessionRoot }
}

/** Kill after COMMIT, without SQLite close/checkpoint, and wait for all OS handles to leave. */
const leaveCommittedWalAfterCrash = async (databasePath: string): Promise<void> => {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `import { DatabaseSync } from 'node:sqlite'
       const database = new DatabaseSync(process.argv[1])
       database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=0')
       database.exec("INSERT INTO synthetic_events VALUES ('committed-in-wal')")
       process.send('wal-committed')
       setInterval(() => { if (!database.isOpen) process.exit(2) }, 1000)`,
      databasePath,
    ],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
  )
  await new Promise<void>((resolve, reject) => {
    let committed = false
    let timedOut = false
    let stderr = ''
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk
    })
    const deadline = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, 10_000)
    child.once('error', (error) => {
      clearTimeout(deadline)
      reject(error)
    })
    child.on('message', (message) => {
      if (message !== 'wal-committed') return
      committed = true
      child.kill('SIGKILL')
    })
    child.once('close', (code, signal) => {
      clearTimeout(deadline)
      if (committed && !timedOut && (code !== 0 || signal !== null)) resolve()
      else
        reject(new Error(`WAL crash fixture failed (timeout=${timedOut}, code=${code}, signal=${signal}): ${stderr}`))
    })
  })
}

describe('DSH Session storage preparation', () => {
  it.each([15, 17, 18])('preflights schema %i without writing files or initializing storage', async (schema) => {
    const { directory, databasePath } = await fixture(schema)
    const before = await readFile(databasePath)
    const filesBefore = await readdir(directory)
    if (schema === 18) await expect(preflightDshSessionStorage({ databasePath })).rejects.toThrow('unsupported')
    else await expect(preflightDshSessionStorage({ databasePath })).resolves.toBeUndefined()
    expect(await readFile(databasePath)).toEqual(before)
    expect(await readdir(directory)).toEqual(filesBefore)
  })

  it('preflight reads a future schema committed in WAL instead of trusting the older main header', async () => {
    const { directory, databasePath } = await fixture(17)
    const source = new DatabaseSync(databasePath)
    source.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA user_version=18')
    try {
      const files = await readdir(directory)
      const mainBefore = await readFile(databasePath)
      const walBefore = await readFile(`${databasePath}-wal`)
      await expect(preflightDshSessionStorage({ databasePath })).rejects.toThrow('unsupported')
      expect(await readdir(directory)).toEqual(files)
      expect(await readFile(databasePath)).toEqual(mainBefore)
      expect(await readFile(`${databasePath}-wal`)).toEqual(walBefore)
    } finally {
      source.close()
    }
  })

  it('preflight never creates a missing data root', async () => {
    const { directory } = await fixture()
    const parent = path.join(directory, 'missing-data-root')
    await preflightDshSessionStorage({ databasePath: path.join(parent, 'sessions.sqlite') })
    await expect(stat(parent)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('initializes JSONL once and preserves new Session files across product restarts', async () => {
    const { databasePath, sessionRoot } = await fixture()
    expect(await prepareDshSessionStorage({ databasePath })).toEqual({
      kind: 'new',
      sessionRoot,
      sessionCompatibilityId: 'jsonl-v4',
    })
    await writeFile(path.join(sessionRoot, 'synthetic.jsonl'), '{"synthetic":true}\n')
    expect(await prepareDshSessionStorage({ databasePath })).toEqual({
      kind: 'compatible',
      sessionRoot,
      sessionCompatibilityId: 'jsonl-v4',
    })
    expect(await readFile(path.join(sessionRoot, 'synthetic.jsonl'), 'utf8')).toBe('{"synthetic":true}\n')
    await expect(stat(databasePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([15, 17])(
    'archives owned schema %i, keeps verified originals, and repeats completion safely',
    async (schema) => {
      const { databasePath, sessionRoot } = await fixture(schema)
      const before = await readFile(databasePath)
      const result = await prepareDshSessionStorage({ databasePath, now: () => archiveDate })
      if (result.kind !== 'archived') throw new Error('Expected archive')
      expect(result).toMatchObject({ schemaVersion: schema, sessionRoot, sessionCompatibilityId: 'jsonl-v4' })
      expect(result.manifest).toMatchObject({
        formatVersion: 2,
        originalSchema: schema,
        targetCompatibilityId: 'jsonl-v4',
      })
      expect(await readFile(path.join(result.archivePath, 'original-sessions.sqlite'))).toEqual(before)
      const snapshot = new DatabaseSync(path.join(result.archivePath, 'sessions.sqlite'), { readOnly: true })
      try {
        expect(snapshot.prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' })
        expect(
          snapshot
            .prepare(
              schema === 17 ? 'SELECT count(*) AS count FROM events' : 'SELECT count(*) AS count FROM synthetic_events',
            )
            .get(),
        ).toEqual({ count: schema === 17 ? 2 : 1 })
      } finally {
        snapshot.close()
      }
      await expect(stat(databasePath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await prepareDshSessionStorage({ databasePath })).toEqual(result)
      await expect(completeDshSessionStoragePreparation(databasePath, 'wrong')).rejects.toThrow('migration ID mismatch')
      await completeDshSessionStoragePreparation(databasePath, result.migrationId)
      await completeDshSessionStoragePreparation(databasePath, result.migrationId)
      expect(await prepareDshSessionStorage({ databasePath })).toMatchObject({ kind: 'compatible' })
    },
  )

  it('includes uncheckpointed WAL data in the verified standalone snapshot', async () => {
    const { databasePath } = await fixture(15)
    await leaveCommittedWalAfterCrash(databasePath)
    expect((await stat(`${databasePath}-wal`)).size).toBeGreaterThan(32)
    // Immutable reads only the main file, proving the second row still lives in WAL.
    const mainUri = pathToFileURL(databasePath)
    mainUri.search = '?mode=ro&immutable=1'
    const source = new DatabaseSync(mainUri.href, { readOnly: true })
    try {
      expect(source.prepare('SELECT count(*) AS count FROM synthetic_events').get()).toEqual({ count: 1 })
    } finally {
      source.close()
    }
    const result = await prepareDshSessionStorage({ databasePath })
    if (result.kind !== 'archived') throw new Error('Expected archive')
    expect(result.manifest.sourceFiles.map(({ suffix }) => suffix)).toEqual(['', '-wal'])
    const snapshot = new DatabaseSync(path.join(result.archivePath, 'sessions.sqlite'), { readOnly: true })
    try {
      expect(snapshot.prepare('SELECT value FROM synthetic_events ORDER BY rowid').all()).toEqual([
        { value: 'synthetic-session-event' },
        { value: 'committed-in-wal' },
      ])
    } finally {
      snapshot.close()
    }
    await expect(stat(path.join(result.archivePath, 'original-sessions.sqlite-wal'))).resolves.toBeDefined()
  }, 30_000)

  it.each(['archive-published', 'reset-pending', 'source-retired', 'target-prepared'] as const)(
    'resumes after interruption at %s without creating a second archive',
    async (failurePhase) => {
      const { databasePath, directory } = await fixture(17)
      await expect(
        prepareDshSessionStorage({
          databasePath,
          onProgress(phase) {
            if (phase === failurePhase) throw new Error('synthetic power loss')
          },
        }),
      ).rejects.toThrow('synthetic power loss')
      const retry = await prepareDshSessionStorage({ databasePath })
      if (retry.kind !== 'archived') throw new Error('Expected archive')
      const archives = await readdir(path.join(directory, 'dsh', 'session-archives'))
      expect(archives.filter((entry) => !entry.startsWith('.'))).toHaveLength(1)
      await completeDshSessionStoragePreparation(databasePath, retry.migrationId)
      expect(await prepareDshSessionStorage({ databasePath })).toMatchObject({ kind: 'compatible' })
    },
  )

  it('resumes interruption after only the main SQLite file was moved', async () => {
    const { directory, databasePath } = await fixture(15)
    await expect(
      prepareDshSessionStorage({
        databasePath,
        onProgress(phase) {
          if (phase === 'reset-pending') throw new Error('interrupted')
        },
      }),
    ).rejects.toThrow('interrupted')
    const archives = await readdir(path.join(directory, 'dsh', 'session-archives'))
    const archivePath = path.join(directory, 'dsh', 'session-archives', archives[0]!)
    await rename(databasePath, path.join(archivePath, 'original-sessions.sqlite'))
    expect(await prepareDshSessionStorage({ databasePath })).toMatchObject({ kind: 'archived', archivePath })
  })

  it('refuses a corrupted archive on retry and preserves the source', async () => {
    const { databasePath, directory } = await fixture(17)
    await expect(
      prepareDshSessionStorage({
        databasePath,
        onProgress(phase) {
          if (phase === 'reset-pending') throw new Error('interrupted')
        },
      }),
    ).rejects.toThrow('interrupted')
    const [archive] = await readdir(path.join(directory, 'dsh', 'session-archives'))
    await writeFile(path.join(directory, 'dsh', 'session-archives', archive!, 'sessions.sqlite'), 'corrupt')
    const before = await readFile(databasePath)
    await expect(prepareDshSessionStorage({ databasePath })).rejects.toThrow('checksum mismatch')
    expect(await readFile(databasePath)).toEqual(before)
  })

  it('refuses to discard a legacy writer change after the archive was published', async () => {
    const { databasePath } = await fixture(15)
    await expect(
      prepareDshSessionStorage({
        databasePath,
        onProgress(phase) {
          if (phase === 'reset-pending') throw new Error('interrupted')
        },
      }),
    ).rejects.toThrow('interrupted')
    const changed = new DatabaseSync(databasePath)
    changed.exec("INSERT INTO synthetic_events VALUES ('late-write')")
    changed.close()
    await expect(prepareDshSessionStorage({ databasePath })).rejects.toThrow('source changed')
    await expect(stat(databasePath)).resolves.toBeDefined()
  })

  it.each([
    { label: 'unknown schema', schema: 16, applicationId: DSH_SESSION_APPLICATION_ID },
    { label: 'future schema', schema: 18, applicationId: DSH_SESSION_APPLICATION_ID },
    { label: 'foreign application', schema: 15, applicationId: 42 },
    { label: 'unversioned database', schema: 0, applicationId: 0 },
  ])('rejects $label without changing the source', async ({ schema, applicationId }) => {
    const { databasePath } = await fixture(schema, applicationId)
    const before = await readFile(databasePath)
    await expect(prepareDshSessionStorage({ databasePath })).rejects.toThrow('DSH Session database')
    expect(await readFile(databasePath)).toEqual(before)
  })

  it('refuses unidentified JSONL data and a future compatibility marker', async () => {
    const { directory, databasePath, sessionRoot } = await fixture()
    await mkdir(sessionRoot, { recursive: true })
    await writeFile(path.join(sessionRoot, 'old.jsonl'), 'preserve-me')
    await expect(prepareDshSessionStorage({ databasePath })).rejects.toThrow('Unidentified non-empty')
    await writeFile(
      path.join(directory, 'dsh', 'session-storage.json'),
      JSON.stringify({
        formatVersion: 1,
        sessionCompatibilityId: 'jsonl-v99',
        sessionRoot,
      }),
    )
    await expect(prepareDshSessionStorage({ databasePath })).rejects.toThrow()
    expect(await readFile(path.join(sessionRoot, 'old.jsonl'), 'utf8')).toBe('preserve-me')
  })

  it('rejects live and unreadable startup locks and reclaims a dead owner', async () => {
    const { databasePath } = await fixture()
    const lockPath = `${databasePath}.nekro-nxt-startup.lock`
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, acquiredAt: archiveDate.toISOString() }))
    await expect(prepareDshSessionStorage({ databasePath })).rejects.toThrow('owns the DSH Session startup lock')
    await writeFile(lockPath, 'partial')
    await expect(prepareDshSessionStorage({ databasePath })).rejects.toThrow()
    await writeFile(lockPath, JSON.stringify({ pid: 2147483647, acquiredAt: archiveDate.toISOString() }))
    expect(await prepareDshSessionStorage({ databasePath })).toMatchObject({ kind: 'new' })
  })
})
