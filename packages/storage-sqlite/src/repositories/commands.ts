import { and, asc, desc, eq, sql } from 'drizzle-orm'
import {
  CommandExecutionRecordSchema,
  CommandPolicySchema,
  undeliveredCommandReplies,
  type ChannelEventId,
  type ChannelId,
  type CommandExecutionRecord,
  type CommandPolicy,
  type ConnectionId,
} from '@nekro-nxt/contracts'
import type { DrizzleCoreDatabase } from '../database.js'
import {
  commandChannelSettings,
  commandIgnoredEvents,
  systemSettings,
  commandSystem,
  commandExecutions,
  commandGrants,
  commandPolicies,
  outboundIntents,
} from '../schema.js'

const UNAUTHORIZED_FEEDBACK_KEY = 'commands.unauthorizedFeedback'

/** Completed executions kept in full per channel; older ones are reduced to their searchable columns. */
export const COMMAND_EXECUTION_RETAIN = 500

export function createCommandRepository(db: DrizzleCoreDatabase) {
  const needsRecovery = (record: CommandExecutionRecord): boolean =>
    record.status === 'pending' || record.status === 'running' || undeliveredCommandReplies(record).length > 0
  const columns = (record: CommandExecutionRecord) => ({
    commandName: record.commandName ?? null,
    status: record.status,
    eventId: record.eventId ?? null,
    needsRecovery: needsRecovery(record),
    createdAt: record.createdAt,
    completedAt: record.completedAt ?? null,
    record,
  })
  const get = (id: string): CommandExecutionRecord | undefined => {
    const row = db.select().from(commandExecutions).where(eq(commandExecutions.id, id)).get()
    return row === undefined ? undefined : CommandExecutionRecordSchema.parse(row.record)
  }
  const update = (record: CommandExecutionRecord): CommandExecutionRecord => {
    const parsed = CommandExecutionRecordSchema.parse(record)
    if (
      db.update(commandExecutions).set(columns(parsed)).where(eq(commandExecutions.id, parsed.id)).run().changes !== 1
    )
      throw new Error('命令执行记录不存在。')
    return parsed
  }
  return {
    get,
    update,
    /** Fact and execution must commit together; callbacks must remain synchronous. */
    transaction<T>(operation: () => T): T {
      return db.transaction(operation)
    },
    cutoff(): string {
      return db.select().from(commandSystem).where(eq(commandSystem.id, 1)).get()?.cutoffEventId ?? ''
    },
    find(
      channelId: ChannelId,
      source: CommandExecutionRecord['source'],
      requestId: string,
    ): CommandExecutionRecord | undefined {
      const row = db
        .select()
        .from(commandExecutions)
        .where(
          and(
            eq(commandExecutions.channelId, channelId),
            eq(commandExecutions.source, source),
            eq(commandExecutions.requestId, requestId),
          ),
        )
        .get()
      return row === undefined ? undefined : CommandExecutionRecordSchema.parse(row.record)
    },
    forEvent(eventId: ChannelEventId): CommandExecutionRecord | undefined {
      const row = db.select().from(commandExecutions).where(eq(commandExecutions.eventId, eventId)).get()
      return row === undefined ? undefined : CommandExecutionRecordSchema.parse(row.record)
    },
    insert(record: CommandExecutionRecord): CommandExecutionRecord {
      const parsed = CommandExecutionRecordSchema.parse(record)
      db.insert(commandExecutions)
        .values({
          id: parsed.id,
          channelId: parsed.channelId,
          source: parsed.source,
          requestId: parsed.requestId,
          ...columns(parsed),
        })
        .onConflictDoNothing()
        .run()
      const stored = this.find(parsed.channelId, parsed.source, parsed.requestId)
      if (!stored) throw new Error('命令入站事件已关联其他请求。')
      return stored
    },
    claim(id: string): boolean {
      const record = get(id)
      if (!record) throw new Error('命令执行记录不存在。')
      return (
        db
          .update(commandExecutions)
          .set({ status: 'running', needsRecovery: true, record: { ...record, status: 'running' } })
          .where(and(eq(commandExecutions.id, id), eq(commandExecutions.status, 'pending')))
          .run().changes === 1
      )
    },
    recover(at: number): void {
      db.transaction(() => {
        const rows = db.select().from(commandExecutions).where(eq(commandExecutions.status, 'running')).all()
        for (const row of rows) {
          const record = CommandExecutionRecordSchema.parse(row.record)
          const error = '宿主在执行期间停止，结果不确定；请检查实际状态后决定下一步。'
          const progress = record.replies.filter((reply) => reply.kind === 'progress')
          update({
            ...record,
            status: 'uncertain',
            error,
            completedAt: at,
            // The administrator is told the outcome is unknown; the handler is never run again.
            replies: [...progress, { ordinal: progress.length, kind: 'final', parts: [{ type: 'text', text: error }] }],
          })
        }
      })
    },
    unfinished(): readonly CommandExecutionRecord[] {
      return db
        .select()
        .from(commandExecutions)
        .where(eq(commandExecutions.needsRecovery, true))
        .orderBy(asc(commandExecutions.createdAt), asc(commandExecutions.eventId), asc(commandExecutions.id))
        .all()
        .map((row) => CommandExecutionRecordSchema.parse(row.record))
    },
    /** The Outbound already planned for this reply, if any; planning is unique per (execution, ordinal). */
    reply(id: string, ordinal: number) {
      return db
        .select({ id: outboundIntents.id, state: outboundIntents.state })
        .from(outboundIntents)
        .where(and(eq(outboundIntents.commandExecutionId, id), eq(outboundIntents.commandOrdinal, ordinal)))
        .get()
    },
    /**
     * Keeps the newest COMMAND_EXECUTION_RETAIN settled executions of a channel in full and drops the arguments,
     * results and reply bodies of older ones. Rows stay: events and Outbounds reference them.
     */
    compact(channelId: ChannelId): number {
      const stale = db
        .select({ id: commandExecutions.id, record: commandExecutions.record })
        .from(commandExecutions)
        .where(and(eq(commandExecutions.channelId, channelId), eq(commandExecutions.needsRecovery, false)))
        .orderBy(desc(commandExecutions.createdAt), desc(commandExecutions.id))
        .limit(1000)
        .offset(COMMAND_EXECUTION_RETAIN)
        .all()
      let compacted = 0
      for (const row of stale) {
        const { result: _result, ...record } = CommandExecutionRecordSchema.parse(row.record)
        if (record.rawText === '' && _result === undefined && record.replies.length === 0) continue
        db.update(commandExecutions)
          .set({ record: { ...record, rawText: '', replies: [] } })
          .where(eq(commandExecutions.id, row.id))
          .run()
        compacted += 1
      }
      return compacted
    },
    policy(scope: string, name: string): CommandPolicy | undefined {
      const row = db
        .select()
        .from(commandPolicies)
        .where(and(eq(commandPolicies.scope, scope), eq(commandPolicies.commandName, name)))
        .get()
      return row === undefined ? undefined : CommandPolicySchema.parse(row.policy)
    },
    setPolicy(scope: string, name: string, policy: CommandPolicy): void {
      const parsed = CommandPolicySchema.parse(policy)
      db.insert(commandPolicies)
        .values({ scope, commandName: name, policy: parsed })
        .onConflictDoUpdate({
          target: [commandPolicies.scope, commandPolicies.commandName],
          set: { policy: parsed },
        })
        .run()
    },
    /** Records that a recognized command message was deliberately not executed. */
    ignore(eventId: ChannelEventId, reason: 'rate-limited'): void {
      db.insert(commandIgnoredEvents).values({ eventId, reason }).onConflictDoNothing().run()
    },
    /** Whether the message was decided to be a command when it arrived (executed or deliberately ignored). */
    isCommandEvent(eventId: ChannelEventId): boolean {
      return (
        db
          .select({ id: commandExecutions.id })
          .from(commandExecutions)
          .where(eq(commandExecutions.eventId, eventId))
          .get() !== undefined ||
        db
          .select({ id: commandIgnoredEvents.eventId })
          .from(commandIgnoredEvents)
          .where(eq(commandIgnoredEvents.eventId, eventId))
          .get() !== undefined
      )
    },
    /** Whether unauthorized platform members are told they need a grant (default) or ignored silently. */
    unauthorizedFeedback(): boolean {
      const value = db
        .select({ value: systemSettings.value })
        .from(systemSettings)
        .where(eq(systemSettings.key, UNAUTHORIZED_FEEDBACK_KEY))
        .get()?.value
      return value !== false
    },
    setUnauthorizedFeedback(enabled: boolean, at: number): void {
      db.insert(systemSettings)
        .values({ key: UNAUTHORIZED_FEEDBACK_KEY, value: enabled, revision: 1, updatedAt: at })
        .onConflictDoUpdate({
          target: systemSettings.key,
          set: { value: enabled, revision: sql`${systemSettings.revision} + 1`, updatedAt: at },
        })
        .run()
    },
    bareCommands(channelId: ChannelId): boolean {
      return (
        db
          .select({ value: commandChannelSettings.bareCommands })
          .from(commandChannelSettings)
          .where(eq(commandChannelSettings.channelId, channelId))
          .get()?.value ?? false
      )
    },
    setBareCommands(channelId: ChannelId, enabled: boolean): void {
      db.insert(commandChannelSettings)
        .values({ channelId, bareCommands: enabled })
        .onConflictDoUpdate({ target: commandChannelSettings.channelId, set: { bareCommands: enabled } })
        .run()
    },
    grants(channelId: ChannelId) {
      return db.select().from(commandGrants).where(eq(commandGrants.channelId, channelId)).all()
    },
    hasGrant(channelId: ChannelId, connectionId: ConnectionId, platformUserId: string): boolean {
      return (
        db
          .select({ exists: sql<number>`1` })
          .from(commandGrants)
          .where(
            and(
              eq(commandGrants.channelId, channelId),
              eq(commandGrants.connectionId, connectionId),
              eq(commandGrants.platformUserId, platformUserId),
            ),
          )
          .get() !== undefined
      )
    },
    grant(channelId: ChannelId, connectionId: ConnectionId, platformUserId: string): void {
      db.insert(commandGrants).values({ channelId, connectionId, platformUserId }).onConflictDoNothing().run()
    },
    revoke(channelId: ChannelId, connectionId: ConnectionId, platformUserId: string): void {
      db.delete(commandGrants)
        .where(
          and(
            eq(commandGrants.channelId, channelId),
            eq(commandGrants.connectionId, connectionId),
            eq(commandGrants.platformUserId, platformUserId),
          ),
        )
        .run()
    },
  }
}
export type CommandRepository = ReturnType<typeof createCommandRepository>
