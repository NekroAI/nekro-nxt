import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import {
  acquireSqliteFileLease,
  createSqliteFileSnapshot,
  readBackupAgentIds,
  verifySqliteSnapshot,
} from '../src/backup.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})
const fixture = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nxt-backup-files-'))
  directories.push(directory)
  return {
    directory,
    source: path.join(directory, 'source.sqlite'),
    destination: path.join(directory, 'snapshot.sqlite'),
  }
}

describe('public SQLite file backup helpers', () => {
  it('excludes concurrent owners and releases without replacing the SQLite inode', async () => {
    const { source } = await fixture()
    const unlock = acquireSqliteFileLease(source)
    const inode = (await stat(source)).ino
    try {
      expect(() => acquireSqliteFileLease(source)).toThrow(/locked/u)
    } finally {
      unlock()
    }
    unlock()
    expect((await stat(source)).ino).toBe(inode)
    const reacquired = acquireSqliteFileLease(source)
    reacquired()
    expect((await stat(source)).ino).toBe(inode)
  })

  it('enumerates valid agent IDs without requiring current Core schema or creating missing sources', async () => {
    const { source } = await fixture()
    expect(() => readBackupAgentIds(source)).toThrow()
    await expect(stat(source)).rejects.toMatchObject({ code: 'ENOENT' })
    const database = new BetterSqlite3(source)
    try {
      expect(readBackupAgentIds(source)).toEqual([])
      database.exec(
        "CREATE TABLE agent_definitions(id TEXT PRIMARY KEY); INSERT INTO agent_definitions VALUES ('agt_B'), ('agt_A')",
      )
      expect(readBackupAgentIds(source)).toEqual(['agt_A', 'agt_B'])
      database.prepare('INSERT INTO agent_definitions VALUES (?)').run('../outside-root')
      expect(() => readBackupAgentIds(source)).toThrow()
      expect(database.prepare('SELECT count(*) AS count FROM agent_definitions').get()).toEqual({ count: 3 })
    } finally {
      database.close()
    }
  })

  it('checks and snapshots a checkpointed WAL source without creating source or verification sidecars', async () => {
    const { source, destination, directory } = await fixture()
    const database = new BetterSqlite3(source)
    database.pragma('journal_mode = WAL')
    database.exec("CREATE TABLE agent_definitions(id TEXT); INSERT INTO agent_definitions VALUES ('agt_SYNTHETIC')")
    database.close()
    expect(await readdir(directory)).toEqual(['source.sqlite'])
    verifySqliteSnapshot(source)
    expect(readBackupAgentIds(source)).toEqual(['agt_SYNTHETIC'])
    expect(await readdir(directory)).toEqual(['source.sqlite'])
    await createSqliteFileSnapshot(source, destination)
    verifySqliteSnapshot(destination)
    expect((await readdir(directory)).sort()).toEqual(['snapshot.sqlite', 'source.sqlite'])
  })

  it('snapshots uncheckpointed committed WAL and independently verifies the result', async () => {
    const { source, destination, directory } = await fixture()
    const database = new BetterSqlite3(source)
    try {
      database.pragma('journal_mode = WAL')
      database.pragma('wal_autocheckpoint = 0')
      database.exec("CREATE TABLE facts(value TEXT); INSERT INTO facts VALUES ('committed-in-wal')")
      await createSqliteFileSnapshot(source, destination)
      expect(() => verifySqliteSnapshot(destination)).not.toThrow()
      expect((await readdir(directory)).filter((name) => name.startsWith('snapshot.sqlite'))).toEqual([
        'snapshot.sqlite',
      ])
      const snapshot = new BetterSqlite3(destination, { readonly: true })
      try {
        expect(snapshot.prepare('SELECT value FROM facts').all()).toEqual([{ value: 'committed-in-wal' }])
      } finally {
        snapshot.close()
      }
      const corrupt = path.join(directory, 'corrupt.sqlite')
      await writeFile(corrupt, 'not a database')
      expect(() => verifySqliteSnapshot(corrupt)).toThrow()
      await expect(
        createSqliteFileSnapshot(path.join(directory, 'missing.sqlite'), path.join(directory, 'missing-copy.sqlite')),
      ).rejects.toThrow()
    } finally {
      database.close()
    }
  })
})
