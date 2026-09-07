import BetterSqlite3 from 'better-sqlite3'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openMigratedCoreDatabase } from '../src/database.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})
const filename = async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nxt-migration-'))
  directories.push(directory)
  return path.join(directory, 'core.sqlite')
}

describe('migration commit boundary', () => {
  it('rolls back the migration journal and schema when integrity fails, including on retry', async () => {
    const file = await filename()
    const native = new BetterSqlite3(file)
    native.exec(`
      CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC);
      CREATE TABLE fixture_parent (id INTEGER PRIMARY KEY);
      CREATE TABLE fixture_child (parent_id INTEGER REFERENCES fixture_parent(id));
    `)
    native.pragma('foreign_keys = OFF')
    native.exec('INSERT INTO fixture_child VALUES (42)')
    native.close()
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(openMigratedCoreDatabase(file)).rejects.toThrow('外键违规')
      const inspected = new BetterSqlite3(file)
      try {
        expect(inspected.prepare('SELECT count(*) AS count FROM __drizzle_migrations').get()).toEqual({ count: 0 })
        expect(inspected.prepare("SELECT name FROM sqlite_master WHERE name = 'agents'").get()).toBeUndefined()
        expect(inspected.prepare('SELECT parent_id FROM fixture_child').get()).toEqual({ parent_id: 42 })
      } finally {
        inspected.close()
      }
    }
  })

  it('checks integrity even when no migration is pending', async () => {
    const file = await filename()
    const database = await openMigratedCoreDatabase(file)
    database.close()
    const native = new BetterSqlite3(file)
    native.exec(
      'CREATE TABLE fixture_parent (id INTEGER PRIMARY KEY); CREATE TABLE fixture_child (parent_id INTEGER REFERENCES fixture_parent(id))',
    )
    native.pragma('foreign_keys = OFF')
    native.exec('INSERT INTO fixture_child VALUES (42)')
    native.close()
    await expect(openMigratedCoreDatabase(file)).rejects.toThrow('外键违规')
  })

  it('rejects future migration metadata without modifying it', async () => {
    const file = await filename()
    const database = await openMigratedCoreDatabase(file)
    database.close()
    const native = new BetterSqlite3(file)
    native
      .prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
      .run('synthetic-future', Number.MAX_SAFE_INTEGER)
    native.close()
    await expect(openMigratedCoreDatabase(file)).rejects.toThrow('未知迁移')
  })
})
