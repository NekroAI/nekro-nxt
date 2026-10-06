import { BrowserWindow, ipcMain, nativeTheme } from 'electron'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { allowedStartupActions, type StartupAction, type StartupViewState } from './host-startup.js'
import { assertTrustedOverlayIpcEvent, installExactTrustedNavigationGuard } from './trusted-view-navigation.js'
import { desktopWindowChrome } from './window-chrome.js'
import { installF12DevToolsShortcut } from './devtools-shortcut.js'

/** A packaged local document. No product/management bridge is exposed to this window. */
export class HostStartupWindow {
  readonly window: BrowserWindow
  readonly #url = pathToFileURL(fileURLToPath(new URL('./startup.html', import.meta.url))).href
  readonly #action: (action: StartupAction) => Promise<void>
  #state: StartupViewState

  constructor(state: StartupViewState, action: (action: StartupAction) => Promise<void>) {
    this.#state = state
    this.#action = action
    this.window = new BrowserWindow({
      width: 800,
      height: 600,
      minWidth: 660,
      minHeight: 520,
      show: false,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1a2c' : '#f5f2ee',
      title: 'NekroNXT',
      ...desktopWindowChrome(process.platform, nativeTheme.shouldUseDarkColors ? 'dark' : 'light'),
      webPreferences: {
        preload: fileURLToPath(new URL('./startup-preload.cjs', import.meta.url)),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    installExactTrustedNavigationGuard(this.window.webContents, () => this.#url)
    installF12DevToolsShortcut(this.window.webContents)
    ipcMain.handle('nxt:startup:snapshot', (event) => {
      assertTrustedOverlayIpcEvent(event, this.window.webContents.id, this.#url)
      return this.#snapshot()
    })
    ipcMain.handle('nxt:startup:action', async (event, action: unknown) => {
      assertTrustedOverlayIpcEvent(event, this.window.webContents.id, this.#url)
      const allowedAction = allowedStartupActions(this.#state).find((candidate) => candidate === action)
      if (allowedAction === undefined) return
      // Main owns serialization and publishes busy state before the first await.
      await this.#action(allowedAction)
    })
    this.window.on('closed', () => {
      ipcMain.removeHandler('nxt:startup:snapshot')
      ipcMain.removeHandler('nxt:startup:action')
    })
  }

  async load(): Promise<void> {
    await this.window.loadURL(this.#url)
    this.window.show()
  }

  update(state: StartupViewState): void {
    this.#state = state
    if (!this.window.isDestroyed()) this.window.webContents.send('nxt:startup:state', this.#snapshot())
  }

  #snapshot(): StartupViewState & {
    readonly theme: 'light' | 'dark'
    readonly platform: NodeJS.Platform
    readonly actions: readonly StartupAction[]
  } {
    return {
      ...this.#state,
      theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
      platform: process.platform,
      actions: allowedStartupActions(this.#state),
    }
  }
}
