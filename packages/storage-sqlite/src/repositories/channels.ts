import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm'
import { normalizeConnectionAlias, type CoreRepository } from '@nekro-nxt/core'
import type {
  AppendChannelEventCommit,
  AppendConnectionEventCommit,
  BindingRecord,
  ArchivedConnectionRecord,
  ChannelEventRecord,
  ChannelMemberRecord,
  ChannelRecord,
  ChannelReferenceRecord,
  ConnectionRecord,
  ConnectionEventRecord,
  PlatformIdentityRecord,
  PlatformUserDirectoryRecord,
  PlatformMessageReferenceRecord,
} from '@nekro-nxt/core'
import type { ChannelEventId, ChannelId, ChannelMemberId, ConnectionId, PlatformIdentityId } from '@nekro-nxt/contracts'
import type { DrizzleCoreDatabase } from '../database.js'
import {
  channelBindings,
  admissions,
  assetChannelGrants,
  assetOccurrences,
  dynamicAuthoringTasks,
  episodeHandoffs,
  channelEvents,
  channelMembers,
  channels,
  connections,
  connectionEvents,
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
  ConnectionEventRowSchema,
  PlatformIdentityRowSchema,
} from '../row-schemas.js'

type ChannelRepository = Pick<
  CoreRepository,
  | 'createConnection'
  | 'updateConnectionAlias'
  | 'updateConnectionConfig'
  | 'updateConnectionActivityTriggerDefaults'
  | 'archiveConnection'
  | 'restoreConnection'
  | 'purgeConnection'
  | 'getConnection'
  | 'getArchivedConnection'
  | 'listArchivedConnections'
  | 'listConnectionIdsByAdapter'
  | 'appendConnectionEvent'
  | 'listConnectionEvents'
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
    ...(row.accountKey === null ? {} : { accountKey: row.accountKey }),
    ...(row.alias?.trim() ? { alias: row.alias.trim() } : {}),
    config: row.config,
    credentialRefs: row.credentialRefs,
    activityTriggerDefaults: row.activityTriggerDefaults,
    createdAt: row.createdAt,
  }
}

