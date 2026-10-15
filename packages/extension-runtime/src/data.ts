import type { AgentId, AssetId, ExtensionId, JsonValue } from '@nekro-nxt/contracts'

/** One stored value; `owner` is `shared` (host partition) or the agent it belongs to. */
export interface ExtensionDatasetStorageEntry {
  readonly owner: 'shared' | AgentId
  readonly partition: string
  readonly key: string
  readonly value: JsonValue
  readonly updatedAt: number
}

/** One search index document with the keywords and filters it was indexed under; vectors are rebuilt on demand. */
export interface ExtensionDatasetIndexDocument {
  readonly collection: string
  readonly documentId: string
  readonly fields: Readonly<Record<string, string>>
  readonly keywords: readonly string[]
  readonly filters: readonly { readonly field: string; readonly value: string }[]
  readonly updatedAt: number
}

/** One library asset reference; the asset itself is content-addressed and shared. */
export interface ExtensionDatasetLibraryAsset {
  readonly assetId: AssetId
  readonly addedAt: number
}

/** Everything an extension has stored on this machine, apart from its configuration and credentials. */
export interface ExtensionDataset {
  readonly storage: readonly ExtensionDatasetStorageEntry[]
  readonly index: readonly ExtensionDatasetIndexDocument[]
  readonly library: readonly ExtensionDatasetLibraryAsset[]
}

/** Which parts of a dataset a read, write or migration covers. */
export interface ExtensionDataScope {
  /** Storage owners to include: `shared` and/or agent ids; `all` takes every owner present. */
  readonly owners: 'all' | readonly ('shared' | AgentId)[]
  readonly index: boolean
  readonly library: boolean
}

export const FULL_DATA_SCOPE: ExtensionDataScope = { owners: 'all', index: true, library: true }

/**
 * `overwrite` merges the source into the target: the same key takes the source's value and target-only entries stay.
 * `replace` empties the covered part of the target first, so the result equals the source.
 */
export type ExtensionDataMigrationMode = 'overwrite' | 'replace'

export interface ExtensionDataChangeCount {
  readonly added: number
  readonly overwritten: number
  readonly removed: number
  readonly unchanged: number
}

export interface ExtensionDataDiff {
  readonly storage: ExtensionDataChangeCount
  readonly index: ExtensionDataChangeCount
  readonly library: ExtensionDataChangeCount
}

export interface ExtensionDataRepository {
  readExtensionDataset(extensionId: ExtensionId, scope?: ExtensionDataScope): ExtensionDataset
  /** Writes `dataset` into the covered part of the extension's data in one transaction. */
  writeExtensionDataset(input: {
    readonly extensionId: ExtensionId
    readonly dataset: ExtensionDataset
    readonly scope: ExtensionDataScope
    readonly mode: ExtensionDataMigrationMode
  }): void
}

const includesOwner = (scope: ExtensionDataScope, owner: 'shared' | AgentId): boolean =>
  scope.owners === 'all' || scope.owners.includes(owner)

/** The part of a dataset a scope covers. */
export const scopeDataset = (dataset: ExtensionDataset, scope: ExtensionDataScope): ExtensionDataset => ({
  storage: dataset.storage.filter((entry) => includesOwner(scope, entry.owner)),
  index: scope.index ? dataset.index : [],
  library: scope.library ? dataset.library : [],
})

const count = <T>(
  target: readonly T[],
  source: readonly T[],
  keyOf: (item: T) => string,
  same: (left: T, right: T) => boolean,
  mode: ExtensionDataMigrationMode,
): ExtensionDataChangeCount => {
  const existing = new Map(target.map((item) => [keyOf(item), item]))
  const incoming = new Set(source.map(keyOf))
  let added = 0
  let overwritten = 0
  let unchanged = 0
  for (const item of source) {
    const current = existing.get(keyOf(item))
    if (current === undefined) added += 1
    else if (same(current, item)) unchanged += 1
    else overwritten += 1
  }
  const removed = mode === 'replace' ? target.filter((item) => !incoming.has(keyOf(item))).length : 0
  return { added, overwritten, removed, unchanged }
}

const sameJson = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)

/** What writing `source` into `target` would change, computed before anything is written. */
export const diffExtensionData = (
  target: ExtensionDataset,
  source: ExtensionDataset,
  mode: ExtensionDataMigrationMode,
): ExtensionDataDiff => ({
  storage: count(
    target.storage,
    source.storage,
    (entry) => `${entry.owner}\u0000${entry.partition}\u0000${entry.key}`,
    (left, right) => sameJson(left.value, right.value),
    mode,
  ),
  index: count(
    target.index,
    source.index,
    (document) => `${document.collection}\u0000${document.documentId}`,
    (left, right) => sameJson(left.fields, right.fields) && sameJson(left.filters, right.filters),
    mode,
  ),
  library: count(
    target.library,
    source.library,
    (asset) => asset.assetId,
    () => true,
    mode,
  ),
})

/** Whether a migration with this diff deletes or overwrites anything that exists now. */
export const dataDiffIsDestructive = (diff: ExtensionDataDiff): boolean =>
  [diff.storage, diff.index, diff.library].some((part) => part.overwritten > 0 || part.removed > 0)

/**
 * Re-keys storage owned by agents of another extension or machine onto this machine's agents. Owners missing from
 * `agents` are dropped; `shared` always stays.
 */
export const remapDatasetOwners = (
  dataset: ExtensionDataset,
  agents: ReadonlyMap<string, AgentId>,
): ExtensionDataset => ({
  ...dataset,
  storage: dataset.storage.flatMap((entry) => {
    if (entry.owner === 'shared') return [entry]
    const owner = agents.get(entry.owner)
    return owner === undefined ? [] : [{ ...entry, owner }]
  }),
})
