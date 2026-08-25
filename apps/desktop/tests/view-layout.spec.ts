import { describe, expect, it } from 'vitest'
import { bringChildViewToFront, desktopViewBounds } from '../src/view-layout.ts'

describe('Desktop multi-view layout', () => {
  it.each([
    { width: 980, height: 680 },
    { width: 1360, height: 880 },
  ])(
    'keeps Product/Fallback full-window and the Sheet scrim below the 48px titlebar at $width×$height',
    ({ width, height }) => {
      expect(desktopViewBounds(width, height)).toEqual({
        product: { x: 0, y: 0, width, height },
        fallback: { x: 0, y: 0, width, height },
        overlay: { x: 0, y: 48, width, height: height - 48 },
      })
    },
  )

  it('uses the production remove/add sequence to place an attached trusted Sheet above Product and Fallback', () => {
    const children = ['product', 'overlay', 'fallback']
    const container = {
      children,
      addChildView: (view: string) => children.push(view),
      removeChildView: (view: string) => children.splice(children.indexOf(view), 1),
    }
    expect(bringChildViewToFront(container, 'overlay')).toBe(true)
    expect(children).toEqual(['product', 'fallback', 'overlay'])
    expect(bringChildViewToFront(container, 'detached')).toBe(false)
    expect(children).toEqual(['product', 'fallback', 'overlay'])
  })
})
