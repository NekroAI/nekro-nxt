import { and, eq } from 'drizzle-orm'
import type { AssetRecord, AssetRepository } from '@nekro-nxt/core'
import type { AssetId, ChannelId } from '@nekro-nxt/contracts'
import type { DrizzleCoreDatabase } from '../database.js'
import { assetOccurrences, assets, channelEvents } from '../schema.js'
import { AssetRowSchema } from '../row-schemas.js'

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

export function createAssetsRepository(database: DrizzleCoreDatabase): AssetRepository & {
  getAssetById(id: AssetId): AssetRecord | undefined
  canAccessAsset(assetId: AssetId, channelId: ChannelId): boolean
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
    canAccessAsset(assetId, channelId): boolean {
      return (
        database
          .select({ assetId: assetOccurrences.assetId })
          .from(assetOccurrences)
          .innerJoin(channelEvents, eq(channelEvents.id, assetOccurrences.channelEventId))
          .where(and(eq(assetOccurrences.assetId, assetId), eq(channelEvents.channelId, channelId)))
          .get() !== undefined
      )
    },
  }
}
