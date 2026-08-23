import { contextBridge, ipcRenderer } from 'electron'

declare const window: {
  addEventListener(type: 'pointerdown', listener: () => void, options: { readonly capture: boolean }): void
}
window.addEventListener('pointerdown', () => ipcRenderer.send('nxt:shell:content-pointer'), { capture: true })

contextBridge.exposeInMainWorld('nekroDesktopShell', {
  getCurrentInstancePresentation: () => ipcRenderer.invoke('nxt:shell:current'),
  openInstanceSwitcher: () => ipcRenderer.invoke('nxt:shell:open-switcher'),
  subscribeCurrentInstanceStatus: (listener: (state: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: unknown): void => listener(state)
    ipcRenderer.on('nxt:shell:current-changed', handler)
    return () => ipcRenderer.removeListener('nxt:shell:current-changed', handler)
  },
})
