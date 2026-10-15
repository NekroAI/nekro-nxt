import { describe, expect, it } from 'vitest'
import { CommandRateLimiter } from '../src/commands/rate-limit.js'

const limiter = (clock: { now: number }) =>
  new CommandRateLimiter(() => clock.now, { perUser: 2, perChannel: 3, windowMs: 1000 })

describe('command rate limiter', () => {
  it('limits each user separately and releases them as the window slides', () => {
    const clock = { now: 0 }
    const limit = limiter(clock)
    expect(limit.admit('chn', 'a')).toBe('allowed')
    expect(limit.admit('chn', 'a')).toBe('allowed')
    expect(limit.admit('chn', 'a')).toBe('user-limited')
    clock.now = 1001
    expect(limit.admit('chn', 'a')).toBe('allowed')
  })

  it('caps the whole channel so many users cannot add up to a flood', () => {
    const clock = { now: 0 }
    const limit = limiter(clock)
    expect(limit.admit('chn', 'a')).toBe('allowed')
    expect(limit.admit('chn', 'b')).toBe('allowed')
    expect(limit.admit('chn', 'c')).toBe('allowed')
    expect(limit.admit('chn', 'd')).toBe('channel-limited')
    // Another channel is independent.
    expect(limit.admit('other', 'd')).toBe('allowed')
  })

  it('does not count refused attempts against the window', () => {
    const clock = { now: 0 }
    const limit = limiter(clock)
    limit.admit('chn', 'a')
    limit.admit('chn', 'a')
    for (let index = 0; index < 10; index += 1) expect(limit.admit('chn', 'a')).toBe('user-limited')
    clock.now = 1001
    expect(limit.admit('chn', 'a')).toBe('allowed')
  })
})
