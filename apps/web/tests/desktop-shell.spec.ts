import { describe, expect, it } from 'vitest'
import { DesktopPresentationOrdering } from '../src/desktop-shell.ts'

describe('Desktop presentation revision ordering', () => {
  it('keeps a newer subscribed event when an older initial request resolves later', () => {
    const ordering = new DesktopPresentationOrdering()
    expect(ordering.accept({ revision: 8, displayName: '北辰实例', status: 'offline' }, 'subscription')).toBe(true)
    expect(ordering.accept({ revision: 7, displayName: '旧实例名称', status: 'ready' }, 'initial')).toBe(false)
    expect(ordering.accept({ revision: 9, displayName: '北辰实例', status: 'ready' }, 'subscription')).toBe(true)
    expect(ordering.accept({ revision: 8, displayName: '北辰实例', status: 'offline' }, 'subscription')).toBe(false)
  })

  it('accepts a legacy initial shape before any subscription event', () => {
    const ordering = new DesktopPresentationOrdering()
    expect(ordering.accept({ displayName: '旧版远程实例', status: 'ready' }, 'initial')).toBe(true)
  })

  it('orders legacy subscription shapes by arrival and rejects a late legacy initial result', () => {
    const ordering = new DesktopPresentationOrdering()
    expect(ordering.accept({ displayName: '旧版远程实例', status: 'offline' }, 'subscription')).toBe(true)
    expect(ordering.accept({ displayName: '旧版远程实例', status: 'ready' }, 'subscription')).toBe(true)
    expect(ordering.accept({ displayName: '迟到初始值', status: 'connecting' }, 'initial')).toBe(false)
  })
})
