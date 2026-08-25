import { contextBridge, ipcRenderer } from 'electron'

interface ProductElement {
  closest(selector: string): unknown
}

declare const Element: {
  new (): ProductElement
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

contextBridge.exposeInMainWorld('nekroDesktopShell', {
  getCurrentInstancePresentation: () => ipcRenderer.invoke('nxt:shell:current'),
  openInstanceSwitcher: () => ipcRenderer.invoke('nxt:shell:open-switcher'),
  closeInstanceSwitcher: () => ipcRenderer.invoke('nxt:shell:close-switcher'),
  subscribeCurrentInstanceStatus: (listener: (state: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: unknown): void => listener(state)
    ipcRenderer.on('nxt:shell:current-changed', handler)
    return () => ipcRenderer.removeListener('nxt:shell:current-changed', handler)
  },
})
