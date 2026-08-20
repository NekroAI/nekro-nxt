import { afterEach, describe, expect, it } from 'vitest'
import { isWorkPath, readLastChannelId, workHomePath, writeLastChannelId } from '../src/shell/last-channel.js'

const memory = new Map<string, string>()

describe('workHomePath', () => {
  afterEach(() => {
    memory.clear()
  })

  it('opens the remembered channel when it still exists', () => {
    const previous = globalThis.window
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        localStorage: {
          getItem: (key: string) => memory.get(key) ?? null,
          setItem: (key: string, value: string) => {
            memory.set(key, value)
          },
        },
      },
    })
    try {
      writeLastChannelId('chn_library')
      expect(readLastChannelId()).toBe('chn_library')
      expect(workHomePath({ channels: [{ id: 'chn_web' }, { id: 'chn_library' }], agents: [{ id: 'agt_a' }] })).toBe(
        '/work/channels/chn_library',
      )
    } finally {
      if (previous === undefined) Reflect.deleteProperty(globalThis, 'window')
      else Object.defineProperty(globalThis, 'window', { configurable: true, value: previous })
    }
  })

  it('falls back to the first channel, then the first agent, then the empty create state', () => {
    expect(workHomePath({ channels: [{ id: 'chn_web' }], agents: [{ id: 'agt_a' }] })).toBe('/work/channels/chn_web')
    expect(workHomePath({ channels: [], agents: [{ id: 'agt_a' }] })).toBe('/work/agents/agt_a')
    expect(workHomePath({ channels: [], agents: [] })).toBe('/work/agents/new')
  })

  it('only treats the /work route family as the work mode', () => {
    expect(isWorkPath('/work')).toBe(true)
    expect(isWorkPath('/work/channels/chn_web')).toBe(true)
    expect(isWorkPath('/work/agents/agt_a')).toBe(true)
    expect(isWorkPath('/work/creator')).toBe(true)
    expect(isWorkPath('/channels/chn_web')).toBe(false)
    expect(isWorkPath('/connections')).toBe(false)
    expect(isWorkPath('/settings')).toBe(false)
  })
})
