import type { AdapterChannelDirectory, AdapterScopedStateStore } from '@nekro-nxt/adapter-sdk'
import type { ChannelId } from '@nekro-nxt/contracts'
import { isQQTransportError } from './transport-error.js'
import { z } from 'zod'

export type QQGroupInfoResult =
  { readonly status: 'available'; readonly name: string } | { readonly status: 'unsupported' }
const cacheSchema = z.object({ nextCheckAt: z.number().finite().nonnegative() })
const REFRESH_MS = 24 * 60 * 60 * 1000
const RETRY_MS = 5 * 60 * 1000
// Below the platform's 30 QPM ceiling; duplicate messages share one queue.
const INTERVAL_MS = 3000

/** Metadata runs after message commit and cannot postpone or reject that message. */
export class QQGroupInfoSync {
  readonly #channels: AdapterChannelDirectory
  readonly #state: AdapterScopedStateStore
  readonly #now: () => number
  readonly #read: (groupId: string, signal: AbortSignal) => Promise<QQGroupInfoResult>
  readonly #queue = new Map<string, ChannelId>()
  #abort = new AbortController()
  #timer: ReturnType<typeof setTimeout> | undefined
  #task: Promise<void> | undefined
  #stopped = true
  #denied = false
  #nextRequestAt = 0

  constructor(
    input: { channels: AdapterChannelDirectory; state: AdapterScopedStateStore; now: () => number },
    read: (groupId: string, signal: AbortSignal) => Promise<QQGroupInfoResult>,
  ) {
    this.#channels = input.channels
    this.#state = input.state
    this.#now = input.now
    this.#read = read
  }
  start(): void {
    this.#abort = new AbortController()
    this.#stopped = false
    this.#denied = false
  }
  schedule(groupId: string, channelId: ChannelId): void {
    if (this.#stopped || this.#denied || this.#queue.size >= 64) return
    this.#queue.set(groupId, channelId)
    this.#schedule()
  }
  async stop(): Promise<void> {
    this.#stopped = true
    this.#abort.abort()
    clearTimeout(this.#timer)
    this.#timer = undefined
    this.#queue.clear()
    await this.#task
  }
  #schedule(): void {
    if (this.#stopped || this.#denied || this.#task || this.#timer || this.#queue.size === 0) return
    this.#timer = setTimeout(
      () => {
        this.#timer = undefined
        this.#task = this.#next()
          .catch(() => undefined)
          .finally(() => {
            this.#task = undefined
            this.#schedule()
          })
      },
      Math.max(0, this.#nextRequestAt - this.#now()),
    )
    this.#timer.unref()
  }
  async #next(): Promise<void> {
    const next = this.#queue.entries().next().value
    if (!next) return
    const [groupId, channelId] = next
    this.#queue.delete(groupId)
    const key = `group-info/${groupId}`
    const cached = cacheSchema.safeParse(await this.#state.load(key))
    if (this.#stopped || (cached.success && cached.data.nextCheckAt > this.#now())) return
    this.#nextRequestAt = this.#now() + INTERVAL_MS
    let delay = RETRY_MS
    try {
      const result = await this.#read(groupId, this.#abort.signal)
      if (this.#stopped) return
      if (result.status === 'unsupported') {
        this.#denied = true
        this.#queue.clear()
        await this.#state.save('group-info/access', { status: 'unsupported', checkedAt: this.#now() })
        return
      }
      await this.#channels.updateDisplayName(channelId, result.name)
      await this.#state.save('group-info/access', { status: 'available', checkedAt: this.#now() })
      delay = REFRESH_MS
    } catch (error) {
      if (this.#stopped) return
      if (isQQTransportError(error) && error.kind === 'rate-limited') {
        delay = Math.max(RETRY_MS, error.retryAfterMs ?? 0)
        this.#nextRequestAt = this.#now() + delay
      }
    }
    if (!this.#stopped) await this.#state.save(key, { nextCheckAt: this.#now() + delay })
  }
}
