import { and, asc, eq, notInArray } from 'drizzle-orm'
import {
  DshPluginEntryIdSchema,
  AdapterClientSlotNameSchema,
  AgentClientSlotNameSchema,
  ExtensionIdSchema,
  ExtensionRevisionIdSchema,
  HostPageContributionSchema,
  HostUiPermissionDeclarationSchema,
  type AgentId,
  type ExtensionId,
  type ExtensionRevisionId,
  type HostUiPageEntry,
} from '@nekro-nxt/contracts'
import type {
  Activation,
  ExtensionRepository,
  ExtensionClientDiagnostic,
  ExtensionRevisionVerification,
  HostUiDiagnostic,
  HostUiPermissionGrant,
  HostUiRepository,
  HostInstallation,
  LocalExtension,
  Revision,
} from '@nekro-nxt/extension-runtime'
import { z } from 'zod'
import type { DrizzleCoreDatabase } from '../database.js'
import {
  agentActivations,
  extensionClientDiagnostics,
  extensionRevisions,
  extensionRevisionVerifications,
  hostExtensionInstallations,
  hostUiDiagnostics,
  hostUiPageEntries,
  hostUiPagePreferences,
  hostUiPermissionGrants,
  localExtensions,
} from '../schema.js'
import {
  AgentActivationRowSchema,
  ExtensionRevisionRowSchema,
  HostExtensionInstallationRowSchema,
  HostUiDiagnosticRowSchema,
  HostUiPageEntryRowSchema,
  HostUiPermissionGrantRowSchema,
  LocalExtensionRowSchema,
} from '../row-schemas.js'

const toExtension = (input: typeof localExtensions.$inferSelect): LocalExtension => {
  const row = LocalExtensionRowSchema.parse(input)
  return {
    id: row.id,
    scope: row.scope,
    slug: row.slug,
    displayName: row.displayName,
    description: row.description,
    ...(row.createdByAgentId === null ? {} : { createdByAgentId: row.createdByAgentId }),
    createdAt: row.createdAt,
  }
}

const toRevision = (input: typeof extensionRevisions.$inferSelect): Revision => {
  const row = ExtensionRevisionRowSchema.parse(input)
  return {
    id: row.id,
    extensionId: row.extensionId,
    revisionNumber: row.revisionNumber,
    contentDigest: row.contentDigest,
    payloadDigest: row.payloadDigest,
    createdAt: row.createdAt,
  }
}

const toActivation = (input: typeof agentActivations.$inferSelect): Activation => {
  const row = AgentActivationRowSchema.parse(input)
  return {
    agentId: row.agentId,
    extensionId: row.extensionId,
    extensionRevisionId: row.extensionRevisionId,
    config: row.config,
    activatedAt: row.activatedAt,
  }
}

const toHostInstallation = (input: typeof hostExtensionInstallations.$inferSelect): HostInstallation => {
  const row = HostExtensionInstallationRowSchema.parse(input)
  return {
    extensionId: row.extensionId,
    extensionRevisionId: row.extensionRevisionId,
    installedAt: row.installedAt,
  }
}

