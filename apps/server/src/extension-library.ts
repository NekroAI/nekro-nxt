import { AssetIdSchema, ExtensionIdSchema, type AssetId, type ChannelId } from '@nekro-nxt/contracts'
import type { AssetRecord, AssetService } from '@nekro-nxt/core'
import type { NxtAssetRecord, NxtImageInfo, NxtLibraryAsset } from '@nekro-nxt/extension-sdk'
import { ExtensionLibraryQuotaError, type ExtensionLibraryRepository } from '@nekro-nxt/storage-sqlite'
import { inspectImage } from './extension-image-info.js'
import { NxtCapabilityError } from './extension-host-service.js'

/** Where library rows live: the database for installed extensions, memory for dynamic runs and verification. */
export interface LibraryRegistry {
  keep(owner: string, asset: AssetRecord, addedAt: number, quotaBytes: number): NxtLibraryAsset & { existed: boolean }
  release(owner: string, assetId: AssetId): boolean
  get(owner: string, assetId: AssetId): NxtLibraryAsset | undefined
  list(
    owner: string,
    options: { readonly limit: number; readonly after?: string },
  ): { readonly assets: readonly NxtLibraryAsset[]; readonly next?: string }
}

export const sqliteLibraryRegistry = (repository: ExtensionLibraryRepository): LibraryRegistry => ({
  keep(owner, asset, addedAt, quotaBytes) {
    try {
      return repository.keepLibraryAsset({
        extensionId: ExtensionIdSchema.parse(owner),
        assetId: asset.id,
        addedAt,
        quotaBytes,
      })
    } catch (error) {
      if (error instanceof ExtensionLibraryQuotaError) throw new NxtCapabilityError(error.message)
      throw error
    }
  },
  release: (owner, assetId) => repository.releaseLibraryAsset(ExtensionIdSchema.parse(owner), assetId),
  get: (owner, assetId) => repository.getLibraryAsset(ExtensionIdSchema.parse(owner), assetId),
  list: (owner, options) => repository.listLibraryAssets(ExtensionIdSchema.parse(owner), options),
})

export const memoryLibraryRegistry = (): LibraryRegistry => {
  const owners = new Map<string, Map<AssetId, NxtLibraryAsset>>()
  const of = (owner: string) => {
    let assets = owners.get(owner)
    if (assets === undefined) owners.set(owner, (assets = new Map<AssetId, NxtLibraryAsset>()))
    return assets
  }
  return {
    keep(owner, asset, addedAt, quotaBytes) {
      const assets = of(owner)
      const existing = assets.get(asset.id)
      if (existing !== undefined) return { ...existing, existed: true }
      const used = [...assets.values()].reduce((sum, entry) => sum + entry.byteSize, 0)
      if (used + asset.byteSize > quotaBytes)
        throw new NxtCapabilityError('扩展资源库已满，请先移出不用的图片或调高容量。')
      const record = { assetId: asset.id, mediaType: asset.mediaType, byteSize: asset.byteSize, addedAt }
      assets.set(asset.id, record)
      return { ...record, existed: false }
    },
    release: (owner, assetId) => of(owner).delete(assetId),
    get: (owner, assetId) => of(owner).get(assetId),
    list(owner, options) {
      const sorted = [...of(owner).values()].sort(
        (left, right) => right.addedAt - left.addedAt || right.assetId.localeCompare(left.assetId),
      )
      const start = options.after === undefined ? 0 : sorted.findIndex(({ assetId }) => assetId === options.after) + 1
      const page = sorted.slice(start, start + options.limit)
      return start + options.limit < sorted.length ? { assets: page, next: page.at(-1)!.assetId } : { assets: page }
    },
  }
}

export interface LibraryAssetAccess {
  getAssetById(id: AssetId): AssetRecord | undefined
  canAccessAsset(assetId: AssetId, channelId: ChannelId): boolean
  grantAssetAccess(grant: {
    readonly assetId: AssetId
    readonly channelId: ChannelId
    readonly source: 'extension-library'
    readonly grantedAt: number
  }): unknown
}

const IMAGE_INFO_CACHE_LIMIT = 2000

/**
 * An extension's asset library: Assets it keeps after seeing them in a channel, usable in any channel later. Only
 * Assets the current channel can see enter the library, so the library never becomes a way around channel isolation.
 */
export class ExtensionLibrary {
  readonly #registry: LibraryRegistry
  readonly #assets: LibraryAssetAccess
  readonly #assetService: Pick<AssetService, 'prepare' | 'blobPath'>
  readonly #now: () => number
  readonly #imageInfo = new Map<string, Promise<NxtImageInfo>>()

