import { describe, expect, it } from 'vitest'
import { CommunityReadCache, COMMUNITY_READ_TTL_MS } from '../src/community-cache.js'

const createCache = (options: { maxEntries?: number } = {}) => {
  let now = 1_790_000_000_000
  let calls = 0
  let failure: Error | undefined
  const cache = new CommunityReadCache({
    now: () => now,
    ...options,
    isGone: (error) => error instanceof Error && error.message === 'gone',
  })
  const load = (label: string) => () => {
    calls += 1
    return failure ? Promise.reject(failure) : Promise.resolve({ label, call: calls })
  }
  return {
    cache,
    load,
    calls: () => calls,
    advance: (ms: number) => {
      now += ms
    },
    now: () => now,
    fail: (error: Error | undefined) => {
      failure = error
    },
  }
}

describe('CommunityReadCache', () => {
  it('returns the cached copy within five minutes and fetches again after', async () => {
    const { cache, load, calls, advance, now } = createCache()
    const first = await cache.read('list', false, load('a'))
    expect(first).toEqual({ label: 'a', call: 1, fetchedAt: now(), stale: false })
    advance(COMMUNITY_READ_TTL_MS - 1)
    expect(await cache.read('list', false, load('a'))).toEqual(first)
    expect(calls()).toBe(1)
    advance(1)
    expect(await cache.read('list', false, load('a'))).toMatchObject({ call: 2, fetchedAt: now(), stale: false })
    expect(calls()).toBe(2)
  })

  it('keeps separate entries per key and shares one request between concurrent misses', async () => {
    const { cache, load, calls } = createCache()
    const [one, two] = await Promise.all([cache.read('a', false, load('a')), cache.read('a', false, load('a'))])
    expect(one).toEqual(two)
    expect(calls()).toBe(1)
    expect(await cache.read('b', false, load('b'))).toMatchObject({ label: 'b' })
    expect(calls()).toBe(2)
  })

  it('refresh skips the fresh copy and replaces it', async () => {
    const { cache, load, calls, advance, now } = createCache()
    await cache.read('list', false, load('a'))
    advance(1_000)
    const refreshed = await cache.read('list', true, load('a'))
    expect(refreshed).toMatchObject({ call: 2, fetchedAt: now(), stale: false })
    expect(await cache.read('list', false, load('a'))).toEqual(refreshed)
    expect(calls()).toBe(2)
  })

  it('returns the older copy marked stale when the community fails, and the error when nothing is cached', async () => {
    const { cache, load, advance, fail } = createCache()
    const first = await cache.read('list', false, load('a'))
    advance(COMMUNITY_READ_TTL_MS + 1)
    fail(new Error('无法连接社区'))
    expect(await cache.read('list', false, load('a'))).toEqual({ ...first, stale: true })
    expect(await cache.read('list', true, load('a'))).toEqual({ ...first, stale: true })
    await expect(cache.read('other', false, load('b'))).rejects.toThrow('无法连接社区')
    fail(undefined)
    expect(await cache.read('list', false, load('a'))).toMatchObject({ call: 5, stale: false })
  })

  it('drops the older copy when the item is gone', async () => {
    const { cache, load, advance, fail } = createCache()
    await cache.read('detail', false, load('a'))
    advance(COMMUNITY_READ_TTL_MS)
    fail(new Error('gone'))
    await expect(cache.read('detail', false, load('a'))).rejects.toThrow('gone')
    fail(new Error('无法连接社区'))
    await expect(cache.read('detail', false, load('a'))).rejects.toThrow('无法连接社区')
  })

  it('evicts the oldest entries past the cap', async () => {
    const { cache, load, calls } = createCache({ maxEntries: 3 })
    for (const key of ['a', 'b', 'c', 'd']) await cache.read(key, false, load(key))
    expect(cache.size).toBe(3)
    await cache.read('b', false, load('b'))
    expect(calls()).toBe(4)
    await cache.read('a', false, load('a'))
    expect(calls()).toBe(5)
  })

  it('forgets everything on clear and does not keep a read that started before it', async () => {
    const { cache, load, calls } = createCache()
    await cache.read('a', false, load('a'))
    cache.clear()
    expect(cache.size).toBe(0)
    let release: () => void = () => undefined
    const pending = cache.read('b', false, async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return { label: 'b', call: 0 }
    })
    await Promise.resolve()
    cache.clear()
    release()
    expect(await pending).toMatchObject({ label: 'b' })
    expect(cache.size).toBe(0)
    await cache.read('a', false, load('a'))
    expect(calls()).toBe(2)
  })
})
