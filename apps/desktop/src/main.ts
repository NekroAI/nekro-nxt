import { app, BrowserWindow, dialog, shell, utilityProcess, type UtilityProcess } from 'electron'
import { createServer } from 'node:net'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  desktopDataRoot,
  desktopUserDataRoot,
  getDesktopDistribution,
  isAllowedExternalUrl,
  isSameApplicationOrigin,
  parseProductRelease,
  resolveProductReleasePath,
  type ProductRelease,
} from './distribution.js'
import { desktopTitleBarCss, desktopWindowChrome } from './window-chrome.js'

const LOOPBACK_HOST = '127.0.0.1'
const HOST_READY_TIMEOUT_MS = 60_000
const HOST_READY_INTERVAL_MS = 200

let mainWindow: BrowserWindow | undefined
let hostProcess: UtilityProcess | undefined
let hostExit: Promise<void> | undefined
let stopping = false

const productReleasePath = (): string => resolveProductReleasePath(import.meta.url)

const readProductRelease = (): ProductRelease =>
  parseProductRelease(JSON.parse(readFileSync(productReleasePath(), 'utf8')))

const webDistIndex = (): string =>
  app.isPackaged
    ? path.join(process.resourcesPath, 'web-dist', 'index.html')
    : fileURLToPath(new URL('../../web/dist/index.html', import.meta.url))

const serverEntry = (): string =>
  app.isPackaged
    ? path.join(process.resourcesPath, 'server-runtime', 'dist', 'main.mjs')
    : fileURLToPath(new URL('../runtime/dist/main.mjs', import.meta.url))

const reserveLoopbackPort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen({ host: LOOPBACK_HOST, port: 0, exclusive: true }, () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('无法分配本地 Host 端口。')))
        return
      }
      server.close((error) => {
        if (error) reject(error)
        else resolve(address.port)
      })
    })
  })

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const waitForHostReady = async (origin: string, releaseId: string): Promise<void> => {
  const deadline = Date.now() + HOST_READY_TIMEOUT_MS
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/health/ready`, { signal: AbortSignal.timeout(2_000) })
      const body: unknown = response.ok ? await response.json() : undefined
      if (isRecord(body) && body['status'] === 'ready' && body['releaseId'] === releaseId) return
      lastError = new Error(`Host 就绪响应与产品 Release 不一致：${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, HOST_READY_INTERVAL_MS))
  }
  throw new Error('NekroNxt Host 未能在限定时间内完成启动。', { cause: lastError })
}

const startProductHost = async (release: ProductRelease): Promise<string> => {
  const port = await reserveLoopbackPort()
  const origin = `http://${LOOPBACK_HOST}:${port}`
  const child = utilityProcess.fork(serverEntry(), [], {
    serviceName: 'NekroNxt Host',
    stdio: 'pipe',
    env: {
      ...process.env,
      NEKRO_DATA: desktopDataRoot(app.getPath('userData')),
      NEKRO_DIST_INDEX: webDistIndex(),
      NEKRO_HOST: LOOPBACK_HOST,
      NEKRO_PORT: String(port),
      NEKRO_RELEASE_ID: release.releaseId,
    },
  })
  hostProcess = child
  child.stdout?.on('data', (chunk: Uint8Array) => process.stdout.write(chunk))
  child.stderr?.on('data', (chunk: Uint8Array) => process.stderr.write(chunk))
  hostExit = new Promise((resolve) => {
    child.once('exit', (code) => {
      if (!stopping && code !== 0) {
        void dialog.showErrorBox('NekroNxt Host 已停止', `本地 Host 意外退出，退出码：${code ?? 'unknown'}`)
      }
      resolve()
    })
  })
  await waitForHostReady(origin, release.releaseId)
  return origin
}

const createMainWindow = async (origin: string): Promise<BrowserWindow> => {
  const window = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 980,
    minHeight: 680,
    show: false,
    backgroundColor: '#172A45',
    ...desktopWindowChrome(process.platform),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  window.webContents.on('dom-ready', () => {
    void window.webContents.insertCSS(desktopTitleBarCss(process.platform))
  })
  window.once('ready-to-show', () => window.show())
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, target) => {
    if (isSameApplicationOrigin(origin, target)) return
    event.preventDefault()
    if (isAllowedExternalUrl(target)) void shell.openExternal(target)
  })
  await window.loadURL(origin)
  return window
}

const stopProductHost = async (): Promise<void> => {
  stopping = true
  const child = hostProcess
  const exited = hostExit
  hostProcess = undefined
  hostExit = undefined
  if (child !== undefined && child.pid !== undefined) child.kill()
  if (exited !== undefined) await exited
}

const productRelease = readProductRelease()
const desktopDistribution = getDesktopDistribution(productRelease.channel)
app.setName(desktopDistribution.productName)
app.setPath(
  'userData',
  desktopUserDataRoot(app.getPath('appData'), desktopDistribution, process.env['NEKRO_DESKTOP_USER_DATA']),
)

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.quit()

app.on('second-instance', () => {
  if (mainWindow?.isMinimized()) mainWindow.restore()
  mainWindow?.show()
  mainWindow?.focus()
})

void app.whenReady().then(async () => {
  app.setAppUserModelId(desktopDistribution.appId)
  try {
    const origin = await startProductHost(productRelease)
    mainWindow = await createMainWindow(origin)
    mainWindow.on('closed', () => {
      mainWindow = undefined
    })
  } catch (error) {
    dialog.showErrorBox('NekroNxt 启动失败', error instanceof Error ? error.message : String(error))
    await stopProductHost()
    app.quit()
  }
})

app.on('activate', () => {
  if (mainWindow !== undefined) {
    mainWindow.show()
    return
  }
  app.quit()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (stopping || hostProcess === undefined) return
  event.preventDefault()
  void stopProductHost().finally(() => app.quit())
})
