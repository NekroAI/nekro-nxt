import type { BrowserWindow, Event } from 'electron'

type ManagedWindow = Pick<
  BrowserWindow,
  'isDestroyed' | 'isMinimized' | 'restore' | 'show' | 'hide' | 'focus' | 'on' | 'once' | 'removeListener'
>

export interface DesktopWindowLifecycleOptions {
  readonly platform: NodeJS.Platform
  readonly isQuitting: () => boolean
  readonly quit: () => void
  readonly createTray: (actions: WindowTrayActions) => { destroy(): void }
}

export interface WindowTrayActions {
  readonly show: () => void
  readonly quit: () => void
}

/** Owns visibility across the startup/product handoff; Host shutdown stays in main. */
export class DesktopWindowLifecycle {
  readonly #input: DesktopWindowLifecycleOptions
  #window: ManagedWindow | undefined
  #hidden = false
  #tray: { destroy(): void } | undefined

  constructor(input: DesktopWindowLifecycleOptions) {
    this.#input = input
    if (input.platform === 'win32') {
      this.#tray = input.createTray({ show: () => this.show(), quit: input.quit })
    }
  }

  attach(window: ManagedWindow): void {
    this.#window = window
    const onClose = (event: Event): void => {
      if (this.#input.isQuitting()) return
      event.preventDefault()
      if (this.#input.platform === 'darwin' || this.#input.platform === 'win32') {
        this.#hidden = true
        window.hide()
      } else {
        // Enter before-quit first so Host shutdown completes before window teardown.
        this.#input.quit()
      }
    }
    window.on('close', onClose)
    window.once('closed', () => {
      window.removeListener('close', onClose)
      if (this.#window === window) this.#window = undefined
    })
  }

  showWhenReady(): void {
    if (!this.#hidden) this.show()
  }

  show(): void {
    const window = this.#window
    if (this.#input.isQuitting() || window === undefined || window.isDestroyed()) return
    this.#hidden = false
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }

  dispose(): void {
    this.#tray?.destroy()
    this.#tray = undefined
  }
}
