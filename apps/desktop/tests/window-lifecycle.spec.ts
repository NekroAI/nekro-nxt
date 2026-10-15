import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { DesktopWindowLifecycle, type WindowTrayActions } from '../src/window-lifecycle.ts'

class FakeWindow extends EventEmitter {
  destroyed = false
  minimized = false
  visible = false
  focused = false
  isDestroyed = () => this.destroyed
  isMinimized = () => this.minimized
  restore = vi.fn(() => {
    this.minimized = false
  })
  show = vi.fn(() => {
    this.visible = true
  })
  hide = vi.fn(() => {
    this.visible = false
    this.focused = false
  })
  focus = vi.fn(() => {
    this.focused = true
  })
  close(): void {
    const event = { preventDefault: vi.fn() }
    this.emit('close', event)
    if (event.preventDefault.mock.calls.length === 0) this.destroy()
  }
  destroy(): void {
    this.destroyed = true
    this.visible = false
    this.emit('closed')
  }
}

const setup = (platform: NodeJS.Platform) => {
  const window = new FakeWindow()
  const state = { quitting: false }
  const quit = vi.fn(() => {
    state.quitting = true
  })
  const tray = { destroy: vi.fn() }
  const createTray = vi.fn<(actions: WindowTrayActions) => { destroy(): void }>(() => tray)
  const lifecycle = new DesktopWindowLifecycle({ platform, isQuitting: () => state.quitting, quit, createTray })
  lifecycle.attach(window)
  lifecycle.showWhenReady()
  return { lifecycle, window, state, quit, tray, createTray }
}

describe('Desktop window lifecycle', () => {
  it.each(['darwin', 'win32'] as const)('%s hides without destroying or requesting Host shutdown', (platform) => {
    const { window, quit, createTray, lifecycle } = setup(platform)
    window.close()
    expect(window.visible).toBe(false)
    expect(window.destroyed).toBe(false)
    expect(quit).not.toHaveBeenCalled()
    expect(createTray).toHaveBeenCalledTimes(platform === 'win32' ? 1 : 0)
    lifecycle.dispose()
  })

  it('routes Linux close through application shutdown, then permits final close', () => {
    const { window, quit, lifecycle } = setup('linux')
    window.close()
    expect(window.destroyed).toBe(false)
    expect(quit).toHaveBeenCalledOnce()
    window.close()
    expect(window.destroyed).toBe(true)
    expect(window.listenerCount('close')).toBe(0)
    expect(window.listenerCount('closed')).toBe(0)
    lifecycle.dispose()
  })

  it('restores minimized and hidden windows without replacing them', () => {
    const { lifecycle, window } = setup('darwin')
    window.minimized = true
    window.close()
    lifecycle.show()
    expect(window.minimized).toBe(false)
    expect(window.restore).toHaveBeenCalledOnce()
    expect(window.visible).toBe(true)
    expect(window.focused).toBe(true)
    expect(window.destroyed).toBe(false)
    lifecycle.dispose()
  })

  it('preserves startup hiding across handoff and removes only owned listeners', () => {
    const { lifecycle, window } = setup('darwin')
    const otherClose = vi.fn()
    window.on('close', otherClose)
    window.close()
    const product = new FakeWindow()
    lifecycle.attach(product)
    lifecycle.showWhenReady()
    expect(product.show).not.toHaveBeenCalled()
    expect(window.listeners('close')).toEqual([otherClose])
    expect(window.listenerCount('closed')).toBe(0)
    window.destroy()
    lifecycle.show()
    expect(product.visible).toBe(true)
    lifecycle.dispose()
    expect(product.listenerCount('close')).toBe(0)
    expect(product.listenerCount('closed')).toBe(0)
    expect(window.listeners('close')).toEqual([otherClose])
  })

  it('ignores missing, destroyed and quitting windows', () => {
    const { lifecycle, window, state } = setup('darwin')
    window.show.mockClear()
    state.quitting = true
    lifecycle.show()
    expect(window.show).not.toHaveBeenCalled()
    state.quitting = false
    window.destroyed = true
    lifecycle.show()
    expect(window.show).not.toHaveBeenCalled()
    window.emit('closed')
    lifecycle.show()
    expect(window.listenerCount('closed')).toBe(0)
    lifecycle.dispose()
  })

  it('disposes once, detaches listeners and rejects late tray callbacks or attachments', () => {
    const { lifecycle, window, tray, createTray } = setup('win32')
    const otherClosed = vi.fn()
    window.on('closed', otherClosed)
    const actions = createTray.mock.calls[0]![0]
    window.close()
    actions.show()
    expect(window.visible).toBe(true)
    window.show.mockClear()
    lifecycle.dispose()
    lifecycle.dispose()
    actions.show()
    const next = new FakeWindow()
    lifecycle.attach(next)
    expect(window.show).not.toHaveBeenCalled()
    expect(window.listenerCount('close')).toBe(0)
    expect(window.listeners('closed')).toEqual([otherClosed])
    expect(next.listenerCount('close')).toBe(0)
    expect(tray.destroy).toHaveBeenCalledOnce()
  })
})
