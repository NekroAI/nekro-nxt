import { and, count, eq, inArray, notInArray, or, sql } from 'drizzle-orm'
import type { AssetRecord } from '@nekro-nxt/core'
import { AssetIdSchema, type AssetId, type ChannelId, type EpisodeId } from '@nekro-nxt/contracts'
import type { DrizzleCoreDatabase } from '../database.js'
import {
  admissions,
  assetChannelGrants,
  assetOccurrences,
  assets,
  bindingAdmissionCutoffs,
  channelEvents,
  channelReadCursors,
  channels,
  commandExecutions,
  dynamicAuthoringTasks,
  episodeHandoffs,
  episodes,
  outboundIntents,
  outboundProcessing,
  physicalDeliveries,
  subConversations,
} from '../schema.js'

/** Creation tasks in these states are still being worked on or wait for the administrator. */
const LIVE_AUTHORING_STATUSES = ['working', 'awaiting-approval', 'running', 'ready', 'repairing'] as const
const SENDING_OUTBOUND_STATES = ['planned', 'sending'] as const
const RUNNING_COMMAND_STATUSES = ['pending', 'running'] as const

/** What clearing a channel's history would remove, and what currently stops it. */
export interface ChannelHistoryPurgePreview {
  /** Messages in the timeline: inbound message facts plus everything the host sent. */
  readonly messages: number
  /** Conversations (Episodes) of every agent that was ever bound to the channel. */
  readonly conversations: number
  /** Attachments that appear in the channel; ones still used elsewhere are kept. */
  readonly attachments: number
  readonly blockers: {
    readonly liveAuthoringTasks: number
    readonly sendingMessages: number
    readonly runningCommands: number
  }
}

export interface ChannelHistoryPurgeResult {
  readonly messages: number
  readonly conversations: number
  /** DSH sessions of the removed conversations and sub-conversations; their logs are the caller's to remove. */
  readonly dshSessionIds: readonly string[]
  /** Asset rows removed because nothing references them any more; their blobs are the caller's to remove. */
  readonly removedAssets: readonly AssetRecord[]
}

export interface ChannelHistoryPurgeOptions {
  /** Asset references the database cannot see, such as extension work files or an upload in progress. */
  readonly isAssetHeld?: (asset: AssetRecord) => boolean
}

export class ChannelHistoryPurgeBlockedError extends Error {
  constructor(readonly preview: ChannelHistoryPurgePreview) {
    super('Channel history cannot be cleared while work in it is still running.')
    this.name = 'ChannelHistoryPurgeBlockedError'
  }
}

const ASSET_ID_PATTERN = /ast_[0-9A-Za-z]+/gu
const DIGEST_PATTERN = /[a-f0-9]{64}/gu

type Tx = Parameters<Parameters<DrizzleCoreDatabase['transaction']>[0]>[0]
type Reader = DrizzleCoreDatabase | Tx

const assetIdsIn = (values: Iterable<unknown>): Set<AssetId> => {
  const found = new Set<AssetId>()
  for (const value of values) {
    if (typeof value !== 'string') continue
    for (const match of value.matchAll(ASSET_ID_PATTERN)) {
      const parsed = AssetIdSchema.safeParse(match[0])
      if (parsed.success) found.add(parsed.data)
    }
  }
  return found
}

/**
 * Every text column of every table, searched once for asset ids and content digests. Assets are named in JSON
 * columns (message parts, extension storage, index documents) that have no foreign key, so an asset counts as
 * unused only when no text anywhere in the database names it.
 */
const referencedAssetKeys = (tx: Reader): Set<string> => {
  const columns = tx.all<{ table_name: string; column_name: string }>(
    sql`SELECT m.name AS table_name, p.name AS column_name
      FROM sqlite_master m JOIN pragma_table_info(m.name) p
      WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' AND m.name NOT IN ('assets', '__drizzle_migrations')
        AND (p.type = '' OR upper(p.type) LIKE '%TEXT%' OR upper(p.type) LIKE '%CHAR%' OR upper(p.type) LIKE '%CLOB%')`,
  )
  const keys = new Set<string>()
  for (const { table_name: table, column_name: column } of columns) {
    const name = sql.identifier(column)
    const rows = tx.all<{ value: unknown }>(
      sql`SELECT ${name} AS value FROM ${sql.identifier(table)} WHERE typeof(${name}) = 'text' AND (instr(${name}, 'ast_') > 0 OR instr(${name}, 'sha256') > 0)`,
    )
    for (const { value } of rows) {
      if (typeof value !== 'string') continue
      for (const match of value.matchAll(ASSET_ID_PATTERN)) keys.add(match[0])
      for (const match of value.matchAll(DIGEST_PATTERN)) keys.add(match[0])
    }
  }
  return keys
}

