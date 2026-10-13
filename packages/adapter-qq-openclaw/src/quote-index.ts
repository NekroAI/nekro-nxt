import type { AdapterScopedStateStore } from '@nekro-nxt/adapter-sdk'
import type { ChannelId } from '@nekro-nxt/contracts'
import { z } from 'zod'

const EntrySchema = z.object({ channelId: z.string(), messageId: z.string().max(2048), refIndex: z.string().max(2048) })
const StateSchema = z.object({ appId: z.string(), entries: z.array(EntrySchema) })
type Entry = z.infer<typeof EntrySchema>
const STATE_KEY = 'qq-quote-index-v1'
// Scoped state is one JSON row per connection. Keep its size bounded, including after account changes.
export const QQ_QUOTE_INDEX_LIMIT = 4096

/** Observed pairs only: QQ's message IDs and reference indexes are not interchangeable. */
export class QQQuoteIndex {
  #entries: Entry[] = []
  #loaded = false
  #tail: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly appId: string,
    private readonly state?: AdapterScopedStateStore,
  ) {}

  #run<T>(action: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(async () => {
      if (!this.#loaded) {
        const parsed = StateSchema.safeParse(await this.state?.load(STATE_KEY))
        this.#entries =
          parsed.success && parsed.data.appId === this.appId ? parsed.data.entries.slice(-QQ_QUOTE_INDEX_LIMIT) : []
        this.#loaded = true
      }
      return action()
    })
    this.#tail = result.catch(() => undefined)
    return result
  }

  remember(channelId: ChannelId, messageId: string, refIndex: string): Promise<void> {
    return this.#run(async () => {
      const entry = EntrySchema.parse({ channelId, messageId, refIndex })
      this.#entries = this.#entries.filter(
        (item) => item.channelId !== channelId || (item.messageId !== messageId && item.refIndex !== refIndex),
      )
      this.#entries.push(entry)
      this.#entries = this.#entries.slice(-QQ_QUOTE_INDEX_LIMIT)
      // Retain the observed pair in memory if persistence fails; the next write retries the complete journal.
      await this.state?.save(STATE_KEY, { appId: this.appId, entries: this.#entries })
    })
  }

  messageId(channelId: ChannelId, refIndex: string): Promise<string | undefined> {
    return this.#run(() =>
      Promise.resolve(
        this.#entries.find((item) => item.channelId === channelId && item.refIndex === refIndex)?.messageId,
      ),
    )
  }

  refIndex(channelId: ChannelId, messageId: string): Promise<string | undefined> {
    return this.#run(() =>
      Promise.resolve(
        this.#entries.find((item) => item.channelId === channelId && item.messageId === messageId)?.refIndex,
      ),
    )
  }
}
