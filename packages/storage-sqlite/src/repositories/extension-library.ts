import { and, desc, eq, lt, or, sql } from 'drizzle-orm'
import { AssetIdSchema, type AssetId, type ExtensionId } from '@nekro-nxt/contracts'
import type { DrizzleCoreDatabase } from '../database.js'
import { assets, extensionLibraryAssets } from '../schema.js'

export class ExtensionLibraryQuotaError extends Error {
  override readonly name = 'ExtensionLibraryQuotaError'
  constructor(
    message: string,
    readonly usedBytes: number,
    readonly quotaBytes: number,
  ) {
    super(message)
  }
}

export interface ExtensionLibraryAssetRecord {
  readonly assetId: AssetId
  readonly mediaType: string
  readonly byteSize: number
  readonly addedAt: number
}

const cursorOf = (record: ExtensionLibraryAssetRecord): string => `${record.addedAt}:${record.assetId}`

const parseCursor = (cursor: string): { readonly addedAt: number; readonly assetId: AssetId } | undefined => {
  const separator = cursor.indexOf(':')
  const addedAt = Number(cursor.slice(0, separator))
  const assetId = AssetIdSchema.safeParse(cursor.slice(separator + 1))
  if (separator <= 0 || !Number.isSafeInteger(addedAt) || !assetId.success) return undefined
  return { addedAt, assetId: assetId.data }
}

export function createExtensionLibraryRepository(database: DrizzleCoreDatabase) {
  const selection = {
    assetId: extensionLibraryAssets.assetId,
    mediaType: assets.mediaType,
    byteSize: assets.byteSize,
    addedAt: extensionLibraryAssets.addedAt,
  }
  const usage = (tx: Pick<DrizzleCoreDatabase, 'select'>, extensionId: ExtensionId) =>
    tx
      .select({
        count: sql<number>`count(*)`,
        bytes: sql<number>`coalesce(sum(${assets.byteSize}), 0)`,
      })
      .from(extensionLibraryAssets)
      .innerJoin(assets, eq(assets.id, extensionLibraryAssets.assetId))
      .where(eq(extensionLibraryAssets.extensionId, extensionId))
      .get() ?? { count: 0, bytes: 0 }

  return {
    /** Adds an Asset to the extension's library; an Asset already there is returned unchanged. */
    keepLibraryAsset(input: {
      readonly extensionId: ExtensionId
      readonly assetId: AssetId
      readonly addedAt: number
      readonly quotaBytes: number
    }): ExtensionLibraryAssetRecord & { readonly existed: boolean } {
      return database.transaction(
        (tx) => {
          const existing = tx
            .select(selection)
            .from(extensionLibraryAssets)
            .innerJoin(assets, eq(assets.id, extensionLibraryAssets.assetId))
            .where(
              and(
                eq(extensionLibraryAssets.extensionId, input.extensionId),
                eq(extensionLibraryAssets.assetId, input.assetId),
              ),
            )
            .get()
          if (existing !== undefined) return { ...existing, existed: true }
          const asset = tx.select().from(assets).where(eq(assets.id, input.assetId)).get()
          if (asset === undefined) throw new Error(`Asset ${input.assetId} does not exist.`)
          const used = usage(tx, input.extensionId)
          if (used.bytes + asset.byteSize > input.quotaBytes) {
            throw new ExtensionLibraryQuotaError(
              '扩展资源库已满，请先移出不用的图片或调高容量。',
              used.bytes,
              input.quotaBytes,
            )
          }
          tx.insert(extensionLibraryAssets)
            .values({ extensionId: input.extensionId, assetId: input.assetId, addedAt: input.addedAt })
            .run()
          return {
            assetId: input.assetId,
            mediaType: asset.mediaType,
            byteSize: asset.byteSize,
            addedAt: input.addedAt,
            existed: false,
          }
        },
        { behavior: 'immediate' },
      )
    },
    releaseLibraryAsset(extensionId: ExtensionId, assetId: AssetId): boolean {
      return (
        database
          .delete(extensionLibraryAssets)
          .where(and(eq(extensionLibraryAssets.extensionId, extensionId), eq(extensionLibraryAssets.assetId, assetId)))
          .run().changes > 0
      )
    },
    getLibraryAsset(extensionId: ExtensionId, assetId: AssetId): ExtensionLibraryAssetRecord | undefined {
      return database
        .select(selection)
        .from(extensionLibraryAssets)
        .innerJoin(assets, eq(assets.id, extensionLibraryAssets.assetId))
        .where(and(eq(extensionLibraryAssets.extensionId, extensionId), eq(extensionLibraryAssets.assetId, assetId)))
        .get()
    },
    /** Newest first; `after` is the `next` of the previous page. */
    listLibraryAssets(
      extensionId: ExtensionId,
      options: { readonly limit: number; readonly after?: string },
    ): { readonly assets: readonly ExtensionLibraryAssetRecord[]; readonly next?: string } {
      const cursor = options.after === undefined ? undefined : parseCursor(options.after)
      const rows = database
        .select(selection)
        .from(extensionLibraryAssets)
        .innerJoin(assets, eq(assets.id, extensionLibraryAssets.assetId))
        .where(
          and(
            eq(extensionLibraryAssets.extensionId, extensionId),
            cursor === undefined
              ? undefined
              : or(
                  lt(extensionLibraryAssets.addedAt, cursor.addedAt),
                  and(
                    eq(extensionLibraryAssets.addedAt, cursor.addedAt),
                    lt(extensionLibraryAssets.assetId, cursor.assetId),
                  ),
                ),
          ),
        )
        .orderBy(desc(extensionLibraryAssets.addedAt), desc(extensionLibraryAssets.assetId))
        .limit(options.limit + 1)
        .all()
      const page = rows.slice(0, options.limit)
      return rows.length > options.limit ? { assets: page, next: cursorOf(page.at(-1)!) } : { assets: page }
    },
    libraryUsage(extensionId: ExtensionId): { readonly count: number; readonly bytes: number } {
      return usage(database, extensionId)
    },
  }
}

export type ExtensionLibraryRepository = ReturnType<typeof createExtensionLibraryRepository>
