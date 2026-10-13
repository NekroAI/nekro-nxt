import { BUILTIN_DEFINITIONS, RESPONSE_MODE_LABELS } from './built-ins.js'
import { randomUUID } from 'node:crypto'
import {
  ChannelIdSchema,
  CommandResultSchema,
  commandUsage,
  parseCommandArguments,
  recognizeCommand,
  tokenizeCommand,
  type AgentId,
  type ChannelId,
  type ChannelMemberId,
  type CommandCatalogEntry,
  type CommandDefinition,
  type CommandExecutionContext,
  type CommandExecutionIdentity,
  type CommandExecutionRecord,
  type CommandHandler,
  type CommandPolicy,
  type CommandResult,
  type ExtensionRevisionId,
  type PlatformIdentityId,
} from '@nekro-nxt/contracts'
import type { CommandGate, ChannelRuntime } from '@nekro-nxt/channel-runtime'
import type { AdapterChannelInboundEvent } from '@nekro-nxt/adapter-sdk'
import type { AppendChannelEventCommit, ChannelEventRecord, CoreService } from '@nekro-nxt/core'
import type { SqliteCoreRepository } from '@nekro-nxt/storage-sqlite'

export interface RegisteredCommand {
  readonly definition: CommandDefinition
  readonly fullName: string
  readonly source: string
  readonly extensionRevisionId?: ExtensionRevisionId
  readonly unavailableReason?: string
  readonly invoke: CommandHandler
}
interface CommandServiceOptions {
  readonly deferExecution?: boolean
  readonly repository: SqliteCoreRepository
  readonly core: CoreService
  readonly channels: () => ChannelRuntime
  readonly extensions: (agentId: AgentId) => readonly RegisteredCommand[]
  readonly running: (sessionId: string) => boolean
  readonly botMemberId: (event: ChannelEventRecord) => ChannelMemberId | undefined
  readonly now: () => number
}
const reply = (text: string): CommandResult => ({ parts: [{ type: 'text', text }] })
class SilentCommandError extends Error {}
interface QueuedCommand {
  readonly record: CommandExecutionRecord
  readonly resolve: (record: CommandExecutionRecord) => void
  readonly reject: (error: unknown) => void
}
/** Host-owned command executor, shared by trusted Web requests and platform facts. */
export class CommandService implements CommandGate {
  readonly #o: CommandServiceOptions
  readonly #inFlight = new Map<string, Promise<CommandExecutionRecord>>()
  readonly #controllers = new Set<AbortController>()
  readonly #queue = new Map<string, QueuedCommand>()
  readonly #activeChannels = new Set<ChannelId>()
  readonly #cutoff: string
  #scheduled: NodeJS.Immediate | undefined
  #opened = false
  #disposed = false
  #ready: boolean
  constructor(options: CommandServiceOptions) {
    this.#o = options
    this.#ready = options.deferExecution !== true
    this.#cutoff = options.repository.commands.cutoff()
    options.repository.commands.recover(options.now())
  }
  #recognize(event: ChannelEventRecord) {
    if (event.kind !== 'message-created' || event.id <= this.#cutoff) return { kind: 'chat' } as const
    return recognizeCommand(event.parts, this.#o.botMemberId(event))
  }
  excludes(event: ChannelEventRecord): boolean {
    return this.#o.repository.commands.forEvent(event.id) !== undefined || this.#recognize(event).kind === 'command'
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
    if (record) this.#background(record)
    return commit
  }
  #capture(event: ChannelEventRecord): CommandExecutionRecord | undefined {
    const existing = this.#o.repository.commands.forEvent(event.id)
    if (existing) return existing
    const detected = this.#recognize(event)
    if (detected.kind !== 'command') return undefined
    const channel = this.#channel(event.channelId)
    const identity =
      event.senderMemberId === undefined
        ? undefined
        : this.#o.core.resolveChannelMemberIdentity(channel.connectionId, channel.id, event.senderMemberId)
    return this.#o.repository.commands.insert({
      id: `cmd_${randomUUID()}`,
      channelId: channel.id,
      source: 'platform',
      requestId: event.id,
      eventId: event.id,
      rawText: detected.text,
      status: 'pending',
      createdAt: this.#o.now(),
      identity: {
        source: 'platform',
        connectionId: channel.connectionId,
        ...(identity === undefined ? {} : { platformUserId: identity.platformUserId }),
        displayName: identity?.displayName ?? '平台用户',
      },
    })
  }
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
      return this.#execute(existing)
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
        createdAt: this.#o.now(),
        identity: { source: 'web', displayName: 'Web 管理员', viewerId },
      })
      return { event, record }
    })
    this.#o.channels().publishInboundFact(event)
    return this.#execute(record)
  }
  catalog(
    channelId?: ChannelId,
    identity: CommandExecutionIdentity = { source: 'web', displayName: 'Web 管理员' },
  ): readonly CommandCatalogEntry[] {
    return this.#registered(channelId).map((command) => {
      const globalPolicy = this.#o.repository.commands.policy('global', command.fullName)
      const channelPolicy =
        channelId === undefined ? undefined : this.#o.repository.commands.policy(channelId, command.fullName)
      const permission =
        command.definition.minimumPermission === 'channel-admin' ||
        globalPolicy?.permission === 'channel-admin' ||
        channelPolicy?.permission === 'channel-admin'
          ? 'channel-admin'
          : 'public'
      const enabled =
        command.fullName === 'help' ||
        (channelPolicy?.enabled ?? globalPolicy?.enabled ?? command.definition.enabledByDefault)
      const bound = channelId !== undefined && this.#o.repository.getBinding(channelId) !== undefined
      return {
        definition: command.definition,
        fullName: command.fullName,
        source: command.source,
        ...(command.extensionRevisionId === undefined ? {} : { extensionRevisionId: command.extensionRevisionId }),
        ...(command.unavailableReason === undefined ? {} : { unavailableReason: command.unavailableReason }),
        enabled,
        permission,
        available:
          enabled &&
          command.unavailableReason === undefined &&
          (permission === 'public' || this.#authorized(channelId, identity)) &&
          (bound || ['help', 'status'].includes(command.fullName)),
        usage: commandUsage(command.definition, command.fullName),
        ...(globalPolicy === undefined ? {} : { globalPolicy }),
        ...(channelPolicy === undefined ? {} : { channelPolicy }),
      }
    })
  }
  setPolicy(scope: string, name: string, policy: CommandPolicy): void {
    if (scope !== 'global') this.#channel(ChannelIdSchema.parse(scope))
    const command = this.#registered(scope === 'global' ? undefined : ChannelIdSchema.parse(scope)).find(
      (c) => c.fullName === name,
    )
    if (!command) throw new Error('命令未注册，请检查扩展加载状态。')
    if (name === 'help' && (policy.enabled === false || policy.permission === 'channel-admin'))
      throw new Error('帮助命令必须始终对普通用户可用。')
    if (command.definition.minimumPermission === 'channel-admin' && policy.permission === 'public')
      throw new Error('不能降低命令声明的最低权限。')
    this.#o.repository.commands.setPolicy(scope, name, policy)
  }
  grant(channelId: ChannelId, identityId: PlatformIdentityId, enabled: boolean): void {
    const channel = this.#channel(channelId)
    const identity = this.#o.repository.getPlatformIdentity(identityId)
    const member = this.#o.repository.getChannelMemberByIdentity(channelId, identityId)
    if (!identity || identity.connectionId !== channel.connectionId || !member)
      throw new Error('只能授权此连接、此频道中已存在的成员。')
    if (enabled) this.#o.repository.commands.grant(channelId, channel.connectionId, identity.platformUserId)
    else this.#o.repository.commands.revoke(channelId, channel.connectionId, identity.platformUserId)
  }
  members(channelId: ChannelId) {
    const channel = this.#channel(channelId)
    return this.#o.repository
      .listPlatformUsers()
      .filter(
        (user) => user.connection.id === channel.connectionId && user.activeChannels.some((c) => c.id === channelId),
      )
      .flatMap((user) => {
        const identity = this.#o.repository.getPlatformIdentity(user.identityId)
        return identity === undefined
          ? []
          : [
              {
                identityId: identity.id,
                displayName: identity.displayName ?? identity.platformUserId,
                platformUserId: identity.platformUserId,
                authorized: this.#o.repository.commands.hasGrant(
                  channelId,
                  channel.connectionId,
                  identity.platformUserId,
                ),
              },
            ]
      })
  }
  open(): void {
    if (this.#disposed) throw new Error('命令服务已停止。')
    if (this.#opened) return
    this.#opened = true
    this.#ready = true
    this.recover()
  }
  recover(): void {
    for (const record of this.#o.repository.commands.unfinished()) this.#background(record)
  }
  async idle(): Promise<void> {
    while (this.#inFlight.size) await Promise.allSettled(this.#inFlight.values())
  }
  async dispose(): Promise<void> {
    this.#disposed = true
    if (this.#scheduled) clearImmediate(this.#scheduled)
    this.#scheduled = undefined
    for (const [id, task] of this.#queue) {
      this.#inFlight.delete(id)
      task.resolve(task.record)
    }
    this.#queue.clear()
    for (const c of this.#controllers) c.abort()
    await Promise.allSettled(this.#inFlight.values())
  }
  #channel(id: ChannelId) {
    const channel = this.#o.repository.getChannel(id)
    if (!channel) throw new Error('频道不存在。')
    return channel
  }
  #authorized(channelId: ChannelId | undefined, identity: CommandExecutionIdentity): boolean {
    // Web identities are created only by the trusted management Host routes, never from inbound facts/JSON.
    if (identity.source === 'web') return true
    if (channelId === undefined || identity.connectionId === undefined || identity.platformUserId === undefined)
      return false
    const channel = this.#o.repository.getChannel(channelId)
    return (
      channel?.connectionId === identity.connectionId &&
      this.#o.repository.commands.hasGrant(channelId, identity.connectionId, identity.platformUserId)
    )
  }
  #status(channelId: ChannelId) {
    const binding = this.#o.repository.getBinding(channelId)
    const episode = binding === undefined ? undefined : this.#o.repository.getActiveEpisode(channelId, binding.agentId)
    return {
      bound: binding !== undefined,
      ...(binding === undefined ? {} : { responseMode: RESPONSE_MODE_LABELS[binding.triggerPolicy] }),
      running: episode?.dshSessionId !== undefined && this.#o.running(episode.dshSessionId),
    }
  }
  #registered(channelId?: ChannelId): readonly RegisteredCommand[] {
    const builtins: RegisteredCommand[] = BUILTIN_DEFINITIONS.map((definition) => ({
      definition,
      fullName: definition.name,
      source: '内置',
      invoke: () => reply(''),
    }))
    const ids =
      channelId === undefined
        ? this.#o.repository.listAgents().map((a) => a.definition.id)
        : [this.#o.repository.getBinding(channelId)?.agentId].filter((id): id is AgentId => id !== undefined)
    const extensions = new Map<string, RegisteredCommand>()
    for (const id of ids) for (const c of this.#o.extensions(id)) extensions.set(c.fullName, c)
    return [...builtins, ...extensions.values()]
  }
  #resolve(name: string, channelId: ChannelId): RegisteredCommand {
    const all = this.#registered(channelId)
    const builtin = all.find(
      (c) => c.extensionRevisionId === undefined && (c.definition.name === name || c.definition.aliases.includes(name)),
    )
    if (builtin) return builtin
    const matches = all.filter(
      (c) =>
        c.fullName === name ||
        c.definition.name === name ||
        c.definition.aliases.includes(name) ||
        c.definition.aliases.some((alias) => c.fullName.slice(0, c.fullName.lastIndexOf(':') + 1) + alias === name),
    )
    if (matches.length > 1)
      throw new Error(`命令名称冲突，请使用完整名称：${matches.map((c) => '/' + c.fullName).join('、')}`)
    if (!matches[0]) throw new SilentCommandError(`未知命令：/${name}。输入 /help 查看可用命令。`)
    return matches[0]
  }
  #execute(record: CommandExecutionRecord): Promise<CommandExecutionRecord> {
    const pending = this.#inFlight.get(record.id)
    if (pending) return pending
    if (this.#disposed || !this.#ready) return Promise.resolve(record)
    const task = new Promise<CommandExecutionRecord>((resolve, reject) => {
      this.#queue.set(record.id, { record, resolve, reject })
    })
    this.#inFlight.set(record.id, task)
    this.#schedule()
    return task
  }
  #background(record: CommandExecutionRecord): void {
    void this.#execute(record).catch(() => {
      // Handler/transport failures are persisted by #run; this catches storage failures without losing the inbox.
      console.warn(`[nekro-nxt] 命令 ${record.id} 后台执行中断，持久记录将在重启时恢复。`)
    })
  }
  #schedule(): void {
    if (this.#scheduled || this.#disposed || !this.#ready || !this.#queue.size) return
    // Yield the inbound commit to its transport before invoking any extension or planning a reply.
    this.#scheduled = setImmediate(() => {
      this.#scheduled = undefined
      for (const [id, task] of this.#queue) {
        if (this.#activeChannels.size >= 4) break
        const channelId = task.record.channelId
        if (this.#activeChannels.has(channelId)) continue
        this.#queue.delete(id)
        this.#activeChannels.add(channelId)
        void this.#run(task.record)
          .then(task.resolve, task.reject)
          .finally(() => {
            this.#inFlight.delete(id)
            this.#activeChannels.delete(channelId)
            this.#schedule()
          })
      }
    })
  }
  async #run(initial: CommandExecutionRecord): Promise<CommandExecutionRecord> {
    const store = this.#o.repository.commands
    let record = store.get(initial.id) ?? initial
    if (record.status === 'pending' && (this.#disposed || !this.#ready)) return record
    if (record.status === 'pending' && store.claim(record.id)) {
      record = store.get(record.id)!
      const controller = new AbortController()
      this.#controllers.add(controller)
      let command: RegisteredCommand | undefined
      try {
        if (record.rawText.length > 16000) throw new Error('命令文本过长，最多支持 16000 字符。')
        const [, name = '', argumentText = ''] = /^(\S+)([\s\S]*)$/u.exec(record.rawText.trimStart().slice(1)) ?? []
        command = this.#resolve(name, record.channelId)
        const binding = this.#o.repository.getBinding(record.channelId)
        const revision = binding === undefined ? undefined : this.#o.repository.getAgent(binding.agentId)?.revision
        record = store.update({
          ...record,
          commandName: command.fullName,
          commandVersion: command.extensionRevisionId ?? 'builtin:1',
          ...(command.extensionRevisionId === undefined ? {} : { extensionRevisionId: command.extensionRevisionId }),
          ...(binding === undefined ? {} : { agentId: binding.agentId }),
          ...(revision === undefined ? {} : { agentRevisionId: revision.id }),
        })
        this.#publish(record)
        const guard = (management = false) => {
          controller.signal.throwIfAborted()
          const current = this.#o.repository.getBinding(record.channelId)
          if (current?.agentId !== binding?.agentId || current?.boundAt !== binding?.boundAt)
            throw new Error('频道绑定已变化，请重新执行命令。')
          const policy = this.catalog(record.channelId, record.identity).find((c) => c.fullName === command!.fullName)
          if (!policy) throw new Error('命令所属扩展已停用。')
          if (!policy.enabled) throw new Error('此命令已禁用。')
          if (
            (policy.permission === 'channel-admin' || management) &&
            !this.#authorized(record.channelId, record.identity)
          )
            throw new SilentCommandError('无权执行此命令，需要此频道的命令管理授权。')
          if (policy.unavailableReason !== undefined) throw new Error(policy.unavailableReason)
          if (!binding && !['help', 'status'].includes(command!.fullName)) throw new Error('请先为频道绑定智能体。')
        }
        guard()
        const args = parseCommandArguments(command.definition, tokenizeCommand(argumentText))
        const stop = async () => {
          guard(true)
          await this.#o.channels().stopCurrentTurn(record.channelId, undefined, () => guard(true))
        }
        const reset = async (mode: 'clear' | 'compact') => {
          guard(true)
          const episode =
            binding === undefined ? undefined : this.#o.repository.getActiveEpisode(record.channelId, binding.agentId)
          if (episode) await this.#o.channels().resetEpisode(episode.id, mode, () => guard(true))
        }
        const context: CommandExecutionContext = {
          channelId: record.channelId,
          ...(binding === undefined ? {} : { agentId: binding.agentId }),
          identity: Object.freeze({ ...record.identity }),
          arguments: args,
          signal: controller.signal,
          host: {
            status: () => {
              guard()
              return this.#status(record.channelId)
            },
            stop,
            reset,
          },
        }
        let result: CommandResult
        if (command.extensionRevisionId !== undefined) {
          try {
            result = await command.invoke(context)
          } catch (error) {
            if (error instanceof SilentCommandError) throw error
            throw new Error(controller.signal.aborted ? '命令已取消。' : '扩展命令执行失败，请检查扩展状态。')
          }
        } else
          switch (command.fullName) {
            case 'help': {
              const target = args['命令']
              const available = this.catalog(record.channelId, record.identity).filter((c) => c.available)
              if (typeof target === 'string') {
                const found = this.#resolve(target.replace(/^\//u, ''), record.channelId)
                const entry = available.find((c) => c.fullName === found.fullName)
                if (!entry) throw new SilentCommandError('该命令不可用或无权查看。')
                result = reply(
                  [
                    entry.usage,
                    entry.definition.description,
                    ...entry.definition.parameters.map((p) => `${p.name}：${p.description ?? p.type}`),
                    ...entry.definition.examples,
                  ].join('\n'),
                )
              } else result = reply(available.map((c) => `${c.usage} — ${c.definition.description}`).join('\n'))
              break
            }
            case 'status': {
              const status = this.#status(record.channelId)
              result = reply(
                `频道：${this.#channel(record.channelId).displayName ?? '当前频道'}\n智能体：${revision?.displayName ?? '未绑定'}\n响应模式：${status.responseMode ?? '未绑定'}\n运行状态：${status.running ? '运行中' : '空闲'}`,
              )
              break
            }
            case 'stop':
              await stop()
              result = reply('当前轮次已停止，上下文已保留。')
              break
            case 'reset':
              await reset('clear')
              result = reply('当前上下文已清空，聊天历史已保留。')
              break
            case 'compact':
              await reset('compact')
              result = reply('当前上下文已压缩。')
              break
            case 'off':
            case 'on': {
              const off = command.fullName === 'off'
              await this.#o.channels().updateCommandResponsePolicy(
                binding!,
                () => guard(true),
                (current) => {
                  if (off) {
                    if (current.triggerPolicy !== 'observe-only') store.saveResponsePolicy(current)
                    return 'observe-only'
                  }
                  return (
                    store.savedResponsePolicy(current) ??
                    (this.#channel(record.channelId).kind === 'group' ? 'mentioned-or-replied' : 'always')
                  )
                },
              )
              result = reply(off ? '已切换为仅观察，仍可使用命令。' : '已恢复响应策略。')
              break
            }
            default:
              throw new Error('未实现的内置命令。')
          }
        result = CommandResultSchema.parse(result)
        for (const part of result.parts)
          if (
            (part.type === 'image' || part.type === 'file') &&
            !this.#o.repository.canAccessAsset(part.assetId, record.channelId)
          )
            throw new Error('命令结果引用了当前频道无权访问的资源。')
        record = store.update({ ...record, status: 'succeeded', result, completedAt: this.#o.now() })
      } catch (error) {
        const message = error instanceof Error ? error.message : '命令执行失败。'
        const detail =
          message + (command === undefined ? '' : `\n用法：${commandUsage(command.definition, command.fullName)}`)
        record = store.update({
          ...record,
          status: 'failed',
          error: detail,
          result: reply(detail),
          ...(record.source === 'platform' && error instanceof SilentCommandError ? { replySuppressed: true } : {}),
          completedAt: this.#o.now(),
        })
      } finally {
        this.#controllers.delete(controller)
      }
    }
    if (record.status === 'running' || record.status === 'pending') return record
    if (record.replySuppressed) {
      this.#publish(record)
      return record
    }
    const existing = store.reply(record.id)
    if (existing) {
      if (record.replyIntentId !== existing.id) {
        record = store.update({ ...record, replyIntentId: existing.id })
        this.#publish(record)
      }
      return record
    }
    if (record.replyError !== undefined) return record
    try {
      await this.#o.channels().sendCommandReply({
        channelId: record.channelId,
        executionId: record.id,
        parts: record.result?.parts ?? reply(record.error ?? '结果不确定。').parts,
        ...(record.eventId === undefined ? {} : { eventId: record.eventId }),
        onPlanned: (id) => {
          record = store.update({ ...record, replyIntentId: id })
        },
      })
    } catch {
      record = store.update({ ...record, replyError: '命令结果已记录，但回复未能投递。' })
    }
    this.#publish(record)
    return record
  }
  #publish(record: CommandExecutionRecord): void {
    if (record.eventId) {
      const event = this.#o.repository.getChannelEvent(record.eventId)
      if (event) this.#o.channels().publishInboundFact(event)
    }
  }
}
