import { contextBridge, ipcRenderer } from 'electron'

interface ProductElement {
  closest(selector: string): unknown
}

declare const Element: {
  new (): ProductElement
}

declare const document: {
  readonly documentElement: { readonly dataset: Record<string, string | undefined> }
  addEventListener(type: 'DOMContentLoaded', listener: () => void): void
}

declare const MutationObserver: new (callback: () => void) => {
  observe(target: unknown, options: { readonly attributes: boolean; readonly attributeFilter: readonly string[] }): void
}

declare const window: {
  addEventListener(
    type: 'pointerdown',
    listener: (event: { readonly target: unknown }) => void,
    options: { readonly capture: boolean },
  ): void
}

window.addEventListener(
  'pointerdown',
  (event) => {
    const target = event.target
    if (target instanceof Element && target.closest('[data-desktop-instance-switcher]')) return
    ipcRenderer.send('nxt:shell:content-pointer')
  },
  { capture: true },
)

// Report the product theme (and every later change) so the main process can recolour the caption buttons.
document.addEventListener('DOMContentLoaded', () => {
  const root = document.documentElement
  let reported: string | undefined
  const report = (): void => {
    const theme = root.dataset['theme']
    if ((theme === 'light' || theme === 'dark') && theme !== reported) {
      reported = theme
      ipcRenderer.send('nxt:shell:theme', theme)
    }
  }
  report()
  new MutationObserver(report).observe(root, { attributes: true, attributeFilter: ['data-theme'] })
})

contextBridge.exposeInMainWorld('nekroDesktopShell', {
  getCurrentInstancePresentation: () => ipcRenderer.invoke('nxt:shell:current'),
  openInstanceSwitcher: (anchor?: unknown) => ipcRenderer.invoke('nxt:shell:open-switcher', anchor),
  closeInstanceSwitcher: () => ipcRenderer.invoke('nxt:shell:close-switcher'),
  subscribeCurrentInstanceStatus: (listener: (state: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: unknown): void => listener(state)
    ipcRenderer.on('nxt:shell:current-changed', handler)
    return () => ipcRenderer.removeListener('nxt:shell:current-changed', handler)
  },
})
