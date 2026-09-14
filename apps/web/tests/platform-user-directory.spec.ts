import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProductRuntime } from '../src/product-runtime.js'

const page = (total: number) => ({ total, items: [], facets: { adapters: [], connections: [] } })
const response = (total: number) => ({ ok: true, status: 200, json: () => Promise.resolve(page(total)) })
afterEach(() => vi.unstubAllGlobals())

describe('platform user directory ownership', () => {
  it('keeps a newer filter result when the superseded request ignores cancellation', async () => {
    const pending: Array<(value: ReturnType<typeof response>) => void> = []
    const signals: AbortSignal[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, options: RequestInit) => {
        if (options.signal) signals.push(options.signal)
        return new Promise((resolve) => pending.push(resolve))
      }),
    )
    const runtime = createProductRuntime()
    const older = runtime.store.getState().loadPlatformUserDirectory({ query: '旧查询' })
    const newer = runtime.store.getState().loadPlatformUserDirectory({ query: '新查询' })
    expect(signals[0]?.aborted).toBe(true)
    pending[1]!(response(2))
    await newer
    pending[0]!(response(99))
    await older
    expect(runtime.store.getState().platformUserDirectory).toMatchObject({ total: 2, loading: false, error: '' })
  })

  it('does not publish a late error after the directory consumer leaves', async () => {
    let reject!: (cause: Error) => void
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((_resolve, fail) => {
            reject = fail
          }),
      ),
    )
    const runtime = createProductRuntime()
    const request = runtime.store.getState().loadPlatformUserDirectory({})
    runtime.store.getState().cancelPlatformUserDirectory()
    const directory = runtime.store.getState().platformUserDirectory
    reject(new Error('late failure'))
    await request
    expect(runtime.store.getState().platformUserDirectory).toBe(directory)
  })
})

it('does not postpone or abort refreshes under sustained revision changes', async () => {
  vi.useFakeTimers()
  try {
    const pending: Array<(value: ReturnType<typeof response>) => void> = []
    const signals: AbortSignal[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, options: RequestInit) => {
        signals.push(options.signal!)
        return new Promise((resolve) => pending.push(resolve))
      }),
    )
    const runtime = createProductRuntime()
    const initial = runtime.store.getState().loadPlatformUserDirectory({})
    pending[0]!(response(1))
    await initial
    for (let revision = 1; revision <= 7; revision += 1) {
      runtime.store.setState({ platformUsersRevision: revision })
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(pending).toHaveLength(2)
    expect(signals[1]?.aborted).toBe(false)
    pending[1]!(response(2))
    await vi.advanceTimersByTimeAsync(0)
    expect(runtime.store.getState().platformUserDirectory.total).toBe(2)
    await vi.advanceTimersByTimeAsync(220)
    expect(pending).toHaveLength(3)
    runtime.store.getState().cancelPlatformUserDirectory()
    expect(signals[2]?.aborted).toBe(true)
    pending[2]!(response(99))
    await vi.advanceTimersByTimeAsync(0)
    expect(runtime.store.getState().platformUserDirectory.total).toBe(2)
  } finally {
    vi.useRealTimers()
  }
})

it('refreshes the loaded cursor depth and publishes all pages atomically', async () => {
  vi.useFakeTimers()
  try {
    let refreshing = false
    const cursors: Array<string | null> = []
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        const cursor = new URL(url, 'http://example.test').searchParams.get('cursor')
        cursors.push(cursor)
        const nextCursor = cursor === null ? 'pid_page2' : cursor === 'pid_page2' ? 'pid_page3' : undefined
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ ...page(refreshing ? 6 : 3), nextCursor }),
        })
      }),
    )
    const runtime = createProductRuntime()
    await runtime.store.getState().loadPlatformUserDirectory({})
    await runtime.store.getState().loadPlatformUserDirectory({}, true)
    await runtime.store.getState().loadPlatformUserDirectory({}, true)
    const totals: number[] = []
    const stop = runtime.store.subscribe((state) => totals.push(state.platformUserDirectory.total))
    refreshing = true
    runtime.store.setState({ platformUsersRevision: 1 })
    await vi.advanceTimersByTimeAsync(220)
    expect(cursors).toEqual([null, 'pid_page2', 'pid_page3', null, 'pid_page2', 'pid_page3'])
    expect(totals.filter((value) => value === 6)).toHaveLength(1)
    stop()
    runtime.store.getState().cancelPlatformUserDirectory()
  } finally {
    vi.useRealTimers()
  }
})
