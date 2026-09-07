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
