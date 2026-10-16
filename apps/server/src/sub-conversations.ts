import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import {
  SubConversationIdSchema,
  type AgentId,
  type AuthoringTaskId,
  type ChannelId,
  type EpisodeId,
  type SubConversation,
  type SubConversationId,
  type SubConversationRetention,
} from '@nekro-nxt/contracts'
import type { SubConversationRecord } from '@nekro-nxt/storage-sqlite'
import { readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { monotonicFactory } from 'ulid'
import {
  CONVERSATION_SCRIPT_PROVIDER,
  type ConversationScript,
  type ConversationScriptModel,
} from './sub-conversation-script.js'

export interface SubConversationStore {
  insertSubConversation(record: SubConversationRecord): void
  getSubConversation(id: SubConversationId): SubConversationRecord | undefined
  getSubConversationBySession(dshSessionId: string): SubConversationRecord | undefined
  listSubConversations(filter: {
    readonly channelId?: ChannelId
    readonly episodeId?: EpisodeId
    readonly status?: SubConversation['status']
  }): readonly SubConversationRecord[]
  listSubConversationsClosedBefore(before: number): readonly SubConversationRecord[]
  closeSubConversation(input: {
    readonly id: SubConversationId
    readonly closeReason: NonNullable<SubConversation['closeReason']>
    readonly summary?: string
    readonly closedAt: number
  }): SubConversationRecord | undefined
  deleteSubConversation(id: SubConversationId): void
}

/** The channel conversation a parent session belongs to. */
export interface SubConversationOwner {
  readonly channelId: ChannelId
  readonly episodeId: EpisodeId
  readonly agentId: AgentId
}

export interface SubConversationManagerOptions {
  readonly context: Context
  readonly scripts: ConversationScriptModel
  readonly store: SubConversationStore
  /** Where DSH keeps session logs; ended sub-conversations are removed from it. */
  readonly sessionsRoot: string
  /** The channel conversation of a live root session; undefined for anything else. */
  readonly ownerOf: (parentSessionId: string) => SubConversationOwner | undefined
  readonly retention: () => SubConversationRetention
  readonly changed: () => void
  readonly now?: () => number
}

const RETENTION_MS: Readonly<Record<SubConversationRetention, number | undefined>> = {
  '1d': 86_400_000,
  '3d': 3 * 86_400_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
  never: undefined,
}

const SUMMARY_MAX = 4000

export class SubConversationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SubConversationError'
  }
}

/**
 * Sub-conversations: conversations of their own under a channel's conversation (docs/NekroNxt界面交互模型.md §5.6).
 * Each is a direct DSH child session of the channel's root session, so DSH owns running, messaging and releasing
 * it; this records what it is for, who opened it and how it ended, and removes ended ones after the retention time.
 */
export class SubConversationManager {
  readonly #options: SubConversationManagerOptions
  readonly #nextId = monotonicFactory()
  /** Model-driven ones whose agent ended them; released once their own turn is over. */
  readonly #releasing = new Set<string>()

  constructor(options: SubConversationManagerOptions) {
    this.#options = options
  }

  #now(): number {
    return (this.#options.now ?? Date.now)()
  }

