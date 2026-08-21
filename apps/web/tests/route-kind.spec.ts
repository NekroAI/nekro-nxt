import { describe, expect, it } from 'vitest'
import { canvasKind, needsCanvasMorph } from '../src/shell/route-kind.ts'

describe('canvasKind', () => {
  it('keeps channel switches in the same canvas kind', () => {
    expect(canvasKind('/work/channels/a')).toBe('work-channel')
    expect(canvasKind('/work/channels/b')).toBe('work-channel')
    expect(needsCanvasMorph('/work/channels/a', '/work/channels/b')).toBe(false)
  })

  it('morphs when leaving a conversation for another work surface', () => {
    expect(needsCanvasMorph('/work/channels/a', '/work/agents/agt_1')).toBe(true)
    expect(needsCanvasMorph('/work/channels/a', '/connections')).toBe(true)
  })
})