  constructor(input: {
    readonly registry: LibraryRegistry
    readonly assets: LibraryAssetAccess
    readonly assetService: Pick<AssetService, 'prepare' | 'blobPath'>
    readonly now: () => number
  }) {
    this.#registry = input.registry
    this.#assets = input.assets
    this.#assetService = input.assetService
    this.#now = input.now
  }

  #asset(assetId: string): AssetRecord {
    const parsed = AssetIdSchema.safeParse(assetId)
    const asset = parsed.success ? this.#assets.getAssetById(parsed.data) : undefined
    if (asset === undefined) throw new NxtCapabilityError(`找不到资源 ${assetId}。`)
    return asset
  }

  /** Adds an Asset the channel can see; keeping it again changes nothing. */
  keep(owner: string, channelId: ChannelId, assetId: string, quotaBytes: number): NxtLibraryAsset {
    const asset = this.#asset(assetId)
    if (!this.#assets.canAccessAsset(asset.id, channelId)) {
      throw new NxtCapabilityError(`资源 ${assetId} 不在当前频道里，不能收进资源库。`)
    }
    const kept = this.#registry.keep(owner, asset, this.#now(), quotaBytes)
    return { assetId: kept.assetId, mediaType: kept.mediaType, byteSize: kept.byteSize, addedAt: kept.addedAt }
  }

  /** Stores new bytes straight into the library, e.g. an upload or a picture the extension made. */
  async import(
    owner: string,
    bytes: Uint8Array | AsyncIterable<Uint8Array>,
    quotaBytes: number,
  ): Promise<NxtLibraryAsset & { readonly existed: boolean }> {
    const prepared = await this.#assetService.prepare({ bytes })
    return this.#registry.keep(owner, prepared.asset, this.#now(), quotaBytes)
  }

  release(owner: string, assetId: string): boolean {
    const parsed = AssetIdSchema.safeParse(assetId)
    return parsed.success && this.#registry.release(owner, parsed.data)
  }

  get(owner: string, assetId: string): NxtLibraryAsset | undefined {
    const parsed = AssetIdSchema.safeParse(assetId)
    return parsed.success ? this.#registry.get(owner, parsed.data) : undefined
  }

  list(owner: string, options: { readonly limit?: number; readonly after?: string } = {}) {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 200)
    return this.#registry.list(owner, { limit, ...(options.after === undefined ? {} : { after: options.after }) })
  }

  /** Grants a library Asset to the channel and returns it ready to send. */
  attach(owner: string, channelId: ChannelId, assetId: string): NxtAssetRecord {
    const record = this.get(owner, assetId)
    if (record === undefined) throw new NxtCapabilityError(`资源 ${assetId} 不在这个扩展的资源库里。`)
    this.#assets.grantAssetAccess({
      assetId: AssetIdSchema.parse(record.assetId),
      channelId,
      source: 'extension-library',
      grantedAt: this.#now(),
    })
    return { assetId: record.assetId, byteSize: record.byteSize, mediaType: record.mediaType }
  }

  /** Whether the extension may read this Asset: it is in the library, or the channel (when given) can see it. */
  readable(owner: string, channelId: ChannelId | undefined, assetId: string): AssetRecord {
    const asset = this.#asset(assetId)
    const visible =
      this.#registry.get(owner, asset.id) !== undefined ||
      (channelId !== undefined && this.#assets.canAccessAsset(asset.id, channelId))
    if (!visible) throw new NxtCapabilityError(`资源 ${assetId} 不在当前频道或扩展资源库里。`)
    return asset
  }

  imageInfo(owner: string, channelId: ChannelId | undefined, assetId: string): Promise<NxtImageInfo> {
    const asset = this.readable(owner, channelId, assetId)
    if (!asset.mediaType.startsWith('image/')) {
      return Promise.reject(new NxtCapabilityError(`资源 ${assetId} 不是图片。`))
    }
    // Content-addressed: the same digest always has the same answer.
    const cached = this.#imageInfo.get(asset.contentDigest)
    if (cached !== undefined) return cached
    const pending = inspectImage(this.#assetService.blobPath(asset), asset.byteSize)
    if (this.#imageInfo.size >= IMAGE_INFO_CACHE_LIMIT) this.#imageInfo.clear()
    this.#imageInfo.set(asset.contentDigest, pending)
    pending.catch(() => this.#imageInfo.delete(asset.contentDigest))
    return pending
  }

  blobPath(asset: AssetRecord): string {
    return this.#assetService.blobPath(asset)
  }
}