  #owner(parent: Agent): SubConversationOwner {
    const owner = this.#options.ownerOf(parent.id)
    if (owner === undefined) throw new SubConversationError('只有频道对话可以开子对话。')
    return owner
  }

  #record(input: {
    readonly parent: Agent
    readonly title: string
    readonly openedBy: SubConversation['openedBy']
    readonly driver: SubConversation['driver']
    readonly authoringTaskId?: AuthoringTaskId
  }): SubConversationRecord {
    const owner = this.#owner(input.parent)
    const id = SubConversationIdSchema.parse(`cnv_${this.#nextId()}`)
    const record: SubConversationRecord = {
      id,
      ...owner,
      dshSessionId: `nxt-${id}`,
      parentDshSessionId: input.parent.id,
      title: input.title.trim().slice(0, 200) || '子对话',
      openedBy: input.openedBy,
      driver: input.driver,
      status: 'open',
      ...(input.authoringTaskId === undefined ? {} : { authoringTaskId: input.authoringTaskId }),
      createdAt: this.#now(),
    }
    this.#options.store.insertSubConversation(record)
    this.#options.changed()
    return record
  }

  #close(
    record: SubConversationRecord,
    closeReason: NonNullable<SubConversation['closeReason']>,
    summary?: string,
  ): SubConversationRecord {
    const closed = this.#options.store.closeSubConversation({
      id: record.id,
      closeReason,
      ...(summary === undefined || summary.trim() === '' ? {} : { summary: summary.trim().slice(0, SUMMARY_MAX) }),
      closedAt: this.#now(),
    })
    if (closed !== undefined) this.#options.changed()
    return closed ?? this.#options.store.getSubConversation(record.id) ?? record
  }

  /** Opens a sub-conversation the agent's model talks in; what it replies is delivered to `parent`. */
  async open(input: {
    readonly parent: Agent
    readonly title: string
    readonly task: string
  }): Promise<SubConversationRecord> {
    const record = this.#record({ parent: input.parent, title: input.title, openedBy: 'agent', driver: 'model' })
    try {
      await this.#options.context.subagents.startActivation({
        provider: 'spawn',
        label: record.title,
        childId: SessionId(record.dshSessionId),
        request: {
          prompt: [{ type: 'text', text: input.task }],
          // The tools it may use and its output limit come from the Host's child composition (agentPresets).
          parent: input.parent,
        },
        signal: new AbortController().signal,
        delivery: 'parent',
      })
    } catch (error) {
      this.#close(record, 'failed', error instanceof Error ? error.message : String(error))
      throw error
    }
    return record
  }

  /**
   * Runs `calls` in a sub-conversation of `parent` played by the conversation script model, and returns each call's
   * outcome by call id. The calls go through the normal tool pipeline inside turns of the sub-conversation's log.
   */
  async runScript(input: {
    readonly parent: Agent
    readonly title: string
    readonly calls: ConversationScript['calls']
    readonly closing: string
    readonly authoringTaskId?: AuthoringTaskId
  }): Promise<{
    readonly conversation: SubConversationRecord
    readonly results: ReadonlyMap<string, Readonly<ToolExecutionResult>>
  }> {
    const record = this.#record({
      parent: input.parent,
      title: input.title,
      openedBy: 'host',
      driver: 'script',
      ...(input.authoringTaskId === undefined ? {} : { authoringTaskId: input.authoringTaskId }),
    })
    const results = new Map<string, Readonly<ToolExecutionResult>>()
    const stopObserving = this.#options.context.on('tools/result', (execution, result) => {
      if (execution.agent?.id === record.dshSessionId) results.set(String(execution.callId), result)
    })
    const unload = this.#options.scripts.load(record.dshSessionId, { calls: input.calls, closing: input.closing })
    try {
      const activation = await this.#options.context.subagents.startActivation({
        provider: 'spawn',
        label: record.title,
        childId: SessionId(record.dshSessionId),
        request: {
          prompt: [{ type: 'text', text: input.title }],
          parent: input.parent,
          agentOptions: { provider: CONVERSATION_SCRIPT_PROVIDER, model: record.dshSessionId },
        },
        signal: new AbortController().signal,
        delivery: 'caller',
      })
      await activation.result
      // Only the scripted calls count: a run_code call also reports each tool call made inside it.
      const outcomes = input.calls.map((call) => results.get(call.id))
      const failed = outcomes.find((result) => result?.isError === true)
      const conversation = this.#close(
        record,
        outcomes.every((result) => result?.isError === false) ? 'completed' : 'failed',
        failed?.isError === true ? failed.error.message : input.closing,
      )
      return { conversation, results }
    } catch (error) {
      this.#close(record, 'failed', error instanceof Error ? error.message : String(error))
      throw error
    } finally {
      stopObserving()
      unload()
    }
  }

  /** Delivers `text` between a channel conversation and one of its own sub-conversations, either way. */
  async send(input: {
    readonly sender: Agent
    readonly conversationId: SubConversationId
    readonly text: string
  }): Promise<void> {
    const record = this.#options.store.getSubConversation(input.conversationId)
    const parentToChild = record?.parentDshSessionId === input.sender.id
    const childToParent = record?.dshSessionId === input.sender.id
    if (!record || (!parentToChild && !childToParent)) throw new SubConversationError('没有找到这个子对话。')
    if (record.status !== 'open') throw new SubConversationError('这个子对话已经结束，不能再发消息。')
    if (record.driver !== 'model') throw new SubConversationError('这个子对话由 NekroNXT 按固定步骤进行，不接收消息。')
    await this.#options.context.subagents.sendMessage(
      input.sender,
      SessionId(parentToChild ? record.dshSessionId : record.parentDshSessionId),
      [{ type: 'text', text: input.text }],
      { signal: new AbortController().signal },
    )
  }

  /**
   * The agent ends a sub-conversation: the channel conversation ends one of its own, or a sub-conversation ends
   * itself. A sub-conversation that ends itself is released after its current turn.
   */
  async closeByAgent(input: {
    readonly caller: Agent
    readonly conversationId?: SubConversationId
    readonly summary?: string
  }): Promise<SubConversationRecord> {
    const record =
      input.conversationId === undefined
        ? this.#options.store.getSubConversationBySession(input.caller.id)
        : this.#options.store.getSubConversation(input.conversationId)
    const isParent = record?.parentDshSessionId === input.caller.id
    const isSelf = record?.dshSessionId === input.caller.id
    if (!record || (!isParent && !isSelf)) throw new SubConversationError('没有找到这个子对话。')
    if (record.status !== 'open') return record
    const closed = this.#close(record, 'closed-by-agent', input.summary)
    if (isParent) await this.#release(record)
    else this.#releaseAfterTurn(input.caller, record)
    return closed
  }

  /** An administrator ends a sub-conversation from its page. */
  async closeByAdmin(id: SubConversationId): Promise<SubConversationRecord> {
    const record = this.#options.store.getSubConversation(id)
    if (!record) throw new SubConversationError('没有找到这个子对话。')
    if (record.status !== 'open') return record
    const closed = this.#close(record, 'closed-by-admin')
    await this.#release(record)
    return closed
  }

  /** The channel conversation ended (cleared, rolled over, stopped); its sub-conversations end with it. */
  closeForEpisode(episodeId: EpisodeId): void {
    for (const record of this.#options.store.listSubConversations({ episodeId, status: 'open' })) {
      this.#close(record, 'conversation-ended')
    }
  }

  /**
   * Scripted ones still marked open after a restart were cut off mid-run; nothing can resume them. Model-driven ones
   * stay open: DSH resumes them when a message arrives.
   */
  closeInterrupted(): void {
    for (const record of this.#options.store.listSubConversations({ status: 'open' })) {
      if (record.driver === 'script') this.#close(record, 'failed', 'NekroNXT 重启时这个子对话还没有完成。')
    }
  }

  /**
   * Removes an ended sub-conversation and its log. The agent may remove the ones it opened; an administrator any.
   */
  async delete(id: SubConversationId, by: { readonly agent: Agent } | 'admin'): Promise<void> {
    const record = this.#options.store.getSubConversation(id)
    if (!record) throw new SubConversationError('没有找到这个子对话。')
    if (by !== 'admin' && (record.parentDshSessionId !== by.agent.id || record.openedBy !== 'agent')) {
      throw new SubConversationError('只能销毁自己开的子对话。')
    }
    if (record.status !== 'closed') throw new SubConversationError('子对话结束后才能销毁。')
    await this.#removeLog(record)
    this.#options.store.deleteSubConversation(id)
    this.#options.changed()
  }

  /** Removes ended sub-conversations older than the retention setting. */
  async sweep(): Promise<number> {
    const keepMs = RETENTION_MS[this.#options.retention()]
    if (keepMs === undefined) return 0
    let removed = 0
    for (const record of this.#options.store.listSubConversationsClosedBefore(this.#now() - keepMs)) {
      try {
        await this.#removeLog(record)
        this.#options.store.deleteSubConversation(record.id)
        removed += 1
      } catch (error) {
        console.error(`[nekro-nxt] 清理子对话 ${record.id} 失败：`, error)
      }
    }
    if (removed > 0) this.#options.changed()
    return removed
  }

  async #release(record: SubConversationRecord): Promise<void> {
    const parent = this.#options.context.agents.get(SessionId(record.parentDshSessionId))
    if (parent === undefined) return
    await this.#options.context.subagents.drainChildren(parent, [SessionId(record.dshSessionId)])
  }

  #releaseAfterTurn(child: Agent, record: SubConversationRecord): void {
    if (this.#releasing.has(record.dshSessionId)) return
    this.#releasing.add(record.dshSessionId)
    void child
      .whenIdle()
      .then(() => this.#release(record))
      .catch((error: unknown) => console.error(`[nekro-nxt] 释放子对话 ${record.id} 失败：`, error))
      .finally(() => this.#releasing.delete(record.dshSessionId))
  }

  /** DSH has no delete; the session directory of an ended, unloaded sub-conversation is removed directly. */
  async #removeLog(record: SubConversationRecord): Promise<void> {
    if (this.#options.context.agents.get(SessionId(record.dshSessionId)) !== undefined) {
      throw new SubConversationError('这个子对话还在运行，稍后再销毁。')
    }
    let projects: string[]
    try {
      projects = await readdir(this.#options.sessionsRoot)
    } catch {
      return
    }
    for (const project of projects) {
      const directory = path.join(this.#options.sessionsRoot, project, record.dshSessionId)
      await rm(directory, { recursive: true, force: true })
    }
  }
}

/** Keeps sub-conversations in memory, for hosts started without the product database (tests, tools). */
export const memorySubConversationStore = (): SubConversationStore => {
  const records = new Map<string, SubConversationRecord>()
  const newestFirst = (a: SubConversationRecord, b: SubConversationRecord) => b.createdAt - a.createdAt
  return {
    insertSubConversation: (record) => {
      records.set(record.id, record)
    },
    getSubConversation: (id) => records.get(id),
    getSubConversationBySession: (dshSessionId) =>
      [...records.values()].find((record) => record.dshSessionId === dshSessionId),
    listSubConversations: (filter) =>
      [...records.values()]
        .filter(
          (record) =>
            (filter.channelId === undefined || record.channelId === filter.channelId) &&
            (filter.episodeId === undefined || record.episodeId === filter.episodeId) &&
            (filter.status === undefined || record.status === filter.status),
        )
        .sort(newestFirst),
    listSubConversationsClosedBefore: (before) =>
      [...records.values()]
        .filter((record) => record.status === 'closed' && (record.closedAt ?? Infinity) < before)
        .sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0)),
    closeSubConversation: (input) => {
      const record = records.get(input.id)
      if (record?.status !== 'open') return undefined
      const closed: SubConversationRecord = {
        ...record,
        status: 'closed',
        closeReason: input.closeReason,
        closedAt: input.closedAt,
        ...(input.summary === undefined ? {} : { summary: input.summary }),
      }
      records.set(input.id, closed)
      return closed
    },
    deleteSubConversation: (id) => {
      records.delete(id)
    },
  }
}
