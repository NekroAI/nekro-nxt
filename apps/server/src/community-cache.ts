export const COMMUNITY_READ_TTL_MS = 5 * 60_000
export const COMMUNITY_READ_MAX_ENTRIES = 100

/** When a cached community read was fetched, and whether it is an older copy kept because the community failed. */
export interface CommunityFreshness {
  readonly fetchedAt: number
  readonly stale: boolean
}

interface Entry {
  readonly value: object
  readonly fetchedAt: number
}

/** A cached read as the route returns it; the route checks it against its response contract. */
export type CommunityCachedRead = object & CommunityFreshness

/**
 * Public community catalog reads (extension and persona lists and details) kept in memory for this process, so page
 * turns and list/detail switches do not reach the community again. Entries are fresh for five minutes; expired ones
 * stay until evicted and are returned marked stale when a new fetch fails. Restarting the app starts empty.
 */
export class CommunityReadCache {
  readonly #entries = new Map<string, Entry>()
  readonly #inflight = new Map<string, Promise<Entry>>()
  readonly #now: () => number
  readonly #ttlMs: number
  readonly #maxEntries: number
  readonly #isGone: (error: unknown) => boolean
  #generation = 0

  constructor(
    options: {
      readonly now?: () => number
      readonly ttlMs?: number
      readonly maxEntries?: number
      /** Failures that mean the item is gone; its older copy is dropped instead of returned. */
      readonly isGone?: (error: unknown) => boolean
    } = {},
  ) {
    this.#now = options.now ?? Date.now
    this.#ttlMs = options.ttlMs ?? COMMUNITY_READ_TTL_MS
    this.#maxEntries = options.maxEntries ?? COMMUNITY_READ_MAX_ENTRIES
    this.#isGone = options.isGone ?? (() => false)
  }

  get size(): number {
    return this.#entries.size
  }

  /**
   * The cached value for `key` while fresh, otherwise `load()`'s result. `refresh` skips the fresh copy and replaces
   * it. A failed load falls back to the older copy unless the community says the item no longer exists.
   */
  async read(key: string, refresh: boolean, load: () => Promise<object>): Promise<CommunityCachedRead> {
    const entry = this.#entries.get(key)
    if (!refresh && entry && this.#now() - entry.fetchedAt < this.#ttlMs) {
      return { ...entry.value, fetchedAt: entry.fetchedAt, stale: false }
    }
    try {
      const { value, fetchedAt } = await this.#load(key, load)
      return { ...value, fetchedAt, stale: false }
    } catch (error) {
      if (this.#isGone(error)) {
        this.#entries.delete(key)
        throw error
      }
      const fallback = this.#entries.get(key)
      if (!fallback) throw error
      return { ...fallback.value, fetchedAt: fallback.fetchedAt, stale: true }
    }
  }

  /** Concurrent misses for one key share a single community request. */
  async #load(key: string, load: () => Promise<object>): Promise<Entry> {
    const running = this.#inflight.get(key)
    if (running) return running
    const generation = this.#generation
    const promise = load()
      .then((value) => {
        const fetchedAt = this.#now()
        // A read started before the community or account changed is returned to its caller but not kept.
        if (generation === this.#generation) this.#store(key, { value, fetchedAt })
        return { value, fetchedAt }
      })
      .finally(() => {
        if (this.#inflight.get(key) === promise) this.#inflight.delete(key)
      })
    this.#inflight.set(key, promise)
    return promise
  }

  #store(key: string, entry: Entry): void {
    this.#entries.delete(key)
    this.#entries.set(key, entry)
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value
      if (oldest === undefined) break
      this.#entries.delete(oldest)
    }
  }

  clear(): void {
    this.#generation += 1
    this.#entries.clear()
    this.#inflight.clear()
  }
}
