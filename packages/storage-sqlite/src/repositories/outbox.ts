import { and, asc, eq, inArray } from 'drizzle-orm'
import type { AdapterDeliveryReceipt } from '@nekro-nxt/adapter-sdk'
import { AdapterDeliveryReceiptSchema } from '@nekro-nxt/adapter-sdk'
import {
  messagePartsSearchText,
  type AgentId,
  type ChannelId,
  type OutboundIntentId,
  type PhysicalDeliveryId,
} from '@nekro-nxt/contracts'
import {
  isConsoleAnchorHistory,
  type ChannelHistoryEntry,
  type ChannelHistoryRepository,
  type DeliveryReceiptRecord,
  type OutboundIntentRecord,
  type OutboundSnapshot,
  type OutboundState,
  type PhysicalDeliveryRecord,
  type RuntimeRepository,
} from '@nekro-nxt/channel-runtime'
import type { DrizzleCoreDatabase } from '../database.js'
import { admissionEvents, admissions, channelEvents, episodes, outboundIntents, physicalDeliveries } from '../schema.js'
import {
  ChannelEventRowSchema,
  EpisodeRowSchema,
  OutboundIntentRowSchema,
  PhysicalDeliveryRowSchema,
} from '../row-schemas.js'

type OutboxSlice = Pick<
  RuntimeRepository,
  | 'findOutboundByClientRequest'
  | 'createOutboundPlan'
  | 'markIntentSending'
  | 'markDeliverySending'
  | 'recordDeliveryReceipt'
  | 'completeOutboundIntent'
  | 'getOutbound'
  | 'listUnsettledOutboundIds'
>

const toIntent = (input: typeof outboundIntents.$inferSelect): OutboundIntentRecord => {
  const row = OutboundIntentRowSchema.parse(input)
  return {
    id: row.id,
    logicalMessageId: row.logicalMessageId,
    agentRevisionId: row.agentRevisionId,
    episodeId: row.episodeId,
    ...(row.sourceTurnId === null ? {} : { sourceTurnId: row.sourceTurnId }),
    parts: row.parts,
    ...(row.replyTo === null ? {} : { replyTo: row.replyTo }),
    ...(row.clientRequestId === null ? {} : { clientRequestId: row.clientRequestId }),
    state: row.state,
    createdAt: row.createdAt,
  }
}

const receiptFromRow = (
  row: ReturnType<typeof PhysicalDeliveryRowSchema.parse>,
): AdapterDeliveryReceipt | undefined => {
  switch (row.state) {
    case 'planned':
    case 'sending':
      return undefined
    case 'sent':
      return AdapterDeliveryReceiptSchema.parse({
        status: 'sent',
        platformMessageId: row.platformMessageId,
        ...(row.capabilityOutcomes === null ? {} : { capabilityOutcomes: row.capabilityOutcomes }),
      })
    case 'failed':
      return AdapterDeliveryReceiptSchema.parse({
        status: 'failed',
        failure: {
          kind: row.failureKind,
          message: row.resultMessage,
          ...(row.retryAfterMs === null ? {} : { retryAfterMs: row.retryAfterMs }),
        },
      })
    case 'unknown':
      return AdapterDeliveryReceiptSchema.parse({ status: 'unknown', message: row.resultMessage })
  }
}

const toDelivery = (input: typeof physicalDeliveries.$inferSelect): PhysicalDeliveryRecord => {
  const row = PhysicalDeliveryRowSchema.parse(input)
  const receipt = receiptFromRow(row)
  return {
    id: row.id,
    intentId: row.intentId,
    sequence: row.sequence,
    parts: row.parts,
    ...(row.adapterContext === null ? {} : { adapterContext: row.adapterContext }),
    state: row.state,
    ...(receipt === undefined ? {} : { receipt }),
    ...(row.completedAt === null ? {} : { completedAt: row.completedAt }),
  }
}

