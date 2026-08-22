import { and, asc, eq, isNull, max } from 'drizzle-orm'
import type {
  AgentDefinitionRecord,
  AgentRevisionRecord,
  CoreRepository,
  CreateAgentCommit,
  CreateAgentWithChannelCommit,
} from '@nekro-nxt/core'
import { parseAgentCapabilityGrants, parseImageUnderstandingPolicy } from '@nekro-nxt/core'
import { normalizePromptDocument, promptDocumentFromText } from '@nekro-nxt/contracts'
import type { AgentId, AgentRevisionId } from '@nekro-nxt/contracts'
import type { DrizzleCoreDatabase } from '../database.js'
import {
  agentCurrentRevisions,
  agentDefinitions,
  agentRevisions,
  channelBindings,
  channels,
  workTreeOrder,
} from '../schema.js'
import { AgentDefinitionRowSchema, AgentRevisionRowSchema } from '../row-schemas.js'

type AgentRepository = Pick<
  CoreRepository,
  | 'createAgent'
  | 'createAgentWithChannel'
  | 'tombstoneAgent'
  | 'getAgent'
  | 'listAgents'
  | 'getAgentRevision'
  | 'getAgentRevisionByDigest'
  | 'listAgentRevisions'
  | 'getNextAgentRevisionNumber'
  | 'appendAgentRevision'
  | 'activateAgentRevision'
>

const toRevision = (input: typeof agentRevisions.$inferSelect): AgentRevisionRecord => {
  const row = AgentRevisionRowSchema.parse(input)
  return {
    id: row.id,
    agentId: row.agentId,
    revision: row.revision,
    displayName: row.displayName,
    persona: row.persona,
    personaDocument: normalizePromptDocument(row.personaDocument ?? promptDocumentFromText(row.persona)),
    model: {
      provider: row.modelProvider,
      model: row.modelId,
      ...(row.reasoningEffort === null ? {} : { reasoningEffort: row.reasoningEffort }),
    },
    capabilities: parseAgentCapabilityGrants(row.capabilities),
    imagePolicy: parseImageUnderstandingPolicy(row.imagePolicy),
    contentDigest: row.contentDigest,
    createdAt: row.createdAt,
  }
}

const toAgentCommit = (input: {
  readonly definition: typeof agentDefinitions.$inferSelect
  readonly revision: typeof agentRevisions.$inferSelect
}): CreateAgentCommit => {
  const definition = AgentDefinitionRowSchema.parse(input.definition)
  return {
    definition: {
      id: definition.id,
      currentRevisionId: input.revision.id,
      createdAt: definition.createdAt,
    },
    revision: toRevision(input.revision),
  }
}

const revisionInsert = (record: AgentRevisionRecord): typeof agentRevisions.$inferInsert => ({
  id: record.id,
  agentId: record.agentId,
  revision: record.revision,
  displayName: record.displayName,
  persona: record.persona,
  personaDocument: record.personaDocument,
  modelProvider: record.model.provider,
  modelId: record.model.model,
  ...(record.model.reasoningEffort === undefined ? {} : { reasoningEffort: record.model.reasoningEffort }),
  capabilities: record.capabilities,
  imagePolicy: record.imagePolicy,
  contentDigest: record.contentDigest,
  createdAt: record.createdAt,
})

