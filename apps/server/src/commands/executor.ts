import {
  COMMAND_MAX_PROGRESS_REPLIES,
  CommandResultSchema,
  parseCommandArguments,
  tokenizeCommand,
  commandUsage,
  type ChannelId,
  type CommandExecutionContext,
  type CommandExecutionRecord,
  type CommandResult,
} from '@nekro-nxt/contracts'
import type { ChannelRuntime } from '@nekro-nxt/channel-runtime'
import type { SqliteCoreRepository } from '@nekro-nxt/storage-sqlite'
import { RESPONSE_MODE_LABELS } from './builtins.js'
import type { CommandDirectory } from './catalog.js'
import { mutateRecord, type CommandReplies } from './replies.js'
import {
  UnauthorizedCommandError,
  textResult,
  type CommandGovernancePort,
  type CommandObserver,
  type CommandRunCapabilities,
  type RegisteredCommand,
} from './types.js'

export const COMMAND_MAX_RAW_TEXT = 16_000
const MAX_PARALLEL_CHANNELS = 4

export interface CommandExecutorOptions {
  readonly repository: SqliteCoreRepository
  readonly directory: CommandDirectory
  readonly replies: CommandReplies
  readonly channels: () => ChannelRuntime
  readonly running: (sessionId: string) => boolean
  readonly now: () => number
  readonly publish: (record: CommandExecutionRecord) => void
  readonly observer?: CommandObserver
  readonly deferExecution?: boolean
  readonly governance?: () => CommandGovernancePort | undefined
}

interface QueuedCommand {
  readonly record: CommandExecutionRecord
  readonly resolve: (record: CommandExecutionRecord) => void
  readonly reject: (error: unknown) => void
}

/**
 * Runs commands: per-channel order, a few channels in parallel, one handler call per execution. Only the business
 * operation holds a channel slot; replies are delivered afterwards and in the background, so a slow receipt never
 * delays a following `/stop`.
 */
export class CommandExecutor {
  readonly #o: CommandExecutorOptions
  readonly #inFlight = new Map<string, Promise<CommandExecutionRecord>>()
  readonly #controllers = new Set<AbortController>()
  readonly #queue = new Map<string, QueuedCommand>()
  readonly #activeChannels = new Set<ChannelId>()
  #scheduled: NodeJS.Immediate | undefined
  #ready: boolean
  #disposed = false

  constructor(options: CommandExecutorOptions) {
    this.#o = options
    this.#ready = options.deferExecution !== true
  }

  /** Allows queued and recovered commands to start. */
  open(): void {
    this.#ready = true
  }

