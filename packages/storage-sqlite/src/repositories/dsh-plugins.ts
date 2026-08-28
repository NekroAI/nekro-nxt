import type {
  DshPluginActivationRecord,
  DshPluginDiagnosticRecord,
  DshPluginEntryId,
  DshPluginEntryRecord,
  DshPluginPackageId,
  DshPluginPackageRecord,
  HostPageContribution,
  HostUiPageInstanceId,
} from '@nekro-nxt/contracts'
import type { HostUiPermissionGrant } from '@nekro-nxt/extension-runtime'
import { and, asc, eq, notInArray } from 'drizzle-orm'
import type { DrizzleCoreDatabase } from '../database.js'
import {
  dshPluginActivations,
  dshPluginDiagnostics,
  dshPluginEntries,
  dshPluginPackages,
  hostUiPageEntries,
  hostUiPagePreferences,
  hostUiPermissionGrants,
} from '../schema.js'
import {
  DshPluginActivationRowSchema,
  DshPluginDiagnosticRowSchema,
  DshPluginEntryRowSchema,
  DshPluginPackageRowSchema,
} from '../row-schemas.js'

export interface DshPluginRepository {
  listDshPluginPackages(): readonly DshPluginPackageRecord[]
  getDshPluginPackage(id: DshPluginPackageId): DshPluginPackageRecord | undefined
  getDshPluginPackageByIdentity(
    packageName: string,
    packageVersion: string,
    packageDigest: string,
  ): DshPluginPackageRecord | undefined
  saveDshPluginPackage(input: {
    readonly package: DshPluginPackageRecord
    readonly entries: readonly DshPluginEntryRecord[]
  }): void
  deleteDshPluginPackage(id: DshPluginPackageId): void
  listDshPluginEntries(packageId?: DshPluginPackageId): readonly DshPluginEntryRecord[]
  getDshPluginEntry(id: DshPluginEntryId): DshPluginEntryRecord | undefined
  updateDshPluginEntry(entry: DshPluginEntryRecord): void
  listDshPluginActivations(entryId?: DshPluginEntryId): readonly DshPluginActivationRecord[]
  upsertDshPluginActivation(activation: DshPluginActivationRecord): void
  deleteDshPluginActivation(entryId: DshPluginEntryId, targetKey: string): void
  commitDshPluginActivationState(input: {
    readonly entry: DshPluginEntryRecord
    readonly activation: DshPluginActivationRecord
    readonly hostUi?: {
      readonly grant: HostUiPermissionGrant
      readonly artifactDigest: string
      readonly pages: readonly HostPageContribution[]
      readonly clientBuildKey: string
      readonly now: number
      readonly nextPageInstanceId: () => HostUiPageInstanceId
    }
  }): void
  deleteDshPluginActivationState(input: {
    readonly entryId: DshPluginEntryId
    readonly targetKey: string
    readonly now: number
  }): void
  getDshPluginDiagnostic(entryId: DshPluginEntryId, targetKey: string): DshPluginDiagnosticRecord | undefined
  upsertDshPluginDiagnostic(diagnostic: DshPluginDiagnosticRecord): void
}

const toPackage = (input: typeof dshPluginPackages.$inferSelect): DshPluginPackageRecord => {
  const row = DshPluginPackageRowSchema.parse(input)
  return {
    id: row.id,
    packageName: row.packageName,
    packageVersion: row.packageVersion,
    source: row.source,
    packageDigest: row.packageDigest,
    ...(row.integrity === null ? {} : { integrity: row.integrity }),
    lockfileDigest: row.lockfileDigest,
    manifest: row.manifest,
    approvedBuilds: row.approvedBuilds,
    installedAt: row.installedAt,
  }
}

