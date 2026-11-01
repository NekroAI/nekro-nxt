import { BrowserWindow, ipcMain, nativeTheme } from 'electron'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { DataMoveFailure, DataMoveProgress } from './data-move.js'
import type { MoveMethod } from './data-move-plan.js'
import { installF12DevToolsShortcut } from './devtools-shortcut.js'
import { assertTrustedOverlayIpcEvent, installExactTrustedNavigationGuard } from './trusted-view-navigation.js'
import { desktopWindowChrome } from './window-chrome.js'

export type DataMoveViewMode = 'moving' | 'undoing' | 'failed' | 'interrupted' | 'cancelled' | 'switching'

export interface DataMoveViewState {
  readonly mode: DataMoveViewMode
  readonly method: MoveMethod
  readonly source: string
  readonly target: string
  /** When copying or moving began, for the elapsed time. */
  readonly startedAt?: number
  readonly progress?: DataMoveProgress
  readonly failure?: DataMoveFailure
  readonly diagnostics: string
}

export type DataMoveAction = 'open' | 'cancel'

/** The move has stopped and the old directory is in use again. */
const stopped = (state: Pick<DataMoveViewState, 'mode'>): boolean =>
  state.mode === 'failed' || state.mode === 'interrupted' || state.mode === 'cancelled'

export const allowedDataMoveActions = (
  state: Pick<DataMoveViewState, 'mode' | 'progress'>,
): readonly DataMoveAction[] => {
  if (stopped(state)) return ['open']
  // Cancel is offered only while copying or verifying; rewriting paths and switching run to the end.
  const step = state.progress?.step ?? 'transferring'
  return state.mode === 'moving' && (step === 'transferring' || step === 'verifying') ? ['cancel'] : []
}

/** The only window of a migration-mode launch: the move's progress, a cancel while copying, and one action once it stopped. */
export class DataMoveWindow {
  readonly window: BrowserWindow
  readonly #url = pathToFileURL(fileURLToPath(new URL('./data-move-view.html', import.meta.url))).href
  #state: DataMoveViewState
  #closable = false

  constructor(state: DataMoveViewState, action: (action: DataMoveAction) => void) {
    this.#state = state
    this.window = new BrowserWindow({
      width: 720,
      height: 520,
      minWidth: 560,
      minHeight: 440,
      show: false,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1a2c' : '#f5f2ee',
      title: 'NekroNXT',
      ...desktopWindowChrome(process.platform, nativeTheme.shouldUseDarkColors ? 'dark' : 'light'),
      webPreferences: {
        preload: fileURLToPath(new URL('./data-move-preload.cjs', import.meta.url)),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    installExactTrustedNavigationGuard(this.window.webContents, () => this.#url)
    installF12DevToolsShortcut(this.window.webContents)
    // Closing mid-move would leave the data half-moved; the window closes itself when there is something to do next.
    this.window.on('close', (event) => {
      if (!this.#closable && !stopped(this.#state)) event.preventDefault()
    })
    ipcMain.handle('nxt:data-move:snapshot', (event) => {
      assertTrustedOverlayIpcEvent(event, this.window.webContents.id, this.#url)
      return this.#snapshot()
    })
    ipcMain.handle('nxt:data-move:action', (event, value: unknown) => {
      assertTrustedOverlayIpcEvent(event, this.window.webContents.id, this.#url)
      const allowed = allowedDataMoveActions(this.#state).find((candidate) => candidate === value)
      if (allowed !== undefined) action(allowed)
    })
    this.window.on('closed', () => {
      ipcMain.removeHandler('nxt:data-move:snapshot')
      ipcMain.removeHandler('nxt:data-move:action')
    })
  }

  async load(): Promise<void> {
    await this.window.loadURL(this.#url)
  }

  update(state: DataMoveViewState): void {
    this.#state = state
    if (!this.window.isDestroyed()) this.window.webContents.send('nxt:data-move:state', this.#snapshot())
  }

  get state(): DataMoveViewState {
    return this.#state
  }

  allowClose(): void {
    this.#closable = true
  }

  #snapshot() {
    return {
      ...this.#state,
      theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
      platform: process.platform,
      actions: allowedDataMoveActions(this.#state),
    }
  }
}
