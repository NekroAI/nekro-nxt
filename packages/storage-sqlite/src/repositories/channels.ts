import { and, asc, desc, eq, isNull, lt, or } from 'drizzle-orm'
import { normalizeConnectionAlias, type CoreRepository } from '@nekro-nxt/core'
import type {
  AppendChannelEventCommit,
  BindingRecord,
  ChannelEventRecord,
  ChannelMemberRecord,
  ChannelRecord,
  ChannelReferenceRecord,
  ConnectionRecord,
  PlatformIdentityRecord,
  PlatformUserDirectoryRecord,
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
  workTreeOrder,
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
  | 'updateConnectionAlias'
  | 'getConnection'
  | 'listConnectionIdsByAdapter'
  | 'createChannel'
  | 'ensureChannel'
  | 'tombstoneChannel'
  | 'updateChannelDisplayName'
  | 'getChannel'
  | 'getChannelByPlatformId'
  | 'listChannelIdsByConnection'
  | 'ensurePlatformIdentity'
  | 'getPlatformIdentity'
  | 'listPlatformUsers'
  | 'ensureChannelMember'
  | 'getChannelMember'
  | 'getChannelMemberByIdentity'
  | 'replaceBinding'
  | 'clearBinding'
  | 'getBinding'
  | 'listBindings'
  | 'appendChannelEvent'
  | 'getChannelEvent'
  | 'listChannelEvents'
  | 'resolvePlatformMessage'
  | 'resolveLogicalMessage'
  | 'resolveLogicalMessagePlatformId'
> & {
  getChannelReference(id: ChannelId): ChannelReferenceRecord | undefined
}

const toConnection = (input: typeof connections.$inferSelect): ConnectionRecord => {
  const row = ConnectionRowSchema.parse(input)
  return {
    id: row.id,
    adapterKey: row.adapterKey,
    ...(row.alias?.trim() ? { alias: row.alias.trim() } : {}),
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
    ...(row.autoCreatedForAgentId === null ? {} : { autoCreatedForAgentId: row.autoCreatedForAgentId }),
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
    processingFeedback: row.processingFeedback,
    eventTriggers: row.eventTriggers,
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
    ...(row.activityType === null ? {} : { activityType: row.activityType }),
    ...(row.targetPlatformMessageId === null ? {} : { targetPlatformMessageId: row.targetPlatformMessageId }),
    ...(row.targetLogicalMessageId === null ? {} : { targetLogicalMessageId: row.targetLogicalMessageId }),
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
    const row = database
      .select()
      .from(channels)
      .where(and(eq(channels.id, id), isNull(channels.deletedAt)))
      .get()
    return row === undefined ? undefined : toChannel(row)
  }
  const getChannelReference = (id: ChannelId): ChannelReferenceRecord | undefined => {
    const row = database.select().from(channels).where(eq(channels.id, id)).get()
    return row === undefined ? undefined : { channel: toChannel(row), removed: row.deletedAt !== null }
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
      database
        .insert(connections)
        .values({ ...record, alias: normalizeConnectionAlias(record.alias) ?? null })
        .run()
    },
    updateConnectionAlias(id, alias): void {
      if (
        database
          .update(connections)
          .set({ alias: normalizeConnectionAlias(alias) ?? null })
          .where(eq(connections.id, id))
          .run().changes !== 1
      ) {
        throw new Error(`Unknown connection: ${id}`)
      }
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
              ? { kind: record.kind, deletedAt: null }
              : { kind: record.kind, displayName: record.displayName, deletedAt: null },
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
    tombstoneChannel(id, deletedAt): void {
      if (!Number.isSafeInteger(deletedAt) || deletedAt < 0) {
        throw new TypeError('Channel delete time must be non-negative.')
      }
      database.transaction(
        (tx) => {
          tx.delete(channelBindings).where(eq(channelBindings.channelId, id)).run()
          const changed = tx
            .update(channels)
            .set({ deletedAt })
            .where(and(eq(channels.id, id), isNull(channels.deletedAt)))
            .run().changes
          if (changed !== 1) throw new Error(`Unknown or deleted channel: ${id}`)
          const order = tx.select().from(workTreeOrder).where(eq(workTreeOrder.id, 1)).get()
          if (order) {
            const channelIdsByAgent = Object.fromEntries(
              Object.entries(order.channelIdsByAgent).map(([agentId, channelIds]) => [
                agentId,
                channelIds.filter((channelId) => channelId !== id),
              ]),
            )
            tx.update(workTreeOrder)
              .set({
                channelIdsByAgent,
                unboundChannelIds: order.unboundChannelIds.filter((channelId) => channelId !== id),
              })
              .where(eq(workTreeOrder.id, 1))
              .run()
          }
        },
        { behavior: 'immediate' },
      )
    },
    updateChannelDisplayName(id, displayName): void {
      if (
        database
          .update(channels)
          .set({ displayName })
          .where(and(eq(channels.id, id), isNull(channels.deletedAt)))
          .run().changes !== 1
      ) {
        throw new Error(`Unknown channel: ${id}`)
      }
    },
    getChannel,
    getChannelReference,
    getChannelByPlatformId(connectionId, platformChannelId): ChannelRecord | undefined {
      const row = database
        .select()
        .from(channels)
        .where(
          and(
            eq(channels.connectionId, connectionId),
            eq(channels.platformChannelId, platformChannelId),
            isNull(channels.deletedAt),
          ),
        )
        .get()
      return row === undefined ? undefined : toChannel(row)
    },
    listChannelIdsByConnection(connectionId): readonly ChannelId[] {
      return database
        .select({ id: channels.id })
        .from(channels)
        .where(and(eq(channels.connectionId, connectionId), isNull(channels.deletedAt)))
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
    listPlatformUsers(): readonly PlatformUserDirectoryRecord[] {
      const rows = database
        .select({ identity: platformIdentities, connection: connections, member: channelMembers, channel: channels })
        .from(platformIdentities)
        .innerJoin(connections, eq(connections.id, platformIdentities.connectionId))
        .leftJoin(channelMembers, eq(channelMembers.platformIdentityId, platformIdentities.id))
        .leftJoin(channels, eq(channels.id, channelMembers.channelId))
        .orderBy(asc(platformIdentities.id), asc(channels.id))
        .all()
      const directory = new Map<PlatformIdentityId, PlatformUserDirectoryRecord>()
      for (const row of rows) {
        const current = directory.get(row.identity.id)
        const activeChannel =
          row.channel === null || row.channel.deletedAt !== null
            ? undefined
            : {
                id: row.channel.id,
                kind: row.channel.kind,
                ...(row.channel.displayName === null ? {} : { displayName: row.channel.displayName }),
              }
        if (current) {
          if (activeChannel && !current.activeChannels.some(({ id }) => id === activeChannel.id)) {
            directory.set(row.identity.id, {
              ...current,
              activeChannels: [...current.activeChannels, activeChannel],
              historicalOnly: false,
            })
          }
          continue
        }
        directory.set(row.identity.id, {
          identityId: row.identity.id,
          ...(row.identity.displayName === null ? {} : { displayName: row.identity.displayName }),
          connection: {
            id: row.connection.id,
            adapterKey: row.connection.adapterKey,
            ...(row.connection.alias === null ? {} : { alias: row.connection.alias }),
            createdAt: row.connection.createdAt,
          },
          activeChannels: activeChannel ? [activeChannel] : [],
          historicalOnly: activeChannel === undefined,
        })
      }
      return [...directory.values()]
    },
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
          set: {
            agentId: record.agentId,
            triggerPolicy: record.triggerPolicy,
            processingFeedback: record.processingFeedback,
            eventTriggers: record.eventTriggers,
            boundAt: record.boundAt,
          },
        })
        .run()
      return record
    },
    clearBinding(channelId): void {
      database.delete(channelBindings).where(eq(channelBindings.channelId, channelId)).run()
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
    resolveLogicalMessage(connectionId, channelId, logicalMessageId): PlatformMessageReferenceRecord | undefined {
      const channel = getChannel(channelId)
      if (channel?.connectionId !== connectionId) return undefined
      const inbound = database
        .select({ logicalMessageId: channelEvents.logicalMessageId })
        .from(channelEvents)
        .where(and(eq(channelEvents.channelId, channelId), eq(channelEvents.logicalMessageId, logicalMessageId)))
        .get()
      if (inbound !== undefined) return { logicalMessageId: inbound.logicalMessageId, authoredByAgent: false }
      const outbound = database
        .select({ logicalMessageId: outboundIntents.logicalMessageId })
        .from(outboundIntents)
        .innerJoin(episodes, eq(episodes.id, outboundIntents.episodeId))
        .where(and(eq(episodes.channelId, channelId), eq(outboundIntents.logicalMessageId, logicalMessageId)))
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
