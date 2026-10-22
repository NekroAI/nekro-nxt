import { and, desc, eq, lt } from 'drizzle-orm'
import type {
  AgentId,
  AuthoringTaskId,
  ChannelId,
  EpisodeId,
  SubConversation,
  SubConversationId,
} from '@nekro-nxt/contracts'
import type { DrizzleCoreDatabase } from '../database.js'
import { subConversations } from '../schema.js'

export interface SubConversationRecord {
  readonly id: SubConversationId
  readonly channelId: ChannelId
  readonly episodeId: EpisodeId
  readonly agentId: AgentId
  readonly dshSessionId: string
  readonly parentDshSessionId: string
  readonly title: string
  readonly openedBy: SubConversation['openedBy']
  readonly driver: SubConversation['driver']
  readonly status: SubConversation['status']
  readonly closeReason?: NonNullable<SubConversation['closeReason']>
  readonly summary?: string
  readonly authoringTaskId?: AuthoringTaskId
  readonly model?: NonNullable<SubConversation['model']>
  readonly createdAt: number
  readonly closedAt?: number
}

type Row = typeof subConversations.$inferSelect

const record = (row: Row): SubConversationRecord => ({
  id: row.id,
  channelId: row.channelId,
  episodeId: row.episodeId,
  agentId: row.agentId,
  dshSessionId: row.dshSessionId,
  parentDshSessionId: row.parentDshSessionId,
  title: row.title,
  openedBy: row.openedBy,
  driver: row.driver,
  status: row.status,
  ...(row.closeReason === null ? {} : { closeReason: row.closeReason }),
  ...(row.summary === null ? {} : { summary: row.summary }),
  ...(row.authoringTaskId === null ? {} : { authoringTaskId: row.authoringTaskId }),
  ...(row.model === null ? {} : { model: row.model }),
  createdAt: row.createdAt,
  ...(row.closedAt === null ? {} : { closedAt: row.closedAt }),
})

export function createSubConversationsRepository(database: DrizzleCoreDatabase) {
  return {
    insertSubConversation(input: SubConversationRecord): void {
      database
        .insert(subConversations)
        .values({
          ...input,
          closeReason: input.closeReason ?? null,
          summary: input.summary ?? null,
          authoringTaskId: input.authoringTaskId ?? null,
          model: input.model ?? null,
          closedAt: input.closedAt ?? null,
        })
        .run()
    },

    getSubConversation(id: SubConversationId): SubConversationRecord | undefined {
      const row = database.select().from(subConversations).where(eq(subConversations.id, id)).get()
      return row === undefined ? undefined : record(row)
    },

    getSubConversationBySession(dshSessionId: string): SubConversationRecord | undefined {
      const row = database.select().from(subConversations).where(eq(subConversations.dshSessionId, dshSessionId)).get()
      return row === undefined ? undefined : record(row)
    },

    /** Newest first. */
    listSubConversations(filter: {
      readonly channelId?: ChannelId
      readonly episodeId?: EpisodeId
      readonly status?: SubConversation['status']
    }): readonly SubConversationRecord[] {
      return database
        .select()
        .from(subConversations)
        .where(
          and(
            filter.channelId === undefined ? undefined : eq(subConversations.channelId, filter.channelId),
            filter.episodeId === undefined ? undefined : eq(subConversations.episodeId, filter.episodeId),
            filter.status === undefined ? undefined : eq(subConversations.status, filter.status),
          ),
        )
        .orderBy(desc(subConversations.createdAt), desc(subConversations.id))
        .all()
        .map(record)
    },

    /** Ended before `before`, oldest first. */
    listSubConversationsClosedBefore(before: number): readonly SubConversationRecord[] {
      return database
        .select()
        .from(subConversations)
        .where(and(eq(subConversations.status, 'closed'), lt(subConversations.closedAt, before)))
        .orderBy(subConversations.closedAt)
        .all()
        .map(record)
    },

    /** Ends an open sub-conversation; returns undefined when it was not open. */
    closeSubConversation(input: {
      readonly id: SubConversationId
      readonly closeReason: NonNullable<SubConversation['closeReason']>
      readonly summary?: string
      readonly closedAt: number
    }): SubConversationRecord | undefined {
      const row = database
        .update(subConversations)
        .set({
          status: 'closed',
          closeReason: input.closeReason,
          closedAt: input.closedAt,
          ...(input.summary === undefined ? {} : { summary: input.summary }),
        })
        .where(and(eq(subConversations.id, input.id), eq(subConversations.status, 'open')))
        .returning()
        .get()
      return row === undefined ? undefined : record(row)
    },

    deleteSubConversation(id: SubConversationId): void {
      database.delete(subConversations).where(eq(subConversations.id, id)).run()
    },
  }
}

export type SubConversationsRepository = ReturnType<typeof createSubConversationsRepository>
