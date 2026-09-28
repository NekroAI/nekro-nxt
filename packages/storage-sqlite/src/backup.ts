import BetterSqlite3 from 'better-sqlite3'
import { backup, DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { openReadOnlySqlite } from './readonly-sqlite.js'
import { AgentIdSchema } from '@nekro-nxt/contracts'
import { lstat, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { CoreDatabase } from './database.js'

export async function backupCoreDatabase(database: CoreDatabase, destination: string): Promise<void> {
  await database.backup(destination)
}

/** Hold an OS-backed lease on a stable SQLite inode. Never unlink the lock database. */
export function acquireSqliteFileLease(filename: string): () => void {
  const database = new BetterSqlite3(filename, { timeout: 0 })
  try {
    database.pragma('journal_mode = DELETE')
    database.exec('BEGIN EXCLUSIVE')
  } catch (error) {
    database.close()
    throw error
  }
  let released = false
  return () => {
    if (released) return
    released = true
    try {
      database.exec('ROLLBACK')
    } finally {
      database.close()
    }
  }
}

/** Enumerate only explicitly owned agent workspace directories, without migrating Core. */
export function readBackupAgentIds(databasePath: string): readonly string[] {
  const database = openReadOnlySqlite(databasePath)
  try {
    const table = database
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'agent_definitions'")
      .get()
    if (table === undefined) return []
    return z
      .array(z.object({ id: AgentIdSchema }))
      .parse(database.prepare('SELECT id FROM agent_definitions ORDER BY id').all())
      .map(({ id }) => id)
  } finally {
    database.close()
  }
}

/** SQLite's backup API includes committed WAL content in the destination snapshot. */
export async function createSqliteFileSnapshot(source: string, destination: string): Promise<void> {
  const database = openReadOnlySqlite(source)
  try {
    await backup(database, destination)
  } finally {
    database.close()
  }
  // backup inherits the source journal mode. Finalize only the destination so
  // read-only verification/restoration cannot create unmanifested WAL sidecars.
  const snapshot = new BetterSqlite3(destination, { fileMustExist: true })
  try {
    snapshot.pragma('journal_mode = DELETE')
  } finally {
    snapshot.close()
  }
}

export function verifySqliteSnapshot(filename: string): void {
  const uri = pathToFileURL(filename)
  uri.search = '?mode=ro&immutable=1'
  const database = new DatabaseSync(uri.href, { readOnly: true })
  try {
    const checks = z.array(z.object({ quick_check: z.string() })).parse(database.prepare('PRAGMA quick_check').all())
    if (checks.length !== 1 || checks[0]?.quick_check !== 'ok') throw new Error('SQLite snapshot failed quick_check.')
  } finally {
    database.close()
  }
}

export interface SqliteBackupSource {
  readonly name: string
  readonly filename: string
}

export interface SqliteBackupManifest {
  readonly format: 'nxt.sqlite-backup-set'
  readonly version: 1
  readonly createdAt: number
  readonly databases: readonly { readonly name: string; readonly filename: string }[]
}

export const SqliteBackupManifestSchema = z
  .object({
    format: z.literal('nxt.sqlite-backup-set'),
    version: z.literal(1),
    createdAt: z.number().int().nonnegative(),
    databases: z.array(z.object({ name: z.string(), filename: z.string() }).strict()),
  })
  .strict()

const isMissing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT'

export async function createSqliteBackupSet(
  sources: readonly SqliteBackupSource[],
  destination: string,
  createdAt = Date.now(),
): Promise<SqliteBackupManifest> {
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new TypeError('Backup createdAt must be non-negative.')
  if (sources.length === 0) throw new TypeError('Backup set requires at least one database.')
  try {
    await lstat(destination)
    throw new Error(`Backup destination already exists: ${destination}`)
  } catch (error) {
    if (!isMissing(error)) throw error
  }
  const names = new Set<string>()
  for (const source of sources) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(source.name) || names.has(source.name)) {
      throw new TypeError(`Backup database name must be unique and kebab-case: ${source.name}`)
    }
    if (source.filename === ':memory:' || !path.isAbsolute(source.filename)) {
      throw new TypeError(`Backup source must be an absolute on-disk SQLite path: ${source.name}`)
    }
    names.add(source.name)
  }

  const staging = await mkdtemp(`${destination}.staging-`)
  const databases = sources.map(({ name }) => ({ name, filename: `${name}.sqlite` }))
  const manifest: SqliteBackupManifest = {
    format: 'nxt.sqlite-backup-set',
    version: 1,
    createdAt,
    databases,
  }
  try {
    for (const [index, source] of sources.entries()) {
      const database = new BetterSqlite3(source.filename, { readonly: true })
      try {
        const target = databases[index]
        if (target === undefined) throw new Error('Backup manifest index is inconsistent.')
        await database.backup(path.join(staging, target.filename))
      } finally {
        database.close()
      }
    }
    await writeFile(path.join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    await rename(staging, destination)
    return manifest
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
}
