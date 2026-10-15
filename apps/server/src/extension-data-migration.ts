import { AgentIdSchema, parseJsonValue, type ExtensionId } from '@nekro-nxt/contracts'
import type { NxtDataMigration, NxtMigrationEntry } from '@nekro-nxt/extension-sdk'
import { FULL_DATA_SCOPE } from '@nekro-nxt/extension-runtime'
import type { SqliteCoreRepository } from '@nekro-nxt/storage-sqlite'

/** A migration may grow data past the extension's normal quota; it rewrites what the user already chose to keep. */
const MIGRATION_QUOTA_BYTES = 1024 * 1024 * 1024

const cursorOf = (entry: NxtMigrationEntry): string =>
  Buffer.from(JSON.stringify([entry.owner, entry.partition, entry.key]), 'utf8').toString('base64url')

const ownerOf = (owner: string) => (owner === 'shared' ? ('shared' as const) : AgentIdSchema.parse(owner))

/**
 * Storage a `migrateData` handler works on: every owner and partition of one extension, in a stable order. The list
 * is read once per call so a handler that rewrites values while paging still sees each entry exactly once.
 */
export const createMigrationStorage = (
  repository: Pick<
    SqliteCoreRepository,
    'readExtensionDataset' | 'setExtensionStorageEntry' | 'deleteExtensionStorageEntry'
  >,
  extensionId: ExtensionId,
  now: () => number = Date.now,
): NxtDataMigration['storage'] => ({
  list(options = {}) {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500)
    const entries = repository
      .readExtensionDataset(extensionId, { ...FULL_DATA_SCOPE, index: false, library: false })
      .storage.map((entry) => ({
        owner: entry.owner,
        partition: entry.partition,
        key: entry.key,
        value: entry.value,
      }))
      .filter((entry) => options.owner === undefined || entry.owner === options.owner)
      .filter((entry) => options.prefix === undefined || entry.key.startsWith(options.prefix))
      .sort((left, right) => cursorOf(left).localeCompare(cursorOf(right)))
    const start = options.after === undefined ? 0 : entries.findIndex((entry) => cursorOf(entry) > options.after!)
    const page = start < 0 ? [] : entries.slice(start, start + limit)
    const last = page.at(-1)
    const more = start >= 0 && start + limit < entries.length
    return Promise.resolve({ entries: page, ...(more && last !== undefined ? { next: cursorOf(last) } : {}) })
  },
  set(entry, value) {
    repository.setExtensionStorageEntry({
      extensionId,
      owner: ownerOf(entry.owner),
      partition: entry.partition,
      key: entry.key,
      value: parseJsonValue(JSON.parse(JSON.stringify(value))),
      updatedAt: now(),
      quotaBytes: MIGRATION_QUOTA_BYTES,
    })
    return Promise.resolve()
  },
  delete(entry) {
    return Promise.resolve(
      repository.deleteExtensionStorageEntry({
        extensionId,
        owner: ownerOf(entry.owner),
        partition: entry.partition,
        key: entry.key,
      }),
    )
  },
})
