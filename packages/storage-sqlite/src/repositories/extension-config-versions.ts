import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { AgentIdSchema, ExtensionIdSchema, type AgentId, type ExtensionId, type JsonValue } from '@nekro-nxt/contracts'
import type { DrizzleCoreDatabase } from '../database.js'
import { extensionConfigVersions } from '../schema.js'

/** Where a version came from: the console, an agent, a chat administrator, or a revert (requested or automatic). */
export type ExtensionConfigVersionSource = (typeof extensionConfigVersions.$inferSelect)['source']

export interface ExtensionConfigVersionRecord {
  readonly id: number
  readonly extensionId: ExtensionId
  readonly layer: 'host' | 'agent'
  readonly agentId: AgentId | null
  readonly version: number
  /** The stored configuration; secret fields hold credential references, never values. */
  readonly config: JsonValue
  readonly source: ExtensionConfigVersionSource
  readonly actorAgentId: AgentId | null
  readonly requesterMemberId: string | null
  readonly reason: string | null
  readonly createdAt: number
}

export interface ExtensionConfigOwner {
  readonly extensionId: ExtensionId
  readonly layer: 'host' | 'agent'
  /** Required for the agent layer, absent for the host layer. */
  readonly agentId?: AgentId | undefined
}

type Row = typeof extensionConfigVersions.$inferSelect

const record = (row: Row): ExtensionConfigVersionRecord => ({
  id: row.id,
  extensionId: ExtensionIdSchema.parse(row.extensionId),
  layer: row.layer,
  agentId: row.agentId === null ? null : AgentIdSchema.parse(row.agentId),
  version: row.version,
  config: row.config,
  source: row.source,
  actorAgentId: row.actorAgentId === null ? null : AgentIdSchema.parse(row.actorAgentId),
  requesterMemberId: row.requesterMemberId,
  reason: row.reason,
  createdAt: row.createdAt,
})

const ownerFilter = (owner: ExtensionConfigOwner) =>
  and(
    eq(extensionConfigVersions.extensionId, owner.extensionId),
    eq(extensionConfigVersions.layer, owner.layer),
    owner.layer === 'agent' && owner.agentId !== undefined
      ? eq(extensionConfigVersions.agentId, owner.agentId)
      : isNull(extensionConfigVersions.agentId),
  )

/** Configuration history: every write of an extension's host configuration or of one agent's configuration. */
export function createExtensionConfigVersionsRepository(database: DrizzleCoreDatabase) {
  return {
    /** Appends the next version for this owner; numbering is monotonic per extension, layer and agent. */
    recordExtensionConfigVersion(
      input: ExtensionConfigOwner & {
        readonly config: JsonValue
        readonly source: ExtensionConfigVersionSource
        readonly actorAgentId?: AgentId | undefined
        readonly requesterMemberId?: string | undefined
        readonly reason?: string | undefined
        readonly createdAt: number
      },
    ): ExtensionConfigVersionRecord {
      if (input.layer === 'agent' && input.agentId === undefined) throw new TypeError('Agent config needs an agent.')
      return database.transaction((tx) => {
        const latest = tx
          .select({ version: sql<number | null>`max(${extensionConfigVersions.version})` })
          .from(extensionConfigVersions)
          .where(ownerFilter(input))
          .get()
        const row = tx
          .insert(extensionConfigVersions)
          .values({
            extensionId: input.extensionId,
            layer: input.layer,
            agentId: input.layer === 'agent' ? (input.agentId ?? null) : null,
            version: (latest?.version ?? 0) + 1,
            config: input.config,
            source: input.source,
            actorAgentId: input.actorAgentId ?? null,
            requesterMemberId: input.requesterMemberId ?? null,
            reason: input.reason ?? null,
            createdAt: input.createdAt,
          })
          .returning()
          .get()
        return record(row)
      })
    },

    /** Versions of one extension, newest first; narrowed to one owner when given. */
    listExtensionConfigVersions(
      extensionId: ExtensionId,
      options: { readonly owner?: Omit<ExtensionConfigOwner, 'extensionId'>; readonly limit?: number } = {},
    ): readonly ExtensionConfigVersionRecord[] {
      return database
        .select()
        .from(extensionConfigVersions)
        .where(
          options.owner === undefined
            ? eq(extensionConfigVersions.extensionId, extensionId)
            : ownerFilter({ extensionId, ...options.owner }),
        )
        .orderBy(desc(extensionConfigVersions.id))
        .limit(options.limit ?? 200)
        .all()
        .map(record)
    },

    getExtensionConfigVersion(id: number): ExtensionConfigVersionRecord | undefined {
      const row = database.select().from(extensionConfigVersions).where(eq(extensionConfigVersions.id, id)).get()
      return row === undefined ? undefined : record(row)
    },

    latestExtensionConfigVersion(owner: ExtensionConfigOwner): ExtensionConfigVersionRecord | undefined {
      const row = database
        .select()
        .from(extensionConfigVersions)
        .where(ownerFilter(owner))
        .orderBy(desc(extensionConfigVersions.version))
        .limit(1)
        .get()
      return row === undefined ? undefined : record(row)
    },
  }
}

export type ExtensionConfigVersionsRepository = ReturnType<typeof createExtensionConfigVersionsRepository>
