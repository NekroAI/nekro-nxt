import { describe, expect, it } from 'vitest'
import { VirtualClock } from '../src/index.ts'

describe('VirtualClock', () => {
  it('runs due tasks in time and registration order', () => {
    const clock = new VirtualClock(100)
    const events: string[] = []
    clock.setTimeout(() => events.push('late'), 20)
    clock.setTimeout(() => events.push('first'), 10)
    clock.setTimeout(() => events.push('second'), 10)
    clock.advanceBy(20)
    expect(events).toEqual(['first', 'second', 'late'])
    expect(clock.now()).toBe(120)
    expect(clock.pendingCount()).toBe(0)
  })

  it('supports cancellation and callbacks that schedule more work', () => {
    const clock = new VirtualClock()
    const events: string[] = []
    const cancel = clock.setTimeout(() => events.push('cancelled'), 1)
    cancel()
    clock.setTimeout(() => {
      events.push('outer')
      clock.setTimeout(() => events.push('inner'), 1)
    }, 1)
    clock.advanceBy(2)
    expect(events).toEqual(['outer', 'inner'])
  })

  it('rejects invalid time values', () => {
    expect(() => new VirtualClock(Number.NaN)).toThrow(TypeError)
    const clock = new VirtualClock()
    expect(() => clock.setTimeout(() => undefined, -1)).toThrow(TypeError)
    expect(() => clock.advanceBy(Number.POSITIVE_INFINITY)).toThrow(TypeError)
  })
})
