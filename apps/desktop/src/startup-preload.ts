import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('nxtStartup', {
  snapshot: () => ipcRenderer.invoke('nxt:startup:snapshot'),
  action: (action: string) => ipcRenderer.invoke('nxt:startup:action', action),
  subscribe: (listener: (state: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: unknown): void => listener(state)
    ipcRenderer.on('nxt:startup:state', handler)
    return () => ipcRenderer.removeListener('nxt:startup:state', handler)
  },
})
