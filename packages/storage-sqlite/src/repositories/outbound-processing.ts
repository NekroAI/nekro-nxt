import { and, eq, isNull } from 'drizzle-orm'
import type { AgentId, ChannelId, EpisodeId, ExtensionId, MessagePart, OutboundIntentId } from '@nekro-nxt/contracts'
import type { DrizzleCoreDatabase } from '../database.js'
import { agentOutboundOrders, outboundProcessing } from '../schema.js'

export interface OutboundProcessingRecord {
  readonly id: string
  readonly agentId: AgentId
  readonly channelId: ChannelId
  readonly episodeId: EpisodeId
  readonly clientRequestId: string
  readonly outboundIntentId?: OutboundIntentId
  /** Id of the processing record of the agent's message this one was appended to. */
  readonly followUpOf?: string
  readonly processedBy: readonly {
    readonly extensionId: ExtensionId
    readonly displayName: string
    readonly changed?: true
  }[]
  readonly rewritten: boolean
  readonly draftParts: readonly MessagePart[]
  /** Absent for a cancelled draft. */
  readonly finalParts?: readonly MessagePart[]
  readonly followUps: readonly { readonly extensionId: ExtensionId; readonly parts: readonly MessagePart[] }[]
  readonly cancelled?: { readonly extensionId: ExtensionId; readonly reason: string }
  readonly diagnostics: readonly { readonly extensionId: ExtensionId; readonly message: string }[]
  readonly createdAt: number
  readonly notifiedAt?: number
}

type Row = typeof outboundProcessing.$inferSelect

const toRecord = (row: Row): OutboundProcessingRecord => ({
  id: row.id,
  agentId: row.agentId,
  channelId: row.channelId,
  episodeId: row.episodeId,
  clientRequestId: row.clientRequestId,
  ...(row.outboundIntentId === null ? {} : { outboundIntentId: row.outboundIntentId }),
  ...(row.followUpOf === null ? {} : { followUpOf: row.followUpOf }),
  processedBy: row.processedBy,
  rewritten: row.rewritten === 1,
  draftParts: row.draftParts,
  ...(row.finalParts === null ? {} : { finalParts: row.finalParts }),
  followUps: row.followUps,
  ...(row.cancelledBy === null ? {} : { cancelled: { extensionId: row.cancelledBy, reason: row.cancelReason ?? '' } }),
  diagnostics: row.diagnostics ?? [],
  createdAt: row.createdAt,
  ...(row.notifiedAt === null ? {} : { notifiedAt: row.notifiedAt }),
})

export function createOutboundProcessingRepository(database: DrizzleCoreDatabase) {
  const byRequest = (episodeId: EpisodeId, clientRequestId: string) =>
    database
      .select()
      .from(outboundProcessing)
      .where(and(eq(outboundProcessing.episodeId, episodeId), eq(outboundProcessing.clientRequestId, clientRequestId)))
      .get()
  return {
    /** Saves the record of one send request; an existing record for the same request wins and is returned. */
    saveOutboundProcessing(record: Omit<OutboundProcessingRecord, 'outboundIntentId' | 'notifiedAt'>) {
      database
        .insert(outboundProcessing)
        .values({
          id: record.id,
          agentId: record.agentId,
          channelId: record.channelId,
          episodeId: record.episodeId,
          clientRequestId: record.clientRequestId,
          followUpOf: record.followUpOf ?? null,
          processedBy: record.processedBy,
          rewritten: record.rewritten ? 1 : 0,
          draftParts: record.draftParts,
          finalParts: record.finalParts ?? null,
          followUps: record.followUps,
          cancelledBy: record.cancelled?.extensionId ?? null,
          cancelReason: record.cancelled?.reason ?? null,
          diagnostics: record.diagnostics.length === 0 ? null : record.diagnostics,
          createdAt: record.createdAt,
        })
        .onConflictDoNothing()
        .run()
      const row = byRequest(record.episodeId, record.clientRequestId)
      if (row === undefined) throw new Error('Outbound processing record disappeared after save.')
      return toRecord(row)
    },

    getOutboundProcessingByRequest(episodeId: EpisodeId, clientRequestId: string) {
      const row = byRequest(episodeId, clientRequestId)
      return row === undefined ? undefined : toRecord(row)
    },

    getOutboundProcessingByIntent(intentId: OutboundIntentId) {
      const row = database
        .select()
        .from(outboundProcessing)
        .where(eq(outboundProcessing.outboundIntentId, intentId))
        .get()
      return row === undefined ? undefined : toRecord(row)
    },

    /** Links the record to the message planned for it; a record is linked at most once. */
    linkOutboundProcessing(id: string, intentId: OutboundIntentId): void {
      database
        .update(outboundProcessing)
        .set({ outboundIntentId: intentId })
        .where(and(eq(outboundProcessing.id, id), isNull(outboundProcessing.outboundIntentId)))
        .run()
    },

    /** Marks the message's after-delivery notification as sent; only the first caller gets the record. */
    claimOutboundNotification(intentId: OutboundIntentId, at: number): OutboundProcessingRecord | undefined {
      const changed = database
        .update(outboundProcessing)
        .set({ notifiedAt: at })
        .where(and(eq(outboundProcessing.outboundIntentId, intentId), isNull(outboundProcessing.notifiedAt)))
        .run()
      if (changed.changes === 0) return undefined
      const row = database
        .select()
        .from(outboundProcessing)
        .where(eq(outboundProcessing.outboundIntentId, intentId))
        .get()
      return row === undefined ? undefined : toRecord(row)
    },

    getAgentOutboundOrder(agentId: AgentId): readonly ExtensionId[] | undefined {
      return database.select().from(agentOutboundOrders).where(eq(agentOutboundOrders.agentId, agentId)).get()
        ?.extensionIds
    },

    putAgentOutboundOrder(agentId: AgentId, extensionIds: readonly ExtensionId[], at: number): void {
      database
        .insert(agentOutboundOrders)
        .values({ agentId, extensionIds, updatedAt: at })
        .onConflictDoUpdate({ target: agentOutboundOrders.agentId, set: { extensionIds, updatedAt: at } })
        .run()
    },
  }
}

export type OutboundProcessingRepository = ReturnType<typeof createOutboundProcessingRepository>
