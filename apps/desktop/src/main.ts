import { app, dialog, utilityProcess, type BrowserWindow } from 'electron'
import { createServer } from 'node:net'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  desktopDataRoot,
  desktopUserDataRoot,
  getDesktopDistribution,
  parseProductRelease,
  resolveProductReleasePath,
  type ProductRelease,
} from './distribution.js'
import { HostSupervisor, abortableDelay } from './host-supervisor.js'
import { DesktopInstanceManager } from './instance-manager.js'

const LOOPBACK_HOST = '127.0.0.1'
const HOST_READY_TIMEOUT_MS = 60_000
const HOST_READY_INTERVAL_MS = 200

let mainWindow: BrowserWindow | undefined
let hostSupervisor: HostSupervisor | undefined
let instanceManager: DesktopInstanceManager | undefined

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
    : fileURLToPath(new URL('./runtime/dist/main.mjs', import.meta.url))

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

const waitForHostReady = async (origin: string, releaseId: string, signal: AbortSignal): Promise<void> => {
  const deadline = Date.now() + HOST_READY_TIMEOUT_MS
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/health/ready`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]),
      })
      const body: unknown = response.ok ? await response.json() : undefined
      if (isRecord(body) && body['status'] === 'ready' && body['releaseId'] === releaseId) return
      lastError = new Error(`Host 就绪响应与产品 Release 不一致：${response.status}`)
    } catch (error) {
      if (signal.aborted) throw signal.reason
      lastError = error
    }
    await abortableDelay(HOST_READY_INTERVAL_MS, signal)
  }
  throw new Error('NekroNxt Host 未能在限定时间内完成启动。', { cause: lastError })
}

const startProductHost = async (release: ProductRelease): Promise<string> => {
  const port = await reserveLoopbackPort()
  const origin = `http://${LOOPBACK_HOST}:${port}`
  const supervisor = new HostSupervisor({
    origin,
    spawnHost: () => {
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
      child.stdout?.on('data', (chunk: Uint8Array) => process.stdout.write(chunk))
      child.stderr?.on('data', (chunk: Uint8Array) => process.stderr.write(chunk))
      return child
    },
    waitUntilReady: (hostOrigin, signal) => waitForHostReady(hostOrigin, release.releaseId, signal),
    onRestarting: ({ attempt, delayMs, cause }) => {
      console.warn(`[desktop] 本地 Host 已停止，将在 ${delayMs}ms 后进行第 ${attempt} 次恢复：${cause.message}`)
    },
    onRecovered: (attempt) => {
      console.info(`[desktop] 本地 Host 已在同一地址恢复（第 ${attempt} 次尝试）。`)
    },
    onFatal: (error) => {
      console.error('[desktop] 本地 Host 自动恢复已停止。', error)
      dialog.showErrorBox(
        'NekroNxt Host 无法恢复',
        '本地 Host 在短时间内多次异常退出，已停止自动恢复。请重启 NekroNxt；若问题持续出现，请查看诊断日志。',
      )
    },
  })
  hostSupervisor = supervisor
  await supervisor.start()
  return origin
}

const stopProductHost = async (): Promise<void> => {
  const supervisor = hostSupervisor
  hostSupervisor = undefined
  await supervisor?.stop()
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
    instanceManager = await DesktopInstanceManager.create({ localOrigin: origin, release: productRelease })
    mainWindow = instanceManager.window
    mainWindow.on('closed', () => {
      mainWindow = undefined
      instanceManager = undefined
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
  if (hostSupervisor === undefined) return
  event.preventDefault()
  instanceManager?.dispose()
  void stopProductHost().finally(() => app.quit())
})
