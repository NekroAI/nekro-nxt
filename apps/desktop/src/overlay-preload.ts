import { contextBridge, ipcRenderer } from 'electron'
import { invokeTrustedInstanceOperation } from './instance-operation-error.js'
import { parseOverlayVisibility, type OverlayVisibility } from './overlay-visibility.js'

const invoke = (action: string, payload?: unknown): Promise<unknown> =>
  invokeTrustedInstanceOperation(ipcRenderer.invoke.bind(ipcRenderer), action, payload)

contextBridge.exposeInMainWorld('nxtInstances', {
  list: () => invoke('list'),
  add: (input: unknown) => invoke('add', input),
  switchTo: (profileId: string) => invoke('switch', { profileId }),
  retry: (profileId: string) => invoke('retry', { profileId }),
  update: (input: unknown) => invoke('update', input),
  editConnection: (input: unknown) => invoke('editConnection', input),
  reauthenticate: (input: unknown) => invoke('reauthenticate', input),
  remove: (profileId: string) => invoke('remove', { profileId }),
  close: (input?: unknown) => invoke('close', input),
  subscribe: (listener: (state: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: unknown): void => listener(state)
    ipcRenderer.on('nxt:instances:changed', handler)
    return () => ipcRenderer.removeListener('nxt:instances:changed', handler)
  },
  subscribeVisibility: (listener: (state: OverlayVisibility) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: unknown): void => {
      const visibility = parseOverlayVisibility(state)
      if (visibility !== undefined) listener(visibility)
    }
    ipcRenderer.on('nxt:instances:visibility', handler)
    return () => ipcRenderer.removeListener('nxt:instances:visibility', handler)
  },
})
