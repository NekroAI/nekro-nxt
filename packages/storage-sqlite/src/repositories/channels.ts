import { and, asc, desc, eq, lt, or } from 'drizzle-orm'
import type { CoreRepository } from '@nekro-nxt/core'
import type {
  AppendChannelEventCommit,
  BindingRecord,
  ChannelEventRecord,
  ChannelMemberRecord,
  ChannelRecord,
  ConnectionRecord,
  PlatformIdentityRecord,
  PlatformMessageReferenceRecord,
} from '@nekro-nxt/core'
import type { ChannelEventId, ChannelId, ChannelMemberId, ConnectionId, PlatformIdentityId } from '@nekro-nxt/contracts'
import type { DrizzleCoreDatabase } from '../database.js'
import {
  channelBindings,
  assetOccurrences,
  channelEvents,
  channelMembers,
  channels,
  connections,
  episodes,
  outboundIntents,
  physicalDeliveries,
  platformIdentities,
} from '../schema.js'
import {
  ChannelBindingRowSchema,
  ChannelEventRowSchema,
  ChannelMemberRowSchema,
  ChannelRowSchema,
  ConnectionRowSchema,
  PlatformIdentityRowSchema,
} from '../row-schemas.js'

type ChannelRepository = Pick<
  CoreRepository,
  | 'createConnection'
  | 'getConnection'
  | 'listConnectionIdsByAdapter'
  | 'createChannel'
  | 'ensureChannel'
  | 'updateChannelDisplayName'
  | 'getChannel'
  | 'getChannelByPlatformId'
  | 'listChannelIdsByConnection'
  | 'ensurePlatformIdentity'
  | 'getPlatformIdentity'
  | 'ensureChannelMember'
  | 'getChannelMember'
  | 'getChannelMemberByIdentity'
  | 'replaceBinding'
  | 'getBinding'
  | 'listBindings'
  | 'appendChannelEvent'
  | 'getChannelEvent'
  | 'listChannelEvents'
  | 'resolvePlatformMessage'
  | 'resolveLogicalMessagePlatformId'
>

const toConnection = (input: typeof connections.$inferSelect): ConnectionRecord => {
  const row = ConnectionRowSchema.parse(input)
  return {
    id: row.id,
    adapterKey: row.adapterKey,
    config: row.config,
    credentialRefs: row.credentialRefs,
    createdAt: row.createdAt,
  }
}

const toChannel = (input: typeof channels.$inferSelect): ChannelRecord => {
  const row = ChannelRowSchema.parse(input)
  return {
    id: row.id,
    connectionId: row.connectionId,
    platformChannelId: row.platformChannelId,
    kind: row.kind,
    ...(row.displayName === null ? {} : { displayName: row.displayName }),
    createdAt: row.createdAt,
  }
}

const toIdentity = (input: typeof platformIdentities.$inferSelect): PlatformIdentityRecord => {
  const row = PlatformIdentityRowSchema.parse(input)
  return {
    id: row.id,
    connectionId: row.connectionId,
    platformUserId: row.platformUserId,
    ...(row.displayName === null ? {} : { displayName: row.displayName }),
  }
}

const toMember = (input: typeof channelMembers.$inferSelect): ChannelMemberRecord => {
  const row = ChannelMemberRowSchema.parse(input)
  return {
    id: row.id,
    channelId: row.channelId,
    platformIdentityId: row.platformIdentityId,
    ...(row.displayName === null ? {} : { displayName: row.displayName }),
  }
}

const toBinding = (input: typeof channelBindings.$inferSelect): BindingRecord => {
  const row = ChannelBindingRowSchema.parse(input)
  return {
    channelId: row.channelId,
    agentId: row.agentId,
    triggerPolicy: row.triggerPolicy,
    boundAt: row.boundAt,
  }
}

const toEvent = (input: typeof channelEvents.$inferSelect): ChannelEventRecord => {
  const row = ChannelEventRowSchema.parse(input)
  return {
    id: row.id,
    logicalMessageId: row.logicalMessageId,
    channelId: row.channelId,
    ...(row.platformMessageId === null ? {} : { platformMessageId: row.platformMessageId }),
    kind: row.kind,
    ...(row.senderMemberId === null ? {} : { senderMemberId: row.senderMemberId }),
    parts: row.parts,
    sourceTimestamp: row.sourceTimestamp,
    receivedAt: row.receivedAt,
    dedupeKey: row.dedupeKey,
    ...(row.facts === null ? {} : { facts: row.facts }),
    searchText: row.searchText,
  }
}

