import BetterSqlite3 from 'better-sqlite3'
import { desc } from 'drizzle-orm'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
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
    this.#native.function('nxt_casefold', { deterministic: true }, (value) =>
      typeof value === 'string' ? value.toLocaleLowerCase() : '',
    )
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
    const migrations = readMigrationFiles({ migrationsFolder: migrationFolder })
    if (hasMigrationTable) {
      const known = new Set(migrations.map(({ folderMillis }) => folderMillis))
      const applied = this.db.select().from(migrationJournal).all()
      if (applied.some(({ createdAt }) => !known.has(createdAt))) {
        throw new Error('Core SQLite 包含当前版本未知迁移，拒绝降级启动。')
      }
    }
    const pending = migrations.filter(({ folderMillis }) => lastApplied === undefined || folderMillis > lastApplied)
    const checkIntegrity = (): void => {
      const violations = foreignKeyViolationSchema.parse(this.#native.pragma('foreign_key_check'))
      if (violations.length > 0) {
        throw new Error(`Core SQLite 存在 ${violations.length} 条外键违规，拒绝启动。`)
      }
    }
    if (pending.length === 0) {
      checkIntegrity()
      return
    }
    // Keep Drizzle's file and journal format, but own the commit so integrity
    // failure rolls back both schema changes and migration metadata.
    this.#native.pragma('foreign_keys = OFF')
    try {
      this.#native
        .transaction(() => {
          this.#native.exec(
            'CREATE TABLE IF NOT EXISTS __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)',
          )
          const record = this.#native.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
          for (const migration of pending) {
            for (const statement of migration.sql) this.#native.exec(statement)
            record.run(migration.hash, migration.folderMillis)
          }
          checkIntegrity()
        })
        .immediate()
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
