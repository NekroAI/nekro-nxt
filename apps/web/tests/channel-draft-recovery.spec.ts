import { afterEach, describe, expect, it, vi } from 'vitest'
import { readChannelDraftRecovery, saveChannelDraftRecovery } from '../src/channel-draft-recovery.js'

afterEach(() => vi.unstubAllGlobals())

describe('channel draft recovery across a release refresh', () => {
  it('restores text while dropping stale request identity', () => {
    const storage = new Map<string, string>()
    vi.stubGlobal('window', {
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    })
    expect(saveChannelDraftRecovery({ channel: { text: '未发送的合成草稿', revision: 9, pending: 3 } })).toBe(true)
    expect(readChannelDraftRecovery()).toEqual({ channel: { text: '未发送的合成草稿', revision: 0 } })
    expect(saveChannelDraftRecovery({})).toBe(true)
    expect(readChannelDraftRecovery()).toEqual({})
  })

  it('keeps refresh blocked when tab storage is unavailable', () => {
    vi.stubGlobal('window', {
      sessionStorage: {
        setItem: () => {
          throw new Error('quota')
        },
      },
    })
    expect(saveChannelDraftRecovery({ channel: { text: '示例', revision: 0 } })).toBe(false)
    expect(readChannelDraftRecovery()).toEqual({})
  })
})
