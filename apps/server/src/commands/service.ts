import { randomUUID } from 'node:crypto'
import {
  commandNameOf,
  recognizeCommand,
  type AgentId,
  type ChannelId,
  type ChannelMemberId,
  type CommandCatalogEntry,
  type CommandExecutionIdentity,
  type CommandExecutionRecord,
  type CommandPolicy,
  type PlatformIdentityId,
} from '@nekro-nxt/contracts'
import type { ChannelRuntime, CommandGate } from '@nekro-nxt/channel-runtime'
import type { AdapterChannelInboundEvent } from '@nekro-nxt/adapter-sdk'
import type { AppendChannelEventCommit, ChannelEventRecord, CoreService } from '@nekro-nxt/core'
import type { SqliteCoreRepository } from '@nekro-nxt/storage-sqlite'
import { CommandDirectory } from './catalog.js'
import { CommandExecutor } from './executor.js'
import { CommandRateLimiter, type CommandAdmission } from './rate-limit.js'
import { CommandReplies } from './replies.js'
import type { CommandGovernancePort, CommandObserver, RegisteredCommand } from './types.js'

export type { CommandObserver, RegisteredCommand } from './types.js'

export interface CommandServiceOptions {
  readonly deferExecution?: boolean
  readonly repository: SqliteCoreRepository
  readonly core: CoreService
  readonly channels: () => ChannelRuntime
  readonly extensions: (agentId: AgentId) => readonly RegisteredCommand[]
  readonly running: (sessionId: string) => boolean
  readonly botMemberId: (event: ChannelEventRecord) => ChannelMemberId | undefined
  readonly now: () => number
  /** Diagnostics: settled executions, undelivered replies and (at most once a minute per channel) rate limiting. */
  readonly observer?: CommandObserver
  /** Extension governance behind `/ext` and `/admin`. */
  readonly governance?: () => CommandGovernancePort | undefined
}

const LIMIT_REPORT_INTERVAL_MS = 60_000

/**
 * Host-owned command service shared by trusted Web requests and platform facts. It owns the inbound gate (what is a
 * command, what is stored with it); the directory, executor and reply delivery do the rest.
 */
export class CommandService implements CommandGate {
  readonly #o: CommandServiceOptions
  readonly #directory: CommandDirectory
  readonly #replies: CommandReplies
  readonly #executor: CommandExecutor
  readonly #cutoff: string
  readonly #limiter: CommandRateLimiter
  readonly #limited = new Map<ChannelId, { dropped: number; reportedAt: number }>()
  #opened = false
  #disposed = false

