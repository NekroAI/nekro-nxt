import { and, desc, eq, lt, notInArray, sql } from 'drizzle-orm'
import {
  AgentIdSchema,
  ChannelIdSchema,
  LinkedAccountIdSchema,
  type AgentId,
  type ChannelId,
  type CredentialId,
  type JsonValue,
  type LinkedAccountId,
} from '@nekro-nxt/contracts'
import { z } from 'zod'
import type { DrizzleCoreDatabase } from '../database.js'
import { credentials, credentialUses, linkedAccounts, linkedAccountUses, systemSettings } from '../schema.js'
import { CREDENTIAL_USES_KEEP, CREDENTIAL_USES_MAX_AGE_MS } from './credentials.js'

export interface LinkedAccountRecord {
  readonly id: LinkedAccountId
  /** A platform id of the host's registry, such as `github`. */
  readonly platform: string
  readonly login: string
  readonly displayName?: string
  /** Token scopes where the platform reports them. */
  readonly scopes?: readonly string[]
  /** How the token was given: `token`, or a platform method such as `gh-login`. */
  readonly source: string
  readonly credentialRef: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly lastUsedAt?: number
}

export interface LinkedAccountUseRecord {
  readonly accountId: LinkedAccountId
  readonly at: number
  readonly agentId?: AgentId
  readonly channelId?: ChannelId
  readonly consumerKind: 'command'
  readonly consumerId: string
}

/** A GitHub credential an older build kept in the credential library, waiting to become a linked account. */
export interface LegacyGithubCredentialRecord {
  readonly id: CredentialId
  readonly credentialRef: string
  readonly login?: string
  readonly scopes?: readonly string[]
  readonly source?: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly lastUsedAt?: number
}

/** One-time move of accounts kept elsewhere by older builds; see {@link LinkedAccountsRepository.importAccounts}. */
export interface LinkedAccountImport {
  readonly accounts: readonly LinkedAccountRecord[]
  /** GitHub credentials whose rows (and command uses) become the account of the same suffix. */
  readonly fromCredentials?: readonly { readonly credentialId: CredentialId; readonly accountId: LinkedAccountId }[]
  /** A system setting written in the same transaction, marking the import as done. */
  readonly marker?: { readonly key: string; readonly value: JsonValue; readonly updatedAt: number }
}

type Row = typeof linkedAccounts.$inferSelect
type UseRow = typeof linkedAccountUses.$inferSelect

const ScopesSchema = z.array(z.string())
const LegacyMetadataSchema = z
  .object({ login: z.string().optional(), scopes: z.array(z.string()).optional(), source: z.string().optional() })
  .passthrough()

const record = (row: Row): LinkedAccountRecord => ({
  id: LinkedAccountIdSchema.parse(row.id),
  platform: row.platform,
  login: row.login,
  ...(row.displayName === null ? {} : { displayName: row.displayName }),
  ...(row.scopes === null ? {} : { scopes: ScopesSchema.parse(row.scopes) }),
  source: row.source,
  credentialRef: row.credentialRef,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  ...(row.lastUsedAt === null ? {} : { lastUsedAt: row.lastUsedAt }),
})

const useRecord = (row: UseRow): LinkedAccountUseRecord => ({
  accountId: LinkedAccountIdSchema.parse(row.accountId),
  at: row.at,
  ...(row.agentId === null ? {} : { agentId: AgentIdSchema.parse(row.agentId) }),
  ...(row.channelId === null ? {} : { channelId: ChannelIdSchema.parse(row.channelId) }),
  consumerKind: row.consumerKind,
  consumerId: row.consumerId,
})

const values = (input: LinkedAccountRecord) => ({
  id: input.id,
  platform: input.platform,
  login: input.login,
  displayName: input.displayName ?? null,
  scopes: input.scopes ?? null,
  source: input.source,
  credentialRef: input.credentialRef,
  createdAt: input.createdAt,
  updatedAt: input.updatedAt,
  lastUsedAt: input.lastUsedAt ?? null,
})

