import { and, desc, eq, lte } from 'drizzle-orm'
import type { ChannelId, PromptDocumentV1 } from '@nekro-nxt/contracts'
import type { DrizzleCoreDatabase } from '../database.js'
import { channelPromptRevisions, channelPrompts } from '../schema.js'

/** Earlier versions kept per channel; older ones are pruned on each write. */
const KEPT_REVISIONS = 20

export type ChannelPromptAuthor = 'admin' | 'agent'
/** `instructions`: the admin's, in the system prompt. `notes`: the agent's own, in the runtime context. */
export type ChannelPromptKind = 'instructions' | 'notes'

export interface ChannelPromptRecord {
  readonly channelId: ChannelId
  readonly kind: ChannelPromptKind
  readonly document: PromptDocumentV1
  readonly locked: boolean
  readonly revision: number
  readonly updatedBy: ChannelPromptAuthor
  readonly updatedAt: number
}

export interface ChannelPromptRevisionRecord {
  readonly revision: number
  readonly document: PromptDocumentV1
  readonly updatedBy: ChannelPromptAuthor
  readonly updatedAt: number
}

export class ChannelPromptConflictError extends Error {
  constructor(readonly current: ChannelPromptRecord | undefined) {
    super('频道说明已被修改，请刷新后重试。')
    this.name = 'ChannelPromptConflictError'
  }
}

export function createChannelPromptsRepository(database: DrizzleCoreDatabase) {
  const read = (channelId: ChannelId, kind: ChannelPromptKind): ChannelPromptRecord | undefined => {
    const row = database
      .select()
      .from(channelPrompts)
      .where(and(eq(channelPrompts.channelId, channelId), eq(channelPrompts.kind, kind)))
      .get()
    return row === undefined ? undefined : { ...row }
  }
  return {
    getChannelPrompt: read,

    /**
     * Writes a new version when `expectedRevision` matches the stored one (0 for none). The replaced version moves to
     * the revision history, which keeps the latest {@link KEPT_REVISIONS}.
     */
    saveChannelPrompt(input: {
      readonly channelId: ChannelId
      readonly kind: ChannelPromptKind
      readonly document: PromptDocumentV1
      readonly locked: boolean
      readonly updatedBy: ChannelPromptAuthor
      readonly updatedAt: number
      readonly expectedRevision: number
    }): ChannelPromptRecord {
      return database.transaction((tx) => {
        const current = tx
          .select()
          .from(channelPrompts)
          .where(and(eq(channelPrompts.channelId, input.channelId), eq(channelPrompts.kind, input.kind)))
          .get()
        if ((current?.revision ?? 0) !== input.expectedRevision) {
          throw new ChannelPromptConflictError(current === undefined ? undefined : { ...current })
        }
        if (current !== undefined) {
          tx.insert(channelPromptRevisions)
            .values({
              channelId: current.channelId,
              kind: current.kind,
              revision: current.revision,
              document: current.document,
              updatedBy: current.updatedBy,
              updatedAt: current.updatedAt,
            })
            .onConflictDoNothing()
            .run()
          tx.delete(channelPromptRevisions)
            .where(
              and(
                eq(channelPromptRevisions.channelId, input.channelId),
                eq(channelPromptRevisions.kind, input.kind),
                lte(channelPromptRevisions.revision, current.revision - KEPT_REVISIONS),
              ),
            )
            .run()
        }
        const record: ChannelPromptRecord = {
          channelId: input.channelId,
          kind: input.kind,
          document: input.document,
          locked: input.locked,
          revision: input.expectedRevision + 1,
          updatedBy: input.updatedBy,
          updatedAt: input.updatedAt,
        }
        tx.insert(channelPrompts)
          .values(record)
          .onConflictDoUpdate({
            target: [channelPrompts.channelId, channelPrompts.kind],
            set: {
              document: record.document,
              locked: record.locked,
              revision: record.revision,
              updatedBy: record.updatedBy,
              updatedAt: record.updatedAt,
            },
          })
          .run()
        return record
      })
    },

    listChannelPromptRevisions(channelId: ChannelId, kind: ChannelPromptKind): readonly ChannelPromptRevisionRecord[] {
      return database
        .select({
          revision: channelPromptRevisions.revision,
          document: channelPromptRevisions.document,
          updatedBy: channelPromptRevisions.updatedBy,
          updatedAt: channelPromptRevisions.updatedAt,
        })
        .from(channelPromptRevisions)
        .where(and(eq(channelPromptRevisions.channelId, channelId), eq(channelPromptRevisions.kind, kind)))
        .orderBy(desc(channelPromptRevisions.revision))
        .all()
    },
  }
}

export type ChannelPromptsRepository = ReturnType<typeof createChannelPromptsRepository>
