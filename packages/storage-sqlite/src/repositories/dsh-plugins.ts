import type {
  DshPluginActivationRecord,
  DshPluginDiagnosticRecord,
  DshPluginEntryId,
  DshPluginEntryRecord,
  DshPluginPackageId,
  DshPluginPackageRecord,
} from '@nekro-nxt/contracts'
import { and, asc, eq } from 'drizzle-orm'
import type { DrizzleCoreDatabase } from '../database.js'
import { dshPluginActivations, dshPluginDiagnostics, dshPluginEntries, dshPluginPackages } from '../schema.js'
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