export function createLinkedAccountsRepository(database: DrizzleCoreDatabase) {
  return {
    listAccounts(): readonly LinkedAccountRecord[] {
      return database
        .select()
        .from(linkedAccounts)
        .orderBy(linkedAccounts.createdAt, linkedAccounts.id)
        .all()
        .map(record)
    },

    getAccount(id: LinkedAccountId): LinkedAccountRecord | undefined {
      const row = database.select().from(linkedAccounts).where(eq(linkedAccounts.id, id)).get()
      return row === undefined ? undefined : record(row)
    },

    insertAccount(input: LinkedAccountRecord): void {
      database.insert(linkedAccounts).values(values(input)).run()
    },

    /** Replaces every column but `id`, `platform` and `createdAt`; false when the account is gone. */
    updateAccount(input: LinkedAccountRecord): boolean {
      const { id: _id, platform: _platform, createdAt: _createdAt, ...rest } = values(input)
      void _id
      void _platform
      void _createdAt
      return database.update(linkedAccounts).set(rest).where(eq(linkedAccounts.id, input.id)).run().changes === 1
    },

    /** Removes the account with its recorded uses. */
    deleteAccount(id: LinkedAccountId): boolean {
      return database.delete(linkedAccounts).where(eq(linkedAccounts.id, id)).run().changes === 1
    },

    /** GitHub rows older builds kept in the credential library. */
    listLegacyGithubCredentials(): readonly LegacyGithubCredentialRecord[] {
      return database
        .select()
        .from(credentials)
        .where(eq(credentials.kind, 'github'))
        .orderBy(credentials.createdAt, credentials.id)
        .all()
        .map((row) => {
          const metadata = LegacyMetadataSchema.safeParse(row.metadata)
          const facts = metadata.success ? metadata.data : {}
          return {
            id: row.id,
            credentialRef: row.credentialRef,
            ...(facts.login === undefined ? {} : { login: facts.login }),
            ...(facts.scopes === undefined ? {} : { scopes: facts.scopes }),
            ...(facts.source === undefined ? {} : { source: facts.source }),
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            ...(row.lastUsedAt === null ? {} : { lastUsedAt: row.lastUsedAt }),
          }
        })
    },

    /**
     * Inserts accounts that do not exist yet, moves the command uses of the GitHub credentials they came from and
     * deletes those credential rows (the stored tokens stay: the accounts keep their references), and writes the
     * marker setting, all in one transaction.
     */
    importAccounts(input: LinkedAccountImport): void {
      database.transaction((transaction) => {
        for (const account of input.accounts) {
          transaction
            .insert(linkedAccounts)
            .values(values(account))
            .onConflictDoNothing({ target: linkedAccounts.id })
            .run()
        }
        for (const move of input.fromCredentials ?? []) {
          const uses = transaction
            .select()
            .from(credentialUses)
            .where(and(eq(credentialUses.credentialId, move.credentialId), eq(credentialUses.consumerKind, 'command')))
            .all()
          for (const use of uses) {
            transaction
              .insert(linkedAccountUses)
              .values({
                accountId: move.accountId,
                at: use.at,
                agentId: use.agentId,
                channelId: use.channelId,
                consumerKind: 'command',
                consumerId: use.consumerId,
              })
              .run()
          }
          transaction
            .delete(credentials)
            .where(and(eq(credentials.id, move.credentialId), eq(credentials.kind, 'github')))
            .run()
        }
        const marker = input.marker
        if (marker !== undefined) {
          const current = transaction.select().from(systemSettings).where(eq(systemSettings.key, marker.key)).get()
          const revision = (current?.revision ?? 0) + 1
          transaction
            .insert(systemSettings)
            .values({ key: marker.key, value: marker.value, revision, updatedAt: marker.updatedAt })
            .onConflictDoUpdate({
              target: systemSettings.key,
              set: { value: marker.value, revision, updatedAt: marker.updatedAt },
            })
            .run()
        }
      })
    },

    /**
     * Records one use and moves `last_used_at`, then trims the account's history like credential uses: the newest
     * {@link CREDENTIAL_USES_KEEP} within {@link CREDENTIAL_USES_MAX_AGE_MS}.
     */
    recordAccountUse(input: LinkedAccountUseRecord): void {
      database.transaction((transaction) => {
        transaction
          .insert(linkedAccountUses)
          .values({
            accountId: input.accountId,
            at: input.at,
            agentId: input.agentId ?? null,
            channelId: input.channelId ?? null,
            consumerKind: input.consumerKind,
            consumerId: input.consumerId,
          })
          .run()
        transaction
          .update(linkedAccounts)
          .set({ lastUsedAt: sql`max(coalesce(${linkedAccounts.lastUsedAt}, 0), ${input.at})` })
          .where(eq(linkedAccounts.id, input.accountId))
          .run()
        transaction
          .delete(linkedAccountUses)
          .where(
            and(
              eq(linkedAccountUses.accountId, input.accountId),
              lt(linkedAccountUses.at, input.at - CREDENTIAL_USES_MAX_AGE_MS),
            ),
          )
          .run()
        const kept = transaction
          .select({ id: linkedAccountUses.id })
          .from(linkedAccountUses)
          .where(eq(linkedAccountUses.accountId, input.accountId))
          .orderBy(desc(linkedAccountUses.at), desc(linkedAccountUses.id))
          .limit(CREDENTIAL_USES_KEEP)
          .all()
          .map((row) => row.id)
        transaction
          .delete(linkedAccountUses)
          .where(and(eq(linkedAccountUses.accountId, input.accountId), notInArray(linkedAccountUses.id, kept)))
          .run()
      })
    },

    /** Newest first. */
    listAccountUses(id: LinkedAccountId, limit: number): readonly LinkedAccountUseRecord[] {
      return database
        .select()
        .from(linkedAccountUses)
        .where(eq(linkedAccountUses.accountId, id))
        .orderBy(desc(linkedAccountUses.at), desc(linkedAccountUses.id))
        .limit(limit)
        .all()
        .map(useRecord)
    },
  }
}

export type LinkedAccountsRepository = ReturnType<typeof createLinkedAccountsRepository>
