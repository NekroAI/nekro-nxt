import { and, desc, eq, exists, lt, or, sql, type SQL } from 'drizzle-orm'
import type { ChannelHistoryEntry, ChannelHistoryRepository, ChannelHistoryCursor } from '@nekro-nxt/channel-runtime'
import type { ChannelId, EpisodeId } from '@nekro-nxt/contracts'
import type { DrizzleCoreDatabase } from '../database.js'
import { admissionEvents, admissions, channelEvents, episodes, outboundIntents } from '../schema.js'
import { ChannelEventRowSchema, OutboundIntentRowSchema } from '../row-schemas.js'

const historyLimit = (value = 50): number => {
  if (!Number.isInteger(value) || value < 1 || value > 100)
    throw new TypeError('History limit must be between 1 and 100.')
  return value
}

const visibleInbound = sql`coalesce(json_type(${channelEvents.facts}, '$.consoleAnchor'), 'null') != 'true'`
const beforeCursor = (
  time: typeof channelEvents.receivedAt | typeof outboundIntents.createdAt,
  id: typeof channelEvents.id | typeof outboundIntents.id,
  cursor?: ChannelHistoryCursor,
): SQL | undefined =>
  cursor === undefined
    ? undefined
    : or(lt(time, cursor.occurredAt), and(eq(time, cursor.occurredAt), sql`${id} < ${cursor.sourceId} collate binary`))
const textMatch = (
  column: typeof channelEvents.searchText | typeof outboundIntents.searchText,
  query?: string,
): SQL | undefined => (query === undefined ? undefined : sql`instr(nxt_casefold(${column}), ${query}) > 0`)

const inboundEntry = (input: typeof channelEvents.$inferSelect): ChannelHistoryEntry => {
  const row = ChannelEventRowSchema.parse(input)
  return {
    source: 'channel-event',
    sourceId: row.id,
    logicalMessageId: row.logicalMessageId,
    channelId: row.channelId,
    occurredAt: row.receivedAt,
    parts: row.parts,
    ...(row.senderMemberId === null ? {} : { senderMemberId: row.senderMemberId }),
    ...(row.activityKey === null ? {} : { activityKey: row.activityKey }),
    ...(row.targetLogicalMessageId === null ? {} : { targetLogicalMessageId: row.targetLogicalMessageId }),
    ...(row.facts === null ? {} : { facts: row.facts }),
  }
}
const outboundEntry = (input: typeof outboundIntents.$inferSelect, channelId: ChannelId): ChannelHistoryEntry => {
  const row = OutboundIntentRowSchema.parse(input)
  return {
    source: 'outbound-intent',
    sourceId: row.id,
    logicalMessageId: row.logicalMessageId,
    channelId,
    occurredAt: row.createdAt,
    parts: row.parts,
    state: row.state,
    ...(row.sourceTurnId === null ? {} : { sourceTurnId: row.sourceTurnId }),
  }
}

/** Query at most one page from each source; JSON decoding is bounded by the requested page size. */
export function createHistoryRepository(
  database: DrizzleCoreDatabase,
): Pick<ChannelHistoryRepository, 'listChannelHistory' | 'listEpisodeHistory' | 'searchChannelHistory'> {
  const read = (
    channelId: ChannelId,
    limit: number,
    before?: ChannelHistoryCursor,
    query?: string,
    episodeId?: EpisodeId,
  ): readonly ChannelHistoryEntry[] => {
    const admitted =
      episodeId === undefined
        ? undefined
        : exists(
            database
              .select({ id: admissionEvents.eventId })
              .from(admissionEvents)
              .innerJoin(admissions, eq(admissions.id, admissionEvents.admissionId))
              .where(and(eq(admissions.episodeId, episodeId), eq(admissionEvents.eventId, channelEvents.id))),
          )
    const inbound = database
      .select()
      .from(channelEvents)
      .where(
        and(
          eq(channelEvents.channelId, channelId),
          visibleInbound,
          admitted,
          beforeCursor(channelEvents.receivedAt, channelEvents.id, before),
          textMatch(channelEvents.searchText, query),
        ),
      )
      .orderBy(desc(channelEvents.receivedAt), desc(channelEvents.id))
      .limit(limit)
      .all()
      .map(inboundEntry)
    const outbound = database
      .select({ intent: outboundIntents })
      .from(outboundIntents)
      .innerJoin(episodes, eq(episodes.id, outboundIntents.episodeId))
      .where(
        and(
          eq(episodes.channelId, channelId),
          episodeId === undefined ? undefined : eq(episodes.id, episodeId),
          beforeCursor(outboundIntents.createdAt, outboundIntents.id, before),
          textMatch(outboundIntents.searchText, query),
        ),
      )
      .orderBy(desc(outboundIntents.createdAt), desc(outboundIntents.id))
      .limit(limit)
      .all()
      .map(({ intent }) => outboundEntry(intent, channelId))
    return [...inbound, ...outbound]
      .sort(
        (left, right) =>
          right.occurredAt - left.occurredAt ||
          (left.sourceId < right.sourceId ? 1 : left.sourceId > right.sourceId ? -1 : 0),
      )
      .slice(0, limit)
  }
  return {
    listChannelHistory: (channelId, options = {}) => read(channelId, historyLimit(options.limit), options.before),
    listEpisodeHistory: (episodeId, options = {}) => {
      const limit = historyLimit(options.limit)
      const episode = database
        .select({ channelId: episodes.channelId })
        .from(episodes)
        .where(eq(episodes.id, episodeId))
        .get()
      return episode === undefined ? [] : read(episode.channelId, limit, undefined, undefined, episodeId)
    },
    searchChannelHistory: (channelId, query, options = {}) => {
      const normalized = query.trim().toLocaleLowerCase()
      if (normalized.length === 0) return []
      return read(channelId, historyLimit(options.limit), undefined, normalized).map((entry) => ({ entry, rank: 1 }))
    },
  }
}
