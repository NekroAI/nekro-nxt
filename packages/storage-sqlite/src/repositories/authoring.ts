import type { AgentId, AuthoringAttemptId, AuthoringTaskId, EpisodeId } from '@nekro-nxt/contracts'
import type {
  AuthoringRepository,
  DynamicAuthoringAttempt,
  DynamicAuthoringEvent,
  DynamicAuthoringTask,
} from '@nekro-nxt/extension-runtime'
import { and, asc, desc, eq, notInArray } from 'drizzle-orm'
import type { DrizzleCoreDatabase } from '../database.js'
import { dynamicAuthoringAttempts, dynamicAuthoringEvents, dynamicAuthoringTasks } from '../schema.js'
import {
  DynamicAuthoringAttemptRowSchema,
  DynamicAuthoringEventRowSchema,
  DynamicAuthoringTaskRowSchema,
} from '../row-schemas.js'

const toTask = (input: typeof dynamicAuthoringTasks.$inferSelect): DynamicAuthoringTask => {
  const row = DynamicAuthoringTaskRowSchema.parse(input)
  return {
    id: row.id,
    agentId: row.agentId,
    channelId: row.channelId,
    episodeId: row.episodeId,
    initiatingEventId: row.initiatingEventId,
    pluginKey: row.pluginKey,
    title: row.title,
    requirementSummary: row.requirementSummary,
    status: row.status,
    approvalPolicy: row.approvalPolicy,
    ...(row.approvedRiskDigest === null ? {} : { approvedRiskDigest: row.approvedRiskDigest }),
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.completedAt === null ? {} : { completedAt: row.completedAt }),
  }
}

const toAttempt = (input: typeof dynamicAuthoringAttempts.$inferSelect): DynamicAuthoringAttempt => {
  const row = DynamicAuthoringAttemptRowSchema.parse(input)
  return {
    id: row.id,
    taskId: row.taskId,
    ordinal: row.ordinal,
    name: row.name,
    purpose: row.purpose,
    snapshotDigest: row.snapshotDigest,
    riskDigest: row.riskDigest,
    sourcePath: row.sourcePath,
    state: row.state,
    host: {
      status: row.host.status,
      waitingFor: row.host.waitingFor,
      ...(row.host.error === undefined ? {} : { error: row.host.error }),
    },
    client: {
      status: row.client.status,
      waitingFor: row.client.waitingFor,
      ...(row.client.error === undefined ? {} : { error: row.client.error }),
    },
    ...(row.error === null
      ? {}
      : {
          error: {
            phase: row.error.phase,
            message: row.error.message,
            ...(row.error.stack === undefined ? {} : { stack: row.error.stack }),
            repairable: row.error.repairable,
          },
        }),
    ...(row.verification === null ? {} : { verification: row.verification }),
    ...(row.runnerPluginId === null ? {} : { runnerPluginId: row.runnerPluginId }),
    ...(row.runnerPackageId === null ? {} : { runnerPackageId: row.runnerPackageId }),
    ...(row.runnerRunId === null ? {} : { runnerRunId: row.runnerRunId }),
    createdAt: row.createdAt,
    ...(row.settledAt === null ? {} : { settledAt: row.settledAt }),
  }
}

const toEvent = (input: typeof dynamicAuthoringEvents.$inferSelect): DynamicAuthoringEvent => {
  const row = DynamicAuthoringEventRowSchema.parse(input)
  return {
    taskId: row.taskId,
    sequence: row.sequence,
    kind: row.kind,
    ...(row.attemptId === null ? {} : { attemptId: row.attemptId }),
    payload: row.payload,
    createdAt: row.createdAt,
  }
}

const taskValues = (task: DynamicAuthoringTask): typeof dynamicAuthoringTasks.$inferInsert => ({
  id: task.id,
  agentId: task.agentId,
  channelId: task.channelId,
  episodeId: task.episodeId,
  initiatingEventId: task.initiatingEventId,
  pluginKey: task.pluginKey,
  title: task.title,
  requirementSummary: task.requirementSummary,
  status: task.status,
  approvalPolicy: task.approvalPolicy,
  approvedRiskDigest: task.approvedRiskDigest ?? null,
  revision: task.revision,
  createdAt: task.createdAt,
  updatedAt: task.updatedAt,
  completedAt: task.completedAt ?? null,
})

const attemptValues = (attempt: DynamicAuthoringAttempt): typeof dynamicAuthoringAttempts.$inferInsert => ({
  id: attempt.id,
  taskId: attempt.taskId,
  ordinal: attempt.ordinal,
  name: attempt.name,
  purpose: attempt.purpose,
  snapshotDigest: attempt.snapshotDigest,
  riskDigest: attempt.riskDigest,
  sourcePath: attempt.sourcePath,
  state: attempt.state,
  host: attempt.host,
  client: attempt.client,
  error: attempt.error ?? null,
  verification: attempt.verification ?? null,
  runnerPluginId: attempt.runnerPluginId ?? null,
  runnerPackageId: attempt.runnerPackageId ?? null,
  runnerRunId: attempt.runnerRunId ?? null,
  createdAt: attempt.createdAt,
  settledAt: attempt.settledAt ?? null,
})

const eventValues = (event: DynamicAuthoringEvent): typeof dynamicAuthoringEvents.$inferInsert => ({
  taskId: event.taskId,
  sequence: event.sequence,
  kind: event.kind,
  attemptId: event.attemptId ?? null,
  payload: event.payload,
  createdAt: event.createdAt,
})

