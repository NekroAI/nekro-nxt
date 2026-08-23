import { contextBridge, ipcRenderer } from 'electron'

const invoke = (action: string, payload?: unknown): Promise<unknown> =>
  ipcRenderer.invoke(`nxt:instances:${action}`, payload)

contextBridge.exposeInMainWorld('nxtInstances', {
  list: () => invoke('list'),
  add: (input: unknown) => invoke('add', input),
  switchTo: (profileId: string) => invoke('switch', { profileId }),
  retry: (profileId: string) => invoke('retry', { profileId }),
  update: (input: unknown) => invoke('update', input),
  reauthenticate: (input: unknown) => invoke('reauthenticate', input),
  remove: (profileId: string) => invoke('remove', { profileId }),
  close: () => invoke('close'),
  subscribe: (listener: (state: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: unknown): void => listener(state)
    ipcRenderer.on('nxt:instances:changed', handler)
    return () => ipcRenderer.removeListener('nxt:instances:changed', handler)
  },
})
