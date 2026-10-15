import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { gunzipSync, gzipSync } from 'node:zlib'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { z } from 'zod'
import {
  AgentIdSchema,
  AssetIdSchema,
  ExtensionRevisionIdSchema,
  JsonValueSchema,
  type AgentId,
  type AssetId,
  type ExtensionId,
  type ExtensionRevisionId,
  type JsonValue,
} from '@nekro-nxt/contracts'
import type { AssetService } from '@nekro-nxt/core'
import {
  FULL_DATA_SCOPE,
  dataDiffIsDestructive,
  diffExtensionData,
  scopeDataset,
  type ExtensionDataDiff,
  type ExtensionDataMigrationMode,
  type ExtensionDataPort,
  type ExtensionDataScope,
  type ExtensionDataset,
} from '@nekro-nxt/extension-runtime'
import type { SqliteCoreRepository } from '@nekro-nxt/storage-sqlite'

/** Copies kept per extension; older ones are dropped. */
export const DATA_SNAPSHOTS_KEPT = 3
const PACKAGE_TTL_MS = 10 * 60_000
const PACKAGE_MAX_BYTES = 512 * 1024 * 1024

const datasetSchema = z
  .object({
    storage: z.array(
      z
        .object({
          owner: z.union([z.literal('shared'), AgentIdSchema]),
          partition: z.string(),
          key: z.string(),
          value: JsonValueSchema,
          updatedAt: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    index: z.array(
      z
        .object({
          collection: z.string(),
          documentId: z.string(),
          fields: z.record(z.string(), z.string()),
          keywords: z.array(z.string()).max(4),
          filters: z.array(z.object({ field: z.string(), value: z.string() }).strict()),
          updatedAt: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    library: z.array(z.object({ assetId: AssetIdSchema, addedAt: z.number().int().nonnegative() }).strict()),
  })
  .strict()

const snapshotSchema = z
  .object({
    fromRevisionId: z.string().optional(),
    toRevisionId: z.string().optional(),
    dataVersion: z.number().int().positive(),
    dataset: datasetSchema,
  })
  .strict()

const packageManifestSchema = z
  .object({
    kind: z.literal('nekro-nxt-extension-data'),
    schemaVersion: z.literal(1),
    extensionId: z.string(),
    displayName: z.string(),
    dataVersion: z.number().int().positive(),
    exportedAt: z.number().int().nonnegative(),
    /** Agents whose storage the package holds, so the importer can map them to its own agents. */
    agents: z.array(z.object({ id: z.string(), name: z.string() }).strict()),
    assets: z.array(z.object({ assetId: AssetIdSchema, mediaType: z.string(), byteSize: z.number().int() }).strict()),
    config: z
      .object({ host: JsonValueSchema.optional(), agents: z.record(z.string(), JsonValueSchema).optional() })
      .strict()
      .optional(),
  })
  .strict()

export type ExtensionDataPackageManifest = z.output<typeof packageManifestSchema>

/** Where a migration takes data from. */
export type ExtensionDataSource =
  | { readonly kind: 'extension'; readonly extensionId: ExtensionId }
  | { readonly kind: 'snapshot'; readonly snapshotId: string }
  | { readonly kind: 'package'; readonly token: string }

export interface ExtensionDataMigrationPlan {
  readonly source: ExtensionDataSource
  readonly targetExtensionId: ExtensionId
  readonly mode: ExtensionDataMigrationMode
  readonly scope: ExtensionDataScope
  /** Storage of a source agent goes to the mapped target agent; unmapped agents are skipped. */
  readonly agentMap?: Readonly<Record<string, AgentId>>
}

export interface ExtensionDataMigrationPreview {
  readonly diff: ExtensionDataDiff
  readonly destructive: boolean
  readonly sourceDataVersion: number
  readonly targetDataVersion: number
  /** The data needs the target's migration to run after it is written. */
  readonly needsMigration: boolean
}

const ownerKey = (owner: string): string => owner

/** Deep-replaces Asset ids in values that refer to them, after assets were imported under new ids. */
const remapAssetIds = (value: JsonValue, map: ReadonlyMap<string, AssetId>): JsonValue => {
  if (typeof value === 'string') return map.get(value) ?? value
  if (Array.isArray(value)) return value.map((item) => remapAssetIds(item, map))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, remapAssetIds(child, map)]))
  }
  return value
}

/**
 * Data of installed extensions beyond the code: the version of its shape, copies taken before switches and
 * migrations, explicit migrations between extensions, snapshots and files, and the files themselves.
 */
export class ExtensionDataService implements ExtensionDataPort {
  readonly #repository: SqliteCoreRepository
  readonly #assets: AssetService
  readonly #now: () => number
  readonly #packages = new Map<
    string,
    { readonly manifest: ExtensionDataPackageManifest; readonly dataset: ExtensionDataset; readonly expiresAt: number }
  >()

  constructor(input: {
    readonly repository: SqliteCoreRepository
    readonly assets: AssetService
    readonly now?: () => number
  }) {
    this.#repository = input.repository
    this.#assets = input.assets
    this.#now = input.now ?? Date.now
  }

  // —— Lifecycle port ——

  dataVersion(extensionId: ExtensionId): number {
    return this.#repository.getExtensionDataVersion(extensionId)
  }

  setDataVersion(extensionId: ExtensionId, version: number): void {
    this.#repository.setExtensionDataVersion(extensionId, version, this.#now())
  }

  hasData(extensionId: ExtensionId): boolean {
    const dataset = this.#repository.readExtensionDataset(extensionId, FULL_DATA_SCOPE)
    return dataset.storage.length + dataset.index.length + dataset.library.length > 0
  }

  snapshot(input: {
    readonly extensionId: ExtensionId
    readonly fromRevisionId: ExtensionRevisionId
    readonly toRevisionId: ExtensionRevisionId
    readonly dataVersion: number
  }): string {
    return this.#store({
      extensionId: input.extensionId,
      reason: 'switch',
      label: '切换版本前',
      dataVersion: input.dataVersion,
      fromRevisionId: input.fromRevisionId,
      toRevisionId: input.toRevisionId,
    })
  }

  restore(snapshotId: string): void {
    const stored = this.#readSnapshot(snapshotId)
    this.#repository.writeExtensionDataset({
      extensionId: stored.extensionId,
      dataset: stored.dataset,
      scope: FULL_DATA_SCOPE,
      mode: 'replace',
      now: this.#now(),
    })
    this.setDataVersion(stored.extensionId, stored.dataVersion)
  }

  // —— Snapshots ——

  listSnapshots(extensionId: ExtensionId) {
    return this.#repository.listExtensionDataSnapshots(extensionId)
  }

  /** A copy the user asked for, or the automatic one an explicit migration takes before writing. */
  takeSnapshot(extensionId: ExtensionId, reason: 'manual' | 'migration', label: string): string {
    return this.#store({ extensionId, reason, label, dataVersion: this.dataVersion(extensionId) })
  }

  /** Revisions the newest switch snapshot moved between; the way back for a rollback. */
  latestSwitch(extensionId: ExtensionId):
    | {
        readonly snapshotId: string
        readonly fromRevisionId: ExtensionRevisionId
        readonly toRevisionId: ExtensionRevisionId
      }
    | undefined {
    for (const summary of this.listSnapshots(extensionId)) {
      if (summary.reason !== 'switch') continue
      const payload = this.#readSnapshot(summary.id)
      if (payload.fromRevisionId !== undefined && payload.toRevisionId !== undefined) {
        return {
          snapshotId: summary.id,
          fromRevisionId: ExtensionRevisionIdSchema.parse(payload.fromRevisionId),
          toRevisionId: ExtensionRevisionIdSchema.parse(payload.toRevisionId),
        }
      }
    }
    return undefined
  }

  // —— Explicit migration ——

  /** What the migration would change; nothing is written. */
  preview(plan: ExtensionDataMigrationPlan): ExtensionDataMigrationPreview {
    const { dataset, dataVersion } = this.#source(plan)
    const target = this.#repository.readExtensionDataset(plan.targetExtensionId, plan.scope)
    const diff = diffExtensionData(target, scopeDataset(dataset, plan.scope), plan.mode)
    const targetDataVersion = this.dataVersion(plan.targetExtensionId)
    return {
      diff,
      destructive: dataDiffIsDestructive(diff),
      sourceDataVersion: dataVersion,
      targetDataVersion,
      needsMigration: dataVersion < targetDataVersion,
    }
  }

  /**
   * Writes the source data into the target. The caller runs it while the target extension is stopped; a copy of the
   * target is kept first so the migration can be undone. Data in a newer shape than the target understands is refused.
   */
  migrate(plan: ExtensionDataMigrationPlan): {
    readonly snapshotId: string
    readonly preview: ExtensionDataMigrationPreview
  } {
    const preview = this.preview(plan)
    if (preview.sourceDataVersion > preview.targetDataVersion) {
      throw new Error(
        `来源数据是第 ${preview.sourceDataVersion} 版格式，目标扩展当前版本只认识第 ${preview.targetDataVersion} 版，请先把目标切换到更新的版本。`,
      )
    }
    const snapshotId = this.takeSnapshot(plan.targetExtensionId, 'migration', '迁移数据前')
    const { dataset } = this.#source(plan)
    this.#repository.writeExtensionDataset({
      extensionId: plan.targetExtensionId,
      dataset: scopeDataset(dataset, plan.scope),
      scope: plan.scope,
      mode: plan.mode,
      now: this.#now(),
    })
    // Older data is migrated by the target's own handler when the extension starts again.
    if (preview.needsMigration) this.setDataVersion(plan.targetExtensionId, preview.sourceDataVersion)
    return { snapshotId, preview }
  }

  // —— Data packages ——

  /** A `.nxt-extension-data` file with the chosen storage, the index, library files and optionally configuration. */
  async exportPackage(input: {
    readonly extensionId: ExtensionId
    readonly displayName: string
    readonly scope: ExtensionDataScope
    readonly config?: { readonly host?: JsonValue; readonly agents?: Readonly<Record<string, JsonValue>> }
  }): Promise<Uint8Array> {
    const dataset = this.#repository.readExtensionDataset(input.extensionId, input.scope)
    const agentNames = new Map(
      this.#repository.listAgents().map((agent) => [agent.definition.id as string, agent.revision.displayName]),
    )
    const owners = [...new Set(dataset.storage.map((entry) => entry.owner).filter((owner) => owner !== 'shared'))]
    const files: Record<string, Uint8Array> = {}
    const assets: ExtensionDataPackageManifest['assets'] = []
    for (const { assetId } of dataset.library) {
      const asset = this.#repository.getAssetById(assetId)
      if (!asset) continue
      files[`assets/${assetId}`] = new Uint8Array(await readFile(this.#assets.blobPath(asset)))
      assets.push({ assetId, mediaType: asset.mediaType, byteSize: asset.byteSize })
    }
    const manifest: ExtensionDataPackageManifest = {
      kind: 'nekro-nxt-extension-data',
      schemaVersion: 1,
      extensionId: input.extensionId,
      displayName: input.displayName,
      dataVersion: this.dataVersion(input.extensionId),
      exportedAt: this.#now(),
      agents: owners.map((id) => ({ id: ownerKey(id), name: agentNames.get(id) ?? id })),
      assets,
      ...(input.config === undefined ? {} : { config: input.config }),
    }
    files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2))
    files['dataset.json'] = strToU8(JSON.stringify(dataset))
    return zipSync(files, { level: 6 })
  }

  /** Reads a data package and keeps it for ten minutes, so the user can choose the target and mode. */
  async inspectPackage(bytes: Uint8Array): Promise<{
    readonly token: string
    readonly manifest: ExtensionDataPackageManifest
    readonly counts: { readonly storage: number; readonly index: number; readonly library: number }
  }> {
    if (bytes.byteLength > PACKAGE_MAX_BYTES) throw new Error('数据包太大。')
    let entries: Record<string, Uint8Array>
    try {
      entries = unzipSync(bytes)
    } catch {
      throw new Error('这不是有效的扩展数据包。')
    }
    const manifestBytes = entries['manifest.json']
    const datasetBytes = entries['dataset.json']
    if (!manifestBytes || !datasetBytes) throw new Error('这不是有效的扩展数据包。')
    const manifest = packageManifestSchema.parse(JSON.parse(strFromU8(manifestBytes)))
    let dataset: ExtensionDataset = datasetSchema.parse(JSON.parse(strFromU8(datasetBytes)))
    // Files become Assets of this machine; their ids differ, so references in the data are rewritten.
    const remap = new Map<string, AssetId>()
    for (const asset of manifest.assets) {
      const file = entries[`assets/${asset.assetId}`]
      if (!file) throw new Error(`数据包缺少文件：${asset.assetId}`)
      const prepared = await this.#assets.prepare({ bytes: file, declaredMediaType: asset.mediaType })
      remap.set(asset.assetId, prepared.asset.id)
    }
    if (remap.size > 0) {
      dataset = {
        storage: dataset.storage.map((entry) => ({ ...entry, value: remapAssetIds(entry.value, remap) })),
        index: dataset.index.map((document) => ({
          ...document,
          fields: Object.fromEntries(
            Object.entries(document.fields).map(([key, value]) => [key, remap.get(value) ?? value]),
          ),
        })),
        library: dataset.library.flatMap((asset) => {
          const id = remap.get(asset.assetId)
          return id === undefined ? [] : [{ ...asset, assetId: id }]
        }),
      }
    }
    this.#prunePackages()
    const token = randomUUID()
    this.#packages.set(token, { manifest, dataset, expiresAt: this.#now() + PACKAGE_TTL_MS })
    return {
      token,
      manifest,
      counts: { storage: dataset.storage.length, index: dataset.index.length, library: dataset.library.length },
    }
  }

  packageManifest(token: string): ExtensionDataPackageManifest | undefined {
    this.#prunePackages()
    return this.#packages.get(token)?.manifest
  }

  discardPackage(token: string): void {
    this.#packages.delete(token)
  }

  /** Copies everything an extension stored to a new branch of it, which starts independent from here on. */
  copyAll(from: ExtensionId, to: ExtensionId): void {
    const dataset = this.#repository.readExtensionDataset(from, FULL_DATA_SCOPE)
    this.#repository.writeExtensionDataset({
      extensionId: to,
      dataset,
      scope: FULL_DATA_SCOPE,
      mode: 'replace',
      now: this.#now(),
    })
    this.setDataVersion(to, this.dataVersion(from))
  }

  // —— Internals ——

  #source(plan: ExtensionDataMigrationPlan): { readonly dataset: ExtensionDataset; readonly dataVersion: number } {
    const remapAgents = (dataset: ExtensionDataset): ExtensionDataset =>
      plan.agentMap === undefined
        ? dataset
        : {
            ...dataset,
            storage: dataset.storage.flatMap((entry) => {
              if (entry.owner === 'shared') return [entry]
              const owner = plan.agentMap?.[entry.owner]
              return owner === undefined ? [] : [{ ...entry, owner }]
            }),
          }
    switch (plan.source.kind) {
      case 'extension':
        return {
          dataset: remapAgents(this.#repository.readExtensionDataset(plan.source.extensionId, FULL_DATA_SCOPE)),
          dataVersion: this.dataVersion(plan.source.extensionId),
        }
      case 'snapshot': {
        const stored = this.#readSnapshot(plan.source.snapshotId)
        return { dataset: remapAgents(stored.dataset), dataVersion: stored.dataVersion }
      }
      case 'package': {
        this.#prunePackages()
        const pending = this.#packages.get(plan.source.token)
        if (!pending) throw new Error('数据包检查已失效，请重新选择文件。')
        return { dataset: remapAgents(pending.dataset), dataVersion: pending.manifest.dataVersion }
      }
    }
  }

  #store(input: {
    readonly extensionId: ExtensionId
    readonly reason: 'switch' | 'migration' | 'manual'
    readonly label: string
    readonly dataVersion: number
    readonly fromRevisionId?: string
    readonly toRevisionId?: string
  }): string {
    const dataset = this.#repository.readExtensionDataset(input.extensionId, FULL_DATA_SCOPE)
    const payload = gzipSync(
      Buffer.from(
        JSON.stringify({
          ...(input.fromRevisionId === undefined ? {} : { fromRevisionId: input.fromRevisionId }),
          ...(input.toRevisionId === undefined ? {} : { toRevisionId: input.toRevisionId }),
          dataVersion: input.dataVersion,
          dataset,
        }),
        'utf8',
      ),
    )
    const id = `xds_${randomUUID().replaceAll('-', '')}`
    this.#repository.createExtensionDataSnapshot({
      id,
      extensionId: input.extensionId,
      reason: input.reason,
      label: input.label,
      dataVersion: input.dataVersion,
      payload,
      createdAt: this.#now(),
      keep: DATA_SNAPSHOTS_KEPT,
    })
    return id
  }

  #readSnapshot(snapshotId: string) {
    const stored = this.#repository.getExtensionDataSnapshotPayload(snapshotId)
    if (!stored) throw new Error('数据快照不存在或已被清理。')
    const parsed = snapshotSchema.parse(JSON.parse(gunzipSync(stored.payload).toString('utf8')))
    return { extensionId: stored.extensionId, ...parsed }
  }

  #prunePackages(): void {
    const now = this.#now()
    for (const [token, pending] of this.#packages) if (pending.expiresAt <= now) this.#packages.delete(token)
  }
}
