import type { ChannelMemberId } from '@nekro-nxt/contracts'

/** Timers the runtime arms for waits and debounce; tests pass a manual clock. */
export interface ResponseTimerPort {
  set(callback: () => void, ms: number): unknown
  clear(handle: unknown): void
}

const pendingTimers = new Map<number, ReturnType<typeof setTimeout>>()
let timerSequence = 0

export const systemTimers: ResponseTimerPort = {
  set: (callback, ms) => {
    timerSequence += 1
    const id = timerSequence
    const handle = setTimeout(() => {
      pendingTimers.delete(id)
      callback()
    }, ms)
    handle.unref?.()
    pendingTimers.set(id, handle)
    return id
  },
  clear: (id) => {
    if (typeof id !== 'number') return
    clearTimeout(pendingTimers.get(id))
    pendingTimers.delete(id)
  },
}

export type WaitEndCause = 'quiet' | 'limit'

interface Wait {
  readonly memberId: ChannelMemberId
  readonly quietMs: number
  readonly startedAt: number
  readonly limitAt: number
  handle: unknown
  readonly onEnd: (cause: WaitEndCause, waitedMs: number) => void
}

interface Debounce {
  readonly firstAt: number
  count: number
  handle: unknown
  flush: () => void
}

/**
 * In-memory timing state per lane (channel + agent): the wait for one speaker to finish, debounce of a speaker's
 * burst, who recently talked with the agent, and the rate of name and attention wakes. Nothing here survives a
 * restart (Decision 2026-10-31 R5).
 */
export class ResponseTiming {
  readonly #now: () => number
  readonly #timers: ResponseTimerPort
  readonly #waits = new Map<string, Wait>()
  /** First wait start per lane and speaker, so re-waiting after an interruption stays inside the total limit. */
  readonly #chains = new Map<string, { readonly memberId: ChannelMemberId; readonly startedAt: number }>()
  /** Lanes whose current turn was opened by a finished wait and may not wait again. */
  readonly #blocked = new Set<string>()
  readonly #lastSpeaker = new Map<string, ChannelMemberId>()
  readonly #debounces = new Map<string, Debounce>()
  readonly #attention = new Map<string, Map<ChannelMemberId, number>>()
  readonly #midWakes = new Map<string, number[]>()

  constructor(now: () => number, timers: ResponseTimerPort) {
    this.#now = now
    this.#timers = timers
  }

  waitingFor(lane: string): ChannelMemberId | undefined {
    return this.#waits.get(lane)?.memberId
  }

  waitState(lane: string): { readonly memberId: ChannelMemberId; readonly until: number } | undefined {
    const wait = this.#waits.get(lane)
    return wait === undefined ? undefined : { memberId: wait.memberId, until: wait.limitAt }
  }

  startWait(
    lane: string,
    memberId: ChannelMemberId,
    quietMs: number,
    totalMs: number,
    onEnd: (cause: WaitEndCause, waitedMs: number) => void,
  ): void {
    this.#clearWait(lane)
    const now = this.#now()
    const chain = this.#chains.get(lane)
    const startedAt = chain?.memberId === memberId ? chain.startedAt : now
    this.#chains.set(lane, { memberId, startedAt })
    const wait: Wait = { memberId, quietMs, startedAt, limitAt: startedAt + totalMs, handle: undefined, onEnd }
    this.#waits.set(lane, wait)
    this.#arm(lane, wait)
  }

  /** The awaited speaker said more: restart the quiet period, never past the total limit. */
  extendWait(lane: string): void {
    const wait = this.#waits.get(lane)
    if (wait === undefined) return
    this.#timers.clear(wait.handle)
    this.#arm(lane, wait)
  }

  /** Another signal opened a turn; the chain stays so a renewed wait keeps the original limit. */
  cancelWait(lane: string): void {
    this.#clearWait(lane)
  }

  blocked(lane: string): boolean {
    return this.#blocked.has(lane)
  }

  /** A turn that did not come from a finished wait clears the block. */
  unblock(lane: string): void {
    this.#blocked.delete(lane)
  }

  noteSpeaker(lane: string, memberId: ChannelMemberId): void {
    this.#lastSpeaker.set(lane, memberId)
  }