  constructor(options: CommandServiceOptions) {
    this.#o = options
    this.#limiter = new CommandRateLimiter(options.now)
    this.#cutoff = options.repository.commands.cutoff()
    this.#directory = new CommandDirectory({
      repository: options.repository,
      extensions: options.extensions,
    })
    const publish = (record: CommandExecutionRecord): void => {
      if (record.eventId === undefined) return
      const event = options.repository.getChannelEvent(record.eventId)
      if (event) options.channels().publishInboundFact(event)
    }
    this.#replies = new CommandReplies({
      repository: options.repository,
      channels: options.channels,
      publish,
      ...(options.observer === undefined ? {} : { observer: options.observer }),
    })
    this.#executor = new CommandExecutor({
      repository: options.repository,
      directory: this.#directory,
      replies: this.#replies,
      channels: options.channels,
      running: options.running,
      now: options.now,
      publish,
      ...(options.observer === undefined ? {} : { observer: options.observer }),
      ...(options.deferExecution === undefined ? {} : { deferExecution: options.deferExecution }),
      ...(options.governance === undefined ? {} : { governance: options.governance }),
    })
    options.repository.commands.recover(options.now())
  }

  // --- inbound gate ------------------------------------------------------------------------------------------

  #recognize(event: ChannelEventRecord) {
    if (event.kind !== 'message-created' || event.id <= this.#cutoff) return { kind: 'chat' } as const
    return recognizeCommand(event.parts, this.#o.botMemberId(event), {
      requireMention: this.#requiresMention(event.channelId),
      addressed: event.facts?.['mentionedBot'] === true,
    })
  }

  /** External groups may hold several bots; there a command must address this account unless the admin opted in. */
  #requiresMention(channelId: ChannelId): boolean {
    return (
      this.#o.repository.getChannel(channelId)?.kind === 'group' && !this.#o.repository.commands.bareCommands(channelId)
    )
  }

  /** Decided once, when the message was committed; later setting changes never reclassify history. */
  excludes(event: ChannelEventRecord): boolean {
    return this.#o.repository.commands.isCommandEvent(event.id)
  }

  project(event: ChannelEventRecord): ChannelEventRecord {
    const result = this.#recognize(event)
    return result.kind === 'escaped' ? { ...event, parts: result.parts } : event
  }

  commitInbound(event: AdapterChannelInboundEvent): AppendChannelEventCommit {
    if (this.#disposed) throw new Error('命令服务已停止。')
    const { commit, record } = this.#o.repository.commands.transaction(() => {
      const commit = this.#o.core.appendInbound(event)
      return { commit, record: this.#capture(commit.event) }
    })
    if (record) this.#executor.background(record)
    return commit
  }

  #capture(event: ChannelEventRecord): CommandExecutionRecord | undefined {
    const existing = this.#o.repository.commands.forEvent(event.id)
    if (existing) return existing
    const detected = this.#recognize(event)
    if (detected.kind !== 'command') return undefined
    const channel = this.#channel(event.channelId)
    // Only names that mean a command here are intercepted; paths, emoticon shortcuts and the like stay chat.
    if (!this.#directory.knows(commandNameOf(detected.text), channel.id)) return undefined
    const identity =
      event.senderMemberId === undefined
        ? undefined
        : this.#o.core.resolveChannelMemberIdentity(channel.connectionId, channel.id, event.senderMemberId)
    // Over the limit the message stays a fact (and never reaches the model), but nothing runs or replies.
    const admission = this.#limiter.admit(channel.id, identity?.platformUserId ?? String(event.senderMemberId))
    if (admission !== 'allowed') {
      this.#o.repository.commands.ignore(event.id, 'rate-limited')
      this.#noteLimited(channel.id, admission)
      return undefined
    }
    return this.#o.repository.commands.insert({
      id: `cmd_${randomUUID()}`,
      channelId: channel.id,
      source: 'platform',
      requestId: event.id,
      eventId: event.id,
      rawText: detected.text,
      status: 'pending',
      replies: [],
      createdAt: this.#o.now(),
      identity: {
        source: 'platform',
        connectionId: channel.connectionId,
        ...(identity === undefined ? {} : { platformUserId: identity.platformUserId }),
        displayName: identity?.displayName ?? '平台用户',
      },
    })
  }

  #noteLimited(channelId: ChannelId, reason: Exclude<CommandAdmission, 'allowed'>): void {
    const now = this.#o.now()
    const entry = this.#limited.get(channelId) ?? { dropped: 0, reportedAt: Number.NEGATIVE_INFINITY }
    entry.dropped += 1
    if (now - entry.reportedAt >= LIMIT_REPORT_INTERVAL_MS) {
      try {
        this.#o.observer?.rateLimited?.({ channelId, dropped: entry.dropped, reason })
      } catch {
        // Diagnostics cannot affect the gate.
      }
      entry.dropped = 0
      entry.reportedAt = now
    }
    this.#limited.set(channelId, entry)
  }

  // --- web execution -----------------------------------------------------------------------------------------

  async executeWeb(
    channelId: ChannelId,
    text: string,
    requestId: string,
    viewerId: string,
  ): Promise<CommandExecutionRecord> {
    if (this.#disposed) throw new Error('命令服务已停止。')
    const existing = this.#o.repository.commands.find(channelId, 'web', requestId)
    if (existing) {
      if (existing.rawText !== text || existing.identity.viewerId !== viewerId)
        throw new Error('请求 ID 已用于其他命令。')
      return this.#executor.execute(existing)
    }
    const channel = this.#channel(channelId)
    const connection = this.#o.repository.getConnection(channel.connectionId)
    if (!connection) throw new Error('频道连接不存在。')
    if (recognizeCommand([{ type: 'text', text }]).kind !== 'command') throw new Error('请输入以 / 开头的命令。')
    const { event, record } = this.#o.repository.commands.transaction(() => {
      const event = this.#o.core.appendInbound({
        connectionId: channel.connectionId,
        channelId,
        adapterKey: connection.adapterKey,
        kind: 'message-created',
        parts: [{ type: 'text', text }],
        platformTimestamp: this.#o.now(),
        receivedAt: this.#o.now(),
        dedupeKey: `web-command:${requestId}`,
      }).event
      const record = this.#o.repository.commands.insert({
        id: `cmd_${randomUUID()}`,
        channelId,
        source: 'web',
        requestId,
        eventId: event.id,
        rawText: text,
        status: 'pending',
        replies: [],
        createdAt: this.#o.now(),
        identity: { source: 'web', displayName: 'Web 管理员', viewerId },
      })
      return { event, record }
    })
    this.#o.channels().publishInboundFact(event)
    return this.#executor.execute(record)
  }

  // --- catalog, policies, grants -----------------------------------------------------------------------------

  catalog(channelId?: ChannelId, identity?: CommandExecutionIdentity): readonly CommandCatalogEntry[] {
    return this.#directory.entries(channelId, identity)
  }

  setPolicy(scope: string, name: string, policy: CommandPolicy): void {
    this.#directory.setPolicy(scope, name, policy)
  }

  grant(channelId: ChannelId, identityId: PlatformIdentityId, enabled: boolean): void {
    this.#directory.grant(channelId, identityId, enabled)
  }

  members(channelId: ChannelId) {
    return this.#directory.members(channelId)
  }

  /** Host-wide command behavior. */
  settings() {
    return { unauthorizedFeedback: this.#o.repository.commands.unauthorizedFeedback() }
  }

  setUnauthorizedFeedback(enabled: boolean): void {
    this.#o.repository.commands.setUnauthorizedFeedback(enabled, this.#o.now())
  }

  channelSettings(channelId: ChannelId) {
    const channel = this.#channel(channelId)
    return {
      kind: channel.kind,
      requiresMention: this.#requiresMention(channelId),
      bareCommands: this.#o.repository.commands.bareCommands(channelId),
    }
  }

  setBareCommands(channelId: ChannelId, enabled: boolean): void {
    if (this.#channel(channelId).kind !== 'group') throw new Error('只有外部群聊需要设置是否允许不带提及的命令。')
    this.#o.repository.commands.setBareCommands(channelId, enabled)
  }

  // --- lifecycle ---------------------------------------------------------------------------------------------

  /** Opens execution after the Host restored its services, and resumes unfinished work once. */
  open(): void {
    if (this.#disposed) throw new Error('命令服务已停止。')
    if (this.#opened) return
    this.#opened = true
    this.#executor.open()
    this.recover()
  }

  recover(): void {
    for (const record of this.#o.repository.commands.unfinished()) this.#executor.background(record)
  }

  idle(): Promise<void> {
    return this.#executor.idle()
  }

  async dispose(): Promise<void> {
    this.#disposed = true
    await this.#executor.dispose()
  }

  #channel(id: ChannelId) {
    const channel = this.#o.repository.getChannel(id)
    if (!channel) throw new Error('频道不存在。')
    return channel
  }
}
