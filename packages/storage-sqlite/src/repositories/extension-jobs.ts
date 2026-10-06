import { and, asc, eq, isNull, notInArray, sql } from 'drizzle-orm'
import type { AgentId, ChannelId, ExtensionId, JsonValue } from '@nekro-nxt/contracts'
import { AgentIdSchema, ChannelIdSchema, ExtensionIdSchema } from '@nekro-nxt/contracts'
import type { DrizzleCoreDatabase } from '../database.js'
import { extensionJobs } from '../schema.js'
import { z } from 'zod'

const JobIdSchema = z.string().regex(/^job_[0-9A-Za-z]+$/u)
type JobId = z.infer<typeof JobIdSchema>

export type ExtensionJobRecord = {
  id: JobId
  agentId: AgentId
  extensionId: ExtensionId | null
  channelId: ChannelId
  source: 'declared' | 'runtime' | 'reminder'
  declaredKey: string | null
  label: string
  scheduleKind: 'once' | 'cron'
  runAt: number | null
  cron: string | null
  timezone: string | null
  payloadJson: JsonValue
  nextRunAt: number | null
  lastFiredAt: number | null
  paused: boolean
  createdAt: number
}

export function createExtensionJobsRepository(database: DrizzleCoreDatabase) {
  return {
    createExtensionJob(record: ExtensionJobRecord): void {
      const {
        id,
        agentId,
        extensionId,
        channelId,
        source,
        declaredKey,
        label,
        scheduleKind,
        runAt,
        cron,
        timezone,
        payloadJson,
        nextRunAt,
        lastFiredAt,
        paused,
        createdAt,
      } = record

      if (source === 'declared') {
        // For declared jobs, check if it exists first and update if so
        database.transaction(
          (tx) => {
            const extensionIdCondition =
              extensionId === null ? isNull(extensionJobs.extensionId) : eq(extensionJobs.extensionId, extensionId)
            const declaredKeyCondition =
              declaredKey === null ? isNull(extensionJobs.declaredKey) : eq(extensionJobs.declaredKey, declaredKey)

            const existing = tx
              .select()
              .from(extensionJobs)
              .where(
                and(
                  eq(extensionJobs.agentId, agentId),
                  extensionIdCondition,
                  eq(extensionJobs.channelId, channelId),
                  declaredKeyCondition,
                  eq(extensionJobs.source, 'declared'),
                ),
              )
              .get()

            if (existing) {
              // Update existing declared job (but don't reset lastFiredAt)
              tx.update(extensionJobs)
                .set({
                  label,
                  scheduleKind,
                  runAt,
                  cron,
                  timezone,
                  payloadJson,
                  nextRunAt,
                })
                .where(eq(extensionJobs.id, id))
                .run()
            } else {
              // Insert new declared job
              tx.insert(extensionJobs)
                .values({
                  id,
                  agentId,
                  extensionId,
                  channelId,
                  source,
                  declaredKey,
                  label,
                  scheduleKind,
                  runAt,
                  cron,
                  timezone,
                  payloadJson,
                  nextRunAt,
                  lastFiredAt,
                  paused: paused ? 1 : 0,
                  createdAt,
                })
                .run()
            }
          },
          { behavior: 'immediate' },
        )
      } else {
        // Direct insert for runtime and reminder jobs
        database
          .insert(extensionJobs)
          .values({
            id,
            agentId,
            extensionId,
            channelId,
            source,
            declaredKey,
            label,
            scheduleKind,
            runAt,
            cron,
            timezone,
            payloadJson,
            nextRunAt,
            lastFiredAt,
            paused: paused ? 1 : 0,
            createdAt,
          })
          .run()
      }
    },

    getExtensionJob(id: JobId): ExtensionJobRecord | undefined {
      const row = database.select().from(extensionJobs).where(eq(extensionJobs.id, id)).get()
      if (!row) return undefined
      return mapRowToRecord(row)
    },

    listExtensionJobs(options: {
      agentId: AgentId
      extensionId?: ExtensionId | null
      channelId?: ChannelId
    }): ExtensionJobRecord[] {
      const conditions = [eq(extensionJobs.agentId, options.agentId)]

      if (options.extensionId !== undefined) {
        if (options.extensionId === null) {
          conditions.push(isNull(extensionJobs.extensionId))
        } else {
          conditions.push(eq(extensionJobs.extensionId, options.extensionId))
        }
      }

      if (options.channelId !== undefined) {
        conditions.push(eq(extensionJobs.channelId, options.channelId))
      }

      const rows = database
        .select()
        .from(extensionJobs)
        .where(and(...conditions))
        .all()
      return rows.map(mapRowToRecord)
    },

    deleteExtensionJob(id: JobId): boolean {
      const result = database.delete(extensionJobs).where(eq(extensionJobs.id, id)).run()
      return result.changes > 0
    },

    deleteDeclaredJobsExcept(options: { agentId: AgentId; extensionId: ExtensionId | null; keep: string[] }): number {
      const conditions = [eq(extensionJobs.agentId, options.agentId), eq(extensionJobs.source, 'declared')]

      if (options.extensionId === null) {
        conditions.push(isNull(extensionJobs.extensionId))
      } else {
        conditions.push(eq(extensionJobs.extensionId, options.extensionId))
      }

      // An empty keep list removes every declared job; NOT IN () is not valid SQL.
      if (options.keep.length > 0) conditions.push(notInArray(extensionJobs.declaredKey, options.keep))

      const result = database
        .delete(extensionJobs)
        .where(and(...conditions))
        .run()
      return result.changes
    },

    listDueExtensionJobs(now: number, limit: number): ExtensionJobRecord[] {
      const rows = database
        .select()
        .from(extensionJobs)
        .where(and(eq(extensionJobs.paused, 0), sql`${extensionJobs.nextRunAt} <= ${now}`))
        .orderBy(asc(extensionJobs.nextRunAt), asc(extensionJobs.id))
        .limit(limit)
        .all()
      return rows.map(mapRowToRecord)
    },

    recordExtensionJobFired(options: {
      id: JobId
      firedAt: number
      nextRunAt: number | null
      expectedNextRunAt: number | null
    }): boolean {
      const { id, firedAt, nextRunAt, expectedNextRunAt } = options

      return database.transaction(
        (tx) => {
          const row = tx.select().from(extensionJobs).where(eq(extensionJobs.id, id)).get()
          if (!row) return false

          // Optimistic concurrency: only update if the current nextRunAt matches expected
          if (row.nextRunAt !== expectedNextRunAt) {
            return false
          }

          tx.update(extensionJobs)
            .set({
              lastFiredAt: firedAt,
              nextRunAt,
            })
            .where(eq(extensionJobs.id, id))
            .run()

          return true
        },
        { behavior: 'immediate' },
      )
    },

    setExtensionJobsPaused(options: { agentId: AgentId; extensionId: ExtensionId | null; paused: boolean }): number {
      const conditions = [eq(extensionJobs.agentId, options.agentId)]

      if (options.extensionId === null) {
        conditions.push(isNull(extensionJobs.extensionId))
      } else {
        conditions.push(eq(extensionJobs.extensionId, options.extensionId))
      }

      const result = database
        .update(extensionJobs)
        .set({ paused: options.paused ? 1 : 0 })
        .where(and(...conditions))
        .run()
      return result.changes
    },

    countExtensionJobs(options: { agentId: AgentId; extensionId: ExtensionId | null }): number {
      const conditions = [eq(extensionJobs.agentId, options.agentId)]

      if (options.extensionId === null) {
        conditions.push(isNull(extensionJobs.extensionId))
      } else {
        conditions.push(eq(extensionJobs.extensionId, options.extensionId))
      }

      const result = database
        .select({ count: sql<number>`COUNT(*)` })
        .from(extensionJobs)
        .where(and(...conditions))
        .get()
      return result?.count ?? 0
    },
  }
}

function mapRowToRecord(row: {
  id: string
  agentId: string
  extensionId: string | null
  channelId: string
  source: 'declared' | 'runtime' | 'reminder'
  declaredKey: string | null
  label: string
  scheduleKind: 'once' | 'cron'
  runAt: number | null
  cron: string | null
  timezone: string | null
  payloadJson: JsonValue
  nextRunAt: number | null
  lastFiredAt: number | null
  paused: number
  createdAt: number
}): ExtensionJobRecord {
  return {
    id: JobIdSchema.parse(row.id),
    agentId: AgentIdSchema.parse(row.agentId),
    extensionId: row.extensionId ? ExtensionIdSchema.parse(row.extensionId) : null,
    channelId: ChannelIdSchema.parse(row.channelId),
    source: row.source,
    declaredKey: row.declaredKey,
    label: row.label,
    scheduleKind: row.scheduleKind,
    runAt: row.runAt,
    cron: row.cron,
    timezone: row.timezone,
    payloadJson: row.payloadJson,
    nextRunAt: row.nextRunAt,
    lastFiredAt: row.lastFiredAt,
    paused: row.paused === 1,
    createdAt: row.createdAt,
  }
}

export type ExtensionJobsRepository = ReturnType<typeof createExtensionJobsRepository>
