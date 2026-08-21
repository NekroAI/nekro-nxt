import BetterSqlite3 from 'better-sqlite3'
import { desc } from 'drizzle-orm'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { integer, sqliteTable } from 'drizzle-orm/sqlite-core'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { coreSchema } from './schema.js'

type NativeDatabase = InstanceType<typeof BetterSqlite3>
export type DrizzleCoreDatabase = BetterSQLite3Database<typeof coreSchema>

const MIGRATION_TABLE = '__drizzle_migrations'
const migrationJournal = sqliteTable(MIGRATION_TABLE, {
  createdAt: integer('created_at').notNull(),
})
const migrationFolder = fileURLToPath(new URL('../migrations', import.meta.url))

interface TableListRow {
  readonly schema: string
  readonly name: string
  readonly type: string
  readonly ncol: number
  readonly wr: number
  readonly strict: number
}

const tableListSchema = z.array(
  z
    .object({
      schema: z.string(),
      name: z.string(),
      type: z.string(),
      ncol: z.number().int().nonnegative(),
      wr: z.number().int().nonnegative(),
      strict: z.number().int().nonnegative(),
    })
    .strict(),
)

const foreignKeyViolationSchema = z.array(
  z
    .object({ table: z.string(), rowid: z.number().int().nullable(), parent: z.string(), fkid: z.number().int() })
    .strict(),
)
export class CoreDatabase {
  readonly db: DrizzleCoreDatabase
  readonly #native: NativeDatabase

  constructor(filename: string) {
    this.#native = new BetterSqlite3(filename)
    this.#native.pragma('foreign_keys = ON')
    this.#native.pragma('journal_mode = WAL')
    this.#native.pragma('busy_timeout = 5000')
    this.db = drizzle(this.#native, { schema: coreSchema })
  }

  migrate(): void {
    const tables: TableListRow[] = tableListSchema.parse(this.#native.pragma('table_list'))
    const userTables = tables.filter(({ name, type }) => type === 'table' && !name.startsWith('sqlite_'))
    if (userTables.length > 0 && !userTables.some(({ name }) => name === MIGRATION_TABLE)) {
      throw new Error('Core 开发数据库基线已重置；请删除现有数据库后重新启动。')
    }
    const hasMigrationTable = userTables.some(({ name }) => name === MIGRATION_TABLE)
    const lastApplied = hasMigrationTable
      ? this.db
          .select({ createdAt: migrationJournal.createdAt })
          .from(migrationJournal)
          .orderBy(desc(migrationJournal.createdAt))
          .limit(1)
          .get()?.createdAt
      : undefined
    const hasPendingMigrations = readMigrationFiles({ migrationsFolder: migrationFolder }).some(
      ({ folderMillis }) => lastApplied === undefined || folderMillis > lastApplied,
    )
    if (!hasPendingMigrations) return
    // SQLite cannot change PRAGMA foreign_keys inside the transaction opened by
    // Drizzle's migrator. Table-rebuild migrations therefore need enforcement
    // disabled before that transaction starts, followed by a full integrity
    // check before normal repository traffic is allowed.
    this.#native.pragma('foreign_keys = OFF')
    try {
      migrate(this.db, { migrationsFolder: migrationFolder })
      const violations = foreignKeyViolationSchema.parse(this.#native.pragma('foreign_key_check'))
      if (violations.length > 0) {
        throw new Error(`Core SQLite 迁移后存在 ${violations.length} 条外键违规，拒绝启动。`)
      }
    } finally {
      this.#native.pragma('foreign_keys = ON')
    }
  }

  pragma(name: 'foreign_keys' | 'journal_mode' | 'busy_timeout'): unknown {
    return this.#native.pragma(name, { simple: true })
  }

  backup(destination: string): Promise<void> {
    return this.#native.backup(destination).then(() => undefined)
  }

  close(): void {
    this.#native.close()
  }
}

export function openCoreDatabase(filename: string): CoreDatabase {
  return new CoreDatabase(filename)
}

export function openMigratedCoreDatabase(filename: string): Promise<CoreDatabase> {
  const database = openCoreDatabase(filename)
  try {
    database.migrate()
    return Promise.resolve(database)
  } catch (error) {
    database.close()
    return Promise.reject(error instanceof Error ? error : new Error(String(error), { cause: error }))
  }
}
