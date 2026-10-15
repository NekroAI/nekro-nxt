import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { z } from 'zod'
import {
  hostLogEntrySchema,
  type HostLogEntry,
  type HostLogQuery,
  type HostLogPage,
  type HostLogSettings,
  type HostLogSource,
} from '@nekro-nxt/contracts'

type StoredLog = Omit<HostLogEntry, 'id' | 'sequence'> & { receipt?: string }
const rowSchema = z.object({ sequence: z.number(), payload: z.string() })
type Row = z.infer<typeof rowSchema>
const databaseStatsSchema = z.object({
  count: z.number(),
  oldestTimestamp: z.string().nullable(),
  newestTimestamp: z.string().nullable(),
})
const scopes = [
  'extensionId',
  'revisionId',
  'connectionId',
  'agentId',
  'channelId',
  'sessionId',
  'episodeId',
  'operationId',
] as const

/** Disposable operational history; deliberately independent of Core's migrations and transactions. */
export class LogDatabase {
  readonly #db: Database.Database
  readonly #epoch: string
  readonly #file: string
  #settings: HostLogSettings
  constructor(file: string, settings: HostLogSettings) {
    this.#file = file
    this.#settings = settings
    this.#db = new Database(file)
    try {
      const version = Number(this.#db.pragma('user_version', { simple: true }))
      if (version > 1) throw new Error('日志格式来自更新的版本，原文件已保留。')
      this.#db.pragma('auto_vacuum = INCREMENTAL')
      this.#db.pragma('journal_mode = WAL')
      this.#db.pragma('synchronous = NORMAL')
      this.#db.pragma('busy_timeout = 0')
      this.#db.exec(`
        CREATE TABLE IF NOT EXISTS log_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS logs (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL,
          level TEXT NOT NULL, source_kind TEXT NOT NULL, source_id TEXT NOT NULL,
          payload TEXT NOT NULL, search_text TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS logs_time ON logs(timestamp);
        CREATE INDEX IF NOT EXISTS logs_source ON logs(source_kind, source_id, sequence);
        CREATE INDEX IF NOT EXISTS logs_level ON logs(level, sequence);
        PRAGMA user_version = 1;
      `)
      if (!this.#db.prepare("SELECT name FROM pragma_table_info('logs') WHERE name = 'receipt'").get())
        this.#db.exec('ALTER TABLE logs ADD COLUMN receipt TEXT')
      this.#db.exec('CREATE UNIQUE INDEX IF NOT EXISTS logs_receipt ON logs(receipt)')
      this.#db.prepare('INSERT OR IGNORE INTO log_meta VALUES (?, ?)').run('epoch', randomUUID())
      const epoch = z
        .object({ value: z.string() })
        .parse(this.#db.prepare('SELECT value FROM log_meta WHERE key = ?').get('epoch'))
      this.#epoch = epoch.value
      this.configure(settings)
    } catch (error) {
      this.#db.close()
      throw error
    }
  }
  configure(settings: HostLogSettings): void {
    this.#settings = settings
    const pageSize = Number(this.#db.pragma('page_size', { simple: true }))
    const pages = Math.floor((settings.maxSizeMiB * 1024 * 1024 * 0.85) / pageSize)
    this.#db.pragma(`max_page_count = ${pages}`)
  }
  cursor(sequence: number): string {
    return `${this.#epoch}:${sequence}`
  }
  #sequence(cursor: string | undefined): number | undefined {
    if (cursor === undefined) return undefined
    const separator = cursor.lastIndexOf(':')
    const sequence = Number(cursor.slice(separator + 1))
    if (separator < 1 || !Number.isSafeInteger(sequence) || sequence < 0) throw new Error('日志位置无效。')
    return cursor.slice(0, separator) === this.#epoch ? sequence : undefined
  }
  #head(): number {
    return (
      z
        .object({ seq: z.number() })
        .optional()
        .parse(this.#db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'logs'").get())?.seq ?? 0
    )
  }
  #entry(row: Row): HostLogEntry {
    return hostLogEntrySchema.parse({
      ...hostLogEntrySchema.omit({ id: true, sequence: true }).parse(JSON.parse(row.payload)),
      id: this.cursor(row.sequence),
      sequence: row.sequence,
    })
  }
  append(entries: readonly StoredLog[]): string {
    const insert = this.#db.prepare(
      'INSERT OR IGNORE INTO logs(timestamp, level, source_kind, source_id, payload, search_text, receipt) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    this.#db.transaction(() => {
      for (const { receipt, ...entry } of entries) {
        const payload = JSON.stringify(entry)
        insert.run(
          entry.timestamp,
          entry.level,
          entry.source.kind,
          entry.source.id,
          payload,
          `${entry.message}\n${JSON.stringify(entry.details ?? '')}\n${entry.code ?? ''}`.toLowerCase(),
          receipt ?? null,
        )
      }
    })()
    if (this.bytes() > this.#settings.maxSizeMiB * 1024 * 1024 * 0.9) this.cleanup(Date.now())
    return this.cursor(this.#head())
  }
  #where(query: HostLogQuery): { sql: string; values: Array<string | number> } {
    const clauses: string[] = []
    const values: Array<string | number> = []
    const list = (column: string, entries: readonly string[] | undefined) => {
      if (entries === undefined) return
      if (entries.length === 0) {
        clauses.push('0')
        return
      }
      clauses.push(`${column} IN (${entries.map(() => '?').join(',')})`)
      values.push(...entries)
    }
    list('level', query.levels)
    list('source_kind', query.sourceKinds)
    list('source_id', query.sourceIds)
    if (query.sources !== undefined) {
      clauses.push(
        query.sources.length ? `(${query.sources.map(() => '(source_kind = ? AND source_id = ?)').join(' OR ')})` : '0',
      )
      query.sources.forEach((source) => values.push(source.kind, source.id))
    }
    if (query.keyword) {
      clauses.push('instr(search_text, ?) > 0')
      values.push(query.keyword.toLowerCase())
    }
    if (query.from) {
      clauses.push('timestamp >= ?')
      values.push(query.from)
    }
    if (query.to) {
      clauses.push('timestamp <= ?')
      values.push(query.to)
    }
    for (const key of scopes) {
      const value = query.scope?.[key]
      if (value !== undefined) {
        clauses.push(`json_extract(payload, '$.scope.${key}') = ?`)
        values.push(value)
      }
    }
    return { sql: clauses.length ? clauses.join(' AND ') : '1', values }
  }
  query(query: HostLogQuery): HostLogPage {
    const filter = this.#where(query)
    const head = this.#head()
    const requested = query.afterCursor ?? query.olderCursor ?? query.headCursor
    const requestedSequence = this.#sequence(requested)
    const reset = requested !== undefined && requestedSequence === undefined
    const oldest = z
      .object({ value: z.number().nullable() })
      .parse(this.#db.prepare('SELECT min(sequence) AS value FROM logs').get()).value
    const expired = !reset && requestedSequence !== undefined && requestedSequence < (oldest ?? head + 1) - 1
    const after = reset ? undefined : this.#sequence(query.afterCursor)
    const older = reset ? undefined : this.#sequence(query.olderCursor)
    const ceiling = Math.min(this.#sequence(query.headCursor) ?? head, head)
    filter.sql += ' AND sequence <= ?'
    filter.values.push(ceiling)
    if (after !== undefined) {
      filter.sql += ' AND sequence > ?'
      filter.values.push(after)
    }
    if (older !== undefined) {
      filter.sql += ' AND sequence < ?'
      filter.values.push(older)
    }
    const forward = after !== undefined
    const rows = z
      .array(rowSchema)
      .parse(
        this.#db
          .prepare(
            `SELECT sequence, payload FROM logs WHERE ${filter.sql} ORDER BY sequence ${forward ? 'ASC' : 'DESC'} LIMIT ?`,
          )
          .all(...filter.values, (query.limit ?? 500) + 1),
      )
    const selected: Row[] = []
    let bytes = 0
    for (const row of rows.slice(0, query.limit ?? 500)) {
      if (selected.length && bytes + Buffer.byteLength(row.payload) > 1024 * 1024) break
      selected.push(row)
      bytes += Buffer.byteLength(row.payload)
    }
    const hasMore = rows.length > selected.length
    if (!forward) selected.reverse()
    const entries = selected.map((row) => this.#entry(row))
    return {
      entries,
      hasMore,
      olderCursor: entries[0]?.id ?? null,
      headCursor: forward && hasMore ? entries.at(-1)!.id : this.cursor(ceiling),
      ...(reset ? { gap: 'reset' as const } : expired ? { gap: 'expired' as const } : {}),
    }
  }
  get(id: string): HostLogEntry | undefined {
    const sequence = this.#sequence(id)
    if (sequence === undefined) return undefined
    const row = rowSchema
      .optional()
      .parse(this.#db.prepare('SELECT sequence, payload FROM logs WHERE sequence = ?').get(sequence))
    return row === undefined ? undefined : this.#entry(row)
  }
  sources(): HostLogSource[] {
    const rows = z
      .array(rowSchema)
      .parse(
        this.#db
          .prepare(
            'SELECT sequence, payload FROM logs WHERE sequence IN (SELECT max(sequence) FROM logs GROUP BY source_kind, source_id)',
          )
          .all(),
      )
    return rows.map((row) => this.#entry(row).source)
  }
  bytes(): number {
    return ['', '-wal', '-shm'].reduce((sum, suffix) => {
      try {
        return sum + statSync(`${this.#file}${suffix}`).size
      } catch {
        return sum
      }
    }, 0)
  }
  stats() {
    const result = databaseStatsSchema.parse(
      this.#db
        .prepare(
          'SELECT count(*) AS count, min(timestamp) AS oldestTimestamp, max(timestamp) AS newestTimestamp FROM logs',
        )
        .get(),
    )
    return { ...result, bytes: this.bytes(), headCursor: this.cursor(this.#head()) }
  }
  cleanup(now: number, force = false): void {
    this.#db
      .prepare('DELETE FROM logs WHERE timestamp < ?')
      .run(new Date(now - this.#settings.retentionDays * 86400_000).toISOString())
    this.#db.pragma('wal_checkpoint(TRUNCATE)')
    this.#db.pragma('incremental_vacuum')
    const budget = this.#settings.maxSizeMiB * 1024 * 1024
    let rounds = 0
    while ((force || this.bytes() > budget * 0.8) && rounds++ < 100) {
      force = false
      const result = this.#db
        .prepare('DELETE FROM logs WHERE sequence IN (SELECT sequence FROM logs ORDER BY sequence LIMIT 2000)')
        .run()
      this.#db.pragma('incremental_vacuum')
      this.#db.pragma('wal_checkpoint(TRUNCATE)')
      if (result.changes === 0) break
    }
  }
  async export(query: HostLogQuery, format: 'text' | 'jsonl', cancelled: () => boolean): Promise<Uint8Array> {
    const { sql, values } = this.#where(query)
    const chunks: Buffer[] = []
    let size = 0
    const end = Date.now() + 60_000
    const add = (text: string) => {
      const chunk = Buffer.from(text)
      size += chunk.length
      if (size > 50 * 1024 * 1024) throw new Error('导出超过 50 MiB，请缩小时间范围。')
      chunks.push(chunk)
    }
    this.#db.exec('BEGIN')
    try {
      const head = this.#head()
      let after = 0
      for (;;) {
        if (cancelled()) throw new Error('导出已取消。')
        if (Date.now() > end) throw new Error('导出超时，请缩小时间范围。')
        const rows = z
          .array(rowSchema)
          .parse(
            this.#db
              .prepare(
                `SELECT sequence, payload FROM logs WHERE ${sql} AND sequence > ? AND sequence <= ? ORDER BY sequence LIMIT 250`,
              )
              .all(...values, after, head),
          )
        for (const row of rows) {
          const entry = this.#entry(row)
          add(
            format === 'jsonl'
              ? `${JSON.stringify(entry)}\n`
              : `${entry.timestamp} ${entry.level.toUpperCase()} [${entry.source.name}] ${entry.message}\n${entry.details === undefined ? '' : `${JSON.stringify(entry.details, null, 2)}\n`}`,
          )
          after = row.sequence
        }
        if (rows.length < 250) break
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      return Buffer.concat(chunks)
    } finally {
      this.#db.exec('ROLLBACK')
    }
  }
  close(): void {
    this.#db.close()
  }
}
