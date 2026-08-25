import { describe, expect, it } from 'vitest'
import { parseOverlayVisibility } from '../src/overlay-visibility.ts'

describe('Desktop Overlay visibility contract', () => {
  it('accepts repeatable list and reauthentication intents while rejecting malformed input', () => {
    expect(parseOverlayVisibility({ state: 'open', intent: { kind: 'list' } })).toEqual({
      state: 'open',
      intent: { kind: 'list' },
    })
    const reauthenticate = { state: 'open', intent: { kind: 'reauthenticate', profileId: 'remote-1' } }
    expect(parseOverlayVisibility(reauthenticate)).toEqual(reauthenticate)
    expect(parseOverlayVisibility(reauthenticate)).toEqual(reauthenticate)
    expect(parseOverlayVisibility({ state: 'open', intent: { kind: 'reauthenticate', profileId: '' } })).toBeUndefined()
    expect(parseOverlayVisibility({ state: 'open', intent: { kind: 'reauthenticate' } })).toBeUndefined()
    expect(parseOverlayVisibility('open')).toBeUndefined()
    expect(parseOverlayVisibility({ state: 'closing' })).toEqual({ state: 'closing' })
  })
})
