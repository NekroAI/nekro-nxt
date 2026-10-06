import { and, asc, count, desc, eq, gt, gte, inArray, isNotNull, lt, or, sql } from 'drizzle-orm'
import type { ChannelId, JsonValue, OutboundIntentId } from '@nekro-nxt/contracts'
import type { OutboundIntentRecord } from '@nekro-nxt/channel-runtime'
import type { ChannelEventRecord } from '@nekro-nxt/core'
import type { DrizzleCoreDatabase } from '../database.js'
import {
  attentionDismissals,
  channelEvents,
  channelReadCursors,
  episodes,
  outboundIntents,
  outboundResolutions,
  physicalDeliveries,
  readViewers,
} from '../schema.js'
import { OutboundResolutionRowSchema, PhysicalDeliveryRowSchema } from '../row-schemas.js'
import { toEvent } from './channels.js'
import { toIntent } from './outbox.js'

/** Position in one Channel's inbound history, ordered by `(receivedAt, id)` with BINARY id collation. */
export interface ChannelReadPosition {
  readonly readAt: number
  readonly readSourceId: string
}

export interface OutboundResolutionRecord {
  readonly id: string
  readonly intentId: OutboundIntentId
  readonly action: 'retry' | 'confirm-delivered'
  readonly previousState: 'partially-sent' | 'failed' | 'unknown'
  readonly previousDeliveries: JsonValue
  readonly viewerKey: string
  readonly createdAt: number
}

export interface UnsettledOutboundRecord {
  readonly intent: OutboundIntentRecord
  readonly channelId: ChannelId
  readonly agentId: string
  /** Number of earlier administrator resolutions, so a renewed failure gets a new attention fingerprint. */
  readonly resolutionCount: number
}

export type ResolvableOutboundState = OutboundResolutionRecord['previousState']

const RESOLVABLE_STATES = ['partially-sent', 'failed', 'unknown'] as const

const isResolvable = (state: string): state is ResolvableOutboundState =>
  (RESOLVABLE_STATES as readonly string[]).includes(state)

const visibleInbound = sql`coalesce(json_type(${channelEvents.facts}, '$.consoleAnchor'), 'null') != 'true'`
const memberMessage = and(
  eq(channelEvents.kind, 'message-created'),
  isNotNull(channelEvents.senderMemberId),
  visibleInbound,
  sql`coalesce(json_type(${channelEvents.facts}, '$.selfInteraction'), 'null') != 'true'`,
)
const afterPosition = (position: ChannelReadPosition) =>
  or(
    gt(channelEvents.receivedAt, position.readAt),
    and(
      eq(channelEvents.receivedAt, position.readAt),
      sql`${channelEvents.id} > ${position.readSourceId} collate binary`,
    ),
  )

const toResolution = (input: typeof outboundResolutions.$inferSelect): OutboundResolutionRecord => {
  const row = OutboundResolutionRowSchema.parse(input)
  return {
    id: row.id,
    intentId: row.intentId,
    action: row.action,
    previousState: row.previousState,
    previousDeliveries: row.previousDeliveries,
    viewerKey: row.viewerKey,
    createdAt: row.createdAt,
  }
}

