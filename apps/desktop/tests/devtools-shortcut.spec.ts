import { describe, expect, it, vi } from 'vitest'
import { installF12DevToolsShortcut } from '../src/devtools-shortcut.ts'

describe('Desktop F12 DevTools shortcut', () => {
  it('toggles DevTools once for a non-repeating F12 keydown', () => {
    let listener!: (
      event: { preventDefault(): void },
      input: { type: string; key: string; isAutoRepeat: boolean },
    ) => void
    const contents = {
      on: vi.fn((_event: 'before-input-event', next: typeof listener) => {
        listener = next
      }),
      toggleDevTools: vi.fn(),
    }
    const event = { preventDefault: vi.fn() }
    installF12DevToolsShortcut(contents)

    listener(event, { type: 'keyDown', key: 'F12', isAutoRepeat: false })

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(contents.toggleDevTools).toHaveBeenCalledOnce()
  })

  it('ignores other keys, keyup and held-key repeats', () => {
    let listener!: (
      event: { preventDefault(): void },
      input: { type: string; key: string; isAutoRepeat: boolean },
    ) => void
    const contents = {
      on: vi.fn((_event: 'before-input-event', next: typeof listener) => {
        listener = next
      }),
      toggleDevTools: vi.fn(),
    }
    const event = { preventDefault: vi.fn() }
    installF12DevToolsShortcut(contents)

    listener(event, { type: 'keyDown', key: 'F11', isAutoRepeat: false })
    listener(event, { type: 'keyUp', key: 'F12', isAutoRepeat: false })
    listener(event, { type: 'keyDown', key: 'F12', isAutoRepeat: true })

    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(contents.toggleDevTools).not.toHaveBeenCalled()
  })
})
