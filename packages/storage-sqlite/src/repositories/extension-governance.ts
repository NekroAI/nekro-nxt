import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm'
import {
  AgentIdSchema,
  AssetIdSchema,
  type AgentId,
  type ChannelId,
  type ConnectionId,
  type ExtensionId,
  type JsonValue,
} from '@nekro-nxt/contracts'
import type {
  ExtensionDataMigrationMode,
  ExtensionDataScope,
  ExtensionDataset,
  ExtensionDatasetIndexDocument,
} from '@nekro-nxt/extension-runtime'
import type { DrizzleCoreDatabase } from '../database.js'
import {
  extensionDataSnapshots,
  extensionDataStates,
  extensionIndexDocuments,
  extensionIndexFilterValues,
  extensionLibraryAssets,
  extensionRequests,
  extensionStorageEntries,
  instanceAdministrators,
} from '../schema.js'

export type InstanceAdministratorRecord = typeof instanceAdministrators.$inferSelect

export type ExtensionRequestStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'completed' | 'failed'

export interface ExtensionRequestRecord {
  readonly number: number
  readonly kind: string
  readonly agentId: AgentId
  readonly channelId: ChannelId | null
  readonly extensionId: ExtensionId | null
  readonly summary: string
  readonly payload: JsonValue
  readonly status: ExtensionRequestStatus
  readonly result: JsonValue | null
  readonly decidedBy: string | null
  readonly createdAt: number
  readonly expiresAt: number
  readonly decidedAt: number | null
}

export interface ExtensionDataSnapshotSummary {
  readonly id: string
  readonly extensionId: ExtensionId
  readonly reason: 'switch' | 'migration' | 'manual'
  readonly label: string
  readonly dataVersion: number
  readonly byteSize: number
  readonly createdAt: number
}

const toRequest = (row: typeof extensionRequests.$inferSelect): ExtensionRequestRecord => ({
  number: row.number,
  kind: row.kind,
  agentId: row.agentId,
  channelId: row.channelId,
  extensionId: row.extensionId,
  summary: row.summary,
  payload: row.payload,
  status: row.status,
  result: row.result,
  decidedBy: row.decidedBy,
  createdAt: row.createdAt,
  expiresAt: row.expiresAt,
  decidedAt: row.decidedAt,
})

const ownerOf = (owner: string): 'shared' | AgentId => (owner === 'shared' ? 'shared' : AgentIdSchema.parse(owner))

