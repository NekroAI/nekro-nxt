import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChannelIdSchema, type JsonValue } from '@nekro-nxt/contracts'
import { QQGroupInfoSync, type QQGroupInfoResult } from '../src/group-info.js'

afterEach(() => vi.useRealTimers())
const fixture = (read: (id: string, signal: AbortSignal) => Promise<QQGroupInfoResult>) => {
  const id = ChannelIdSchema.parse('chn_groupInfo')
  const update = vi.fn(() => Promise.resolve())
  const state = new Map<string, JsonValue>()
  const sync = new QQGroupInfoSync(
    {
      now: () => Date.now(),
      channels: {
        ensure: () => Promise.resolve(id),
        updateDisplayName: update,
        resolvePlatformChannelId: () => Promise.resolve('group:fixture'),
        resolveKind: () => Promise.resolve('group'),
      },
      state: {
        load: (key) => Promise.resolve(state.get(key)),
        save: (key, value) => {
          state.set(key, value)
          return Promise.resolve()
        },
        clear: (key) => {
          state.delete(key)
          return Promise.resolve()
        },
      },
    },
    read,
  )
  sync.start()
  return { id, update, state, sync }
}
describe('QQ group information background refresh', () => {
  it('coalesces duplicate groups, refreshes daily and spaces requests below the platform limit', async () => {
    vi.useFakeTimers()
    const times: number[] = []
    const read = vi.fn(() => {
      times.push(Date.now())
      return Promise.resolve({ status: 'available' as const, name: '虚构群名' })
    })
    const { sync, id, update } = fixture(read)
    sync.schedule('first', id)
    sync.schedule('first', id)
    sync.schedule('second', id)
    await vi.advanceTimersByTimeAsync(3001)
    expect(read).toHaveBeenCalledTimes(2)
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(3000)
    expect(update).toHaveBeenCalledWith(id, '虚构群名')
    sync.schedule('first', id)
    await vi.advanceTimersByTimeAsync(3001)
    expect(read).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
    sync.schedule('first', id)
    await vi.advanceTimersByTimeAsync(1)
    expect(read).toHaveBeenCalledTimes(3)
    await sync.stop()
  })
  it('stops querying every group after a whitelist denial without changing any names', async () => {
    vi.useFakeTimers()
    const read = vi.fn(() => Promise.resolve({ status: 'unsupported' as const }))
    const { sync, id, update, state } = fixture(read)
    sync.schedule('first', id)
    sync.schedule('second', id)
    await vi.advanceTimersByTimeAsync(60_000)
    sync.schedule('third', id)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(read).toHaveBeenCalledTimes(1)
    expect(update).not.toHaveBeenCalled()
    expect(state.get('group-info/access')).toMatchObject({ status: 'unsupported' })
    await sync.stop()
  })
  it('cancels an in-flight lookup and never writes a name after stopping', async () => {
    vi.useFakeTimers()
    let aborted = false
    const { sync, id, update } = fixture(
      (_id, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              aborted = true
              reject(new Error('fixture cancellation'))
            },
            { once: true },
          )
        }),
    )
    sync.schedule('first', id)
    await vi.advanceTimersByTimeAsync(1)
    await sync.stop()
    expect(aborted).toBe(true)
    expect(update).not.toHaveBeenCalled()
  })
})
