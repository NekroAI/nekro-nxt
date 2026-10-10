import { and, desc, eq, inArray } from 'drizzle-orm'
import type { ChannelId, ChannelMemberId } from '@nekro-nxt/contracts'
import type { DrizzleCoreDatabase } from '../database.js'
import { channelMemberNotes } from '../schema.js'

export interface ChannelMemberNoteRecord {
  readonly channelId: ChannelId
  readonly memberId: ChannelMemberId
  readonly text: string
  readonly updatedBy: 'admin' | 'agent'
  readonly updatedAt: number
}

export function createChannelMemberNotesRepository(database: DrizzleCoreDatabase) {
  return {
    getChannelMemberNote(channelId: ChannelId, memberId: ChannelMemberId): ChannelMemberNoteRecord | undefined {
      const row = database
        .select()
        .from(channelMemberNotes)
        .where(and(eq(channelMemberNotes.channelId, channelId), eq(channelMemberNotes.memberId, memberId)))
        .get()
      return row === undefined ? undefined : { ...row }
    },

    /** Notes of the given members that have one; members without a note are left out. */
    listChannelMemberNotes(
      channelId: ChannelId,
      memberIds?: readonly ChannelMemberId[],
    ): readonly ChannelMemberNoteRecord[] {
      if (memberIds !== undefined && memberIds.length === 0) return []
      return database
        .select()
        .from(channelMemberNotes)
        .where(
          and(
            eq(channelMemberNotes.channelId, channelId),
            memberIds === undefined ? undefined : inArray(channelMemberNotes.memberId, [...memberIds]),
          ),
        )
        .orderBy(desc(channelMemberNotes.updatedAt))
        .all()
        .map((row) => ({ ...row }))
    },

    /** An empty text removes the member's note. */
    saveChannelMemberNote(record: ChannelMemberNoteRecord): void {
      if (record.text.length === 0) {
        database
          .delete(channelMemberNotes)
          .where(
            and(eq(channelMemberNotes.channelId, record.channelId), eq(channelMemberNotes.memberId, record.memberId)),
          )
          .run()
        return
      }
      database
        .insert(channelMemberNotes)
        .values(record)
        .onConflictDoUpdate({
          target: [channelMemberNotes.channelId, channelMemberNotes.memberId],
          set: { text: record.text, updatedBy: record.updatedBy, updatedAt: record.updatedAt },
        })
        .run()
    },
  }
}

export type ChannelMemberNotesRepository = ReturnType<typeof createChannelMemberNotesRepository>