const updateTask = (database: DrizzleCoreDatabase, task: DynamicAuthoringTask, expectedRevision: number): void => {
  if (task.revision !== expectedRevision + 1) throw new Error('Authoring Task revision must increase by one.')
  const result = database
    .update(dynamicAuthoringTasks)
    .set(taskValues(task))
    .where(and(eq(dynamicAuthoringTasks.id, task.id), eq(dynamicAuthoringTasks.revision, expectedRevision)))
    .run()
  if (result.changes !== 1) throw new Error('Authoring Task revision conflict.')
}

export const createAuthoringRepository = (database: DrizzleCoreDatabase): AuthoringRepository => ({
  listAuthoringTasks(agentId?: AgentId): readonly DynamicAuthoringTask[] {
    const rows =
      agentId === undefined
        ? database.select().from(dynamicAuthoringTasks).orderBy(desc(dynamicAuthoringTasks.updatedAt)).all()
        : database
            .select()
            .from(dynamicAuthoringTasks)
            .where(eq(dynamicAuthoringTasks.agentId, agentId))
            .orderBy(desc(dynamicAuthoringTasks.updatedAt))
            .all()
    return rows.map(toTask)
  },
  listRecoverableAuthoringTasks(): readonly DynamicAuthoringTask[] {
    return database
      .select()
      .from(dynamicAuthoringTasks)
      .where(notInArray(dynamicAuthoringTasks.status, ['interrupted', 'stopped', 'completed']))
      .orderBy(asc(dynamicAuthoringTasks.createdAt))
      .all()
      .map(toTask)
  },
  getAuthoringTask(id: AuthoringTaskId): DynamicAuthoringTask | undefined {
    const row = database.select().from(dynamicAuthoringTasks).where(eq(dynamicAuthoringTasks.id, id)).get()
    return row === undefined ? undefined : toTask(row)
  },
  getAuthoringTaskByPlugin(episodeId: EpisodeId, pluginKey: string): DynamicAuthoringTask | undefined {
    const row = database
      .select()
      .from(dynamicAuthoringTasks)
      .where(and(eq(dynamicAuthoringTasks.episodeId, episodeId), eq(dynamicAuthoringTasks.pluginKey, pluginKey)))
      .get()
    return row === undefined ? undefined : toTask(row)
  },
  listAuthoringAttempts(taskId: AuthoringTaskId): readonly DynamicAuthoringAttempt[] {
    return database
      .select()
      .from(dynamicAuthoringAttempts)
      .where(eq(dynamicAuthoringAttempts.taskId, taskId))
      .orderBy(asc(dynamicAuthoringAttempts.ordinal))
      .all()
      .map(toAttempt)
  },
  getAuthoringAttempt(id: AuthoringAttemptId): DynamicAuthoringAttempt | undefined {
    const row = database.select().from(dynamicAuthoringAttempts).where(eq(dynamicAuthoringAttempts.id, id)).get()
    return row === undefined ? undefined : toAttempt(row)
  },
  listAuthoringEvents(taskId: AuthoringTaskId): readonly DynamicAuthoringEvent[] {
    return database
      .select()
      .from(dynamicAuthoringEvents)
      .where(eq(dynamicAuthoringEvents.taskId, taskId))
      .orderBy(asc(dynamicAuthoringEvents.sequence))
      .all()
      .map(toEvent)
  },
  createAuthoringTask(input): void {
    if (input.task.revision !== 1 || input.event.sequence !== 1) {
      throw new Error('New Authoring Task must start at revision and event sequence one.')
    }
    database.transaction((transaction) => {
      transaction.insert(dynamicAuthoringTasks).values(taskValues(input.task)).run()
      transaction.insert(dynamicAuthoringAttempts).values(attemptValues(input.attempt)).run()
      transaction.insert(dynamicAuthoringEvents).values(eventValues(input.event)).run()
    })
  },
  appendAuthoringAttempt(input): void {
    database.transaction((transaction) => {
      updateTask(transaction, input.task, input.expectedRevision)
      transaction.insert(dynamicAuthoringAttempts).values(attemptValues(input.attempt)).run()
      transaction.insert(dynamicAuthoringEvents).values(eventValues(input.event)).run()
    })
  },
  updateAuthoringAttempt(input): void {
    database.transaction((transaction) => {
      updateTask(transaction, input.task, input.expectedRevision)
      const result = transaction
        .update(dynamicAuthoringAttempts)
        .set(attemptValues(input.attempt))
        .where(
          and(eq(dynamicAuthoringAttempts.id, input.attempt.id), eq(dynamicAuthoringAttempts.taskId, input.task.id)),
        )
        .run()
      if (result.changes !== 1) throw new Error('Authoring Attempt update target is missing.')
      transaction.insert(dynamicAuthoringEvents).values(eventValues(input.event)).run()
    })
  },
  updateAuthoringTask(input): void {
    database.transaction((transaction) => {
      updateTask(transaction, input.task, input.expectedRevision)
      transaction.insert(dynamicAuthoringEvents).values(eventValues(input.event)).run()
    })
  },
  deleteAuthoringTask(id: AuthoringTaskId): void {
    const task = database.select().from(dynamicAuthoringTasks).where(eq(dynamicAuthoringTasks.id, id)).get()
    if (task === undefined) return
    if (!['interrupted', 'stopped', 'completed'].includes(task.status)) {
      throw new Error('Running Authoring Task must stop before deletion.')
    }
    database.delete(dynamicAuthoringTasks).where(eq(dynamicAuthoringTasks.id, id)).run()
  },
})