const toHostUiPageEntry = (
  input: typeof hostUiPageEntries.$inferSelect,
  diagnostic?: HostUiDiagnostic,
): HostUiPageEntry => {
  const row = HostUiPageEntryRowSchema.parse(input)
  const owner =
    row.ownerKind === 'extension'
      ? {
          kind: 'extension' as const,
          extensionId: ExtensionIdSchema.parse(row.ownerId),
          revisionId: ExtensionRevisionIdSchema.parse(row.artifactId),
        }
      : {
          kind: 'dsh-plugin' as const,
          entryId: DshPluginEntryIdSchema.parse(row.ownerId),
          artifactDigest: row.artifactId,
        }
  const moduleUrl =
    owner.kind === 'extension'
      ? `/api/extensions/${owner.extensionId}/revisions/${owner.revisionId}/host-ui/client/${row.clientBuildKey}.mjs`
      : `/api/dsh/plugin-entries/${owner.entryId}/host-ui/client/${row.clientBuildKey}.mjs`
  return {
    pageInstanceId: row.pageInstanceId,
    owner,
    entryId: row.entryId,
    title: row.title,
    ...(row.description === null ? {} : { description: row.description }),
    icon: row.icon,
    objectPane: row.objectPane,
    startPath: row.startPath,
    visible: row.visible,
    sortOrder: row.sortOrder,
    routeBase: `/apps/${row.pageInstanceId}`,
    client: { moduleUrl, buildKey: row.clientBuildKey },
    ...(diagnostic === undefined
      ? {}
      : {
          diagnostic: {
            status: diagnostic.status,
            ...(diagnostic.message === undefined ? {} : { message: diagnostic.message }),
            observedAt: diagnostic.observedAt,
          },
        }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

const toHostUiDiagnostic = (input: typeof hostUiDiagnostics.$inferSelect): HostUiDiagnostic => {
  const row = HostUiDiagnosticRowSchema.parse(input)
  return {
    pageInstanceId: row.pageInstanceId,
    status: row.status,
    ...(row.message === null ? {} : { message: row.message }),
    observedAt: row.observedAt,
  }
}

const ExtensionRevisionVerificationSchema = z.object({
  revisionId: ExtensionRevisionIdSchema,
  dshVersion: z.string().trim().min(1),
  contractVersion: z.enum(['nekro-nxt-extension-v1', 'nekro-nxt-extension-v2', 'nekro-nxt-extension-v3']),
  scope: z.enum(['host-adapter', 'host-ui']).optional(),
  origin: z.object({ episodeId: z.string(), pluginId: z.string(), packageId: z.string(), pluginRunId: z.string() }),
  verifiedAt: z.number().int().nonnegative(),
  hostBuild: z.object({ built: z.boolean(), buildKey: z.string() }),
  clientBuild: z.object({ built: z.boolean(), buildKey: z.string() }),
  toolInvocations: z.array(z.object({ name: z.string(), succeeded: z.boolean() })),
  rpcMethods: z.array(z.string()),
  renderedSlots: z.array(AgentClientSlotNameSchema),
  renderedPages: z.array(HostPageContributionSchema).max(8).optional(),
  permissions: HostUiPermissionDeclarationSchema.optional(),
  adapter: z
    .object({
      apiVersion: z.literal(1),
      key: z.string().trim().min(1),
      descriptorDigest: z.string().regex(/^[a-f0-9]{64}$/u),
      registered: z.boolean(),
      started: z.boolean(),
      stopped: z.boolean(),
      inboundCommitted: z.boolean(),
      outboundReceipt: z.enum(['sent', 'failed', 'unknown']),
    })
    .optional(),
  renderedHostSlots: z
    .array(
      z
        .object({
          name: AdapterClientSlotNameSchema,
          key: z.string().trim().min(1),
        })
        .strict(),
    )
    .optional(),
})

const parseExtensionRevisionVerification = (input: unknown): ExtensionRevisionVerification => {
  const parsed = ExtensionRevisionVerificationSchema.parse(input)
  return {
    revisionId: parsed.revisionId,
    dshVersion: parsed.dshVersion,
    contractVersion: parsed.contractVersion,
    origin: parsed.origin,
    verifiedAt: parsed.verifiedAt,
    hostBuild: parsed.hostBuild,
    clientBuild: parsed.clientBuild,
    toolInvocations: parsed.toolInvocations,
    rpcMethods: parsed.rpcMethods,
    renderedSlots: parsed.renderedSlots,
    ...(parsed.scope === undefined ? {} : { scope: parsed.scope }),
    ...(parsed.renderedPages === undefined ? {} : { renderedPages: parsed.renderedPages }),
    ...(parsed.permissions === undefined ? {} : { permissions: parsed.permissions }),
    ...(parsed.adapter === undefined ? {} : { adapter: parsed.adapter }),
    ...(parsed.renderedHostSlots === undefined ? {} : { renderedHostSlots: parsed.renderedHostSlots }),
  }
}

export function createExtensionsRepository(database: DrizzleCoreDatabase): ExtensionRepository & HostUiRepository {
  return {
    listExtensions(): readonly LocalExtension[] {
      return database
        .select()
        .from(localExtensions)
        .orderBy(asc(localExtensions.createdAt), asc(localExtensions.id))
        .all()
        .map(toExtension)
    },
    getExtension(id: ExtensionId): LocalExtension | undefined {
      const row = database.select().from(localExtensions).where(eq(localExtensions.id, id)).get()
      return row === undefined ? undefined : toExtension(row)
    },
    getExtensionBySlug(slug: string): LocalExtension | undefined {
      const row = database.select().from(localExtensions).where(eq(localExtensions.slug, slug)).get()
      return row === undefined ? undefined : toExtension(row)
    },
    listExtensionRevisions(extensionId?: ExtensionId): readonly Revision[] {
      const query = database.select().from(extensionRevisions)
      return (extensionId === undefined ? query : query.where(eq(extensionRevisions.extensionId, extensionId)))
        .orderBy(asc(extensionRevisions.extensionId), asc(extensionRevisions.revisionNumber))
        .all()
        .map(toRevision)
    },
    getExtensionRevision(id: ExtensionRevisionId): Revision | undefined {
      const row = database.select().from(extensionRevisions).where(eq(extensionRevisions.id, id)).get()
      return row === undefined ? undefined : toRevision(row)
    },
    getExtensionRevisionByPayloadDigest(extensionId, payloadDigest): Revision | undefined {
      const row = database
        .select()
        .from(extensionRevisions)
        .where(
          and(eq(extensionRevisions.extensionId, extensionId), eq(extensionRevisions.payloadDigest, payloadDigest)),
        )
        .get()
      return row === undefined ? undefined : toRevision(row)
    },
    nextExtensionRevisionNumber(extensionId: ExtensionId): number {
      const rows = database
        .select({ revisionNumber: extensionRevisions.revisionNumber })
        .from(extensionRevisions)
        .where(eq(extensionRevisions.extensionId, extensionId))
        .orderBy(asc(extensionRevisions.revisionNumber))
        .all()
      return (rows.at(-1)?.revisionNumber ?? 0) + 1
    },
    saveExtensionRevision({ extension, revision, verification }): void {
      database.transaction(
        (tx) => {
          tx.insert(localExtensions).values(extension).onConflictDoNothing({ target: localExtensions.id }).run()
          tx.insert(extensionRevisions).values(revision).run()
          if (verification) {
            tx.insert(extensionRevisionVerifications)
              .values({ revisionId: revision.id, verifiedAt: verification.verifiedAt, evidence: verification })
              .run()
          }
        },
        { behavior: 'immediate' },
      )
    },
    deleteExtension(extensionId): void {
      database.transaction(
        (tx) => {
          const active = tx.select().from(agentActivations).where(eq(agentActivations.extensionId, extensionId)).get()
          const installed = tx
            .select()
            .from(hostExtensionInstallations)
            .where(eq(hostExtensionInstallations.extensionId, extensionId))
            .get()
          if (active || installed) throw new Error('运行中的 Extension 必须先全部关闭或卸载。')
          const revisions = tx
            .select({ id: extensionRevisions.id })
            .from(extensionRevisions)
            .where(eq(extensionRevisions.extensionId, extensionId))
            .all()
          tx.delete(extensionClientDiagnostics).where(eq(extensionClientDiagnostics.extensionId, extensionId)).run()
          tx.delete(hostUiPageEntries)
            .where(and(eq(hostUiPageEntries.ownerKind, 'extension'), eq(hostUiPageEntries.ownerId, extensionId)))
            .run()
          tx.delete(hostUiPermissionGrants)
            .where(eq(hostUiPermissionGrants.ownerKey, `extension:${extensionId}`))
            .run()
          for (const revision of revisions) {
            tx.delete(extensionRevisionVerifications)
              .where(eq(extensionRevisionVerifications.revisionId, revision.id))
              .run()
          }
          tx.delete(extensionRevisions).where(eq(extensionRevisions.extensionId, extensionId)).run()
          const result = tx.delete(localExtensions).where(eq(localExtensions.id, extensionId)).run()
          if (result.changes !== 1) throw new Error('Extension 不存在或已被删除。')
        },
        { behavior: 'immediate' },
      )
    },
    getExtensionRevisionVerification(revisionId): ExtensionRevisionVerification | undefined {
      const row = database
        .select()
        .from(extensionRevisionVerifications)
        .where(eq(extensionRevisionVerifications.revisionId, revisionId))
        .get()
      return row === undefined ? undefined : parseExtensionRevisionVerification(row.evidence)
    },
    getExtensionClientDiagnostic(agentId, extensionId): ExtensionClientDiagnostic | undefined {
      const row = database
        .select()
        .from(extensionClientDiagnostics)
        .where(
          and(eq(extensionClientDiagnostics.agentId, agentId), eq(extensionClientDiagnostics.extensionId, extensionId)),
        )
        .get()
      if (!row) return undefined
      return {
        agentId: row.agentId,
        extensionId: row.extensionId,
        revisionId: row.revisionId,
        status: row.status,
        ...(row.message === null ? {} : { message: row.message }),
        observedAt: row.observedAt,
      }
    },
    upsertExtensionClientDiagnostic(diagnostic): void {
      database
        .insert(extensionClientDiagnostics)
        .values({ ...diagnostic, message: diagnostic.message ?? null })
        .onConflictDoUpdate({
          target: [extensionClientDiagnostics.agentId, extensionClientDiagnostics.extensionId],
          set: {
            revisionId: diagnostic.revisionId,
            status: diagnostic.status,
            message: diagnostic.message ?? null,
            observedAt: diagnostic.observedAt,
          },
        })
        .run()
    },
    getActivation(agentId: AgentId, extensionId: ExtensionId): Activation | undefined {
      const row = database
        .select()
        .from(agentActivations)
        .where(and(eq(agentActivations.agentId, agentId), eq(agentActivations.extensionId, extensionId)))
        .get()
      return row === undefined ? undefined : toActivation(row)
    },
    listActivations(agentId?: AgentId): readonly Activation[] {
      const query = database.select().from(agentActivations)
      return (agentId === undefined ? query : query.where(eq(agentActivations.agentId, agentId)))
        .orderBy(asc(agentActivations.activatedAt), asc(agentActivations.agentId), asc(agentActivations.extensionId))
        .all()
        .map(toActivation)
    },
    upsertActivation(activation): void {
      database
        .insert(agentActivations)
        .values(activation)
        .onConflictDoUpdate({
          target: [agentActivations.agentId, agentActivations.extensionId],
          set: {
            extensionRevisionId: activation.extensionRevisionId,
            config: activation.config,
            activatedAt: activation.activatedAt,
          },
        })
        .run()
    },
    deleteActivation(agentId, extensionId): void {
      database
        .delete(agentActivations)
        .where(and(eq(agentActivations.agentId, agentId), eq(agentActivations.extensionId, extensionId)))
        .run()
    },
    getHostInstallation(extensionId): HostInstallation | undefined {
      const row = database
        .select()
        .from(hostExtensionInstallations)
        .where(eq(hostExtensionInstallations.extensionId, extensionId))
        .get()
      return row === undefined ? undefined : toHostInstallation(row)
    },
    listHostInstallations(): readonly HostInstallation[] {
      return database
        .select()
        .from(hostExtensionInstallations)
        .orderBy(asc(hostExtensionInstallations.installedAt), asc(hostExtensionInstallations.extensionId))
        .all()
        .map(toHostInstallation)
    },
    upsertHostInstallation(installation): void {
      database
        .insert(hostExtensionInstallations)
        .values(installation)
        .onConflictDoUpdate({
          target: hostExtensionInstallations.extensionId,
          set: {
            extensionRevisionId: installation.extensionRevisionId,
            installedAt: installation.installedAt,
          },
        })
        .run()
    },
    deleteHostInstallation(extensionId): void {
      database.delete(hostExtensionInstallations).where(eq(hostExtensionInstallations.extensionId, extensionId)).run()
    },
    listHostUiPageEntries(): readonly HostUiPageEntry[] {
      const diagnostics = new Map(
        database
          .select()
          .from(hostUiDiagnostics)
          .all()
          .map((row) => {
            const diagnostic = toHostUiDiagnostic(row)
            return [diagnostic.pageInstanceId, diagnostic] as const
          }),
      )
      return database
        .select()
        .from(hostUiPageEntries)
        .orderBy(asc(hostUiPageEntries.sortOrder), asc(hostUiPageEntries.pageInstanceId))
        .all()
        .map((row) => toHostUiPageEntry(row, diagnostics.get(row.pageInstanceId)))
    },
    replaceHostUiExtensionPages(input): readonly HostUiPageEntry[] {
      database.transaction(
        (transaction) => {
          const existing = transaction
            .select()
            .from(hostUiPageEntries)
            .where(and(eq(hostUiPageEntries.ownerKind, 'extension'), eq(hostUiPageEntries.ownerId, input.extensionId)))
            .all()
          const byEntryId = new Map(existing.map((row) => [row.entryId, row] as const))
          const allRows = transaction.select().from(hostUiPageEntries).orderBy(asc(hostUiPageEntries.sortOrder)).all()
          let nextSortOrder = (allRows.at(-1)?.sortOrder ?? -1) + 1
          for (const page of input.pages) {
            const previous = byEntryId.get(page.entryId)
            transaction
              .insert(hostUiPageEntries)
              .values({
                pageInstanceId: previous?.pageInstanceId ?? input.nextPageInstanceId(),
                ownerKind: 'extension',
                ownerId: input.extensionId,
                artifactId: input.revisionId,
                entryId: page.entryId,
                title: page.title,
                description: page.description ?? null,
                icon: page.icon,
                objectPane: page.objectPane,
                startPath: page.startPath,
                visible: previous?.visible ?? true,
                sortOrder: previous?.sortOrder ?? nextSortOrder++,
                clientBuildKey: input.clientBuildKey,
                createdAt: previous?.createdAt ?? input.now,
                updatedAt: input.now,
              })
              .onConflictDoUpdate({
                target: [hostUiPageEntries.ownerKind, hostUiPageEntries.ownerId, hostUiPageEntries.entryId],
                set: {
                  artifactId: input.revisionId,
                  title: page.title,
                  description: page.description ?? null,
                  icon: page.icon,
                  objectPane: page.objectPane,
                  startPath: page.startPath,
                  clientBuildKey: input.clientBuildKey,
                  updatedAt: input.now,
                },
              })
              .run()
          }
          const retainedIds = input.pages.map(({ entryId }) => entryId)
          const deleteWhere =
            retainedIds.length === 0
              ? and(eq(hostUiPageEntries.ownerKind, 'extension'), eq(hostUiPageEntries.ownerId, input.extensionId))
              : and(
                  eq(hostUiPageEntries.ownerKind, 'extension'),
                  eq(hostUiPageEntries.ownerId, input.extensionId),
                  notInArray(hostUiPageEntries.entryId, retainedIds),
                )
          transaction.delete(hostUiPageEntries).where(deleteWhere).run()
          if (existing.length !== input.pages.length || input.pages.some((page) => !byEntryId.has(page.entryId))) {
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
      return this.listHostUiPageEntries().filter(
        (entry) => entry.owner.kind === 'extension' && entry.owner.extensionId === input.extensionId,
      )
    },
    deleteHostUiExtensionPages(extensionId): void {
      database.transaction(
        (transaction) => {
          const removed = transaction
            .delete(hostUiPageEntries)
            .where(and(eq(hostUiPageEntries.ownerKind, 'extension'), eq(hostUiPageEntries.ownerId, extensionId)))
            .run()
          if (removed.changes > 0) {
            const preference = transaction
              .select()
              .from(hostUiPagePreferences)
              .where(eq(hostUiPagePreferences.id, 1))
              .get()
            transaction
              .insert(hostUiPagePreferences)
              .values({ id: 1, revision: (preference?.revision ?? 0) + 1, updatedAt: Date.now() })
              .onConflictDoUpdate({
                target: hostUiPagePreferences.id,
                set: { revision: (preference?.revision ?? 0) + 1, updatedAt: Date.now() },
              })
              .run()
          }
        },
        { behavior: 'immediate' },
      )
    },
    replaceHostUiDshPages(input): readonly HostUiPageEntry[] {
      database.transaction(
        (transaction) => {
          const existing = transaction
            .select()
            .from(hostUiPageEntries)
            .where(and(eq(hostUiPageEntries.ownerKind, 'dsh-plugin'), eq(hostUiPageEntries.ownerId, input.entryId)))
            .all()
          const byEntryId = new Map(existing.map((row) => [row.entryId, row] as const))
          let nextSortOrder =
            (transaction.select().from(hostUiPageEntries).orderBy(asc(hostUiPageEntries.sortOrder)).all().at(-1)
              ?.sortOrder ?? -1) + 1
          for (const page of input.pages) {
            const previous = byEntryId.get(page.entryId)
            transaction
              .insert(hostUiPageEntries)
              .values({
                pageInstanceId: previous?.pageInstanceId ?? input.nextPageInstanceId(),
                ownerKind: 'dsh-plugin',
                ownerId: input.entryId,
                artifactId: input.artifactDigest,
                entryId: page.entryId,
                title: page.title,
                description: page.description ?? null,
                icon: page.icon,
                objectPane: page.objectPane,
                startPath: page.startPath,
                visible: previous?.visible ?? true,
                sortOrder: previous?.sortOrder ?? nextSortOrder++,
                clientBuildKey: input.clientBuildKey,
                createdAt: previous?.createdAt ?? input.now,
                updatedAt: input.now,
              })
              .onConflictDoUpdate({
                target: [hostUiPageEntries.ownerKind, hostUiPageEntries.ownerId, hostUiPageEntries.entryId],
                set: {
                  artifactId: input.artifactDigest,
                  title: page.title,
                  description: page.description ?? null,
                  icon: page.icon,
                  objectPane: page.objectPane,
                  startPath: page.startPath,
                  clientBuildKey: input.clientBuildKey,
                  updatedAt: input.now,
                },
              })
              .run()
          }
          const retainedIds = input.pages.map(({ entryId }) => entryId)
          transaction
            .delete(hostUiPageEntries)
            .where(
              retainedIds.length === 0
                ? and(eq(hostUiPageEntries.ownerKind, 'dsh-plugin'), eq(hostUiPageEntries.ownerId, input.entryId))
                : and(
                    eq(hostUiPageEntries.ownerKind, 'dsh-plugin'),
                    eq(hostUiPageEntries.ownerId, input.entryId),
                    notInArray(hostUiPageEntries.entryId, retainedIds),
                  ),
            )
            .run()
          if (existing.length !== input.pages.length || input.pages.some((page) => !byEntryId.has(page.entryId))) {
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
      return this.listHostUiPageEntries().filter(
        (entry) => entry.owner.kind === 'dsh-plugin' && entry.owner.entryId === input.entryId,
      )
    },
    deleteHostUiDshPages(entryId): void {
      database.transaction(
        (transaction) => {
          const removed = transaction
            .delete(hostUiPageEntries)
            .where(and(eq(hostUiPageEntries.ownerKind, 'dsh-plugin'), eq(hostUiPageEntries.ownerId, entryId)))
            .run()
          if (removed.changes === 0) return
          const preference = transaction
            .select()
            .from(hostUiPagePreferences)
            .where(eq(hostUiPagePreferences.id, 1))
            .get()
          transaction
            .insert(hostUiPagePreferences)
            .values({ id: 1, revision: (preference?.revision ?? 0) + 1, updatedAt: Date.now() })
            .onConflictDoUpdate({
              target: hostUiPagePreferences.id,
              set: { revision: (preference?.revision ?? 0) + 1, updatedAt: Date.now() },
            })
            .run()
        },
        { behavior: 'immediate' },
      )
    },
    getHostUiPreferencesRevision(): number {
      return database.select().from(hostUiPagePreferences).where(eq(hostUiPagePreferences.id, 1)).get()?.revision ?? 0
    },
    updateHostUiPagePreferences(input): number {
      return database.transaction(
        (transaction) => {
          const current = transaction.select().from(hostUiPagePreferences).where(eq(hostUiPagePreferences.id, 1)).get()
          if ((current?.revision ?? 0) !== input.expectedRevision) {
            throw new Error('页面入口偏好已被其他客户端更新。')
          }
          const currentRows = transaction
            .select()
            .from(hostUiPageEntries)
            .orderBy(asc(hostUiPageEntries.sortOrder))
            .all()
          const requestedIds = input.entries.map(({ pageInstanceId }) => pageInstanceId)
          if (
            new Set(requestedIds).size !== requestedIds.length ||
            currentRows.length !== requestedIds.length ||
            currentRows.some(({ pageInstanceId }) => !requestedIds.includes(pageInstanceId))
          ) {
            throw new Error('页面入口列表与 Host 当前状态不一致。')
          }
          input.entries.forEach((entry, index) => {
            transaction
              .update(hostUiPageEntries)
              .set({ sortOrder: 1_000_000 + index, visible: entry.visible, updatedAt: input.now })
              .where(eq(hostUiPageEntries.pageInstanceId, entry.pageInstanceId))
              .run()
          })
          input.entries.forEach((entry, index) => {
            transaction
              .update(hostUiPageEntries)
              .set({ sortOrder: index })
              .where(eq(hostUiPageEntries.pageInstanceId, entry.pageInstanceId))
              .run()
          })
          const revision = input.expectedRevision + 1
          transaction
            .insert(hostUiPagePreferences)
            .values({ id: 1, revision, updatedAt: input.now })
            .onConflictDoUpdate({
              target: hostUiPagePreferences.id,
              set: { revision, updatedAt: input.now },
            })
            .run()
          return revision
        },
        { behavior: 'immediate' },
      )
    },
    getHostUiPermissionGrant(ownerKey): HostUiPermissionGrant | undefined {
      const row = database
        .select()
        .from(hostUiPermissionGrants)
        .where(eq(hostUiPermissionGrants.ownerKey, ownerKey))
        .get()
      if (!row) return undefined
      return HostUiPermissionGrantRowSchema.parse(row)
    },
    upsertHostUiPermissionGrant(grant): void {
      database
        .insert(hostUiPermissionGrants)
        .values(grant)
        .onConflictDoUpdate({
          target: hostUiPermissionGrants.ownerKey,
          set: {
            artifactDigest: grant.artifactDigest,
            permissionDigest: grant.permissionDigest,
            declaration: grant.declaration,
            approvedAt: grant.approvedAt,
          },
        })
        .run()
    },
    deleteHostUiPermissionGrant(ownerKey): void {
      database.delete(hostUiPermissionGrants).where(eq(hostUiPermissionGrants.ownerKey, ownerKey)).run()
    },
    getHostUiDiagnostic(pageInstanceId): HostUiDiagnostic | undefined {
      const row = database
        .select()
        .from(hostUiDiagnostics)
        .where(eq(hostUiDiagnostics.pageInstanceId, pageInstanceId))
        .get()
      return row === undefined ? undefined : toHostUiDiagnostic(row)
    },
    upsertHostUiDiagnostic(diagnostic): void {
      database
        .insert(hostUiDiagnostics)
        .values({ ...diagnostic, message: diagnostic.message ?? null })
        .onConflictDoUpdate({
          target: hostUiDiagnostics.pageInstanceId,
          set: {
            status: diagnostic.status,
            message: diagnostic.message ?? null,
            observedAt: diagnostic.observedAt,
          },
        })
        .run()
    },
    deleteHostUiDiagnosticsForExtension(extensionId): void {
      const pages = database
        .select({ pageInstanceId: hostUiPageEntries.pageInstanceId })
        .from(hostUiPageEntries)
        .where(and(eq(hostUiPageEntries.ownerKind, 'extension'), eq(hostUiPageEntries.ownerId, extensionId)))
        .all()
      for (const page of pages) {
        database.delete(hostUiDiagnostics).where(eq(hostUiDiagnostics.pageInstanceId, page.pageInstanceId)).run()
      }
    },
  }
}
