import { expect, it, vi } from 'vitest'
import { createOwnedHostQuery, type HostQueryState } from '../src/owned-host-query.js'
import { StaleHostReadError } from '../src/host-api-client.js'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

it('coalesces invalidations during a read into one trailing request', async () => {
  const first = deferred<string>()
  const second = deferred<string>()
  let state: HostQueryState<string> = { data: undefined, loading: false, error: '' }
  const read = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  const query = createOwnedHostQuery<string>(read, (patch) => {
    state = { ...state, ...patch }
  })
  const loading = query.load()
  await Promise.resolve()
  expect(query.load(true)).toBe(loading)
  expect(query.load(true)).toBe(loading)
  first.resolve('old')
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2))
  second.resolve('new')
  await expect(loading).resolves.toBe('new')
  expect(state).toEqual({ data: 'new', loading: false, error: '' })
})

it('a committed response supersedes pending reads, including late errors', async () => {
  for (const fail of [false, true]) {
    const pending = deferred<string>()
    let state: HostQueryState<string> = { data: 'before', loading: false, error: '' }
    const query = createOwnedHostQuery(
      () => pending.promise,
      (patch) => {
        state = { ...state, ...patch }
      },
    )
    const loading = query.load()
    const rejected = expect(loading).rejects.toBeInstanceOf(StaleHostReadError)
    query.replace('saved')
    if (fail) pending.reject(new Error('late failure'))
    else pending.resolve('stale')
    await rejected
    expect(state).toEqual({ data: 'saved', loading: false, error: '' })
  }
})

it('cancels requests without letting their completion reset a newer read', async () => {
  const first = deferred<string>()
  const second = deferred<string>()
  let state: HostQueryState<string> = { data: 'cached', loading: false, error: '' }
  const signals: AbortSignal[] = []
  const query = createOwnedHostQuery(
    (signal) => {
      signals.push(signal)
      return signals.length === 1 ? first.promise : second.promise
    },
    (patch) => {
      state = { ...state, ...patch }
    },
  )
  const old = query.load()
  await Promise.resolve()
  const rejected = expect(old).rejects.toBeInstanceOf(StaleHostReadError)
  query.cancel()
  expect(signals[0]?.aborted).toBe(true)
  const current = query.load()
  first.resolve('old')
  await rejected
  expect(state.loading).toBe(true)
  second.resolve('current')
  await current
  expect(state.data).toBe('current')
})

it('preserves cached data on failure and allows retry after a synchronous failure', async () => {
  let state: HostQueryState<string> = { data: 'cached', loading: false, error: '' }
  const read = vi
    .fn<() => Promise<string>>()
    .mockImplementationOnce(() => {
      throw new Error('failed')
    })
    .mockResolvedValue('retry')
  const query = createOwnedHostQuery(read, (patch) => {
    state = { ...state, ...patch }
  })
  await expect(query.load()).rejects.toThrow('failed')
  expect(state).toEqual({ data: 'cached', loading: false, error: 'failed' })
  await query.load()
  expect(state).toEqual({ data: 'retry', loading: false, error: '' })
})
