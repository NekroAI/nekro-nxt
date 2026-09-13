import type { HostApiResponse } from '@nekro-nxt/contracts'
import {
  emptyPlatformUserDirectory,
  platformUserFilterKey,
  type PlatformUserDirectory,
  type PlatformUserFilter,
} from './product-model.js'
import { StaleHostReadError } from './host-api-client.js'

type Page = HostApiResponse<'listPlatformUsers'>
export function createPlatformUserDirectoryLoader(options: {
  readonly read: (input: PlatformUserFilter & { limit: number; cursor?: string }, signal: AbortSignal) => Promise<Page>
  readonly get: () => PlatformUserDirectory
  readonly write: (directory: PlatformUserDirectory, facets?: Page['facets']) => void
}) {
  let generation = 0
  let filter: PlatformUserFilter | undefined
  let pages = 1
  let controller: AbortController | undefined
  let inFlight: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let dirty = false
  let more: Promise<void> | undefined
  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  const cancel = () => {
    generation += 1
    clearTimer()
    controller?.abort()
    filter = undefined
    inFlight = undefined
    more = undefined
    dirty = false
    const old = options.get()
    if (old.loading || old.loadingMore) options.write({ ...old, loading: false, loadingMore: false })
  }
  const schedule = () => {
    if (!filter || !dirty || inFlight || more || timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      if (filter) void load(filter)
    }, 220)
  }
  const load = (input: PlatformUserFilter, older = false): Promise<void> => {
    const key = platformUserFilterKey(input)
    if (!filter || platformUserFilterKey(filter) !== key) {
      cancel()
      filter = input
      pages = 1
    }
    if (inFlight) {
      if (!older) return inFlight
      if (!more) {
        const token = generation
        more = inFlight.then(() => {
          more = undefined
          if (token === generation) return load(input, true)
          return undefined
        })
      }
      return more
    }
    const previous = options.get()
    if (older && (!previous.nextCursor || previous.key !== key)) {
      schedule()
      return Promise.resolve()
    }
    clearTimer()
    const token = generation
    const backgroundDirty = dirty
    if (!older) dirty = false
    controller = new AbortController()
    const signal = controller.signal
    const initial = previous.key === key ? previous : emptyPlatformUserDirectory(key)
    options.write({ ...initial, loading: !older, loadingMore: older, error: '' })
    const task = (async () => {
      try {
        let cursor = older ? previous.nextCursor : undefined
        let result: Page | undefined
        const items = older ? [...previous.items] : []
        let loaded = 0
        do {
          result = await options.read({ ...input, limit: 50, ...(cursor ? { cursor } : {}) }, signal)
          if (token !== generation) return
          items.push(...result.items)
          cursor = result.nextCursor
          loaded += 1
        } while (!older && cursor && loaded < pages)
        pages = older ? pages + 1 : loaded
        options.write(
          {
            key,
            items: [...new Map(items.map((item) => [item.identityId, item])).values()],
            total: result.total,
            nextCursor: result.nextCursor,
            loading: false,
            loadingMore: false,
            error: '',
          },
          result.facets,
        )
      } catch (cause) {
        if (token !== generation || cause instanceof StaleHostReadError) return
        options.write({
          ...initial,
          loading: false,
          loadingMore: false,
          error: cause instanceof Error ? cause.message : String(cause),
        })
        // New invalidations may retry after the bounded window; failures alone never spin.
      } finally {
        if (token === generation) {
          inFlight = undefined
          if (older) dirty ||= backgroundDirty
          schedule()
        }
      }
    })()
    inFlight = task
    return task
  }
  return {
    load,
    cancel,
    invalidate: () => {
      if (filter) {
        dirty = true
        schedule()
      }
    },
  }
}
