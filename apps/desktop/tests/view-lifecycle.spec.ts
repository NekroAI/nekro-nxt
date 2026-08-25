import { describe, expect, it, vi } from 'vitest'
import { detachAndCloseView } from '../src/view-lifecycle.ts'

const fixture = (options: { readonly windowDestroyed?: boolean; readonly contentsDestroyed?: boolean } = {}) => {
  const view = {
    webContents: {
      isDestroyed: () => options.contentsDestroyed === true,
      close: vi.fn(),
    },
  }
  const removeChildView = vi.fn()
  const window = {
    isDestroyed: () => options.windowDestroyed === true,
    contentView: { children: [view], removeChildView },
  }
  return { view, window, removeChildView }
}

describe('Desktop View lifecycle', () => {
  it('detaches and closes a live child before its BrowserWindow is destroyed', () => {
    const { view, window, removeChildView } = fixture()
    detachAndCloseView(window, view)
    expect(removeChildView).toHaveBeenCalledOnce()
    expect(view.webContents.close).toHaveBeenCalledOnce()
  })

  it('does not touch objects Electron already destroyed', () => {
    const { view, window, removeChildView } = fixture({ windowDestroyed: true, contentsDestroyed: true })
    expect(() => detachAndCloseView(window, view)).not.toThrow()
    expect(removeChildView).not.toHaveBeenCalled()
    expect(view.webContents.close).not.toHaveBeenCalled()
  })

  it('contains teardown races instead of surfacing an uncaught main-process exception', () => {
    const { view, window } = fixture()
    window.contentView.removeChildView.mockImplementation(() => {
      throw new TypeError('Object has been destroyed')
    })
    view.webContents.close.mockImplementation(() => {
      throw new TypeError('Object has been destroyed')
    })
    expect(() => detachAndCloseView(window, view)).not.toThrow()
  })
})
