import { and, desc, eq, isNull, or } from 'drizzle-orm'
import {
  CommunityFeedbackDraftSchema,
  CommunityFeedbackItemSchema,
  JsonValueSchema,
  type CommunityFeedbackDraft,
  type CommunityFeedbackDraftId,
  type CommunityFeedbackItem,
  type JsonValue,
} from '@nekro-nxt/contracts'
import { z } from 'zod'
import type { DrizzleCoreDatabase } from '../database.js'
import { communityFeedbackDrafts as drafts, communityFeedbackItems as items, systemSettings } from '../schema.js'

export interface CommunityFeedbackIdentity {
  readonly communityUrl: string
  readonly communityUserId: string | null
}
const quotaKey = 'community.feedback.autoQuota'
const QuotaSchema = z.object({ day: z.number().int(), ids: z.array(z.string()).max(5) }).strict()
const draftScope = (identity: CommunityFeedbackIdentity, unbound = false) =>
  and(
    eq(drafts.communityUrl, identity.communityUrl),
    identity.communityUserId === null
      ? isNull(drafts.communityUserId)
      : unbound
        ? or(eq(drafts.communityUserId, identity.communityUserId), isNull(drafts.communityUserId))
        : eq(drafts.communityUserId, identity.communityUserId),
  )
const itemScope = (identity: CommunityFeedbackIdentity) =>
  and(eq(items.communityUrl, identity.communityUrl), eq(items.communityUserId, identity.communityUserId ?? ''))

