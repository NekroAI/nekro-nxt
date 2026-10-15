import { and, asc, eq, sql } from 'drizzle-orm'
import {
  CommandExecutionRecordSchema,
  CommandPolicySchema,
  type ChannelEventId,
  type ChannelId,
  type CommandExecutionRecord,
  type CommandPolicy,
  type ConnectionId,
} from '@nekro-nxt/contracts'
import type { DrizzleCoreDatabase } from '../database.js'
import { commandSystem, commandExecutions, commandGrants, commandPolicies, outboundIntents } from '../schema.js'

export function createCommandRepository(db: DrizzleCoreDatabase) {
  const needsRecovery = (record: CommandExecutionRecord): boolean =>
    record.status === 'pending' ||
    record.status === 'running' ||
    (record.replyIntentId === undefined && record.replyError === undefined && record.replySuppressed !== true)
  const get = (id: string): CommandExecutionRecord | undefined => {
    const row = db.select().from(commandExecutions).where(eq(commandExecutions.id, id)).get()
    return row === undefined ? undefined : CommandExecutionRecordSchema.parse(row.record)
  }
  const update = (record: CommandExecutionRecord): CommandExecutionRecord => {
    const parsed = CommandExecutionRecordSchema.parse(record)
    if (
      db
        .update(commandExecutions)
        .set({
          record: parsed,
          status: parsed.status,
          eventId: parsed.eventId ?? null,
          needsRecovery: needsRecovery(parsed),
        })
        .where(eq(commandExecutions.id, parsed.id))
        .run().changes !== 1
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
          eventId: parsed.eventId ?? null,
          status: parsed.status,
          needsRecovery: needsRecovery(parsed),
          record: parsed,
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
        for (const row of rows)
          update({
            ...CommandExecutionRecordSchema.parse(row.record),
            status: 'uncertain',
            error: '宿主在执行期间停止，结果不确定；请检查实际状态后决定下一步。',
            completedAt: at,
          })
      })
    },
    unfinished(): readonly CommandExecutionRecord[] {
      return db
        .select()
        .from(commandExecutions)
        .where(eq(commandExecutions.needsRecovery, true))
        .orderBy(
          sql`json_extract(${commandExecutions.record}, '$.createdAt')`,
          asc(commandExecutions.eventId),
          asc(commandExecutions.id),
        )
        .all()
        .map((row) => CommandExecutionRecordSchema.parse(row.record))
    },
    reply(id: string) {
      return db
        .select({ id: outboundIntents.id, state: outboundIntents.state })
        .from(outboundIntents)
        .where(eq(outboundIntents.commandExecutionId, id))
        .get()
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