const toConnectionEvent = (input: typeof connectionEvents.$inferSelect): ConnectionEventRecord => {
  const row = ConnectionEventRowSchema.parse(input)
  return {
    id: row.id,
    connectionId: row.connectionId,
    activityKey: row.activityKey,
    summary: row.summary,
    ...(row.actorIdentityId === null ? {} : { actorIdentityId: row.actorIdentityId }),
    ...(row.subjectIdentityId === null ? {} : { subjectIdentityId: row.subjectIdentityId }),
    sourceTimestamp: row.sourceTimestamp,
    receivedAt: row.receivedAt,
    dedupeKey: row.dedupeKey,
    ...(row.facts === null ? {} : { facts: row.facts }),
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
    activityTriggerOverrides: Object.fromEntries([
      ...row.activityTriggerOverridesEnabled.map((key) => [key, true] as const),
      ...row.activityTriggerSuppressions.map((key) => [key, false] as const),
    ]),
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
    ...(row.activityKey === null ? {} : { activityKey: row.activityKey }),
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
    const row = database
      .select()
      .from(connections)
      .where(and(eq(connections.id, id), isNull(connections.archivedAt)))
      .get()
    return row === undefined ? undefined : toConnection(row)
  }
  const getArchivedConnection = (id: ConnectionId): ArchivedConnectionRecord | undefined => {
    const row = database
      .select()
      .from(connections)
      .where(and(eq(connections.id, id), isNotNull(connections.archivedAt)))
      .get()
    return row === undefined || row.archivedAt === null
      ? undefined
      : { ...toConnection(row), archivedAt: row.archivedAt }
  }
  const getChannel = (id: ChannelId): ChannelRecord | undefined => {
    const row = database
      .select()
      .from(channels)
      .where(and(eq(channels.id, id), isNull(channels.deletedAt)))
      .get()
    if (row === undefined) return undefined
    const channel = toChannel(row)
    const owner = database
      .select({ archivedAt: connections.archivedAt })
      .from(connections)
      .where(eq(connections.id, channel.connectionId))
      .get()
    return owner === undefined || owner.archivedAt !== null ? undefined : channel
  }
  const getChannelReference = (id: ChannelId): ChannelReferenceRecord | undefined => {
    const row = database
      .select({ channel: channels, connectionArchivedAt: connections.archivedAt })
      .from(channels)
      .innerJoin(connections, eq(connections.id, channels.connectionId))
      .where(eq(channels.id, id))
      .get()
    return row === undefined
      ? undefined
      : {
          channel: toChannel(row.channel),
          removed: row.channel.deletedAt !== null || row.connectionArchivedAt !== null,
        }
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
          .where(and(eq(connections.id, id), isNull(connections.archivedAt)))
          .run().changes !== 1
      ) {
        throw new Error(`Unknown connection: ${id}`)
      }
    },
    updateConnectionConfig(id, config): void {
      if (
        database
          .update(connections)
          .set({ config })
          .where(and(eq(connections.id, id), isNull(connections.archivedAt)))
          .run().changes !== 1
      ) {
        throw new Error(`Unknown connection: ${id}`)
      }
    },
    updateConnectionActivityTriggerDefaults(id, activityKeys): void {
      if (
        database
          .update(connections)
          .set({ activityTriggerDefaults: activityKeys })
          .where(and(eq(connections.id, id), isNull(connections.archivedAt)))
          .run().changes !== 1
      ) {
        throw new Error(`Unknown connection: ${id}`)
      }
    },
    archiveConnection(id, archivedAt): void {
      if (
        database
          .update(connections)
          .set({ archivedAt })
          .where(and(eq(connections.id, id), isNull(connections.archivedAt)))
          .run().changes !== 1
      ) {
        throw new Error(`Unknown connection: ${id}`)
      }
    },
    restoreConnection(id): void {
      if (
        database
          .update(connections)
          .set({ archivedAt: null })
          .where(and(eq(connections.id, id), isNotNull(connections.archivedAt)))
          .run().changes !== 1
      ) {
        throw new Error(`Unknown archived connection: ${id}`)
      }
    },
    purgeConnection(id): void {
      database.transaction((tx) => {
        const channelIds = tx
          .select({ id: channels.id })
          .from(channels)
          .where(eq(channels.connectionId, id))
          .all()
          .map(({ id }) => id)
        if (channelIds.length > 0) {
          const episodeIds = tx
            .select({ id: episodes.id })
            .from(episodes)
            .where(inArray(episodes.channelId, channelIds))
            .all()
            .map(({ id }) => id)
          tx.delete(dynamicAuthoringTasks).where(inArray(dynamicAuthoringTasks.channelId, channelIds)).run()
          if (episodeIds.length > 0) {
            tx.delete(episodeHandoffs)
              .where(
                or(
                  inArray(episodeHandoffs.fromEpisodeId, episodeIds),
                  inArray(episodeHandoffs.toEpisodeId, episodeIds),
                ),
              )
              .run()
            tx.delete(admissions).where(inArray(admissions.episodeId, episodeIds)).run()
            tx.delete(outboundIntents).where(inArray(outboundIntents.episodeId, episodeIds)).run()
            tx.delete(episodes).where(inArray(episodes.id, episodeIds)).run()
          }
          tx.delete(assetChannelGrants).where(inArray(assetChannelGrants.channelId, channelIds)).run()
          tx.delete(channelEvents).where(inArray(channelEvents.channelId, channelIds)).run()
          tx.delete(channelBindings).where(inArray(channelBindings.channelId, channelIds)).run()
          tx.delete(channelMembers).where(inArray(channelMembers.channelId, channelIds)).run()
          tx.delete(channels).where(inArray(channels.id, channelIds)).run()
        }
        tx.delete(connectionEvents).where(eq(connectionEvents.connectionId, id)).run()
        tx.delete(platformIdentities).where(eq(platformIdentities.connectionId, id)).run()
        if (tx.delete(connections).where(eq(connections.id, id)).run().changes !== 1) {
          throw new Error(`Unknown connection: ${id}`)
        }
      })
    },
    getConnection,
    getArchivedConnection,
    listArchivedConnections(): readonly ArchivedConnectionRecord[] {
      return database
        .select()
        .from(connections)
        .where(isNotNull(connections.archivedAt))
        .orderBy(desc(connections.archivedAt), desc(connections.id))
        .all()
        .flatMap((row) => (row.archivedAt === null ? [] : [{ ...toConnection(row), archivedAt: row.archivedAt }]))
    },
    listConnectionIdsByAdapter(adapterKey?: string): readonly ConnectionId[] {
      const query = database.select({ id: connections.id }).from(connections)
      return (
        adapterKey === undefined
          ? query.where(isNull(connections.archivedAt))
          : query.where(and(eq(connections.adapterKey, adapterKey), isNull(connections.archivedAt)))
      )
        .orderBy(asc(connections.createdAt), asc(connections.id))
        .all()
        .map(({ id }) => id)
    },
    appendConnectionEvent(candidate): AppendConnectionEventCommit {
      const changed = database
        .insert(connectionEvents)
        .values(candidate)
        .onConflictDoNothing({ target: [connectionEvents.connectionId, connectionEvents.dedupeKey] })
        .run().changes
      if (changed === 1) return { event: candidate, inserted: true }
      const stored = database
        .select()
        .from(connectionEvents)
        .where(
          and(
            eq(connectionEvents.connectionId, candidate.connectionId),
            eq(connectionEvents.dedupeKey, candidate.dedupeKey),
          ),
        )
        .get()
      if (!stored) throw new Error('Connection event dedupe conflict did not produce a stored row.')
      return { event: toConnectionEvent(stored), inserted: false }
    },
    listConnectionEvents(connectionId, options = {}): readonly ConnectionEventRecord[] {
      const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
      const cursor = options.before
      return database
        .select()
        .from(connectionEvents)
        .where(
          cursor === undefined
            ? eq(connectionEvents.connectionId, connectionId)
            : and(
                eq(connectionEvents.connectionId, connectionId),
                or(
                  lt(connectionEvents.receivedAt, cursor.receivedAt),
                  and(eq(connectionEvents.receivedAt, cursor.receivedAt), lt(connectionEvents.id, cursor.id)),
                ),
              ),
        )
        .orderBy(desc(connectionEvents.receivedAt), desc(connectionEvents.id))
        .limit(limit)
        .all()
        .map(toConnectionEvent)
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
        .where(isNull(connections.archivedAt))
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
      const activityTriggerOverridesEnabled = Object.entries(record.activityTriggerOverrides)
        .filter(([, enabled]) => enabled)
        .map(([key]) => key)
      const activityTriggerSuppressions = Object.entries(record.activityTriggerOverrides)
        .filter(([, enabled]) => !enabled)
        .map(([key]) => key)
      database
        .insert(channelBindings)
        .values({ ...record, activityTriggerOverridesEnabled, activityTriggerSuppressions })
        .onConflictDoUpdate({
          target: channelBindings.channelId,
          set: {
            agentId: record.agentId,
            triggerPolicy: record.triggerPolicy,
            processingFeedback: record.processingFeedback,
            activityTriggerOverridesEnabled,
            activityTriggerSuppressions,
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