const toReceipt = (delivery: PhysicalDeliveryRecord): DeliveryReceiptRecord | undefined =>
  delivery.receipt === undefined || delivery.completedAt === undefined
    ? undefined
    : { physicalDeliveryId: delivery.id, receipt: delivery.receipt, completedAt: delivery.completedAt }

const searchLimit = (limit: number | undefined): number => {
  const value = limit ?? 50
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw new TypeError('History limit must be 1–100.')
  return value
}

export function createOutboxRepository(database: DrizzleCoreDatabase): OutboxSlice & ChannelHistoryRepository {
  const getOutbound = (id: OutboundIntentId): OutboundSnapshot => {
    const intentRow = database.select().from(outboundIntents).where(eq(outboundIntents.id, id)).get()
    if (intentRow === undefined) throw new Error(`Unknown Outbound Intent: ${id}`)
    const deliveries = database
      .select()
      .from(physicalDeliveries)
      .where(eq(physicalDeliveries.intentId, id))
      .orderBy(asc(physicalDeliveries.sequence))
      .all()
      .map(toDelivery)
    return {
      intent: toIntent(intentRow),
      deliveries,
      receipts: deliveries.flatMap((delivery) => {
        const receipt = toReceipt(delivery)
        return receipt === undefined ? [] : [receipt]
      }),
    }
  }

  return {
    findOutboundByClientRequest(
      agentId: AgentId,
      channelId: ChannelId,
      clientRequestId: string,
    ): OutboundSnapshot | undefined {
      const row = database
        .select({ id: outboundIntents.id })
        .from(outboundIntents)
        .innerJoin(episodes, eq(episodes.id, outboundIntents.episodeId))
        .where(
          and(
            eq(episodes.agentId, agentId),
            eq(episodes.channelId, channelId),
            eq(outboundIntents.clientRequestId, clientRequestId),
          ),
        )
        .get()
      return row === undefined ? undefined : getOutbound(row.id)
    },
    createOutboundPlan(intent, deliveries): void {
      database.transaction(
        (tx) => {
          tx.insert(outboundIntents)
            .values({
              ...intent,
              searchText: messagePartsSearchText(intent.parts),
            })
            .run()
          if (deliveries.length > 0) {
            tx.insert(physicalDeliveries)
              .values(
                deliveries.map((delivery) => ({
                  id: delivery.id,
                  intentId: delivery.intentId,
                  sequence: delivery.sequence,
                  parts: delivery.parts,
                  ...(delivery.adapterContext === undefined ? {} : { adapterContext: delivery.adapterContext }),
                  state: delivery.state,
                })),
              )
              .run()
          }
        },
        { behavior: 'immediate' },
      )
    },
    markIntentSending(id): void {
      if (
        database
          .update(outboundIntents)
          .set({ state: 'sending' })
          .where(and(eq(outboundIntents.id, id), eq(outboundIntents.state, 'planned')))
          .run().changes !== 1
      )
        throw new Error(`Outbound Intent is not planned: ${id}`)
    },
    markDeliverySending(id): void {
      if (
        database
          .update(physicalDeliveries)
          .set({ state: 'sending' })
          .where(and(eq(physicalDeliveries.id, id), eq(physicalDeliveries.state, 'planned')))
          .run().changes !== 1
      )
        throw new Error(`Physical Delivery is not planned: ${id}`)
    },
    recordDeliveryReceipt(id: PhysicalDeliveryId, receipt: AdapterDeliveryReceipt, completedAt: number): void {
      const parsed = AdapterDeliveryReceiptSchema.parse(receipt)
      const values =
        parsed.status === 'sent'
          ? {
              state: 'sent' as const,
              platformMessageId: parsed.platformMessageId,
              capabilityOutcomes: parsed.capabilityOutcomes ?? null,
              completedAt,
            }
          : parsed.status === 'failed'
            ? {
                state: 'failed' as const,
                failureKind: parsed.failure.kind,
                resultMessage: parsed.failure.message,
                retryAfterMs: parsed.failure.retryAfterMs ?? null,
                completedAt,
              }
            : { state: 'unknown' as const, resultMessage: parsed.message, completedAt }
      if (
        database
          .update(physicalDeliveries)
          .set(values)
          .where(and(eq(physicalDeliveries.id, id), eq(physicalDeliveries.state, 'sending')))
          .run().changes !== 1
      )
        throw new Error(`Physical Delivery is not sending: ${id}`)
    },
    completeOutboundIntent(id, state: OutboundState): void {
      if (!['sent', 'partially-sent', 'failed', 'unknown'].includes(state)) throw new Error('Invalid settled state.')
      if (
        database
          .update(outboundIntents)
          .set({ state })
          .where(and(eq(outboundIntents.id, id), eq(outboundIntents.state, 'sending')))
          .run().changes !== 1
      )
        throw new Error(`Outbound Intent is not sending: ${id}`)
    },
    getOutbound,
    listUnsettledOutboundIds(): readonly OutboundIntentId[] {
      return database
        .select({ id: outboundIntents.id })
        .from(outboundIntents)
        .where(inArray(outboundIntents.state, ['planned', 'sending']))
        .orderBy(asc(outboundIntents.createdAt), asc(outboundIntents.id))
        .all()
        .map(({ id }) => id)
    },
    listChannelHistory(channelId, options = {}): readonly ChannelHistoryEntry[] {
      const limit = searchLimit(options.limit)
      const before = options.before
      const inbound = database
        .select()
        .from(channelEvents)
        .where(eq(channelEvents.channelId, channelId))
        .all()
        .map((input): ChannelHistoryEntry => {
          const row = ChannelEventRowSchema.parse(input)
          return {
            source: 'channel-event',
            sourceId: row.id,
            channelId: row.channelId,
            occurredAt: row.receivedAt,
            ...(row.senderMemberId === null ? {} : { senderMemberId: row.senderMemberId }),
            parts: row.parts,
            ...(row.facts === null ? {} : { facts: row.facts }),
          }
        })
        .filter((entry) => !isConsoleAnchorHistory(entry))
      const outbound = database
        .select({ intent: outboundIntents, channelId: episodes.channelId })
        .from(outboundIntents)
        .innerJoin(episodes, eq(episodes.id, outboundIntents.episodeId))
        .where(eq(episodes.channelId, channelId))
        .all()
        .map(({ intent: input, channelId: projectedChannelId }): ChannelHistoryEntry => {
          const intent = OutboundIntentRowSchema.parse(input)
          return {
            source: 'outbound-intent',
            sourceId: intent.id,
            logicalMessageId: intent.logicalMessageId,
            channelId: projectedChannelId,
            occurredAt: intent.createdAt,
            parts: intent.parts,
            state: intent.state,
            ...(intent.sourceTurnId === null ? {} : { sourceTurnId: intent.sourceTurnId }),
          }
        })
      return [...inbound, ...outbound]
        .filter(
          (entry) =>
            before === undefined ||
            entry.occurredAt < before.occurredAt ||
            (entry.occurredAt === before.occurredAt && entry.sourceId < before.sourceId),
        )
        .sort((left, right) => right.occurredAt - left.occurredAt || right.sourceId.localeCompare(left.sourceId))
        .slice(0, limit)
    },
    listEpisodeHistory(episodeId, options = {}): readonly ChannelHistoryEntry[] {
      const limit = searchLimit(options.limit)
      const episodeCandidate = database.select().from(episodes).where(eq(episodes.id, episodeId)).get()
      if (episodeCandidate === undefined) return []
      const episode = EpisodeRowSchema.parse(episodeCandidate)
      const admittedIds = database
        .select({ id: admissionEvents.eventId })
        .from(admissionEvents)
        .innerJoin(admissions, eq(admissions.id, admissionEvents.admissionId))
        .where(eq(admissions.episodeId, episodeId))
        .all()
        .map(({ id }) => id)
      const inbound =
        admittedIds.length === 0
          ? []
          : database
              .select()
              .from(channelEvents)
              .where(inArray(channelEvents.id, admittedIds))
              .all()
              .map((input): ChannelHistoryEntry => {
                const row = ChannelEventRowSchema.parse(input)
                return {
                  source: 'channel-event',
                  sourceId: row.id,
                  channelId: row.channelId,
                  occurredAt: row.receivedAt,
                  ...(row.senderMemberId === null ? {} : { senderMemberId: row.senderMemberId }),
                  parts: row.parts,
                  ...(row.facts === null ? {} : { facts: row.facts }),
                }
              })
              .filter((entry) => !isConsoleAnchorHistory(entry))
      const outbound = database
        .select()
        .from(outboundIntents)
        .where(eq(outboundIntents.episodeId, episodeId))
        .all()
        .map((input): ChannelHistoryEntry => {
          const row = OutboundIntentRowSchema.parse(input)
          return {
            source: 'outbound-intent',
            sourceId: row.id,
            logicalMessageId: row.logicalMessageId,
            channelId: episode.channelId,
            occurredAt: row.createdAt,
            parts: row.parts,
            state: row.state,
            ...(row.sourceTurnId === null ? {} : { sourceTurnId: row.sourceTurnId }),
          }
        })
      return [...inbound, ...outbound]
        .sort((left, right) => right.occurredAt - left.occurredAt || right.sourceId.localeCompare(left.sourceId))
        .slice(0, limit)
    },
    searchChannelHistory(channelId, query, options = {}) {
      const normalized = query.trim().toLocaleLowerCase()
      if (normalized.length === 0) return []
      const limit = searchLimit(options.limit)
      const hits: { readonly entry: ChannelHistoryEntry; readonly rank: number }[] = []
      let cursor: { readonly occurredAt: number; readonly sourceId: string } | undefined
      while (hits.length < limit) {
        const page = this.listChannelHistory(channelId, {
          ...(cursor === undefined ? {} : { before: cursor }),
          limit: 100,
        })
        if (page.length === 0) break
        const inboundIds = page.flatMap((entry) => (entry.source === 'channel-event' ? [entry.sourceId] : []))
        const outboundIds = page.flatMap((entry) => (entry.source === 'outbound-intent' ? [entry.sourceId] : []))
        const inboundText = new Map(
          inboundIds.length === 0
            ? []
            : database
                .select({ id: channelEvents.id, searchText: channelEvents.searchText })
                .from(channelEvents)
                .where(and(eq(channelEvents.channelId, channelId), inArray(channelEvents.id, inboundIds)))
                .all()
                .map(({ id, searchText }) => [id, searchText] as const),
        )
        const outboundText = new Map(
          outboundIds.length === 0
            ? []
            : database
                .select({ id: outboundIntents.id, searchText: outboundIntents.searchText })
                .from(outboundIntents)
                .innerJoin(episodes, eq(episodes.id, outboundIntents.episodeId))
                .where(and(eq(episodes.channelId, channelId), inArray(outboundIntents.id, outboundIds)))
                .all()
                .map(({ id, searchText }) => [id, searchText] as const),
        )
        for (const entry of page) {
          const text = (
            entry.source === 'channel-event' ? inboundText.get(entry.sourceId) : outboundText.get(entry.sourceId)
          )?.toLocaleLowerCase()
          if (text?.includes(normalized) === true) hits.push({ entry, rank: 1 })
          if (hits.length === limit) break
        }
        const last = page.at(-1)
        if (last === undefined || page.length < 100) break
        cursor = { occurredAt: last.occurredAt, sourceId: last.sourceId }
      }
      return hits
    },
  }
}