  execute(record: CommandExecutionRecord): Promise<CommandExecutionRecord> {
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

  background(record: CommandExecutionRecord): void {
    void this.execute(record).catch(() => {
      // Handler and transport failures are persisted by #run; this only keeps a storage failure from escaping.
      console.warn(`[nekro-nxt] 命令 ${record.id} 后台执行中断，持久记录将在重启时恢复。`)
    })
  }

  async idle(): Promise<void> {
    while (this.#inFlight.size) await Promise.allSettled(this.#inFlight.values())
    await this.#o.replies.idle()
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
    for (const controller of this.#controllers) controller.abort()
    await Promise.allSettled(this.#inFlight.values())
  }

  #schedule(): void {
    if (this.#scheduled || this.#disposed || !this.#ready || !this.#queue.size) return
    // Yield the inbound commit to its transport before invoking any extension or planning a reply.
    this.#scheduled = setImmediate(() => {
      this.#scheduled = undefined
      for (const [id, task] of this.#queue) {
        if (this.#activeChannels.size >= MAX_PARALLEL_CHANNELS) break
        const channelId = task.record.channelId
        if (this.#activeChannels.has(channelId)) continue
        this.#queue.delete(id)
        this.#activeChannels.add(channelId)
        void this.#run(task.record)
          .finally(() => {
            // Only business operations share the channel queue; a slow receipt must not delay /stop.
            this.#activeChannels.delete(channelId)
            this.#schedule()
          })
          .then(async (record) => {
            await this.#o.replies.flush(record.id)
            return this.#o.repository.commands.get(record.id) ?? record
          })
          .then(task.resolve, task.reject)
          .finally(() => this.#inFlight.delete(id))
      }
    })
  }

  async #run(initial: CommandExecutionRecord): Promise<CommandExecutionRecord> {
    const repository = this.#o.repository
    const store = repository.commands
    let record = store.get(initial.id) ?? initial
    if (record.status === 'pending' && (this.#disposed || !this.#ready)) return record
    if (record.status !== 'pending' || !store.claim(record.id)) {
      this.#o.publish(record)
      return record
    }
    const id = record.id
    const patch = (change: Partial<CommandExecutionRecord>): CommandExecutionRecord =>
      mutateRecord(repository, id, (current) => ({ ...current, ...change }))
    record = store.get(id)!
    const controller = new AbortController()
    this.#controllers.add(controller)
    let command: RegisteredCommand | undefined
    try {
      if (record.rawText.length > COMMAND_MAX_RAW_TEXT)
        throw new Error(`命令文本过长，最多支持 ${COMMAND_MAX_RAW_TEXT} 字符。`)
      const [, name = '', argumentText = ''] = /^(\S+)([\s\S]*)$/u.exec(record.rawText.trimStart().slice(1)) ?? []
      command = this.#o.directory.resolve(name, record.channelId)
      const channel = repository.getChannel(record.channelId)
      const binding = repository.getBinding(record.channelId)
      const revision = binding === undefined ? undefined : repository.getAgent(binding.agentId)?.revision
      record = patch({
        commandName: command.fullName,
        commandVersion: command.extensionRevisionId ?? 'builtin:1',
        ...(command.extensionRevisionId === undefined ? {} : { extensionRevisionId: command.extensionRevisionId }),
        ...(binding === undefined ? {} : { agentId: binding.agentId }),
        ...(revision === undefined ? {} : { agentRevisionId: revision.id }),
        // Console runs in an external channel stay in the console unless the command declares otherwise.
        ...(record.source === 'web' && channel?.kind !== 'internal' && command.definition.consoleReply !== 'channel'
          ? { replyLocal: true, replySuppressed: true }
          : {}),
      })
      this.#o.publish(record)
      const invoked = command
      const guard = (management = false): void => {
        controller.signal.throwIfAborted()
        const current = repository.getBinding(record.channelId)
        if (current?.agentId !== binding?.agentId || current?.boundAt !== binding?.boundAt)
          throw new Error('频道绑定已变化，请重新执行命令。')
        const entry = this.#o.directory
          .entries(record.channelId, record.identity)
          .find((candidate) => candidate.fullName === invoked.fullName)
        if (!entry) throw new Error('命令所属扩展已停用。')
        if (!entry.enabled) throw new Error('此命令已禁用。')
        const required = management && entry.permission === 'public' ? 'channel-admin' : entry.permission
        if (!this.#o.directory.authorized(record.channelId, record.identity, required))
          throw new UnauthorizedCommandError(
            required === 'admin'
              ? '无权执行此命令，只有 NekroNXT 管理员可以使用。'
              : '无权执行此命令，需要管理员在 NekroNXT 中授予此频道的命令管理权限。',
          )
        if (entry.unavailableReason !== undefined) throw new Error(entry.unavailableReason)
        if (!binding && !['help', 'status', 'admin'].includes(invoked.fullName))
          throw new Error('请先为频道绑定智能体。')
      }
      guard()
      const args = parseCommandArguments(command.definition, tokenizeCommand(argumentText))
      const context: CommandExecutionContext = {
        channelId: record.channelId,
        ...(binding === undefined ? {} : { agentId: binding.agentId }),
        identity: Object.freeze({ ...record.identity }),
        arguments: args,
        signal: controller.signal,
        reply: (result) => {
          controller.signal.throwIfAborted()
          const parsed = CommandResultSchema.parse(result)
          this.#assertAssets(record.channelId, parsed)
          const updated = mutateRecord(repository, id, (current) => {
            const progress = current.replies.filter((reply) => reply.kind === 'progress').length
            if (progress >= COMMAND_MAX_PROGRESS_REPLIES)
              throw new Error(`一次命令最多发送 ${COMMAND_MAX_PROGRESS_REPLIES} 条过程回复。`)
            return {
              ...current,
              replies: [...current.replies, { ordinal: current.replies.length, kind: 'progress', parts: parsed.parts }],
            }
          })
          this.#o.publish(updated)
          // Ordered background delivery; the handler never waits for a receipt.
          void this.#o.replies.flush(id)
        },
        host: {
          status: () => {
            guard()
            return this.#status(record.channelId)
          },
          stop: async () => {
            guard(true)
            const outcome = await this.#o.channels().stopCurrentTurn(record.channelId, undefined, () => guard(true))
            return { stopped: outcome.result === 'stopped' }
          },
          reset: async (mode) => {
            guard(true)
            const episode =
              binding === undefined ? undefined : repository.getActiveEpisode(record.channelId, binding.agentId)
            if (episode) await this.#o.channels().resetEpisode(episode.id, mode, () => guard(true))
          },
        },
      }
      const capabilities = this.#capabilities(record, binding?.boundAt, guard)
      let result: CommandResult
      if (command.extensionRevisionId === undefined) {
        result = await command.invoke(context, capabilities)
      } else {
        const seconds = command.definition.timeoutSeconds
        let timer: NodeJS.Timeout | undefined
        let timedOut = false
        // A stuck handler must not hold the channel queue (and the /stop or /pause behind it) indefinitely.
        const deadline = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            timedOut = true
            controller.abort(new Error('timeout'))
            reject(new Error(`扩展命令超过 ${seconds} 秒未完成，已取消。`))
          }, seconds * 1000)
        })
        const running = Promise.resolve().then(() => invoked.invoke(context, capabilities))
        // After a timeout the handler may still settle; its outcome no longer matters.
        running.catch(() => undefined)
        try {
          result = await Promise.race([running, deadline])
        } catch (error) {
          if (timedOut || error instanceof UnauthorizedCommandError) throw error
          throw new Error(controller.signal.aborted ? '命令已取消。' : '扩展命令执行失败，请检查扩展状态。')
        } finally {
          clearTimeout(timer)
        }
      }
      result = CommandResultSchema.parse(result)
      this.#assertAssets(record.channelId, result)
      record = this.#settle(id, { status: 'succeeded', result })
    } catch (error) {
      const message = error instanceof Error ? error.message : '命令执行失败。'
      const unauthorized = error instanceof UnauthorizedCommandError
      const detail =
        message +
        (command === undefined || unauthorized ? '' : `\n用法：${commandUsage(command.definition, command.fullName)}`)
      record = this.#settle(id, {
        status: 'failed',
        error: detail,
        result: textResult(detail),
        // The administrator decides whether platform members hear that they lack a grant.
        ...(record.source === 'platform' && unauthorized && !repository.commands.unauthorizedFeedback()
          ? { replySuppressed: true }
          : {}),
      })
    } finally {
      this.#controllers.delete(controller)
    }
    this.#o.publish(record)
    return record
  }

  /** Records the outcome and its final reply in one write; older settled executions are compacted afterwards. */
  #settle(
    id: string,
    outcome: Pick<CommandExecutionRecord, 'status'> & Partial<CommandExecutionRecord>,
  ): CommandExecutionRecord {
    const settled = mutateRecord(this.#o.repository, id, (current) => {
      const parts = outcome.result?.parts ?? textResult(outcome.error ?? '结果不确定。').parts
      const progress = current.replies.filter((reply) => reply.kind === 'progress')
      return {
        ...current,
        ...outcome,
        completedAt: this.#o.now(),
        replies: [...progress, { ordinal: progress.length, kind: 'final', parts }],
      }
    })
    try {
      this.#o.repository.commands.compact(settled.channelId)
    } catch {
      // Compaction is housekeeping; it must never turn a finished command into a failure.
    }
    try {
      this.#o.observer?.settled?.(settled)
    } catch {
      // Diagnostics cannot affect the result.
    }
    return settled
  }

  #assertAssets(channelId: ChannelId, result: CommandResult): void {
    for (const part of result.parts)
      if (
        (part.type === 'image' || part.type === 'file') &&
        !this.#o.repository.canAccessAsset(part.assetId, channelId)
      )
        throw new Error('命令结果引用了当前频道无权访问的资源。')
  }

  #status(channelId: ChannelId) {
    const binding = this.#o.repository.getBinding(channelId)
    const episode = binding === undefined ? undefined : this.#o.repository.getActiveEpisode(channelId, binding.agentId)
    return {
      bound: binding !== undefined,
      ...(binding === undefined
        ? {}
        : { responseMode: RESPONSE_MODE_LABELS[binding.triggerPolicy], paused: binding.paused }),
      running: episode?.dshSessionId !== undefined && this.#o.running(episode.dshSessionId),
    }
  }

  #capabilities(
    record: CommandExecutionRecord,
    boundAt: number | undefined,
    guard: (management?: boolean) => void,
  ): CommandRunCapabilities {
    const repository = this.#o.repository
    return {
      help: (target) => {
        const available = this.#o.directory
          .entries(record.channelId, record.identity)
          .filter((entry) => entry.available)
        if (typeof target !== 'string') {
          return textResult(
            available.map((entry) => `${entry.usage} — ${entry.definition.description}`).join('\n') || '没有可用命令。',
          )
        }
        const found = this.#o.directory.resolve(target.replace(/^\//u, ''), record.channelId)
        const entry = available.find((candidate) => candidate.fullName === found.fullName)
        if (!entry) throw new Error('该命令不可用，或你没有使用它的权限。')
        return textResult(
          [
            entry.usage,
            entry.definition.description,
            ...entry.definition.parameters.map((p) => `${p.name}：${p.description ?? p.type}`),
            ...entry.definition.examples,
          ].join('\n'),
        )
      },
      statusText: () => {
        const status = this.#status(record.channelId)
        const channel = repository.getChannel(record.channelId)
        const binding = repository.getBinding(record.channelId)
        const agent = binding === undefined ? undefined : repository.getAgent(binding.agentId)?.revision.displayName
        return `频道：${channel?.displayName ?? '当前频道'}\n智能体：${agent ?? '未绑定'}\n响应模式：${status.responseMode ?? '未绑定'}\n暂停状态：${status.paused === true ? '已暂停' : '未暂停'}\n运行状态：${status.running ? '运行中' : '空闲'}`
      },
      pause: async () => {
        const outcome = await this.#o.channels().setPaused(record.channelId, true, {
          ...(boundAt === undefined ? {} : { boundAt }),
          guard: () => guard(true),
        })
        return { changed: outcome.changed, stopped: outcome.stopped }
      },
      resume: async () => {
        const outcome = await this.#o.channels().setPaused(record.channelId, false, {
          ...(boundAt === undefined ? {} : { boundAt }),
          guard: () => guard(true),
        })
        return { changed: outcome.changed }
      },
      ...this.#governance(record),
    }
  }

  #governance(record: CommandExecutionRecord): Pick<CommandRunCapabilities, 'governance'> {
    const port = this.#o.governance?.()
    if (!port) return {}
    const binding = this.#o.repository.getBinding(record.channelId)
    const context = {
      channelId: record.channelId,
      ...(binding === undefined ? {} : { agentId: binding.agentId }),
      identity: record.identity,
      administrator: this.#o.directory.administrator(record.identity),
    }
    return {
      governance: {
        administrator: context.administrator,
        ext: (input) => port.ext(input, context),
        admin: (input) => port.admin(input, context),
      },
    }
  }
}
