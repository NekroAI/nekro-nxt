import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('nxtDataMove', {
  snapshot: () => ipcRenderer.invoke('nxt:data-move:snapshot'),
  action: (action: string) => ipcRenderer.invoke('nxt:data-move:action', action),
  subscribe: (listener: (state: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: unknown): void => listener(state)
    ipcRenderer.on('nxt:data-move:state', handler)
    return () => ipcRenderer.removeListener('nxt:data-move:state', handler)
  },
})
