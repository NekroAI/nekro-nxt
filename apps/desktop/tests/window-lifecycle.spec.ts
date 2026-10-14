import { describe, expect, it, vi } from 'vitest'
import { DesktopWindowLifecycle, type WindowTrayActions } from '../src/window-lifecycle.ts'

type FakeWindow = {
  destroyed: boolean
  minimized: boolean
  hidden: boolean
  focused: boolean
  listeners: Map<string, (event: { preventDefault(): void }) => void>
  on: (event: string, listener: (event: { preventDefault(): void }) => void) => void
  once: (event: string, listener: () => void) => void
  removeListener: (event: string, listener: (event: { preventDefault(): void }) => void) => void
  isDestroyed: () => boolean
  isMinimized: () => boolean
  restore: () => void
  show: () => void
  hide: () => void
  focus: () => void
}

const fakeWindow = (): FakeWindow => {
  const listeners = new Map<string, (event: { preventDefault(): void }) => void>()
  const window: FakeWindow = {
    destroyed: false,
    minimized: false,
    hidden: false,
    focused: false,
    listeners,
    on: (event, listener) => listeners.set(event, listener),
    once: () => undefined,
    removeListener: (event, listener) => {
      if (listeners.get(event) === listener) listeners.delete(event)
    },
    isDestroyed: () => false,
    isMinimized: () => false,
    restore: () => {
      window.minimized = false
    },
    show: () => {
      window.hidden = false
    },
    hide: () => {
      window.hidden = true
    },
    focus: () => {
      window.focused = true
    },
  }
  return window
}

const setup = (platform: NodeJS.Platform) => {
  const window = fakeWindow()
  const quit = vi.fn()
  const tray = { destroy: vi.fn() }
  const createTray = vi.fn((_actions: WindowTrayActions) => tray)
  const lifecycle = new DesktopWindowLifecycle({
    platform,
    isQuitting: () => false,
    quit,
    createTray,
  })
  lifecycle.attach(window)
  return { lifecycle, window, quit, tray, createTray }
}

describe('Desktop window lifecycle', () => {
  it.each([
    ['darwin', 'macOS hides on close and has no tray'],
    ['win32', 'Windows hides on close and creates a tray'],
  ] as const)('%s %s', (platform) => {
    const { window, quit, createTray } = setup(platform)
    let prevented = false
    window.listeners.get('close')?.({ preventDefault: () => (prevented = true) })
    expect(prevented).toBe(true)
    expect(window.hidden).toBe(platform === 'darwin' || platform === 'win32')
    if (platform === 'win32') expect(createTray).toHaveBeenCalledOnce()
    else expect(createTray).not.toHaveBeenCalled()
    expect(quit).not.toHaveBeenCalled()
  })

  it('lets Linux close continue into explicit application shutdown', () => {
    const { window, quit } = setup('linux')
    const event = { preventDefault: vi.fn() }
    window.listeners.get('close')?.(event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(quit).toHaveBeenCalledOnce()
  })

  it('restores a hidden window for activate and second-instance', () => {
    const { lifecycle, window } = setup('darwin')
    window.listeners.get('close')?.({ preventDefault: () => undefined })
    lifecycle.show()
    expect(window.hidden).toBe(false)
    expect(window.focused).toBe(true)
  })

  it('disposes the Windows tray with the application', () => {
    const { lifecycle, tray } = setup('win32')
    lifecycle.dispose()
    expect(tray.destroy).toHaveBeenCalledOnce()
  })
})
