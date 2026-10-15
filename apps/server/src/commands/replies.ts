import { undeliveredCommandReplies, type CommandExecutionRecord, type CommandReply } from '@nekro-nxt/contracts'
import type { ChannelRuntime } from '@nekro-nxt/channel-runtime'
import type { SqliteCoreRepository } from '@nekro-nxt/storage-sqlite'
import type { CommandObserver } from './types.js'

export const REPLY_NOT_DELIVERED = '命令结果已记录，但回复未能投递。'

export interface CommandRepliesOptions {
  readonly repository: SqliteCoreRepository
  readonly channels: () => ChannelRuntime
  readonly publish: (record: CommandExecutionRecord) => void
  readonly observer?: CommandObserver
}

/** Read-modify-write on a record without an await in between, so concurrent writers cannot lose each other's changes. */
export const mutateRecord = (
  repository: SqliteCoreRepository,
  id: string,
  change: (current: CommandExecutionRecord) => CommandExecutionRecord,
): CommandExecutionRecord => {
  const current = repository.commands.get(id)
  if (!current) throw new Error('命令执行记录不存在。')
  return repository.commands.update(change(current))
}

const withReply = (record: CommandExecutionRecord, ordinal: number, patch: Partial<CommandReply>) => ({
  ...record,
  replies: record.replies.map((reply) => (reply.ordinal === ordinal ? { ...reply, ...patch } : reply)),
})

/**
 * Delivers the replies of one command through the ordinary Outbox, strictly in ordinal order. A reply is planned at
 * most once per (execution, ordinal); recovery finds an already planned Outbound instead of sending again, and
 * receipts that never arrived stay unknown rather than being retried. Callers never wait on a receipt.
 */
export class CommandReplies {
  readonly #o: CommandRepliesOptions
  readonly #chains = new Map<string, Promise<void>>()
  constructor(options: CommandRepliesOptions) {
    this.#o = options
  }

  /** Resolves when everything pending for the execution was attempted; concurrent calls share one ordered chain. */
  flush(executionId: string): Promise<void> {
    const previous = this.#chains.get(executionId) ?? Promise.resolve()
    const tracked: Promise<void> = previous
      .then(() => this.#deliver(executionId))
      .catch(() => undefined)
      .finally(() => {
        if (this.#chains.get(executionId) === tracked) this.#chains.delete(executionId)
      })
    this.#chains.set(executionId, tracked)
    return tracked
  }

  async idle(): Promise<void> {
    while (this.#chains.size) await Promise.allSettled([...this.#chains.values()])
  }

  async #deliver(executionId: string): Promise<void> {
    const store = this.#o.repository.commands
    for (;;) {
      const record = store.get(executionId)
      const next = record === undefined ? undefined : [...undeliveredCommandReplies(record)].sort(byOrdinal)[0]
      if (record === undefined || next === undefined) return
      const planned = store.reply(executionId, next.ordinal)
      if (planned !== undefined) {
        this.#patch(executionId, next.ordinal, { intentId: planned.id })
        continue
      }
      try {
        await this.#o.channels().sendCommandReply({
          channelId: record.channelId,
          executionId,
          ordinal: next.ordinal,
          parts: next.parts,
          ...(record.eventId === undefined ? {} : { eventId: record.eventId }),
          // Persist the association with the plan, before dispatch starts, so a crash can find it again.
          onPlanned: (intentId) => this.#patch(executionId, next.ordinal, { intentId }),
        })
      } catch {
        // Delivery failures are on the Outbound; only a reply that never got one is marked here.
      }
      const settled = store.get(executionId)?.replies.find((reply) => reply.ordinal === next.ordinal)
      if (settled !== undefined && settled.intentId === undefined && settled.error === undefined) {
        this.#patch(executionId, next.ordinal, { error: REPLY_NOT_DELIVERED })
        try {
          const failed = store.get(executionId)
          if (failed) this.#o.observer?.replyNotDelivered?.(failed, next.ordinal)
        } catch {
          // Diagnostics cannot affect delivery.
        }
      }
    }
  }

  #patch(executionId: string, ordinal: number, patch: Partial<CommandReply>): void {
    const record = mutateRecord(this.#o.repository, executionId, (current) => withReply(current, ordinal, patch))
    this.#o.publish(record)
  }
}

const byOrdinal = (a: CommandReply, b: CommandReply): number => a.ordinal - b.ordinal
