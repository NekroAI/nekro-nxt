import { describe, expect, it, vi } from 'vitest'
import { DesktopNotifier, connectionNoticeAllowed, latestPerId, type DesktopNotice } from '../src/desktop-notifier.js'

class FakeNotice implements DesktopNotice {
  readonly title: string
  readonly body: string
  shown = false
  closed = false
  readonly #listeners = new Map<string, Array<() => void>>()

  constructor(input: { readonly title: string; readonly body: string }) {
    this.title = input.title
    this.body = input.body
  }

  on(event: 'click' | 'close', listener: () => void): this {
    this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), listener])
    return this
  }

  show(): void {
    this.shown = true
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.emit('close')
  }

  emit(event: 'click' | 'close'): void {
    for (const listener of this.#listeners.get(event) ?? []) listener()
  }
}

const createNotifier = (state: { foreground: boolean; supported?: boolean }) => {
  const notices: FakeNotice[] = []
  const notifier = new DesktopNotifier({
    isSupported: () => state.supported ?? true,
    isForeground: () => state.foreground,
    create: (input) => {
      const notice = new FakeNotice(input)
      notices.push(notice)
      return notice
    },
  })
  return { notifier, notices }
}

describe('DesktopNotifier', () => {
  it('replaces the live notification of the same key and leaves other keys alone', () => {
    const { notifier, notices } = createNotifier({ foreground: false })
    const show = (key: string, title: string) => notifier.show(key, { title, body: '内容', onClick: () => undefined })
    expect(show('local:dynamic-approval:agent_a:plugin_a', '第一次')).toBe('shown')
    expect(show('local:notice:extension:ext_weather', '天气')).toBe('shown')
    expect(show('local:dynamic-approval:agent_a:plugin_a', '第二次')).toBe('shown')
    expect(notices.map((notice) => [notice.title, notice.shown, notice.closed])).toEqual([
      ['第一次', true, true],
      ['天气', true, false],
      ['第二次', true, false],
    ])
  })

  it('stays silent while the window is in front, and shows again once it is not', () => {
    const state = { foreground: true }
    const { notifier, notices } = createNotifier(state)
    expect(notifier.show('local:feedback:FB-1', { title: '反馈', body: '新进展', onClick: () => undefined })).toBe(
      'foreground',
    )
    expect(notices).toEqual([])
    state.foreground = false
    expect(notifier.show('local:feedback:FB-1', { title: '反馈', body: '新进展', onClick: () => undefined })).toBe(
      'shown',
    )
    expect(notices).toHaveLength(1)
  })

  it('does nothing where the system has no notifications', () => {
    const { notifier, notices } = createNotifier({ foreground: false, supported: false })
    expect(notifier.show('local:x', { title: '标题', body: '内容', onClick: () => undefined })).toBe('unsupported')
    expect(notices).toEqual([])
  })

  it('forgets a clicked or dismissed notification, so a later one shows without closing anything', () => {
    const { notifier, notices } = createNotifier({ foreground: false })
    const onClick = vi.fn()
    notifier.show('remote:connection', { title: '实例', body: '持续无法连接', onClick })
    notices[0]?.emit('click')
    expect(onClick).toHaveBeenCalledTimes(1)
    notifier.show('remote:connection', { title: '实例', body: '已经恢复连接', onClick })
    expect(notices[0]?.closed).toBe(false)
    expect(notices[1]?.shown).toBe(true)
  })

  it('keeps the newest notification of each id within one poll', () => {
    expect(
      latestPerId([
        { id: 'a', n: 1 },
        { id: 'b', n: 2 },
        { id: 'a', n: 3 },
      ]),
    ).toEqual([
      { id: 'b', n: 2 },
      { id: 'a', n: 3 },
    ])
  })
})

describe('connectionNoticeAllowed', () => {
  it('needs both the Desktop-wide switch and the instance system notification switch', () => {
    expect(connectionNoticeAllowed(true, { notificationsEnabled: true })).toBe(true)
    expect(connectionNoticeAllowed(false, { notificationsEnabled: true })).toBe(false)
    expect(connectionNoticeAllowed(true, { notificationsEnabled: false })).toBe(false)
  })
})