export function createChannelsRepository(database: DrizzleCoreDatabase): ChannelRepository {
  const getConnection = (id: ConnectionId): ConnectionRecord | undefined => {
    const row = database.select().from(connections).where(eq(connections.id, id)).get()
    return row === undefined ? undefined : toConnection(row)
  }
  const getChannel = (id: ChannelId): ChannelRecord | undefined => {
    const row = database.select().from(channels).where(eq(channels.id, id)).get()
    return row === undefined ? undefined : toChannel(row)
  }
  const getPlatformIdentity = (id: PlatformIdentityId): PlatformIdentityRecord | undefined => {
    const row = database.select().from(platformIdentities).where(eq(platformIdentities.id, id)).get()
    return row === undefined ? undefined : toIdentity(row)
  }
  const getChannelMember = (id: ChannelMemberId): ChannelMemberRecord | undefined => {
    const row = database.select().from(channelMembers).where(eq(channelMembers.id, id)).get()
    return row === undefined ? undefined : toMember(row)
  }
  const getBinding = (channelId: ChannelId): BindingRecord | undefined => {
    const row = database.select().from(channelBindings).where(eq(channelBindings.channelId, channelId)).get()
    return row === undefined ? undefined : toBinding(row)
  }
  const getChannelEvent = (id: ChannelEventId): ChannelEventRecord | undefined => {
    const row = database.select().from(channelEvents).where(eq(channelEvents.id, id)).get()
    return row === undefined ? undefined : toEvent(row)
  }

  return {
    createConnection(record): void {
      database.insert(connections).values(record).run()
    },
    getConnection,
    listConnectionIdsByAdapter(adapterKey?: string): readonly ConnectionId[] {
      const query = database.select({ id: connections.id }).from(connections)
      return (adapterKey === undefined ? query : query.where(eq(connections.adapterKey, adapterKey)))
        .orderBy(asc(connections.createdAt), asc(connections.id))
        .all()
        .map(({ id }) => id)
    },
    createChannel(record): void {
      database.insert(channels).values(record).run()
    },
    ensureChannel(record): ChannelRecord {
      database
        .insert(channels)
        .values(record)
        .onConflictDoUpdate({
          target: [channels.connectionId, channels.platformChannelId],
          set:
            record.displayName === undefined
              ? { kind: record.kind }
              : { kind: record.kind, displayName: record.displayName },
        })
        .run()
      const stored = database
        .select()
        .from(channels)
        .where(
          and(eq(channels.connectionId, record.connectionId), eq(channels.platformChannelId, record.platformChannelId)),
        )
        .get()
      if (stored === undefined) throw new Error('Channel upsert did not produce a row.')
      return toChannel(stored)
    },
    updateChannelDisplayName(id, displayName): void {
      if (database.update(channels).set({ displayName }).where(eq(channels.id, id)).run().changes !== 1) {
        throw new Error(`Unknown channel: ${id}`)
      }
    },
    getChannel,
    getChannelByPlatformId(connectionId, platformChannelId): ChannelRecord | undefined {
      const row = database
        .select()
        .from(channels)
        .where(and(eq(channels.connectionId, connectionId), eq(channels.platformChannelId, platformChannelId)))
        .get()
      return row === undefined ? undefined : toChannel(row)
    },
    listChannelIdsByConnection(connectionId): readonly ChannelId[] {
      return database
        .select({ id: channels.id })
        .from(channels)
        .where(eq(channels.connectionId, connectionId))
        .orderBy(asc(channels.createdAt), asc(channels.id))
        .all()
        .map(({ id }) => id)
    },
    ensurePlatformIdentity(record): PlatformIdentityRecord {
      const insert = database.insert(platformIdentities).values(record)
      if (record.displayName === undefined) {
        insert
          .onConflictDoNothing({ target: [platformIdentities.connectionId, platformIdentities.platformUserId] })
          .run()
      } else {
        insert
          .onConflictDoUpdate({
            target: [platformIdentities.connectionId, platformIdentities.platformUserId],
            set: { displayName: record.displayName },
          })
          .run()
      }
      const row = database
        .select()
        .from(platformIdentities)
        .where(
          and(
            eq(platformIdentities.connectionId, record.connectionId),
            eq(platformIdentities.platformUserId, record.platformUserId),
          ),
        )
        .get()
      if (row === undefined) throw new Error('Platform Identity upsert did not produce a row.')
      return toIdentity(row)
    },
    getPlatformIdentity,
    ensureChannelMember(record): ChannelMemberRecord {
      const insert = database.insert(channelMembers).values(record)
      if (record.displayName === undefined) {
        insert.onConflictDoNothing({ target: [channelMembers.channelId, channelMembers.platformIdentityId] }).run()
      } else {
        insert
          .onConflictDoUpdate({
            target: [channelMembers.channelId, channelMembers.platformIdentityId],
            set: { displayName: record.displayName },
          })
          .run()
      }
      const row = database
        .select()
        .from(channelMembers)
        .where(
          and(
            eq(channelMembers.channelId, record.channelId),
            eq(channelMembers.platformIdentityId, record.platformIdentityId),
          ),
        )
        .get()
      if (row === undefined) throw new Error('Channel Member upsert did not produce a row.')
      return toMember(row)
    },
    getChannelMember,
    getChannelMemberByIdentity(channelId, platformIdentityId): ChannelMemberRecord | undefined {
      const row = database
        .select()
        .from(channelMembers)
        .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.platformIdentityId, platformIdentityId)))
        .get()
      return row === undefined ? undefined : toMember(row)
    },
    replaceBinding(record): BindingRecord {
      database
        .insert(channelBindings)
        .values(record)
        .onConflictDoUpdate({
          target: channelBindings.channelId,
          set: { agentId: record.agentId, triggerPolicy: record.triggerPolicy, boundAt: record.boundAt },
        })
        .run()
      return record
    },
    getBinding,
    listBindings(channelId): readonly BindingRecord[] {
      const binding = getBinding(channelId)
      return binding === undefined ? [] : [binding]
    },
    appendChannelEvent(candidate, occurrences = []): AppendChannelEventCommit {
      const inserted = database.transaction(
        (tx) => {
          const changed = tx
            .insert(channelEvents)
            .values(candidate)
            .onConflictDoNothing({ target: [channelEvents.channelId, channelEvents.dedupeKey] })
            .run().changes
          if (changed === 1 && occurrences.length > 0) {
            tx.insert(assetOccurrences)
              .values(
                occurrences.map(({ partIndex, assetId }) => ({
                  channelEventId: candidate.id,
                  partIndex,
                  assetId,
                })),
              )
              .run()
          }
          return changed === 1
        },
        { behavior: 'immediate' },
      )
      if (inserted) return { event: candidate, inserted: true }
      const row = database
        .select()
        .from(channelEvents)
        .where(and(eq(channelEvents.channelId, candidate.channelId), eq(channelEvents.dedupeKey, candidate.dedupeKey)))
        .get()
      if (row === undefined) throw new Error('Channel Event dedupe conflict has no existing row.')
      return { event: toEvent(row), inserted: false }
    },
    getChannelEvent,
    listChannelEvents(channelId, options = {}): readonly ChannelEventRecord[] {
      const limit = options.limit ?? 50
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TypeError('Invalid Channel Event limit.')
      const cursor = options.before
      return database
        .select()
        .from(channelEvents)
        .where(
          cursor === undefined
            ? eq(channelEvents.channelId, channelId)
            : and(
                eq(channelEvents.channelId, channelId),
                or(
                  lt(channelEvents.receivedAt, cursor.receivedAt),
                  and(eq(channelEvents.receivedAt, cursor.receivedAt), lt(channelEvents.id, cursor.id)),
                ),
              ),
        )
        .orderBy(desc(channelEvents.receivedAt), desc(channelEvents.id))
        .limit(limit)
        .all()
        .reverse()
        .map(toEvent)
    },
    resolvePlatformMessage(connectionId, channelId, platformMessageId): PlatformMessageReferenceRecord | undefined {
      const channel = getChannel(channelId)
      if (channel?.connectionId !== connectionId) return undefined
      const inbound = database
        .select({ logicalMessageId: channelEvents.logicalMessageId })
        .from(channelEvents)
        .where(and(eq(channelEvents.channelId, channelId), eq(channelEvents.platformMessageId, platformMessageId)))
        .get()
      if (inbound !== undefined) return { logicalMessageId: inbound.logicalMessageId, authoredByAgent: false }
      const outbound = database
        .select({ logicalMessageId: outboundIntents.logicalMessageId })
        .from(physicalDeliveries)
        .innerJoin(outboundIntents, eq(outboundIntents.id, physicalDeliveries.intentId))
        .innerJoin(episodes, eq(episodes.id, outboundIntents.episodeId))
        .where(and(eq(episodes.channelId, channelId), eq(physicalDeliveries.platformMessageId, platformMessageId)))
        .get()
      return outbound === undefined ? undefined : { logicalMessageId: outbound.logicalMessageId, authoredByAgent: true }
    },
    resolveLogicalMessagePlatformId(connectionId, channelId, logicalMessageId): string | undefined {
      const channel = getChannel(channelId)
      if (channel?.connectionId !== connectionId) return undefined
      const inbound = database
        .select({ platformMessageId: channelEvents.platformMessageId })
        .from(channelEvents)
        .where(and(eq(channelEvents.channelId, channelId), eq(channelEvents.logicalMessageId, logicalMessageId)))
        .get()
      if (inbound?.platformMessageId) return inbound.platformMessageId
      return (
        database
          .select({ platformMessageId: physicalDeliveries.platformMessageId })
          .from(physicalDeliveries)
          .innerJoin(outboundIntents, eq(outboundIntents.id, physicalDeliveries.intentId))
          .innerJoin(episodes, eq(episodes.id, outboundIntents.episodeId))
          .where(and(eq(episodes.channelId, channelId), eq(outboundIntents.logicalMessageId, logicalMessageId)))
          .orderBy(asc(physicalDeliveries.sequence))
          .get()?.platformMessageId ?? undefined
      )
    },
  }
}