const toEntry = (input: typeof dshPluginEntries.$inferSelect): DshPluginEntryRecord => {
  const row = DshPluginEntryRowSchema.parse(input)
  return {
    id: row.id,
    packageId: row.packageId,
    entryKey: row.entryKey,
    moduleName: row.moduleName,
    suggestedScope: row.suggestedScope,
    ...(row.selectedScope === null ? {} : { selectedScope: row.selectedScope }),
    config: row.config,
    createdAt: row.createdAt,
  }
}

const toActivation = (input: typeof dshPluginActivations.$inferSelect): DshPluginActivationRecord => {
  const row = DshPluginActivationRowSchema.parse(input)
  return {
    entryId: row.entryId,
    targetKey: row.targetKey,
    target: row.target,
    ...(row.agentId === null ? {} : { agentId: row.agentId }),
    activatedAt: row.activatedAt,
  }
}

const toDiagnostic = (input: typeof dshPluginDiagnostics.$inferSelect): DshPluginDiagnosticRecord => {
  const row = DshPluginDiagnosticRowSchema.parse(input)
  return {
    entryId: row.entryId,
    targetKey: row.targetKey,
    status: row.status,
    phase: row.phase,
    ...(row.message === null ? {} : { message: row.message }),
    observedAt: row.observedAt,
  }
}

