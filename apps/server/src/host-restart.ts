import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AgentId, ChannelId, HostRestartStatus } from '@nekro-nxt/contracts'

/** Time between answering a restart and stopping, so the reply and the channel notice get out first. */
export const HOST_RESTART_DELAY_MS = 1_500

/** Shutdown drains sessions before the process ends; this is the share of the estimate it usually takes. */
const STOP_ALLOWANCE_MS = 5_000
/** A container also waits for the engine to start it again. */
const CONTAINER_ALLOWANCE_MS = 5_000

export interface HostRestartOptions {
  readonly hostKind: HostRestartStatus['hostKind']
  /**
   * Stops the service the way a shutdown signal does and ends the process with `HOST_RESTART_EXIT_CODE`. Absent where
   * nothing would start the process again (embedded and test hosts), which leaves restarting unsupported.
   */
  readonly exit?: () => void
  /** False while startup, an upgrade or a migration is still running. */
  readonly isReady: () => boolean
  /** How long this process took to become ready, the best guess of how long the next start takes. */
  readonly startupMs: () => number | undefined
  readonly schedule?: (run: () => void, delayMs: number) => void
}

/**
 * Restarting the service from the console, or after an administrator approved an agent's request (#123). The process
 * ends cleanly with a dedicated exit code; Desktop or the container restart policy starts it again.
 */
export class HostRestart {
  readonly #options: HostRestartOptions
  #requested = false

  constructor(options: HostRestartOptions) {
    this.#options = options
  }

  status(): HostRestartStatus {
    return {
      supported: this.#options.exit !== undefined,
      hostKind: this.#options.hostKind,
      estimatedSeconds: this.#estimatedSeconds(),
    }
  }

  /** Why a restart cannot start now, or undefined when it can. */
  blockedReason(): string | undefined {
    if (this.#options.exit === undefined) return '这台 NekroNXT 不能从页面重启，请在它的运行环境里重启。'
    if (!this.#options.isReady()) return 'NekroNXT 正在完成升级，完成后再重启。'
    return undefined
  }

  /** Schedules the restart and returns the estimate; asking again while one is under way changes nothing. */
  request(): { readonly estimatedSeconds: number } {
    const estimatedSeconds = this.#estimatedSeconds()
    if (this.#requested) return { estimatedSeconds }
    const blocked = this.blockedReason()
    if (blocked !== undefined) throw new Error(blocked)
    const exit = this.#options.exit
    if (exit === undefined) throw new Error('Host restart has no exit.')
    this.#requested = true
    const schedule = this.#options.schedule ?? ((run, delayMs) => void setTimeout(run, delayMs))
    schedule(exit, HOST_RESTART_DELAY_MS)
    return { estimatedSeconds }
  }

  #estimatedSeconds(): number {
    const startup = this.#options.startupMs() ?? 10_000
    const total =
      HOST_RESTART_DELAY_MS +
      STOP_ALLOWANCE_MS +
      startup +
      (this.#options.hostKind === 'server' ? CONTAINER_ALLOWANCE_MS : 0)
    // Rounded up to five seconds: an estimate, not a countdown.
    return Math.min(300, Math.max(10, Math.ceil(total / 5_000) * 5))
  }
}

/** Files an agent's restart request for an administrator; see `NekroRuntime.requestHostRestart`. */
export interface HostRestartRequester {
  request(input: { readonly agentId: AgentId; readonly channelId: ChannelId; readonly reason: string }): {
    readonly number: number
  }
}

/** What `nekro_nxt_restart` does: checks the reason and files the request, answering with its number. */
export const fileRestartRequest = (
  agentId: AgentId,
  channelId: ChannelId,
  requester: HostRestartRequester | undefined,
  reason: unknown,
): string => {
  const text = typeof reason === 'string' ? reason.trim() : ''
  if (text === '') throw new Error('写一下为什么需要重启。')
  if (requester === undefined) throw new Error('这台 NekroNXT 不能从内部重启，请告诉管理员手动重启。')
  const { number } = requester.request({ agentId, channelId, reason: text.slice(0, 500) })
  return `已在频道里发出请求 #${number}，等管理员同意。`
}

export const hostRestartTool = (
  agentId: AgentId,
  channelId: ChannelId,
  requester: () => HostRestartRequester | undefined,
) =>
  defineTool({
    name: 'nekro_nxt_restart',
    description:
      '请管理员重启 NekroNXT。很少需要：扩展开发暂停之类的状态在用户发下一条消息时就会解除。只在改过的配置一直不生效、或某个连接卡住重连不上时使用。管理员同意后才会重启，请求会发在频道里。',
    parameters: {
      reason: {
        type: 'string',
        required: true,
        description: '为什么需要重启：哪里不正常、已经试过什么。管理员会看到这段话。',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_arguments, value) => [{ type: 'text', text: value }],
    },
    execute: ({ reason }) => Promise.resolve().then(() => fileRestartRequest(agentId, channelId, requester(), reason)),
  })