export function createCommunityFeedbackRepository(database: DrizzleCoreDatabase) {
  const getDraft = (id: CommunityFeedbackDraftId): CommunityFeedbackDraft | undefined => {
    const row = database.select().from(drafts).where(eq(drafts.id, id)).get()
    return row === undefined ? undefined : CommunityFeedbackDraftSchema.parse(row)
  }
  const listDrafts = (identity: CommunityFeedbackIdentity): CommunityFeedbackDraft[] =>
    database
      .select()
      .from(drafts)
      .where(draftScope(identity, true))
      .orderBy(desc(drafts.createdAt))
      .all()
      .map((row) => CommunityFeedbackDraftSchema.parse(row))
  const listItems = (identity: CommunityFeedbackIdentity): CommunityFeedbackItem[] =>
    database
      .select()
      .from(items)
      .where(itemScope(identity))
      .orderBy(desc(items.updatedAt))
      .all()
      .map((row) => CommunityFeedbackItemSchema.parse(row))

  return {
    getDraft,
    listDrafts,
    listItems,
    getItem(identity: CommunityFeedbackIdentity, ref: string): CommunityFeedbackItem | undefined {
      const row = database
        .select()
        .from(items)
        .where(and(itemScope(identity), eq(items.ref, ref)))
        .get()
      return row === undefined ? undefined : CommunityFeedbackItemSchema.parse(row)
    },
    insertDraft(record: CommunityFeedbackDraft): void {
      database.insert(drafts).values(record).run()
    },
    replaceDraft(record: CommunityFeedbackDraft, expectedUpdatedAt: number): void {
      const changed = database
        .update(drafts)
        .set(record)
        .where(and(eq(drafts.id, record.id), eq(drafts.updatedAt, expectedUpdatedAt)))
        .run()
      if (changed.changes !== 1) throw new Error('草稿已被修改，请刷新后重试。')
    },
    saveItem(record: CommunityFeedbackItem): void {
      database
        .insert(items)
        .values(record)
        .onConflictDoUpdate({
          target: [items.communityUrl, items.communityUserId, items.ref],
          set: record,
        })
        .run()
    },
    removeItem(identity: CommunityFeedbackIdentity, ref: string): void {
      database
        .delete(items)
        .where(and(itemScope(identity), eq(items.ref, ref)))
        .run()
    },
    claimSend(
      id: CommunityFeedbackDraftId,
      identity: CommunityFeedbackIdentity,
      expectedUpdatedAt: number,
      automatic: boolean,
      time: number,
    ): 'claimed' | 'quota' {
      if (identity.communityUserId === null) throw new Error('请先登录社区。')
      return database.transaction(
        (tx) => {
          const row = tx
            .select()
            .from(drafts)
            .where(and(eq(drafts.id, id), draftScope(identity, true)))
            .get()
          if (!row || row.updatedAt !== expectedUpdatedAt || !['awaiting', 'failed'].includes(row.state))
            throw new Error('草稿已被修改，请刷新后重试。')
          if (automatic) {
            const current = tx.select().from(systemSettings).where(eq(systemSettings.key, quotaKey)).get()
            const previous = current ? QuotaSchema.parse(current.value) : undefined
            const day = Math.floor(time / 86400000)
            const ids = previous?.day === day ? previous.ids : []
            if (!ids.includes(id) && ids.length >= 5) return 'quota'
            const value = { day, ids: ids.includes(id) ? ids : [...ids, id] }
            tx.insert(systemSettings)
              .values({ key: quotaKey, value, revision: (current?.revision ?? 0) + 1, updatedAt: time })
              .onConflictDoUpdate({
                target: systemSettings.key,
                set: { value, revision: (current?.revision ?? 0) + 1, updatedAt: time },
              })
              .run()
          }
          tx.update(drafts)
            .set({
              state: 'sending',
              communityUserId: identity.communityUserId,
              auto: automatic,
              error: null,
              updatedAt: Math.max(time, row.updatedAt + 1),
            })
            .where(eq(drafts.id, id))
            .run()
          return 'claimed'
        },
        { behavior: 'immediate' },
      )
    },
    commitSent(
      draftId: CommunityFeedbackDraftId,
      item: CommunityFeedbackItem,
      lastPayloadKey: string,
      payload: JsonValue,
      time: number,
    ): void {
      database.transaction(
        (tx) => {
          const row = tx.select().from(drafts).where(eq(drafts.id, draftId)).get()
          if (
            !row ||
            row.state !== 'sending' ||
            row.communityUrl !== item.communityUrl ||
            row.communityUserId !== item.communityUserId
          )
            throw new Error('Feedback send identity changed before commit.')
          tx.update(drafts).set({ state: 'sent', error: null, updatedAt: time }).where(eq(drafts.id, draftId)).run()
          tx.insert(items)
            .values(item)
            .onConflictDoUpdate({ target: [items.communityUrl, items.communityUserId, items.ref], set: item })
            .run()
          const current = tx.select().from(systemSettings).where(eq(systemSettings.key, lastPayloadKey)).get()
          tx.insert(systemSettings)
            .values({
              key: lastPayloadKey,
              value: JsonValueSchema.parse(payload),
              revision: (current?.revision ?? 0) + 1,
              updatedAt: time,
            })
            .onConflictDoUpdate({
              target: systemSettings.key,
              set: { value: payload, revision: (current?.revision ?? 0) + 1, updatedAt: time },
            })
            .run()
        },
        { behavior: 'immediate' },
      )
    },
    recoverSending(time: number): void {
      database
        .update(drafts)
        .set({ state: 'failed', error: '上次发送尚未确认，可以重试。', updatedAt: time })
        .where(eq(drafts.state, 'sending'))
        .run()
    },
    clearText(identity: CommunityFeedbackIdentity, ref: string, time: number): void {
      database.transaction(
        (tx) => {
          const item = tx
            .select()
            .from(items)
            .where(and(itemScope(identity), eq(items.ref, ref)))
            .get()
          tx.update(items)
            .set({ title: '已删除', updatedAt: time })
            .where(and(itemScope(identity), eq(items.ref, ref)))
            .run()
          if (item?.draftId)
            tx.update(drafts)
              .set({ title: '已删除', body: '', excerpt: null, diagnostics: {}, updatedAt: time })
              .where(and(eq(drafts.id, item.draftId), draftScope(identity)))
              .run()
        },
        { behavior: 'immediate' },
      )
    },
  }
}
export type CommunityFeedbackRepository = ReturnType<typeof createCommunityFeedbackRepository>