export const createDshPluginRepository = (database: DrizzleCoreDatabase): DshPluginRepository => ({
  listDshPluginPackages: () =>
    database
      .select()
      .from(dshPluginPackages)
      .orderBy(asc(dshPluginPackages.installedAt), asc(dshPluginPackages.id))
      .all()
      .map(toPackage),
  getDshPluginPackage: (id) => {
    const row = database.select().from(dshPluginPackages).where(eq(dshPluginPackages.id, id)).get()
    return row === undefined ? undefined : toPackage(row)
  },
  getDshPluginPackageByIdentity: (packageName, packageVersion, packageDigest) => {
    const row = database
      .select()
      .from(dshPluginPackages)
      .where(
        and(
          eq(dshPluginPackages.packageName, packageName),
          eq(dshPluginPackages.packageVersion, packageVersion),
          eq(dshPluginPackages.packageDigest, packageDigest),
        ),
      )
      .get()
    return row === undefined ? undefined : toPackage(row)
  },
  saveDshPluginPackage: ({ package: packageRecord, entries }) => {
    database.transaction(
      (tx) => {
        tx.insert(dshPluginPackages)
          .values({ ...packageRecord, integrity: packageRecord.integrity ?? null })
          .run()
        if (entries.length)
          tx.insert(dshPluginEntries)
            .values([...entries])
            .run()
      },
      { behavior: 'immediate' },
    )
  },
  deleteDshPluginPackage: (id) => {
    database.delete(dshPluginPackages).where(eq(dshPluginPackages.id, id)).run()
  },
  listDshPluginEntries: (packageId) => {
    const query = database.select().from(dshPluginEntries)
    return (packageId === undefined ? query : query.where(eq(dshPluginEntries.packageId, packageId)))
      .orderBy(asc(dshPluginEntries.packageId), asc(dshPluginEntries.createdAt), asc(dshPluginEntries.id))
      .all()
      .map(toEntry)
  },
  getDshPluginEntry: (id) => {
    const row = database.select().from(dshPluginEntries).where(eq(dshPluginEntries.id, id)).get()
    return row === undefined ? undefined : toEntry(row)
  },
  updateDshPluginEntry: (entry) => {
    database
      .update(dshPluginEntries)
      .set({ selectedScope: entry.selectedScope ?? null, config: entry.config })
      .where(eq(dshPluginEntries.id, entry.id))
      .run()
  },
  listDshPluginActivations: (entryId) => {
    const query = database.select().from(dshPluginActivations)
    return (entryId === undefined ? query : query.where(eq(dshPluginActivations.entryId, entryId)))
      .orderBy(asc(dshPluginActivations.entryId), asc(dshPluginActivations.targetKey))
      .all()
      .map(toActivation)
  },
  upsertDshPluginActivation: (activation) => {
    database
      .insert(dshPluginActivations)
      .values({ ...activation, agentId: activation.agentId ?? null })
      .onConflictDoUpdate({
        target: [dshPluginActivations.entryId, dshPluginActivations.targetKey],
        set: {
          target: activation.target,
          agentId: activation.agentId ?? null,
          activatedAt: activation.activatedAt,
        },
      })
      .run()
  },
  deleteDshPluginActivation: (entryId, targetKey) => {
    database
      .delete(dshPluginActivations)
      .where(and(eq(dshPluginActivations.entryId, entryId), eq(dshPluginActivations.targetKey, targetKey)))
      .run()
  },
  commitDshPluginActivationState: (input) => {
    database.transaction(
      (transaction) => {
        transaction
          .update(dshPluginEntries)
          .set({ selectedScope: input.entry.selectedScope ?? null, config: input.entry.config })
          .where(eq(dshPluginEntries.id, input.entry.id))
          .run()
        transaction
          .insert(dshPluginActivations)
          .values({ ...input.activation, agentId: input.activation.agentId ?? null })
          .onConflictDoUpdate({
            target: [dshPluginActivations.entryId, dshPluginActivations.targetKey],
            set: {
              target: input.activation.target,
              agentId: input.activation.agentId ?? null,
              activatedAt: input.activation.activatedAt,
            },
          })
          .run()
        if (input.activation.target !== 'host') return

        const existing = transaction
          .select()
          .from(hostUiPageEntries)
          .where(and(eq(hostUiPageEntries.ownerKind, 'dsh-plugin'), eq(hostUiPageEntries.ownerId, input.entry.id)))
          .all()
        const byEntryId = new Map(existing.map((row) => [row.entryId, row] as const))
        let directoryChanged = false
        if (input.hostUi) {
          transaction
            .insert(hostUiPermissionGrants)
            .values(input.hostUi.grant)
            .onConflictDoUpdate({
              target: hostUiPermissionGrants.ownerKey,
              set: {
                artifactDigest: input.hostUi.grant.artifactDigest,
                permissionDigest: input.hostUi.grant.permissionDigest,
                declaration: input.hostUi.grant.declaration,
                approvedAt: input.hostUi.grant.approvedAt,
              },
            })
            .run()
          let nextSortOrder =
            (transaction.select().from(hostUiPageEntries).orderBy(asc(hostUiPageEntries.sortOrder)).all().at(-1)
              ?.sortOrder ?? -1) + 1
          for (const page of input.hostUi.pages) {
            const previous = byEntryId.get(page.entryId)
            transaction
              .insert(hostUiPageEntries)
              .values({
                pageInstanceId: previous?.pageInstanceId ?? input.hostUi.nextPageInstanceId(),
                ownerKind: 'dsh-plugin',
                ownerId: input.entry.id,
                artifactId: input.hostUi.artifactDigest,
                entryId: page.entryId,
                title: page.title,
                description: page.description ?? null,
                icon: page.icon,
                objectPane: page.objectPane,
                startPath: page.startPath,
                visible: previous?.visible ?? true,
                sortOrder: previous?.sortOrder ?? nextSortOrder++,
                clientBuildKey: input.hostUi.clientBuildKey,
                createdAt: previous?.createdAt ?? input.hostUi.now,
                updatedAt: input.hostUi.now,
              })
              .onConflictDoUpdate({
                target: [hostUiPageEntries.ownerKind, hostUiPageEntries.ownerId, hostUiPageEntries.entryId],
                set: {
                  artifactId: input.hostUi.artifactDigest,
                  title: page.title,
                  description: page.description ?? null,
                  icon: page.icon,
                  objectPane: page.objectPane,
                  startPath: page.startPath,
                  clientBuildKey: input.hostUi.clientBuildKey,
                  updatedAt: input.hostUi.now,
                },
              })
              .run()
          }
          const retainedIds = input.hostUi.pages.map(({ entryId }) => entryId)
          transaction
            .delete(hostUiPageEntries)
            .where(
              retainedIds.length === 0
                ? and(eq(hostUiPageEntries.ownerKind, 'dsh-plugin'), eq(hostUiPageEntries.ownerId, input.entry.id))
                : and(
                    eq(hostUiPageEntries.ownerKind, 'dsh-plugin'),
                    eq(hostUiPageEntries.ownerId, input.entry.id),
                    notInArray(hostUiPageEntries.entryId, retainedIds),
                  ),
            )
            .run()
          directoryChanged =
            existing.length !== input.hostUi.pages.length ||
            input.hostUi.pages.some((page) => !byEntryId.has(page.entryId))
        } else {
          const removed = transaction
            .delete(hostUiPageEntries)
            .where(and(eq(hostUiPageEntries.ownerKind, 'dsh-plugin'), eq(hostUiPageEntries.ownerId, input.entry.id)))
            .run()
          directoryChanged = removed.changes > 0
          transaction
            .delete(hostUiPermissionGrants)
            .where(eq(hostUiPermissionGrants.ownerKey, `dsh:${input.entry.id}`))
            .run()
        }
        if (directoryChanged) {
          const now = input.hostUi?.now ?? input.activation.activatedAt
          const preference = transaction
            .select()
            .from(hostUiPagePreferences)
            .where(eq(hostUiPagePreferences.id, 1))
            .get()
          transaction
            .insert(hostUiPagePreferences)
            .values({ id: 1, revision: (preference?.revision ?? 0) + 1, updatedAt: now })
            .onConflictDoUpdate({
              target: hostUiPagePreferences.id,
              set: { revision: (preference?.revision ?? 0) + 1, updatedAt: now },
            })
            .run()
        }
      },
      { behavior: 'immediate' },
    )
  },
  deleteDshPluginActivationState: (input) => {
    database.transaction(
      (transaction) => {
        transaction
          .delete(dshPluginActivations)
          .where(
            and(eq(dshPluginActivations.entryId, input.entryId), eq(dshPluginActivations.targetKey, input.targetKey)),
          )
          .run()
        if (input.targetKey !== 'host') return
        const removed = transaction
          .delete(hostUiPageEntries)
          .where(and(eq(hostUiPageEntries.ownerKind, 'dsh-plugin'), eq(hostUiPageEntries.ownerId, input.entryId)))
          .run()
        transaction
          .delete(hostUiPermissionGrants)
          .where(eq(hostUiPermissionGrants.ownerKey, `dsh:${input.entryId}`))
          .run()
        if (removed.changes > 0) {
          const preference = transaction
            .select()
            .from(hostUiPagePreferences)
            .where(eq(hostUiPagePreferences.id, 1))
            .get()
          transaction
            .insert(hostUiPagePreferences)
            .values({ id: 1, revision: (preference?.revision ?? 0) + 1, updatedAt: input.now })
            .onConflictDoUpdate({
              target: hostUiPagePreferences.id,
              set: { revision: (preference?.revision ?? 0) + 1, updatedAt: input.now },
            })
            .run()
        }
      },
      { behavior: 'immediate' },
    )
  },
  getDshPluginDiagnostic: (entryId, targetKey) => {
    const row = database
      .select()
      .from(dshPluginDiagnostics)
      .where(and(eq(dshPluginDiagnostics.entryId, entryId), eq(dshPluginDiagnostics.targetKey, targetKey)))
      .get()
    return row === undefined ? undefined : toDiagnostic(row)
  },
  upsertDshPluginDiagnostic: (diagnostic) => {
    database
      .insert(dshPluginDiagnostics)
      .values({ ...diagnostic, message: diagnostic.message ?? null })
      .onConflictDoUpdate({
        target: [dshPluginDiagnostics.entryId, dshPluginDiagnostics.targetKey],
        set: {
          status: diagnostic.status,
          phase: diagnostic.phase,
          message: diagnostic.message ?? null,
          observedAt: diagnostic.observedAt,
        },
      })
      .run()
  },
})
