import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HOST_FORCE_EXIT_WAIT_MS,
  HOST_STOP_GRACE_MS,
  waitForHostShutdown,
  type HostStopWaitReason,
} from '../src/host-shutdown.ts'

const deferred = () => {
  let finish!: () => void
  const exited = new Promise<void>((resolve) => {
    finish = resolve
  })
  return { exited, finish }
}

describe('Desktop shutdown deadline', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('clears the deadline when cooperative exit finishes', async () => {
    const { exited, finish } = deferred()
    const forceTerminate = vi.fn()
    const onWaiting = vi.fn<(reason: string, signal: AbortSignal) => void>()
    const stop = waitForHostShutdown({ exited, forceTerminate, onWaiting })
    finish()
    await stop
    await vi.advanceTimersByTimeAsync(HOST_STOP_GRACE_MS + HOST_FORCE_EXIT_WAIT_MS)
    expect(forceTerminate).not.toHaveBeenCalled()
    expect(onWaiting).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('escalates at the deadline, but still waits for the actual exit', async () => {
    const { exited, finish } = deferred()
    const forceTerminate = vi.fn()
    const onWaiting = vi.fn()
    const done = vi.fn()
    const stop = waitForHostShutdown({ exited, forceTerminate, onWaiting }).then(done)
    await vi.advanceTimersByTimeAsync(HOST_STOP_GRACE_MS - 1)
    expect(forceTerminate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(forceTerminate).toHaveBeenCalledOnce()
    expect(done).not.toHaveBeenCalled()
    finish()
    await stop
    expect(onWaiting).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports protected operations without terminating them and dismisses notice on completion', async () => {
    const { exited, finish } = deferred()
    const onWaiting = vi.fn<(reason: HostStopWaitReason, signal: AbortSignal) => void>()
    const done = vi.fn()
    const stop = waitForHostShutdown({ exited, onWaiting }).then(done)
    await vi.advanceTimersByTimeAsync(HOST_STOP_GRACE_MS)
    expect(onWaiting).toHaveBeenCalledWith('protected-operation', expect.any(AbortSignal))
    const signal = onWaiting.mock.calls[0]![1]
    expect(signal.aborted).toBe(false)
    expect(done).not.toHaveBeenCalled()
    finish()
    await stop
    expect(signal.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['throws', 'no-exit'] as const)('surfaces failed forced termination: %s', async (mode) => {
    const { exited, finish } = deferred()
    const onWaiting = vi.fn()
    const stop = waitForHostShutdown({
      exited,
      onWaiting,
      forceTerminate: () => {
        if (mode === 'throws') throw new Error('synthetic permission error')
      },
    })
    await vi.advanceTimersByTimeAsync(HOST_STOP_GRACE_MS + HOST_FORCE_EXIT_WAIT_MS)
    expect(onWaiting).toHaveBeenCalledOnce()
    expect(onWaiting).toHaveBeenCalledWith('force-failed', expect.any(AbortSignal))
    finish()
    await stop
    expect(vi.getTimerCount()).toBe(0)
  })
})
