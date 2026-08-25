import { describe, expect, it } from 'vitest'
import { ProfileGenerationRegistry, type ProfileGenerationReason } from '../src/profile-generation.ts'

describe('Desktop profile generation registry', () => {
  it('invalidates captured work for every manager mutation commit point', () => {
    const registry = new ProfileGenerationRegistry()
    registry.register('remote-1')
    for (const reason of [
      'switch',
      'update',
      'reauthenticate',
      'remove',
      'dispose',
    ] as const satisfies readonly ProfileGenerationReason[]) {
      const before = registry.capture('remote-1')
      const after = registry.advance('remote-1', reason)
      expect(registry.isCurrent(before), reason).toBe(false)
      expect(registry.isCurrent(after), reason).toBe(true)
    }
    registry.remove('remote-1')
    expect(registry.isCurrent({ profileId: 'remote-1', generation: 5 })).toBe(false)
  })
})
