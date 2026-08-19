import { describe, expect, it } from 'vitest'
import { isNearBottom } from '../src/pages/channel-scroll.js'

describe('isNearBottom', () => {
  it('treats the last 80 pixels as the follow zone', () => {
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 920, clientHeight: 80 })).toBe(true)
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 800, clientHeight: 80 })).toBe(false)
  })
})
