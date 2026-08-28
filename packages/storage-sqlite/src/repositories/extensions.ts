import { and, asc, eq } from 'drizzle-orm'
import {
  ExtensionRevisionIdSchema,
  type AgentId,
  type ExtensionId,
  type ExtensionRevisionId,
} from '@nekro-nxt/contracts'
import type {
  Activation,
  ExtensionRepository,
  ExtensionClientDiagnostic,
  ExtensionRevisionVerification,
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
  localExtensions,
} from '../schema.js'
import {
  AgentActivationRowSchema,
  ExtensionRevisionRowSchema,
  HostExtensionInstallationRowSchema,
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

const ExtensionRevisionVerificationSchema = z.object({
  revisionId: ExtensionRevisionIdSchema,
  dshVersion: z.string().trim().min(1),
  contractVersion: z.enum(['nekro-nxt-extension-v1', 'nekro-nxt-extension-v2']),
  scope: z.literal('host-adapter').optional(),
  origin: z.object({ episodeId: z.string(), pluginId: z.string(), packageId: z.string(), pluginRunId: z.string() }),
  verifiedAt: z.number().int().nonnegative(),
  hostBuild: z.object({ built: z.boolean(), buildKey: z.string() }),
  clientBuild: z.object({ built: z.boolean(), buildKey: z.string() }),
  toolInvocations: z.array(z.object({ name: z.string(), succeeded: z.boolean() })),
  rpcMethods: z.array(z.string()),
  renderedSlots: z.array(z.enum(['agent.workbench.sections', 'extension.details.panels'])),
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
          name: z.literal('conversation.message.rich'),
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
    ...(parsed.adapter === undefined ? {} : { adapter: parsed.adapter }),
    ...(parsed.renderedHostSlots === undefined ? {} : { renderedHostSlots: parsed.renderedHostSlots }),
  }
}

export function createExtensionsRepository(database: DrizzleCoreDatabase): ExtensionRepository {
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
  }
}
