import { and, eq, lt, sql } from 'drizzle-orm'
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
  revokeUnusedBrowserAsset(assetId: AssetId, channelId: ChannelId): 'revoked' | 'in-use' | 'not-granted'
  expireBrowserAssets(before: number, channelId: ChannelId): void
} {
  const revokeUnused = (
    assetId: AssetId,
    channelId: ChannelId,
    source?: AssetChannelGrant['source'],
  ): 'revoked' | 'in-use' | 'not-granted' => {
    return database.transaction((tx) => {
      const grant = tx
        .select({ assetId: assetChannelGrants.assetId, source: assetChannelGrants.source })
        .from(assetChannelGrants)
        .where(and(eq(assetChannelGrants.assetId, assetId), eq(assetChannelGrants.channelId, channelId)))
        .get()
      if (grant === undefined || (source !== undefined && grant.source !== source)) return 'not-granted'
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
      const historical = tx
        .select({ id: channelEvents.id })
        .from(channelEvents)
        .where(and(eq(channelEvents.channelId, channelId), sql`instr(${channelEvents.parts}, ${assetId}) > 0`))
        .get()
      if (inbound !== undefined || outbound !== undefined || historical !== undefined) return 'in-use'
      tx.delete(assetChannelGrants)
        .where(and(eq(assetChannelGrants.assetId, assetId), eq(assetChannelGrants.channelId, channelId)))
        .run()
      return 'revoked'
    })
  }
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
      if (grant.source === 'browser-composer') {
        database
          .update(assetChannelGrants)
          .set({ grantedAt: grant.grantedAt })
          .where(
            and(
              eq(assetChannelGrants.assetId, grant.assetId),
              eq(assetChannelGrants.channelId, grant.channelId),
              eq(assetChannelGrants.source, 'browser-composer'),
            ),
          )
          .run()
      }
      const row = database
        .select()
        .from(assetChannelGrants)
        .where(and(eq(assetChannelGrants.assetId, grant.assetId), eq(assetChannelGrants.channelId, grant.channelId)))
        .get()
      if (row === undefined) throw new Error('Asset Channel grant upsert did not produce a row.')
      return toAssetChannelGrant(row)
    },
    revokeUnusedAgentAsset: (assetId, channelId) => revokeUnused(assetId, channelId, 'agent-tool'),
    revokeUnusedBrowserAsset: (assetId, channelId) => revokeUnused(assetId, channelId, 'browser-composer'),
    expireBrowserAssets(before, channelId) {
      const expired = database
        .select()
        .from(assetChannelGrants)
        .where(
          and(
            eq(assetChannelGrants.source, 'browser-composer'),
            lt(assetChannelGrants.grantedAt, before),
            eq(assetChannelGrants.channelId, channelId),
          ),
        )
        .all()
      for (const grant of expired) revokeUnused(grant.assetId, grant.channelId, 'browser-composer')
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
