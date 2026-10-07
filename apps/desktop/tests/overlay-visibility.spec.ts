import { describe, expect, it } from 'vitest'
import { parseOverlayAnchor, parseOverlayVisibility } from '../src/overlay-visibility.ts'

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

  it('carries the switcher button position so the panel opens below it', () => {
    expect(parseOverlayVisibility({ state: 'open', intent: { kind: 'list' }, anchor: { left: 136.4 } })).toEqual({
      state: 'open',
      intent: { kind: 'list' },
      anchor: { left: 136 },
    })
    // 位置无效时退回默认位置，而不是拒绝打开。
    expect(parseOverlayVisibility({ state: 'open', intent: { kind: 'list' }, anchor: { left: -5 } })).toEqual({
      state: 'open',
      intent: { kind: 'list' },
    })
    expect(parseOverlayAnchor({ left: Number.NaN })).toBeUndefined()
    expect(parseOverlayAnchor({ left: '100' })).toBeUndefined()
    expect(parseOverlayAnchor(undefined)).toBeUndefined()
  })
})
