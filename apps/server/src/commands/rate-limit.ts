export interface CommandRateLimits {
  /** Executions one platform user may start in a channel per window. */
  readonly perUser: number
  /** Executions a channel may start per window, whoever sends them. */
  readonly perChannel: number
  readonly windowMs: number
}

export const DEFAULT_COMMAND_RATE_LIMITS: CommandRateLimits = { perUser: 10, perChannel: 30, windowMs: 60_000 }

export type CommandAdmission = 'allowed' | 'user-limited' | 'channel-limited'

/**
 * Sliding-window limiter for platform-originated commands. Commands cost no model tokens, so without a cap any
 * group member could make the account post and the Host store records at will. Counted per attempt that is let
 * through; refused attempts leave no execution record, only a counter. State is in memory: a restart only loosens
 * the window, which is acceptable for abuse protection.
 */
export class CommandRateLimiter {
  readonly #limits: CommandRateLimits
  readonly #now: () => number
  readonly #windows = new Map<string, number[]>()
  #calls = 0

  constructor(now: () => number, limits: CommandRateLimits = DEFAULT_COMMAND_RATE_LIMITS) {
    this.#now = now
    this.#limits = limits
  }

  admit(channelId: string, userKey: string): CommandAdmission {
    const now = this.#now()
    if (++this.#calls % 1000 === 0) this.#sweep(now)
    const user = this.#recent(`u:${channelId}:${userKey}`, now)
    const channel = this.#recent(`c:${channelId}`, now)
    if (user.length >= this.#limits.perUser) return 'user-limited'
    if (channel.length >= this.#limits.perChannel) return 'channel-limited'
    user.push(now)
    channel.push(now)
    return 'allowed'
  }

  #recent(key: string, now: number): number[] {
    let window = this.#windows.get(key)
    if (window === undefined) {
      window = []
      this.#windows.set(key, window)
    }
    const cutoff = now - this.#limits.windowMs
    let drop = 0
    while (drop < window.length && window[drop]! <= cutoff) drop += 1
    if (drop > 0) window.splice(0, drop)
    return window
  }

  #sweep(now: number): void {
    const cutoff = now - this.#limits.windowMs
    for (const [key, window] of this.#windows) {
      if (window.length === 0 || window[window.length - 1]! <= cutoff) this.#windows.delete(key)
    }
  }
}
