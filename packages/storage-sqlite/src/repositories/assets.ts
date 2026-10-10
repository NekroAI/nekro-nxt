import { and, eq, sql } from 'drizzle-orm'
import type { AssetAccessRepository, AssetChannelGrant, AssetRecord } from '@nekro-nxt/core'
import type { AssetId, ChannelId } from '@nekro-nxt/contracts'
import type { DrizzleCoreDatabase } from '../database.js'
import { assetChannelGrants, assetOccurrences, assets, channelEvents, episodes, outboundIntents } from '../schema.js'
import { AssetChannelGrantRowSchema, AssetRowSchema } from '../row-schemas.js'

const toAsset = (input: typeof assets.$inferSelect): AssetRecord => {
  const row = AssetRowSchema.parse(input)
  return {
    id: row.id,
    contentDigest: row.contentDigest,
    byteSize: row.byteSize,
    mediaType: row.mediaType,
    createdAt: row.createdAt,
  }
}

const toAssetChannelGrant = (input: typeof assetChannelGrants.$inferSelect): AssetChannelGrant => {
  const row = AssetChannelGrantRowSchema.parse(input)
  return {
    assetId: row.assetId,
    channelId: row.channelId,
    source: row.source,
    grantedAt: row.grantedAt,
  }
}

export function createAssetsRepository(database: DrizzleCoreDatabase): AssetAccessRepository & {
  getAssetById(id: AssetId): AssetRecord | undefined
  revokeUnusedAgentAsset(assetId: AssetId, channelId: ChannelId): 'revoked' | 'in-use' | 'not-granted'
} {
  return {
    ensureAsset(candidate): AssetRecord {
      database.insert(assets).values(candidate).onConflictDoNothing({ target: assets.contentDigest }).run()
      const row = database.select().from(assets).where(eq(assets.contentDigest, candidate.contentDigest)).get()
      if (row === undefined) throw new Error('Asset upsert did not produce a row.')
      return toAsset(row)
    },
    getAssetById(id): AssetRecord | undefined {
      const row = database.select().from(assets).where(eq(assets.id, id)).get()
      return row === undefined ? undefined : toAsset(row)
    },
    grantAssetAccess(grant): AssetChannelGrant {
      database
        .insert(assetChannelGrants)
        .values(grant)
        .onConflictDoNothing({ target: [assetChannelGrants.assetId, assetChannelGrants.channelId] })
        .run()
      const row = database
        .select()
        .from(assetChannelGrants)
        .where(and(eq(assetChannelGrants.assetId, grant.assetId), eq(assetChannelGrants.channelId, grant.channelId)))
        .get()
      if (row === undefined) throw new Error('Asset Channel grant upsert did not produce a row.')
      return toAssetChannelGrant(row)
    },
    /**
     * Withdraws the agent's own grant for an Asset nothing in the channel uses yet: no member message carries it and
     * the agent has not sent it. The content-addressed blob stays, since other channels or messages may share it.
     */
    revokeUnusedAgentAsset(assetId, channelId) {
      return database.transaction((tx) => {
        const grant = tx
          .select({ assetId: assetChannelGrants.assetId })
          .from(assetChannelGrants)
          .where(and(eq(assetChannelGrants.assetId, assetId), eq(assetChannelGrants.channelId, channelId)))
          .get()
        if (grant === undefined) return 'not-granted'
        const inbound = tx
          .select({ assetId: assetOccurrences.assetId })
          .from(assetOccurrences)
          .innerJoin(channelEvents, eq(channelEvents.id, assetOccurrences.channelEventId))
          .where(and(eq(assetOccurrences.assetId, assetId), eq(channelEvents.channelId, channelId)))
          .get()
        const outbound = tx
          .select({ id: outboundIntents.id })
          .from(outboundIntents)
          .innerJoin(episodes, eq(episodes.id, outboundIntents.episodeId))
          .where(and(eq(episodes.channelId, channelId), sql`instr(${outboundIntents.parts}, ${assetId}) > 0`))
          .get()
        if (inbound !== undefined || outbound !== undefined) return 'in-use'
        tx.delete(assetChannelGrants)
          .where(and(eq(assetChannelGrants.assetId, assetId), eq(assetChannelGrants.channelId, channelId)))
          .run()
        return 'revoked'
      })
    },
    canAccessAsset(assetId, channelId): boolean {
      const occurrence = database
        .select({ assetId: assetOccurrences.assetId })
        .from(assetOccurrences)
        .innerJoin(channelEvents, eq(channelEvents.id, assetOccurrences.channelEventId))
        .where(and(eq(assetOccurrences.assetId, assetId), eq(channelEvents.channelId, channelId)))
        .get()
      if (occurrence !== undefined) return true
      return (
        database
          .select({ assetId: assetChannelGrants.assetId })
          .from(assetChannelGrants)
          .where(and(eq(assetChannelGrants.assetId, assetId), eq(assetChannelGrants.channelId, channelId)))
          .get() !== undefined
      )
    },
  }
}
