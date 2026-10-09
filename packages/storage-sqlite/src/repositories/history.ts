import { and, desc, eq, exists, gte, inArray, lt, or, sql, type SQL } from 'drizzle-orm'
import type {
  ChannelHistoryCursor,
  ChannelHistoryEntry,
  ChannelHistoryFilter,
  ChannelHistoryRepository,
} from '@nekro-nxt/channel-runtime'
import type { ChannelId, EpisodeId } from '@nekro-nxt/contracts'
import type { DrizzleCoreDatabase } from '../database.js'
import { admissionEvents, admissions, channelEvents, channelMembers, episodes, outboundIntents } from '../schema.js'
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
  terms?: readonly string[],
): SQL | undefined =>
  terms === undefined ? undefined : and(...terms.map((term) => sql`instr(nxt_casefold(${column}), ${term}) > 0`))
const timeRange = (
  time: typeof channelEvents.receivedAt | typeof outboundIntents.createdAt,
  filter: ChannelHistoryFilter,
): SQL | undefined =>
  and(
    filter.since === undefined ? undefined : gte(time, filter.since),
    filter.until === undefined ? undefined : lt(time, filter.until),
  )

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
    terms?: readonly string[],
    episodeId?: EpisodeId,
    filter: ChannelHistoryFilter = {},
  ): readonly ChannelHistoryEntry[] => {
    const sender = filter.sender?.trim().toLocaleLowerCase()
    const senders =
      sender === undefined || sender.length === 0
        ? undefined
        : inArray(
            channelEvents.senderMemberId,
            database
              .select({ id: channelMembers.id })
              .from(channelMembers)
              .where(
                and(
                  eq(channelMembers.channelId, channelId),
                  or(
                    sql`nxt_casefold(${channelMembers.id}) = ${sender}`,
                    sql`instr(nxt_casefold(coalesce(${channelMembers.displayName}, '')), ${sender}) > 0`,
                  ),
                ),
              ),
          )
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
    const inbound = filter.ownOnly
      ? []
      : database
          .select()
          .from(channelEvents)
          .where(
            and(
              eq(channelEvents.channelId, channelId),
              visibleInbound,
              admitted,
              senders,
              timeRange(channelEvents.receivedAt, filter),
              beforeCursor(channelEvents.receivedAt, channelEvents.id, before),
              textMatch(channelEvents.searchText, terms),
            ),
          )
          .orderBy(desc(channelEvents.receivedAt), desc(channelEvents.id))
          .limit(limit)
          .all()
          .map(inboundEntry)
    const outbound =
      senders !== undefined
        ? []
        : database
            .select({ intent: outboundIntents })
            .from(outboundIntents)
            .innerJoin(episodes, eq(episodes.id, outboundIntents.episodeId))
            .where(
              and(
                eq(episodes.channelId, channelId),
                episodeId === undefined ? undefined : eq(episodes.id, episodeId),
                timeRange(outboundIntents.createdAt, filter),
                beforeCursor(outboundIntents.createdAt, outboundIntents.id, before),
                textMatch(outboundIntents.searchText, terms),
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
    listChannelHistory: (channelId, options = {}) =>
      read(channelId, historyLimit(options.limit), options.before, undefined, undefined, options),
    listEpisodeHistory: (episodeId, options = {}) => {
      const limit = historyLimit(options.limit)
      const episode = database
        .select({ channelId: episodes.channelId })
        .from(episodes)
        .where(eq(episodes.id, episodeId))
        .get()
      return episode === undefined ? [] : read(episode.channelId, limit, options.before, undefined, episodeId)
    },
    searchChannelHistory: (channelId, query, options = {}) => {
      const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean)
      if (terms.length === 0) return []
      return read(channelId, historyLimit(options.limit), options.before, terms, undefined, options).map((entry) => ({
        entry,
        rank: 1,
      }))
    },
  }
}
