import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomId } from '../src/random-id.js'

afterEach(() => vi.unstubAllGlobals())

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

describe('randomId', () => {
  it('builds a v4 UUID where plain-HTTP LAN access leaves crypto.randomUUID undefined', () => {
    const native = globalThis.crypto
    vi.stubGlobal('crypto', { getRandomValues: (array: Uint8Array<ArrayBuffer>) => native.getRandomValues(array) })
    const ids = Array.from({ length: 64 }, randomId)
    for (const id of ids) expect(id).toMatch(UUID_V4)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('uses the native function in a secure context', () => {
    vi.stubGlobal('crypto', { randomUUID: () => '00000000-0000-4000-8000-000000000000' })
    expect(randomId()).toBe('00000000-0000-4000-8000-000000000000')
  })
})