const digestHex = (asset: Pick<AssetRecord, 'contentDigest'>): string => asset.contentDigest.replace(/^sha256:/u, '')

export function createChannelHistoryPurgeRepository(database: DrizzleCoreDatabase) {
  const episodeIdsOf = (tx: Reader, channelId: ChannelId): EpisodeId[] =>
    tx
      .select({ id: episodes.id })
      .from(episodes)
      .where(eq(episodes.channelId, channelId))
      .all()
      .map(({ id }) => id)

  const outboundOf = (episodeIds: readonly EpisodeId[], channelId: ChannelId) =>
    episodeIds.length === 0
      ? eq(outboundIntents.channelId, channelId)
      : or(eq(outboundIntents.channelId, channelId), inArray(outboundIntents.episodeId, [...episodeIds]))

  const candidateAssetIds = (tx: Reader, channelId: ChannelId, episodeIds: readonly EpisodeId[]): Set<AssetId> => {
    const ids = new Set<AssetId>()
    for (const { assetId } of tx
      .select({ assetId: assetOccurrences.assetId })
      .from(assetOccurrences)
      .innerJoin(channelEvents, eq(channelEvents.id, assetOccurrences.channelEventId))
      .where(eq(channelEvents.channelId, channelId))
      .all())
      ids.add(assetId)
    for (const { assetId } of tx
      .select({ assetId: assetChannelGrants.assetId })
      .from(assetChannelGrants)
      .where(eq(assetChannelGrants.channelId, channelId))
      .all())
      ids.add(assetId)
    const outbound = tx
      .select({ id: outboundIntents.id, parts: sql<string>`${outboundIntents.parts}` })
      .from(outboundIntents)
      .where(outboundOf(episodeIds, channelId))
      .all()
    for (const id of assetIdsIn(outbound.map(({ parts }) => parts))) ids.add(id)
    const intentIds = outbound.map(({ id }) => id)
    if (intentIds.length > 0) {
      const deliveries = tx
        .select({ parts: sql<string>`${physicalDeliveries.parts}` })
        .from(physicalDeliveries)
        .where(inArray(physicalDeliveries.intentId, intentIds))
        .all()
      for (const id of assetIdsIn(deliveries.map(({ parts }) => parts))) ids.add(id)
    }
    return ids
  }

  const preview = (tx: Reader, channelId: ChannelId): ChannelHistoryPurgePreview => {
    if (tx.select({ id: channels.id }).from(channels).where(eq(channels.id, channelId)).get() === undefined) {
      throw new Error(`Unknown channel: ${channelId}`)
    }
    const episodeIds = episodeIdsOf(tx, channelId)
    const inbound =
      tx
        .select({ value: count() })
        .from(channelEvents)
        .where(
          and(
            eq(channelEvents.channelId, channelId),
            eq(channelEvents.kind, 'message-created'),
            sql`coalesce(json_type(${channelEvents.facts}, '$.consoleAnchor'), 'null') != 'true'`,
          ),
        )
        .get()?.value ?? 0
    const outbound =
      tx.select({ value: count() }).from(outboundIntents).where(outboundOf(episodeIds, channelId)).get()?.value ?? 0
    const liveAuthoringTasks =
      tx
        .select({ value: count() })
        .from(dynamicAuthoringTasks)
        .where(
          and(
            or(eq(dynamicAuthoringTasks.channelId, channelId), eq(dynamicAuthoringTasks.originChannelId, channelId)),
            inArray(dynamicAuthoringTasks.status, [...LIVE_AUTHORING_STATUSES]),
          ),
        )
        .get()?.value ?? 0
    const sendingMessages =
      tx
        .select({ value: count() })
        .from(outboundIntents)
        .where(and(outboundOf(episodeIds, channelId), inArray(outboundIntents.state, [...SENDING_OUTBOUND_STATES])))
        .get()?.value ?? 0
    const runningCommands =
      tx
        .select({ value: count() })
        .from(commandExecutions)
        .where(
          and(
            eq(commandExecutions.channelId, channelId),
            inArray(commandExecutions.status, [...RUNNING_COMMAND_STATUSES]),
          ),
        )
        .get()?.value ?? 0
    return {
      messages: inbound + outbound,
      conversations: episodeIds.length,
      attachments: candidateAssetIds(tx, channelId, episodeIds).size,
      blockers: { liveAuthoringTasks, sendingMessages, runningCommands },
    }
  }

  return {
    previewChannelHistoryPurge(channelId: ChannelId): ChannelHistoryPurgePreview {
      return preview(database, channelId)
    },

    /**
     * Physically deletes the channel's message history and everything derived from it, in one transaction: message
     * facts with their attachment links, conversations with their admissions, handoffs and sub-conversations, sent
     * messages with their deliveries and processing records, command runs, finished creation tasks, read positions
     * and attachment grants. The channel, its binding, members, prompts, settings, member notes, command policies,
     * scheduled jobs and extension data stay. Attachments nothing else references are removed as well.
     */
    purgeChannelHistory(channelId: ChannelId, options: ChannelHistoryPurgeOptions = {}): ChannelHistoryPurgeResult {
      return database.transaction(
        (tx) => {
          const current = preview(tx, channelId)
          const { liveAuthoringTasks, sendingMessages, runningCommands } = current.blockers
          if (liveAuthoringTasks + sendingMessages + runningCommands > 0) {
            throw new ChannelHistoryPurgeBlockedError(current)
          }
          const episodeIds = episodeIdsOf(tx, channelId)
          const candidates = candidateAssetIds(tx, channelId, episodeIds)
          const dshSessionIds = new Set<string>()
          for (const { dshSessionId } of episodeIds.length === 0
            ? []
            : tx
                .select({ dshSessionId: episodes.dshSessionId })
                .from(episodes)
                .where(inArray(episodes.id, episodeIds))
                .all())
            if (dshSessionId !== null) dshSessionIds.add(dshSessionId)
          for (const { dshSessionId } of tx
            .select({ dshSessionId: subConversations.dshSessionId })
            .from(subConversations)
            .where(eq(subConversations.channelId, channelId))
            .all())
            dshSessionIds.add(dshSessionId)

          tx.delete(subConversations).where(eq(subConversations.channelId, channelId)).run()
          tx.delete(dynamicAuthoringTasks)
            .where(
              or(eq(dynamicAuthoringTasks.channelId, channelId), eq(dynamicAuthoringTasks.originChannelId, channelId)),
            )
            .run()
          // Deliveries, resolutions and processing records of these messages go with them (cascade).
          tx.delete(outboundProcessing).where(eq(outboundProcessing.channelId, channelId)).run()
          tx.delete(outboundIntents).where(outboundOf(episodeIds, channelId)).run()
          tx.delete(commandExecutions).where(eq(commandExecutions.channelId, channelId)).run()
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
            tx.delete(episodes).where(inArray(episodes.id, episodeIds)).run()
          }
          tx.delete(bindingAdmissionCutoffs).where(eq(bindingAdmissionCutoffs.channelId, channelId)).run()
          tx.delete(assetChannelGrants).where(eq(assetChannelGrants.channelId, channelId)).run()
          tx.delete(channelReadCursors).where(eq(channelReadCursors.channelId, channelId)).run()
          // Attachment links, hook decisions and command exclusions of these facts go with them (cascade).
          tx.delete(channelEvents).where(eq(channelEvents.channelId, channelId)).run()

          const removedAssets: AssetRecord[] = []
          if (candidates.size > 0) {
            const structurallyHeld = new Set(
              [
                ...tx
                  .select({ id: assetOccurrences.assetId })
                  .from(assetOccurrences)
                  .where(inArray(assetOccurrences.assetId, [...candidates]))
                  .all(),
                ...tx
                  .select({ id: assetChannelGrants.assetId })
                  .from(assetChannelGrants)
                  .where(inArray(assetChannelGrants.assetId, [...candidates]))
                  .all(),
              ].map(({ id }) => id),
            )
            const unlinked = tx
              .select()
              .from(assets)
              .where(
                and(
                  inArray(assets.id, [...candidates]),
                  structurallyHeld.size === 0 ? undefined : notInArray(assets.id, [...structurallyHeld]),
                ),
              )
              .all()
            if (unlinked.length > 0) {
              const referenced = referencedAssetKeys(tx)
              for (const row of unlinked) {
                const asset: AssetRecord = {
                  id: row.id,
                  contentDigest: row.contentDigest,
                  byteSize: row.byteSize,
                  mediaType: row.mediaType,
                  createdAt: row.createdAt,
                }
                if (referenced.has(asset.id) || referenced.has(digestHex(asset))) continue
                if (options.isAssetHeld?.(asset) === true) continue
                removedAssets.push(asset)
              }
              if (removedAssets.length > 0) {
                tx.delete(assets)
                  .where(
                    inArray(
                      assets.id,
                      removedAssets.map(({ id }) => id),
                    ),
                  )
                  .run()
              }
            }
          }
          return {
            messages: current.messages,
            conversations: current.conversations,
            dshSessionIds: [...dshSessionIds],
            removedAssets,
          }
        },
        { behavior: 'immediate' },
      )
    },
  }
}

export type ChannelHistoryPurgeRepository = ReturnType<typeof createChannelHistoryPurgeRepository>
