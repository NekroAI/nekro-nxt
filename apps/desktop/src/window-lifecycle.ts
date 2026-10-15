import type { Event } from 'electron'

/** The BrowserWindow surface this lifecycle uses, narrow enough for real-behavior fakes. */
interface ManagedWindow {
  isDestroyed(): boolean
  isMinimized(): boolean
  restore(): void
  show(): void
  hide(): void
  focus(): void
  on(event: 'close', listener: (event: Event) => void): unknown
  once(event: 'closed', listener: () => void): unknown
  removeListener(event: 'close', listener: (event: Event) => void): unknown
  removeListener(event: 'closed', listener: () => void): unknown
}

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
  #detachWindow: (() => void) | undefined
  #disposed = false

  constructor(input: DesktopWindowLifecycleOptions) {
    this.#input = input
    if (input.platform === 'win32') {
      this.#tray = input.createTray({ show: () => this.show(), quit: input.quit })
    }
  }

  attach(window: ManagedWindow): void {
    if (this.#disposed) return
    this.#detachWindow?.()
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
    const detach = (): void => {
      window.removeListener('close', onClose)
      window.removeListener('closed', onClosed)
      if (this.#window === window) {
        this.#window = undefined
        this.#detachWindow = undefined
      }
    }
    const onClosed = (): void => detach()
    this.#detachWindow = detach
    window.on('close', onClose)
    window.once('closed', onClosed)
  }

  showWhenReady(): void {
    if (!this.#hidden) this.show()
  }

  show(): void {
    const window = this.#window
    if (this.#disposed || this.#input.isQuitting() || window === undefined || window.isDestroyed()) return
    this.#hidden = false
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#detachWindow?.()
    this.#tray?.destroy()
    this.#tray = undefined
  }
}
