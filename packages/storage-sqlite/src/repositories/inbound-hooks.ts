import { and, eq, inArray } from 'drizzle-orm'
import type { AgentId, ChannelEventId, ExtensionId, JsonValue } from '@nekro-nxt/contracts'
import type { DrizzleCoreDatabase } from '../database.js'
import { inboundHookDecisions } from '../schema.js'

export type InboundHookDecisionRecord = {
  channelEventId: ChannelEventId
  agentId: AgentId
  trigger: 'default' | 'suppress' | 'force'
  hidden: boolean
  annotation: string | null
  decidedBy: ExtensionId[]
  diagnostics: JsonValue | null
  decidedAt: number
}

export function createInboundHooksRepository(database: DrizzleCoreDatabase) {
  return {
    getInboundHookDecision(eventId: ChannelEventId, agentId: AgentId): InboundHookDecisionRecord | undefined {
      const row = database
        .select()
        .from(inboundHookDecisions)
        .where(and(eq(inboundHookDecisions.channelEventId, eventId), eq(inboundHookDecisions.agentId, agentId)))
        .get()
      if (!row) return undefined
      return mapRowToRecord(row)
    },

    saveInboundHookDecision(record: InboundHookDecisionRecord): InboundHookDecisionRecord {
      const { channelEventId, agentId, trigger, hidden, annotation, decidedBy, diagnostics, decidedAt } = record

      // Insert or ignore - insert only if not exists
      database
        .insert(inboundHookDecisions)
        .values({
          channelEventId,
          agentId,
          trigger,
          hidden: hidden ? 1 : 0,
          annotation,
          decidedBy,
          diagnostics,
          decidedAt,
        })
        .onConflictDoNothing()
        .run()

      // Return the final stored record (either the new one or the existing one)
      const row = database
        .select()
        .from(inboundHookDecisions)
        .where(and(eq(inboundHookDecisions.channelEventId, channelEventId), eq(inboundHookDecisions.agentId, agentId)))
        .get()

      if (!row) {
        throw new Error('Failed to retrieve inbound hook decision after save')
      }

      return mapRowToRecord(row)
    },

    listInboundHookDecisions(agentId: AgentId, eventIds: ChannelEventId[]): InboundHookDecisionRecord[] {
      if (eventIds.length === 0) return []

      const rows = database
        .select()
        .from(inboundHookDecisions)
        .where(and(eq(inboundHookDecisions.agentId, agentId), inArray(inboundHookDecisions.channelEventId, eventIds)))
        .all()
      return rows.map(mapRowToRecord)
    },
  }
}

function mapRowToRecord(row: {
  channelEventId: ChannelEventId
  agentId: AgentId
  trigger: 'default' | 'suppress' | 'force'
  hidden: number
  annotation: string | null
  decidedBy: ExtensionId[]
  diagnostics: JsonValue | null
  decidedAt: number
}): InboundHookDecisionRecord {
  return {
    channelEventId: row.channelEventId,
    agentId: row.agentId,
    trigger: row.trigger,
    hidden: row.hidden === 1,
    annotation: row.annotation,
    decidedBy: row.decidedBy,
    diagnostics: row.diagnostics,
    decidedAt: row.decidedAt,
  }
}

export type InboundHooksRepository = ReturnType<typeof createInboundHooksRepository>