export function createAgentsRepository(database: DrizzleCoreDatabase): AgentRepository {
  const getAgentRevision = (id: AgentRevisionId): AgentRevisionRecord | undefined => {
    const row = database.select().from(agentRevisions).where(eq(agentRevisions.id, id)).get()
    return row === undefined ? undefined : toRevision(row)
  }

  return {
    createAgent(commit: CreateAgentCommit): void {
      database.transaction(
        (tx) => {
          tx.insert(agentDefinitions).values({ id: commit.definition.id, createdAt: commit.definition.createdAt }).run()
          tx.insert(agentRevisions).values(revisionInsert(commit.revision)).run()
          tx.insert(agentCurrentRevisions)
            .values({ agentId: commit.definition.id, revisionId: commit.revision.id })
            .run()
        },
        { behavior: 'immediate' },
      )
    },

    createAgentWithChannel(commit: CreateAgentWithChannelCommit): void {
      database.transaction(
        (tx) => {
          tx.insert(agentDefinitions).values({ id: commit.definition.id, createdAt: commit.definition.createdAt }).run()
          tx.insert(agentRevisions).values(revisionInsert(commit.revision)).run()
          tx.insert(agentCurrentRevisions)
            .values({ agentId: commit.definition.id, revisionId: commit.revision.id })
            .run()
          tx.insert(channels).values(commit.channel).run()
          tx.insert(channelBindings).values(commit.binding).run()
        },
        { behavior: 'immediate' },
      )
    },

    tombstoneAgent(id, deletedAt): void {
      if (!Number.isSafeInteger(deletedAt) || deletedAt < 0)
        throw new TypeError('Agent delete time must be non-negative.')
      database.transaction(
        (tx) => {
          const boundChannelIds = tx
            .select({ channelId: channelBindings.channelId })
            .from(channelBindings)
            .where(eq(channelBindings.agentId, id))
            .all()
            .map(({ channelId }) => channelId)
          tx.delete(channelBindings).where(eq(channelBindings.agentId, id)).run()
          const changed = tx
            .update(agentDefinitions)
            .set({ deletedAt })
            .where(and(eq(agentDefinitions.id, id), isNull(agentDefinitions.deletedAt)))
            .run().changes
          if (changed !== 1) throw new Error(`Unknown or deleted agent: ${id}`)
          const order = tx.select().from(workTreeOrder).where(eq(workTreeOrder.id, 1)).get()
          if (order) {
            const channelIdsByAgent = { ...order.channelIdsByAgent }
            delete channelIdsByAgent[id]
            tx.update(workTreeOrder)
              .set({
                agentIds: order.agentIds.filter((agentId) => agentId !== id),
                channelIdsByAgent,
                unboundChannelIds: [...new Set([...order.unboundChannelIds, ...boundChannelIds])],
              })
              .where(eq(workTreeOrder.id, 1))
              .run()
          }
        },
        { behavior: 'immediate' },
      )
    },

    getAgent(id: AgentId): CreateAgentCommit | undefined {
      const row = database
        .select({ definition: agentDefinitions, revision: agentRevisions })
        .from(agentDefinitions)
        .innerJoin(agentCurrentRevisions, eq(agentCurrentRevisions.agentId, agentDefinitions.id))
        .innerJoin(agentRevisions, eq(agentRevisions.id, agentCurrentRevisions.revisionId))
        .where(and(eq(agentDefinitions.id, id), isNull(agentDefinitions.deletedAt)))
        .get()
      return row === undefined ? undefined : toAgentCommit(row)
    },

    listAgents(): readonly CreateAgentCommit[] {
      return database
        .select({ definition: agentDefinitions, revision: agentRevisions })
        .from(agentDefinitions)
        .innerJoin(agentCurrentRevisions, eq(agentCurrentRevisions.agentId, agentDefinitions.id))
        .innerJoin(agentRevisions, eq(agentRevisions.id, agentCurrentRevisions.revisionId))
        .where(isNull(agentDefinitions.deletedAt))
        .orderBy(asc(agentDefinitions.createdAt), asc(agentDefinitions.id))
        .all()
        .map(toAgentCommit)
    },

    getAgentRevision,

    getAgentRevisionByDigest(agentId: AgentId, contentDigest: string): AgentRevisionRecord | undefined {
      const row = database
        .select()
        .from(agentRevisions)
        .where(and(eq(agentRevisions.agentId, agentId), eq(agentRevisions.contentDigest, contentDigest)))
        .get()
      return row === undefined ? undefined : toRevision(row)
    },

    listAgentRevisions(agentId: AgentId): readonly AgentRevisionRecord[] {
      return database
        .select()
        .from(agentRevisions)
        .where(eq(agentRevisions.agentId, agentId))
        .orderBy(asc(agentRevisions.revision), asc(agentRevisions.id))
        .all()
        .map(toRevision)
    },

    getNextAgentRevisionNumber(agentId: AgentId): number {
      const row = database
        .select({ current: max(agentRevisions.revision) })
        .from(agentRevisions)
        .where(eq(agentRevisions.agentId, agentId))
        .get()
      return (row?.current ?? 0) + 1
    },

    appendAgentRevision(
      definition: AgentDefinitionRecord,
      revision: AgentRevisionRecord,
      expectedCurrentRevisionId: AgentRevisionId,
    ): void {
      database.transaction(
        (tx) => {
          tx.insert(agentRevisions).values(revisionInsert(revision)).run()
          const changed = tx
            .update(agentCurrentRevisions)
            .set({ revisionId: definition.currentRevisionId })
            .where(
              and(
                eq(agentCurrentRevisions.agentId, definition.id),
                eq(agentCurrentRevisions.revisionId, expectedCurrentRevisionId),
              ),
            )
            .run().changes
          if (changed !== 1) throw new Error('Agent revision conflict.')
        },
        { behavior: 'immediate' },
      )
    },

    activateAgentRevision(
      definition: AgentDefinitionRecord,
      revision: AgentRevisionRecord,
      expectedCurrentRevisionId: AgentRevisionId,
    ): void {
      if (revision.agentId !== definition.id) throw new Error('Agent Revision does not belong to Agent.')
      const changed = database
        .update(agentCurrentRevisions)
        .set({ revisionId: revision.id })
        .where(
          and(
            eq(agentCurrentRevisions.agentId, definition.id),
            eq(agentCurrentRevisions.revisionId, expectedCurrentRevisionId),
          ),
        )
        .run().changes
      if (changed !== 1) throw new Error('Agent revision conflict.')
    },
  }
}
