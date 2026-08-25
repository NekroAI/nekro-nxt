import { describe, expect, it, vi } from 'vitest'
import { LocalHostLifecycleRelay, localHostStatusForLifecycleEvent } from '../src/local-host-state.ts'

describe('Desktop local Host lifecycle state', () => {
  it('maps only lifecycle commit points to local profile health', () => {
    expect(localHostStatusForLifecycleEvent('initial-ready')).toBe('ready')
    expect(localHostStatusForLifecycleEvent('restarting')).toBe('unstable')
    expect(localHostStatusForLifecycleEvent('recovered')).toBe('ready')
    expect(localHostStatusForLifecycleEvent('fatal')).toBe('offline')
  })

  it('retains transitions during manager construction and stops delivery during disposal', () => {
    const relay = new LocalHostLifecycleRelay()
    relay.commit('initial-ready')
    relay.commit('restarting')

    const sink = vi.fn()
    const detach = relay.subscribe(sink)
    expect(sink).toHaveBeenLastCalledWith('unstable')

    relay.commit('recovered')
    expect(sink).toHaveBeenLastCalledWith('ready')
    detach()
    relay.commit('fatal')
    expect(relay.status).toBe('offline')
    expect(sink).toHaveBeenCalledTimes(2)
  })
})