/** Administrators, administrator-confirmed requests, data versions, data snapshots and whole-dataset copies. */
export function createExtensionGovernanceRepository(database: DrizzleCoreDatabase) {
  const readDataset = (
    tx: Pick<DrizzleCoreDatabase, 'select' | 'all'>,
    extensionId: ExtensionId,
    scope: ExtensionDataScope,
  ): ExtensionDataset => {
    const storage = tx
      .select()
      .from(extensionStorageEntries)
      .where(eq(extensionStorageEntries.extensionId, extensionId))
      .orderBy(asc(extensionStorageEntries.owner), asc(extensionStorageEntries.partition), asc(extensionStorageEntries.key))
      .all()
      .filter((row) => scope.owners === 'all' || scope.owners.includes(ownerOf(row.owner)))
      .map((row) => ({
        owner: ownerOf(row.owner),
        partition: row.partition,
        key: row.key,
        value: row.valueJson,
        updatedAt: row.updatedAt,
      }))
    const index: ExtensionDatasetIndexDocument[] = []
    if (scope.index) {
      const documents = tx
        .select()
        .from(extensionIndexDocuments)
        .where(eq(extensionIndexDocuments.extensionId, extensionId))
        .orderBy(asc(extensionIndexDocuments.id))
        .all()
      const ids = documents.map((document) => document.id)
      const filters =
        ids.length === 0
          ? []
          : tx.select().from(extensionIndexFilterValues).where(inArray(extensionIndexFilterValues.documentRowId, ids)).all()
      const keywords = new Map(
        (ids.length === 0
          ? []
          : tx.all<{ rowid: number; f1: string; f2: string; f3: string; f4: string }>(
              sql`SELECT rowid, f1, f2, f3, f4 FROM extension_index_fts WHERE rowid IN (${sql.join(
                ids.map((id) => sql`${id}`),
                sql`, `,
              )})`,
            )
        ).map((row) => [row.rowid, [row.f1, row.f2, row.f3, row.f4]] as const),
      )
      for (const document of documents) {
        index.push({
          collection: document.collection,
          documentId: document.documentId,
          fields: document.fields,
          keywords: keywords.get(document.id) ?? ['', '', '', ''],
          filters: filters
            .filter((filter) => filter.documentRowId === document.id)
            .map(({ field, value }) => ({ field, value })),
          updatedAt: document.updatedAt,
        })
      }
    }
    const library = scope.library
      ? tx
          .select({ assetId: extensionLibraryAssets.assetId, addedAt: extensionLibraryAssets.addedAt })
          .from(extensionLibraryAssets)
          .where(eq(extensionLibraryAssets.extensionId, extensionId))
          .orderBy(asc(extensionLibraryAssets.addedAt))
          .all()
          .map((row) => ({ assetId: AssetIdSchema.parse(row.assetId), addedAt: row.addedAt }))
      : []
    return { storage, index, library }
  }

  return {
    listInstanceAdministrators(): InstanceAdministratorRecord[] {
      return database.select().from(instanceAdministrators).orderBy(asc(instanceAdministrators.addedAt)).all()
    },
    isInstanceAdministrator(connectionId: ConnectionId, platformUserId: string): boolean {
      return (
        database
          .select({ id: instanceAdministrators.platformUserId })
          .from(instanceAdministrators)
          .where(
            and(
              eq(instanceAdministrators.connectionId, connectionId),
              eq(instanceAdministrators.platformUserId, platformUserId),
            ),
          )
          .get() !== undefined
      )
    },
    addInstanceAdministrator(record: InstanceAdministratorRecord): void {
      database.insert(instanceAdministrators).values(record).onConflictDoNothing().run()
    },
    removeInstanceAdministrator(connectionId: ConnectionId, platformUserId: string): boolean {
      return (
        database
          .delete(instanceAdministrators)
          .where(
            and(
              eq(instanceAdministrators.connectionId, connectionId),
              eq(instanceAdministrators.platformUserId, platformUserId),
            ),
          )
          .run().changes === 1
      )
    },

    createExtensionRequest(input: Omit<ExtensionRequestRecord, 'number' | 'status' | 'result' | 'decidedBy' | 'decidedAt'>): ExtensionRequestRecord {
      const row = database
        .insert(extensionRequests)
        .values({ ...input, status: 'pending', result: null, decidedBy: null, decidedAt: null })
        .returning()
        .get()
      return toRequest(row)
    },
    getExtensionRequest(number: number): ExtensionRequestRecord | undefined {
      const row = database.select().from(extensionRequests).where(eq(extensionRequests.number, number)).get()
      return row === undefined ? undefined : toRequest(row)
    },
    listExtensionRequests(input: { readonly status?: ExtensionRequestStatus; readonly limit?: number } = {}) {
      const query = database.select().from(extensionRequests)
      return (input.status === undefined ? query : query.where(eq(extensionRequests.status, input.status)))
        .orderBy(desc(extensionRequests.number))
        .limit(input.limit ?? 100)
        .all()
        .map(toRequest)
    },
    /** Moves a request on only from the status the caller saw, so two administrators cannot both decide it. */
    updateExtensionRequest(input: {
      readonly number: number
      readonly from: ExtensionRequestStatus
      readonly status: ExtensionRequestStatus
      readonly result?: JsonValue
      readonly decidedBy?: string
      readonly decidedAt?: number
    }): boolean {
      return (
        database
          .update(extensionRequests)
          .set({
            status: input.status,
            ...(input.result === undefined ? {} : { result: input.result }),
            ...(input.decidedBy === undefined ? {} : { decidedBy: input.decidedBy }),
            ...(input.decidedAt === undefined ? {} : { decidedAt: input.decidedAt }),
          })
          .where(and(eq(extensionRequests.number, input.number), eq(extensionRequests.status, input.from)))
          .run().changes === 1
      )
    },
    expireExtensionRequests(now: number): number {
      return database
        .update(extensionRequests)
        .set({ status: 'expired', decidedAt: now })
        .where(and(eq(extensionRequests.status, 'pending'), lt(extensionRequests.expiresAt, now)))
        .run().changes
    },

    /** Data version the extension's stored data has; 1 when it never declared one. */
    getExtensionDataVersion(extensionId: ExtensionId): number {
      return (
        database
          .select({ version: extensionDataStates.dataVersion })
          .from(extensionDataStates)
          .where(eq(extensionDataStates.extensionId, extensionId))
          .get()?.version ?? 1
      )
    },
    setExtensionDataVersion(extensionId: ExtensionId, dataVersion: number, now: number): void {
      database
        .insert(extensionDataStates)
        .values({ extensionId, dataVersion, updatedAt: now })
        .onConflictDoUpdate({ target: extensionDataStates.extensionId, set: { dataVersion, updatedAt: now } })
        .run()
    },

    readExtensionDataset(extensionId: ExtensionId, scope: ExtensionDataScope): ExtensionDataset {
      return readDataset(database, extensionId, scope)
    },
    /**
     * Writes a dataset into the covered part of an extension's data in one transaction. Quotas do not apply: this is
     * an explicit user action restoring or migrating data the extension already had.
     */
    writeExtensionDataset(input: {
      readonly extensionId: ExtensionId
      readonly dataset: ExtensionDataset
      readonly scope: ExtensionDataScope
      readonly mode: ExtensionDataMigrationMode
      readonly now: number
    }): void {
      const { extensionId, dataset, scope } = input
      database.transaction(
        (tx) => {
          if (input.mode === 'replace') {
            const owners = scope.owners
            tx.delete(extensionStorageEntries)
              .where(
                owners === 'all'
                  ? eq(extensionStorageEntries.extensionId, extensionId)
                  : and(eq(extensionStorageEntries.extensionId, extensionId), inArray(extensionStorageEntries.owner, [...owners])),
              )
              .run()
            if (scope.index) {
              // The delete trigger removes keyword rows; filter values and vectors cascade.
              tx.delete(extensionIndexDocuments).where(eq(extensionIndexDocuments.extensionId, extensionId)).run()
            }
            if (scope.library) {
              tx.delete(extensionLibraryAssets).where(eq(extensionLibraryAssets.extensionId, extensionId)).run()
            }
          }
          for (const entry of dataset.storage) {
            if (scope.owners !== 'all' && !scope.owners.includes(entry.owner)) continue
            const valueJson = entry.value
            const byteSize = Buffer.byteLength(JSON.stringify(valueJson), 'utf8')
            tx.insert(extensionStorageEntries)
              .values({
                extensionId,
                owner: entry.owner,
                agentId: entry.owner === 'shared' ? null : entry.owner,
                partition: entry.partition,
                key: entry.key,
                valueJson,
                byteSize,
                updatedAt: input.now,
              })
              .onConflictDoUpdate({
                target: [
                  extensionStorageEntries.extensionId,
                  extensionStorageEntries.owner,
                  extensionStorageEntries.partition,
                  extensionStorageEntries.key,
                ],
                set: { valueJson, byteSize, updatedAt: input.now },
              })
              .run()
          }
          if (scope.index) {
            for (const document of dataset.index) {
              const row = tx
                .insert(extensionIndexDocuments)
                .values({
                  extensionId,
                  collection: document.collection,
                  documentId: document.documentId,
                  fields: document.fields,
                  updatedAt: input.now,
                })
                .onConflictDoUpdate({
                  target: [
                    extensionIndexDocuments.extensionId,
                    extensionIndexDocuments.collection,
                    extensionIndexDocuments.documentId,
                  ],
                  set: { fields: document.fields, updatedAt: input.now },
                })
                .returning({ id: extensionIndexDocuments.id })
                .get()
              tx.run(sql`DELETE FROM extension_index_fts WHERE rowid = ${row.id}`)
              const [f1 = '', f2 = '', f3 = '', f4 = ''] = document.keywords
              tx.run(
                sql`INSERT INTO extension_index_fts (rowid, f1, f2, f3, f4) VALUES (${row.id}, ${f1}, ${f2}, ${f3}, ${f4})`,
              )
              tx.delete(extensionIndexFilterValues).where(eq(extensionIndexFilterValues.documentRowId, row.id)).run()
              const filters = [
                ...new Map(document.filters.map((entry) => [`${entry.field}\u0000${entry.value}`, entry])).values(),
              ]
              if (filters.length > 0) {
                tx.insert(extensionIndexFilterValues)
                  .values(filters.map(({ field, value }) => ({ documentRowId: row.id, field, value })))
                  .run()
              }
            }
          }
          if (scope.library) {
            for (const asset of dataset.library) {
              tx.insert(extensionLibraryAssets)
                .values({ extensionId, assetId: asset.assetId, addedAt: asset.addedAt })
                .onConflictDoNothing()
                .run()
            }
          }
        },
        { behavior: 'immediate' },
      )
    },

    createExtensionDataSnapshot(input: {
      readonly id: string
      readonly extensionId: ExtensionId
      readonly reason: 'switch' | 'migration' | 'manual'
      readonly label: string
      readonly dataVersion: number
      readonly payload: Buffer
      readonly createdAt: number
      /** Older snapshots of the same extension beyond this many are deleted. */
      readonly keep: number
    }): void {
      database.transaction((tx) => {
        tx.insert(extensionDataSnapshots)
          .values({
            id: input.id,
            extensionId: input.extensionId,
            reason: input.reason,
            label: input.label,
            dataVersion: input.dataVersion,
            payload: input.payload,
            byteSize: input.payload.byteLength,
            createdAt: input.createdAt,
          })
          .run()
        const stale = tx
          .select({ id: extensionDataSnapshots.id })
          .from(extensionDataSnapshots)
          .where(eq(extensionDataSnapshots.extensionId, input.extensionId))
          .orderBy(desc(extensionDataSnapshots.createdAt), desc(extensionDataSnapshots.id))
          .all()
          .slice(input.keep)
          .map((row) => row.id)
        if (stale.length > 0) tx.delete(extensionDataSnapshots).where(inArray(extensionDataSnapshots.id, stale)).run()
      })
    },
    listExtensionDataSnapshots(extensionId: ExtensionId): ExtensionDataSnapshotSummary[] {
      return database
        .select({
          id: extensionDataSnapshots.id,
          extensionId: extensionDataSnapshots.extensionId,
          reason: extensionDataSnapshots.reason,
          label: extensionDataSnapshots.label,
          dataVersion: extensionDataSnapshots.dataVersion,
          byteSize: extensionDataSnapshots.byteSize,
          createdAt: extensionDataSnapshots.createdAt,
        })
        .from(extensionDataSnapshots)
        .where(eq(extensionDataSnapshots.extensionId, extensionId))
        .orderBy(desc(extensionDataSnapshots.createdAt))
        .all()
    },
    getExtensionDataSnapshotPayload(id: string): { readonly extensionId: ExtensionId; readonly payload: Buffer } | undefined {
      return database
        .select({ extensionId: extensionDataSnapshots.extensionId, payload: extensionDataSnapshots.payload })
        .from(extensionDataSnapshots)
        .where(eq(extensionDataSnapshots.id, id))
        .get()
    },
  }
}

export type ExtensionGovernanceRepository = ReturnType<typeof createExtensionGovernanceRepository>