/** Read models for the client workspace: read positions, activity, attention and delivery resolutions. */
export function createProjectionRepository(database: DrizzleCoreDatabase) {
  const latestResolution = (intentId: OutboundIntentId): OutboundResolutionRecord | undefined => {
    const row = database
      .select()
      .from(outboundResolutions)
      .where(eq(outboundResolutions.intentId, intentId))
      .orderBy(desc(outboundResolutions.createdAt), desc(outboundResolutions.id))
      .get()
    return row === undefined ? undefined : toResolution(row)
  }

  return {
    /** Registers a viewer on first use; its creation time is the unread baseline for Channels it never read. */
    ensureReadViewer(viewerKey: string, now: number): number {
      if (viewerKey.trim().length === 0 || viewerKey.length > 200) throw new TypeError('Invalid viewer key.')
      database.insert(readViewers).values({ viewerKey, createdAt: now }).onConflictDoNothing().run()
      const row = database.select().from(readViewers).where(eq(readViewers.viewerKey, viewerKey)).get()
      if (row === undefined) throw new Error(`Viewer was not persisted: ${viewerKey}`)
      return row.createdAt
    },

    listChannelReadPositions(viewerKey: string): ReadonlyMap<ChannelId, ChannelReadPosition> {
      return new Map(
        database
          .select()
          .from(channelReadCursors)
          .where(eq(channelReadCursors.viewerKey, viewerKey))
          .all()
          .map((row) => [row.channelId, { readAt: row.readAt, readSourceId: row.readSourceId }] as const),
      )
    },

    /** Moves the cursor forward only; a stale request from another tab never marks newer messages unread. */
    advanceChannelReadPosition(
      viewerKey: string,
      channelId: ChannelId,
      position: ChannelReadPosition,
      now: number,
    ): ChannelReadPosition {
      return database.transaction(
        (tx) => {
          const current = tx
            .select()
            .from(channelReadCursors)
            .where(and(eq(channelReadCursors.viewerKey, viewerKey), eq(channelReadCursors.channelId, channelId)))
            .get()
          const advances =
            current === undefined ||
            position.readAt > current.readAt ||
            (position.readAt === current.readAt && position.readSourceId > current.readSourceId)
          if (!advances) return { readAt: current.readAt, readSourceId: current.readSourceId }
          tx.insert(channelReadCursors)
            .values({ viewerKey, channelId, ...position, updatedAt: now })
            .onConflictDoUpdate({
              target: [channelReadCursors.viewerKey, channelReadCursors.channelId],
              set: { ...position, updatedAt: now },
            })
            .run()
          return position
        },
        { behavior: 'immediate' },
      )
    },

    getLatestMemberMessage(channelId: ChannelId): ChannelEventRecord | undefined {
      const row = database
        .select()
        .from(channelEvents)
        .where(and(eq(channelEvents.channelId, channelId), memberMessage))
        .orderBy(desc(channelEvents.receivedAt), desc(channelEvents.id))
        .get()
      return row === undefined ? undefined : toEvent(row)
    },

    getLatestVisibleInbound(channelId: ChannelId): ChannelEventRecord | undefined {
      const row = database
        .select()
        .from(channelEvents)
        .where(and(eq(channelEvents.channelId, channelId), eq(channelEvents.kind, 'message-created'), visibleInbound))
        .orderBy(desc(channelEvents.receivedAt), desc(channelEvents.id))
        .get()
      return row === undefined ? undefined : toEvent(row)
    },

    getLatestOutbound(channelId: ChannelId): OutboundIntentRecord | undefined {
      const row = database
        .select({ intent: outboundIntents })
        .from(outboundIntents)
        .innerJoin(episodes, eq(episodes.id, outboundIntents.episodeId))
        .where(eq(episodes.channelId, channelId))
        .orderBy(desc(outboundIntents.createdAt), desc(outboundIntents.id))
        .get()
      return row === undefined ? undefined : toIntent(row.intent)
    },

    /** Counts member messages after the position, reading at most `cap + 1` rows. */
    countUnreadMemberMessages(
      channelId: ChannelId,
      after: ChannelReadPosition,
      cap: number,
    ): { readonly count: number; readonly capped: boolean } {
      const rows = database
        .select({ id: channelEvents.id })
        .from(channelEvents)
        .where(and(eq(channelEvents.channelId, channelId), memberMessage, afterPosition(after)))
        .limit(cap + 1)
        .all()
      return { count: Math.min(rows.length, cap), capped: rows.length > cap }
    },

    /** Member message and Agent/admin outbound counts per Channel in `[from, to)` buckets. */
    countChannelActivity(
      from: number,
      to: number,
      bucketMs: number,
    ): ReadonlyMap<ChannelId, ReadonlyMap<number, number>> {
      const result = new Map<ChannelId, Map<number, number>>()
      const add = (channelId: ChannelId, bucket: number, value: number): void => {
        const buckets = result.get(channelId) ?? new Map<number, number>()
        buckets.set(bucket, (buckets.get(bucket) ?? 0) + value)
        result.set(channelId, buckets)
      }
      const inboundBucket = sql<number>`cast((${channelEvents.receivedAt} - ${from}) / ${bucketMs} as integer)`
      for (const row of database
        .select({ channelId: channelEvents.channelId, bucket: inboundBucket, value: count() })
        .from(channelEvents)
        .where(
          and(
            eq(channelEvents.kind, 'message-created'),
            visibleInbound,
            gte(channelEvents.receivedAt, from),
            lt(channelEvents.receivedAt, to),
          ),
        )
        .groupBy(channelEvents.channelId, inboundBucket)
        .all())
        add(row.channelId, row.bucket, row.value)
      const outboundBucket = sql<number>`cast((${outboundIntents.createdAt} - ${from}) / ${bucketMs} as integer)`
      for (const row of database
        .select({ channelId: episodes.channelId, bucket: outboundBucket, value: count() })
        .from(outboundIntents)
        .innerJoin(episodes, eq(episodes.id, outboundIntents.episodeId))
        .where(and(gte(outboundIntents.createdAt, from), lt(outboundIntents.createdAt, to)))
        .groupBy(episodes.channelId, outboundBucket)
        .all())
        add(row.channelId, row.bucket, row.value)
      return result
    },

    listAttentionDismissals(): ReadonlySet<string> {
      return new Set(
        database
          .select({ fingerprint: attentionDismissals.fingerprint })
          .from(attentionDismissals)
          .all()
          .map(({ fingerprint }) => fingerprint),
      )
    },

    /** Records a dismissal and forgets dismissals older than `retainSince`. */
    dismissAttention(fingerprint: string, now: number, retainSince: number): void {
      if (fingerprint.length === 0 || fingerprint.length > 200) throw new TypeError('Invalid attention fingerprint.')
      database.transaction(
        (tx) => {
          tx.insert(attentionDismissals).values({ fingerprint, dismissedAt: now }).onConflictDoNothing().run()
          tx.delete(attentionDismissals).where(lt(attentionDismissals.dismissedAt, retainSince)).run()
        },
        { behavior: 'immediate' },
      )
    },

    /** Outbound Intents whose final state needs an administrator, newest first, excluding confirmed ones. */
    listUnsettledAttentionOutbounds(since: number, limit: number): readonly UnsettledOutboundRecord[] {
      const rows = database
        .select({ intent: outboundIntents, channelId: episodes.channelId, agentId: episodes.agentId })
        .from(outboundIntents)
        .innerJoin(episodes, eq(episodes.id, outboundIntents.episodeId))
        .where(
          and(
            inArray(outboundIntents.state, [...RESOLVABLE_STATES]),
            gte(outboundIntents.createdAt, since),
            sql`not exists (select 1 from ${outboundResolutions} where ${outboundResolutions.intentId} = ${outboundIntents.id} and ${outboundResolutions.action} = 'confirm-delivered')`,
          ),
        )
        .orderBy(desc(outboundIntents.createdAt), desc(outboundIntents.id))
        .limit(limit)
        .all()
      return rows.map((row) => ({
        intent: toIntent(row.intent),
        channelId: row.channelId,
        agentId: row.agentId,
        resolutionCount:
          database
            .select({ value: count() })
            .from(outboundResolutions)
            .where(eq(outboundResolutions.intentId, row.intent.id))
            .get()?.value ?? 0,
      }))
    },

    getLatestOutboundResolution: latestResolution,

    /**
     * Atomically records the administrator's resolution. `retry` returns every unsent Physical Delivery and
     * the Intent to `planned` so the normal dispatcher sends it again; the replaced receipts stay in the
     * resolution row. A second concurrent request finds the Intent no longer resolvable and fails.
     */
    resolveOutbound(input: {
      readonly id: string
      readonly intentId: OutboundIntentId
      readonly action: OutboundResolutionRecord['action']
      readonly viewerKey: string
      readonly now: number
    }): OutboundResolutionRecord {
      return database.transaction(
        (tx) => {
          const intentRow = tx.select().from(outboundIntents).where(eq(outboundIntents.id, input.intentId)).get()
          if (intentRow === undefined) throw new OutboundResolutionError('not-found', '投递记录不存在。')
          const state = intentRow.state
          if (!isResolvable(state)) {
            throw new OutboundResolutionError('not-resolvable', '这条消息当前不需要处理。')
          }
          const confirmed = tx
            .select({ id: outboundResolutions.id })
            .from(outboundResolutions)
            .where(
              and(
                eq(outboundResolutions.intentId, input.intentId),
                eq(outboundResolutions.action, 'confirm-delivered'),
              ),
            )
            .get()
          if (confirmed !== undefined) throw new OutboundResolutionError('not-resolvable', '这条消息已确认送达。')
          const deliveries = tx
            .select()
            .from(physicalDeliveries)
            .where(eq(physicalDeliveries.intentId, input.intentId))
            .orderBy(asc(physicalDeliveries.sequence))
            .all()
            .map((row) => PhysicalDeliveryRowSchema.parse(row))
          const previousDeliveries: JsonValue = deliveries.map((delivery) => ({
            id: delivery.id,
            sequence: delivery.sequence,
            state: delivery.state,
            ...(delivery.platformMessageId === null ? {} : { platformMessageId: delivery.platformMessageId }),
            ...(delivery.failureKind === null ? {} : { failureKind: delivery.failureKind }),
            ...(delivery.resultMessage === null ? {} : { resultMessage: delivery.resultMessage }),
            ...(delivery.completedAt === null ? {} : { completedAt: delivery.completedAt }),
          }))
          const record = {
            id: input.id,
            intentId: input.intentId,
            action: input.action,
            previousState: state,
            previousDeliveries,
            viewerKey: input.viewerKey,
            createdAt: input.now,
          }
          tx.insert(outboundResolutions).values(record).run()
          if (input.action === 'retry') {
            const retried = deliveries.filter((delivery) => delivery.state === 'failed' || delivery.state === 'unknown')
            if (retried.length === 0) throw new OutboundResolutionError('not-resolvable', '没有需要重新发送的内容。')
            for (const delivery of retried) {
              tx.update(physicalDeliveries)
                .set({
                  state: 'planned',
                  platformMessageId: null,
                  capabilityOutcomes: null,
                  failureKind: null,
                  resultMessage: null,
                  retryAfterMs: null,
                  completedAt: null,
                })
                .where(and(eq(physicalDeliveries.id, delivery.id), eq(physicalDeliveries.state, delivery.state)))
                .run()
            }
            if (
              tx
                .update(outboundIntents)
                .set({ state: 'planned' })
                .where(and(eq(outboundIntents.id, input.intentId), eq(outboundIntents.state, state)))
                .run().changes !== 1
            )
              throw new OutboundResolutionError('not-resolvable', '这条消息的状态已经变化，请刷新后重试。')
          }
          return toResolution(record)
        },
        { behavior: 'immediate' },
      )
    },
  }
}

export class OutboundResolutionError extends Error {
  constructor(
    readonly code: 'not-found' | 'not-resolvable',
    message: string,
  ) {
    super(message)
    this.name = 'OutboundResolutionError'
  }
}

export type ProjectionRepository = ReturnType<typeof createProjectionRepository>
