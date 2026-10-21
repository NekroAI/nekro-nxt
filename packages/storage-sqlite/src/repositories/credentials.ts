import { and, desc, eq, lt, notInArray, sql } from 'drizzle-orm'
import {
  AgentIdSchema,
  ChannelIdSchema,
  CredentialAgentScopeSchema,
  CredentialIdSchema,
  type AgentId,
  type ChannelId,
  type CredentialAgentScope,
  type CredentialId,
  type CredentialUsage,
} from '@nekro-nxt/contracts'
import { z } from 'zod'
import type { DrizzleCoreDatabase } from '../database.js'
import { credentials, credentialUses } from '../schema.js'

export interface CredentialRecord {
  readonly id: CredentialId
  readonly name: string
  readonly description: string
  readonly usage: CredentialUsage
  readonly domains: readonly string[]
  readonly agentScope: CredentialAgentScope
  readonly autoUse: boolean
  /** Program credentials only: the environment variable commands receive it under. */
  readonly envName?: string
  /** Agents an administrator let use it while automatic use is off. */
  readonly approvedAgentIds: readonly AgentId[]
  readonly credentialRef: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly lastUsedAt?: number
}

export type CredentialConsumerKind = 'extension' | 'command' | 'mcp' | 'model'

export interface CredentialUseRecord {
  readonly credentialId: CredentialId
  readonly at: number
  readonly agentId?: AgentId
  readonly channelId?: ChannelId
  readonly requesterMemberId?: string
  readonly consumerKind: CredentialConsumerKind
  readonly consumerId: string
  readonly targetHost?: string
}

/** Uses kept per credential: the newest {@link CREDENTIAL_USES_KEEP}, none older than {@link CREDENTIAL_USES_MAX_AGE_MS}. */
export const CREDENTIAL_USES_KEEP = 500
export const CREDENTIAL_USES_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000

type Row = typeof credentials.$inferSelect
type UseRow = typeof credentialUses.$inferSelect

const DomainsSchema = z.array(z.string())

const record = (row: Row): CredentialRecord => ({
  id: CredentialIdSchema.parse(row.id),
  name: row.name,
  description: row.description,
  usage: row.usage,
  domains: DomainsSchema.parse(row.domains),
  agentScope: CredentialAgentScopeSchema.parse(row.agentScope),
  autoUse: row.autoUse,
  ...(row.envName === null ? {} : { envName: row.envName }),
  approvedAgentIds: z.array(AgentIdSchema).parse(row.approvedAgentIds),
  credentialRef: row.credentialRef,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  ...(row.lastUsedAt === null ? {} : { lastUsedAt: row.lastUsedAt }),
})

const useRecord = (row: UseRow): CredentialUseRecord => ({
  credentialId: CredentialIdSchema.parse(row.credentialId),
  at: row.at,
  ...(row.agentId === null ? {} : { agentId: AgentIdSchema.parse(row.agentId) }),
  ...(row.channelId === null ? {} : { channelId: ChannelIdSchema.parse(row.channelId) }),
  ...(row.requesterMemberId === null ? {} : { requesterMemberId: row.requesterMemberId }),
  consumerKind: row.consumerKind,
  consumerId: row.consumerId,
  ...(row.targetHost === null ? {} : { targetHost: row.targetHost }),
})

const values = (input: CredentialRecord) => ({
  id: input.id,
  name: input.name,
  description: input.description,
  kind: 'generic' as const,
  usage: input.usage,
  domains: input.domains,
  agentScope: input.agentScope,
  autoUse: input.autoUse,
  envName: input.envName ?? null,
  approvedAgentIds: input.approvedAgentIds,
  credentialRef: input.credentialRef,
  metadata: {},
  createdAt: input.createdAt,
  updatedAt: input.updatedAt,
  lastUsedAt: input.lastUsedAt ?? null,
})

/** Rows of older builds' GitHub credentials wait to become linked accounts and are not credentials any more. */
const generic = eq(credentials.kind, 'generic')

export function createCredentialsRepository(database: DrizzleCoreDatabase) {
  return {
    listCredentials(): readonly CredentialRecord[] {
      return database
        .select()
        .from(credentials)
        .where(generic)
        .orderBy(credentials.createdAt, credentials.id)
        .all()
        .map(record)
    },

    getCredential(id: CredentialId): CredentialRecord | undefined {
      const row = database
        .select()
        .from(credentials)
        .where(and(eq(credentials.id, id), generic))
        .get()
      return row === undefined ? undefined : record(row)
    },

    insertCredential(input: CredentialRecord): void {
      database.insert(credentials).values(values(input)).run()
    },

    /** Replaces every column but `id` and `createdAt`; false when the credential is gone. */
    updateCredential(input: CredentialRecord): boolean {
      const { id: _id, createdAt: _createdAt, ...rest } = values(input)
      void _id
      void _createdAt
      return (
        database
          .update(credentials)
          .set(rest)
          .where(and(eq(credentials.id, input.id), generic))
          .run().changes === 1
      )
    },

    /** Removes the credential with its recorded uses. */
    deleteCredential(id: CredentialId): boolean {
      return (
        database
          .delete(credentials)
          .where(and(eq(credentials.id, id), generic))
          .run().changes === 1
      )
    },

    /**
     * Records one use and moves `last_used_at`, then trims the credential's history to the newest
     * {@link CREDENTIAL_USES_KEEP} uses within {@link CREDENTIAL_USES_MAX_AGE_MS}.
     */
    recordCredentialUse(input: CredentialUseRecord): void {
      database.transaction((transaction) => {
        transaction
          .insert(credentialUses)
          .values({
            credentialId: input.credentialId,
            at: input.at,
            agentId: input.agentId ?? null,
            channelId: input.channelId ?? null,
            requesterMemberId: input.requesterMemberId ?? null,
            consumerKind: input.consumerKind,
            consumerId: input.consumerId,
            targetHost: input.targetHost ?? null,
          })
          .run()
        transaction
          .update(credentials)
          .set({ lastUsedAt: sql`max(coalesce(${credentials.lastUsedAt}, 0), ${input.at})` })
          .where(eq(credentials.id, input.credentialId))
          .run()
        transaction
          .delete(credentialUses)
          .where(
            and(
              eq(credentialUses.credentialId, input.credentialId),
              lt(credentialUses.at, input.at - CREDENTIAL_USES_MAX_AGE_MS),
            ),
          )
          .run()
        const kept = transaction
          .select({ id: credentialUses.id })
          .from(credentialUses)
          .where(eq(credentialUses.credentialId, input.credentialId))
          .orderBy(desc(credentialUses.at), desc(credentialUses.id))
          .limit(CREDENTIAL_USES_KEEP)
          .all()
          .map((row) => row.id)
        transaction
          .delete(credentialUses)
          .where(and(eq(credentialUses.credentialId, input.credentialId), notInArray(credentialUses.id, kept)))
          .run()
      })
    },

    /** Newest first. */
    listCredentialUses(id: CredentialId, limit: number): readonly CredentialUseRecord[] {
      return database
        .select()
        .from(credentialUses)
        .where(eq(credentialUses.credentialId, id))
        .orderBy(desc(credentialUses.at), desc(credentialUses.id))
        .limit(limit)
        .all()
        .map(useRecord)
    },
  }
}

export type CredentialsRepository = ReturnType<typeof createCredentialsRepository>