  lastSpeaker(lane: string): ChannelMemberId | undefined {
    return this.#lastSpeaker.get(lane)
  }

  /** The agent sent a message: the wait chain ends and everyone it is talking with stays in attention. */
  agentSpoke(lane: string, attentionMs: number): void {
    this.#chains.delete(lane)
    const members = this.#attention.get(lane)
    if (members === undefined) return
    const now = this.#now()
    for (const [memberId, at] of members) if (now - at < attentionMs) members.set(memberId, now)
  }

  /**
   * Collects a speaker's burst. Each message restarts the quiet period; the burst flushes once it is quiet, has run
   * `maxMs` since its first message, or holds `maxMessages`. `flush` always runs the newest callback; without one the
   * message only joins a burst already collecting.
   */
  debounce(key: string, quietMs: number, maxMs: number, maxMessages: number, flush?: () => void): void {
    const now = this.#now()
    const current = this.#debounces.get(key)
    let entry: Debounce
    if (current !== undefined) {
      this.#timers.clear(current.handle)
      entry = current
      if (flush !== undefined) entry.flush = flush
    } else if (flush !== undefined) {
      entry = { firstAt: now, count: 0, handle: undefined, flush }
    } else {
      return
    }
    entry.count += 1
    this.#debounces.set(key, entry)
    const remaining = Math.min(quietMs, entry.firstAt + maxMs - now)
    if (entry.count >= maxMessages || remaining <= 0) {
      this.#debounces.delete(key)
      entry.flush()
      return
    }
    entry.handle = this.#timers.set(() => {
      if (this.#debounces.get(key) !== entry) return
      this.#debounces.delete(key)
      entry.flush()
    }, remaining)
  }

  debouncing(key: string): boolean {
    return this.#debounces.has(key)
  }

  noteAttention(lane: string, memberId: ChannelMemberId): void {
    const members = this.#attention.get(lane) ?? new Map<ChannelMemberId, number>()
    members.set(memberId, this.#now())
    this.#attention.set(lane, members)
  }

  inAttention(lane: string, memberId: ChannelMemberId, attentionMs: number): boolean {
    const at = this.#attention.get(lane)?.get(memberId)
    return at !== undefined && this.#now() - at < attentionMs
  }

  midWakeAvailable(lane: string, perMinute: number): boolean {
    const now = this.#now()
    const recent = (this.#midWakes.get(lane) ?? []).filter((at) => now - at < 60_000)
    this.#midWakes.set(lane, recent)
    return recent.length < perMinute
  }

  recordMidWake(lane: string): void {
    const recent = this.#midWakes.get(lane) ?? []
    recent.push(this.#now())
    this.#midWakes.set(lane, recent)
  }

  /** The binding changed or went away: forget everything for the lane. */
  clearLane(lane: string): void {
    this.#clearWait(lane)
    this.#chains.delete(lane)
    this.#blocked.delete(lane)
    this.#lastSpeaker.delete(lane)
    this.#attention.delete(lane)
    this.#midWakes.delete(lane)
    for (const [key, entry] of this.#debounces) {
      if (key === lane || key.startsWith(`${lane}\u0000`)) {
        this.#timers.clear(entry.handle)
        this.#debounces.delete(key)
      }
    }
  }

  dispose(): void {
    for (const wait of this.#waits.values()) this.#timers.clear(wait.handle)
    for (const entry of this.#debounces.values()) this.#timers.clear(entry.handle)
    this.#waits.clear()
    this.#debounces.clear()
  }

  #arm(lane: string, wait: Wait): void {
    const now = this.#now()
    const quietAt = now + wait.quietMs
    const cause: WaitEndCause = quietAt < wait.limitAt ? 'quiet' : 'limit'
    wait.handle = this.#timers.set(
      () => {
        if (this.#waits.get(lane) !== wait) return
        this.#waits.delete(lane)
        this.#chains.delete(lane)
        this.#blocked.add(lane)
        wait.onEnd(cause, this.#now() - wait.startedAt)
      },
      Math.max(0, Math.min(quietAt, wait.limitAt) - now),
    )
  }

  #clearWait(lane: string): void {
    const wait = this.#waits.get(lane)
    if (wait === undefined) return
    this.#timers.clear(wait.handle)
    this.#waits.delete(lane)
  }
}
