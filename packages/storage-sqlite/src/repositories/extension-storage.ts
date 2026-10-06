import { and, asc, eq, gt, sql } from 'drizzle-orm'
import { JsonValueSchema, type AgentId, type ExtensionId, type JsonValue } from '@nekro-nxt/contracts'
import type { DrizzleCoreDatabase } from '../database.js'
import { extensionStorageEntries } from '../schema.js'

export class ExtensionStorageQuotaError extends Error {
  constructor(
    message: string,
    readonly usedBytes: number,
    readonly quotaBytes: number,
  ) {
    super(message)
    this.name = 'ExtensionStorageQuotaError'
  }
}

export interface ExtensionStorageEntry {
  key: string
  value: JsonValue
  updatedAt: number
}

export interface ExtensionStorageListResult {
  entries: ExtensionStorageEntry[]
  next?: string
}

function getUtf8ByteSize(json: string): number {
  return new TextEncoder().encode(json).length
}

export function createExtensionStorageRepository(database: DrizzleCoreDatabase) {
  return {
    getExtensionStorageEntry({
      extensionId,
      owner,
      partition,
      key,
    }: {
      extensionId: ExtensionId
      owner: 'shared' | AgentId
      partition: string
      key: string
    }): JsonValue | undefined {
      const agentId = owner === 'shared' ? null : owner
      const row = database
        .select({ valueJson: extensionStorageEntries.valueJson })
        .from(extensionStorageEntries)
        .where(
          and(
            eq(extensionStorageEntries.extensionId, extensionId),
            eq(extensionStorageEntries.owner, owner),
            agentId ? eq(extensionStorageEntries.agentId, agentId) : sql`${extensionStorageEntries.agentId} IS NULL`,
            eq(extensionStorageEntries.partition, partition),
            eq(extensionStorageEntries.key, key),
          ),
        )
        .get()

      if (!row) return undefined
      return JsonValueSchema.parse(row.valueJson)
    },

    setExtensionStorageEntry({
      extensionId,
      owner,
      partition,
      key,
      value,
      updatedAt,
      quotaBytes,
    }: {
      extensionId: ExtensionId
      owner: 'shared' | AgentId
      partition: string
      key: string
      value: JsonValue
      updatedAt: number
      quotaBytes: number
    }): void {
      const valueJson = JSON.stringify(value)
      const newByteSize = getUtf8ByteSize(valueJson)

      if (newByteSize > 256 * 1024) {
        throw new Error('Single value exceeds 256 KiB limit.')
      }

      database.transaction(
        (tx) => {
          const agentId = owner === 'shared' ? null : owner

          // Get old value size if it exists
          const oldRow = tx
            .select({ byteSize: extensionStorageEntries.byteSize })
            .from(extensionStorageEntries)
            .where(
              and(
                eq(extensionStorageEntries.extensionId, extensionId),
                eq(extensionStorageEntries.owner, owner),
                agentId
                  ? eq(extensionStorageEntries.agentId, agentId)
                  : sql`${extensionStorageEntries.agentId} IS NULL`,
                eq(extensionStorageEntries.partition, partition),
                eq(extensionStorageEntries.key, key),
              ),
            )
            .get()

          const oldByteSize = oldRow?.byteSize ?? 0

          // Calculate total usage
          const result = tx
            .select({
              totalBytes: sql<number>`COALESCE(SUM(${extensionStorageEntries.byteSize}), 0)`,
            })
            .from(extensionStorageEntries)
            .where(eq(extensionStorageEntries.extensionId, extensionId))
            .get()

          const currentTotal = result?.totalBytes ?? 0
          const newTotal = currentTotal - oldByteSize + newByteSize

          if (newTotal > quotaBytes) {
            throw new ExtensionStorageQuotaError(
              `Extension storage quota exceeded: ${newTotal} bytes used, ${quotaBytes} bytes available.`,
              newTotal,
              quotaBytes,
            )
          }

          // Upsert the entry
          tx.insert(extensionStorageEntries)
            .values({
              extensionId,
              owner,
              agentId,
              partition,
              key,
              valueJson: value,
              byteSize: newByteSize,
              updatedAt,
            })
            .onConflictDoUpdate({
              target: [
                extensionStorageEntries.extensionId,
                extensionStorageEntries.owner,
                extensionStorageEntries.partition,
                extensionStorageEntries.key,
              ],
              set: {
                valueJson: value,
                byteSize: newByteSize,
                updatedAt,
              },
            })
            .run()
        },
        { behavior: 'immediate' },
      )
    },

    deleteExtensionStorageEntry({
      extensionId,
      owner,
      partition,
      key,
    }: {
      extensionId: ExtensionId
      owner: 'shared' | AgentId
      partition: string
      key: string
    }): boolean {
      const agentId = owner === 'shared' ? null : owner
      const result = database
        .delete(extensionStorageEntries)
        .where(
          and(
            eq(extensionStorageEntries.extensionId, extensionId),
            eq(extensionStorageEntries.owner, owner),
            agentId ? eq(extensionStorageEntries.agentId, agentId) : sql`${extensionStorageEntries.agentId} IS NULL`,
            eq(extensionStorageEntries.partition, partition),
            eq(extensionStorageEntries.key, key),
          ),
        )
        .run()
      return result.changes > 0
    },

    listExtensionStorageEntries({
      extensionId,
      owner,
      partition,
      prefix,
      limit = 50,
      after,
    }: {
      extensionId: ExtensionId
      owner: 'shared' | AgentId
      partition: string
      prefix?: string
      limit?: number
      after?: string
    }): ExtensionStorageListResult {
      if (limit < 1 || limit > 200) {
        throw new Error('Limit must be between 1 and 200')
      }

      const agentId = owner === 'shared' ? null : owner

      let whereConditions = and(
        eq(extensionStorageEntries.extensionId, extensionId),
        eq(extensionStorageEntries.owner, owner),
        agentId ? eq(extensionStorageEntries.agentId, agentId) : sql`${extensionStorageEntries.agentId} IS NULL`,
        eq(extensionStorageEntries.partition, partition),
      )

      if (prefix) {
        // instr is a literal match: % and _ keep no wildcard meaning.
        whereConditions = and(whereConditions, sql`instr(${extensionStorageEntries.key}, ${prefix}) = 1`)
      }

      if (after) {
        whereConditions = and(whereConditions, gt(extensionStorageEntries.key, after))
      }

      const rows = database
        .select({
          key: extensionStorageEntries.key,
          valueJson: extensionStorageEntries.valueJson,
          updatedAt: extensionStorageEntries.updatedAt,
        })
        .from(extensionStorageEntries)
        .where(whereConditions)
        .orderBy(asc(extensionStorageEntries.key))
        .limit(limit + 1)
        .all()

      const hasMore = rows.length > limit
      const entries = rows.slice(0, limit)

      const last = entries.at(-1)
      return {
        entries: entries.map((row) => ({
          key: row.key,
          value: JsonValueSchema.parse(row.valueJson),
          updatedAt: row.updatedAt,
        })),
        ...(hasMore && last !== undefined ? { next: last.key } : {}),
      }
    },

    extensionStorageUsage(extensionId: ExtensionId): { bytes: number; entries: number } {
      const result = database
        .select({
          bytes: sql<number>`COALESCE(SUM(${extensionStorageEntries.byteSize}), 0)`,
          entries: sql<number>`COUNT(*)`,
        })
        .from(extensionStorageEntries)
        .where(eq(extensionStorageEntries.extensionId, extensionId))
        .get()

      return {
        bytes: result?.bytes ?? 0,
        entries: result?.entries ?? 0,
      }
    },
  }
}

export type ExtensionStorageRepository = ReturnType<typeof createExtensionStorageRepository>
