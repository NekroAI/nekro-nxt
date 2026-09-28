import { app, dialog, utilityProcess, type BrowserWindow, type UtilityProcess } from 'electron'
import { createServer } from 'node:net'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
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
import { HostSupervisor, type SupervisedHostProcess } from './host-supervisor.js'
import { DesktopInstanceManager } from './instance-manager.js'
import { LocalHostLifecycleRelay } from './local-host-state.js'
import {
  parseHostUpgradeProgress,
  restoreHostBackup,
  waitForHostReady,
  type HostStartupObservation,
  type StartupAction,
  type StartupViewState,
} from './host-startup.js'
import { HostStartupWindow } from './startup-window.js'

const LOOPBACK_HOST = '127.0.0.1'

let mainWindow: BrowserWindow | undefined
let hostSupervisor: HostSupervisor | undefined
let instanceManager: DesktopInstanceManager | undefined
let detachLocalHostLifecycle: (() => void) | undefined
const localHostLifecycle = new LocalHostLifecycleRelay()
let startupWindow: HostStartupWindow | undefined
let startupState: StartupViewState = { mode: 'starting', diagnostics: '' }
let startupTask: Promise<void> | undefined
let restoreTask: Promise<void> | undefined
let stoppingHost: Promise<void> | undefined
let cancelled = false
let quitting = false
let shutdownTask: Promise<void> | undefined

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

const dataRoot = (): string => desktopDataRoot(app.getPath('userData'))
const progressPath = (): string => path.join(dataRoot(), 'backups', 'upgrade-progress.json')
const readUpgradeProgress = async (): Promise<unknown> => JSON.parse(await readFile(progressPath(), 'utf8'))

const publishStartup = (state: Omit<StartupViewState, 'diagnostics'>): void => {
  const progress = state.observation?.progress
  const status = progress?.status
  startupState = {
    ...state,
    diagnostics: [
      `产品版本：${productRelease.version}`,
      `Release：${productRelease.releaseId}`,
      `状态文件：${progressPath()}`,
      ...(progress === undefined
        ? []
        : [
            `运行 ID：${progress.runId}`,
            `进程：${progress.pid}`,
            `最近心跳：${new Date(progress.updatedAt).toISOString()}`,
            `阶段：${progress.status.phase}`,
          ]),
      ...(status?.currentStepId === undefined ? [] : [`当前步骤：${status.currentStepId}`]),
      ...(status?.backupId === undefined ? [] : [`升级恢复点：${status.backupId}`]),
      ...(state.errorSummary === undefined ? [] : [`错误：${state.errorSummary}`]),
    ].join('\n'),
  }
  startupWindow?.update(startupState)
}

const observeStartup = (observation: HostStartupObservation): void => {
  if (startupState.mode !== 'starting') return
  publishStartup({ mode: 'starting', observation })
}

const forkServer = (
  args: readonly string[],
  env: Record<string, string>,
  runId: string,
): { child: UtilityProcess; supervised: SupervisedHostProcess } => {
  const child = utilityProcess.fork(serverEntry(), [...args], {
    serviceName: args.length ? 'NekroNXT Upgrade Recovery' : 'NekroNXT Host',
    stdio: 'pipe',
    env: {
      ...process.env,
      ...env,
      NEKRO_DATA: dataRoot(),
      NEKRO_RELEASE_ID: productRelease.releaseId,
      NEKRO_UPGRADE_RUN_ID: runId,
    },
  })
  child.stdout?.on('data', (chunk: Uint8Array) => process.stdout.write(chunk))
  child.stderr?.on('data', (chunk: Uint8Array) => process.stderr.write(chunk))
  return {
    child,
    supervised: {
      once: (event, listener) => child.once(event, listener),
      kill: () => {
        // UtilityProcess.kill sends SIGTERM on POSIX. Windows needs cooperative parentPort cancellation.
        if (process.platform !== 'win32') return child.kill()
        child.postMessage({ format: 'nxt.host-control', version: 1, action: 'cancel', runId })
        return true
      },
    },
  }
}

const startProductHost = async (release: ProductRelease): Promise<string> => {
  const port = await reserveLoopbackPort()
  if (cancelled || quitting) throw new Error('启动已取消。')
  const origin = `http://${LOOPBACK_HOST}:${port}`
  let identity: { releaseId: string; runId: string; pid: number | undefined } = {
    releaseId: release.releaseId,
    runId: '',
    pid: undefined,
  }
  const supervisor = new HostSupervisor({
    origin,
    spawnHost: () => {
      const runId = randomUUID()
      const { child, supervised } = forkServer(
        [],
        {
          NEKRO_DIST_INDEX: webDistIndex(),
          NEKRO_HOST: LOOPBACK_HOST,
          NEKRO_PORT: String(port),
        },
        runId,
      )
      const launchIdentity = { releaseId: release.releaseId, runId, pid: child.pid }
      identity = launchIdentity
      child.once('spawn', () => {
        launchIdentity.pid = child.pid
      })
      return supervised
    },
    waitUntilReady: (hostOrigin, signal) =>
      waitForHostReady({
        origin: hostOrigin,
        identity: () => identity,
        signal,
        readProgress: readUpgradeProgress,
        onObservation: observeStartup,
        probeReady: async (signal) => {
          const response = await fetch(`${hostOrigin}/health/ready`, {
            signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]),
          })
          const body: unknown = response.ok ? await response.json() : undefined
          return body
        },
      }).catch((error: unknown) => {
        if (!signal.aborted && startupState.mode === 'starting') {
          publishStartup({
            ...startupState,
            mode: 'cancelling',
            errorSummary: error instanceof Error ? error.message : String(error),
          })
        }
        throw error
      }),
    onRestarting: ({ attempt, delayMs, cause }) => {
      localHostLifecycle.commit('restarting')
      console.warn(`[desktop] 本地 Host 已停止，将在 ${delayMs}ms 后进行第 ${attempt} 次恢复：${cause.message}`)
    },
    onRecovered: (attempt) => {
      localHostLifecycle.commit('recovered')
      console.info(`[desktop] 本地 Host 已在同一地址恢复（第 ${attempt} 次尝试）。`)
    },
    onFatal: (error) => {
      localHostLifecycle.commit('fatal')
      console.error('[desktop] 本地 Host 自动恢复已停止。', error)
      dialog.showErrorBox(
        'NekroNXT Host 无法恢复',
        '本地 Host 在短时间内多次异常退出，已停止自动恢复。请重启 NekroNXT；若问题持续出现，请查看诊断日志。',
      )
    },
  })
  hostSupervisor = supervisor
  try {
    await supervisor.start()
  } catch (error) {
    // A fast failure may publish its recovery point between the last poll and child exit.
    const progress = parseHostUpgradeProgress(await readUpgradeProgress().catch(() => undefined))
    if (
      progress?.runId === identity.runId &&
      progress?.pid === identity.pid &&
      progress?.releaseId === identity.releaseId
    ) {
      publishStartup({ mode: startupState.mode, observation: { progress, stalled: false } })
    }
    throw error
  }
  localHostLifecycle.commit('initial-ready')
  return origin
}

const stopProductHost = async (): Promise<void> => {
  if (stoppingHost !== undefined) return stoppingHost
  const supervisor = hostSupervisor
  if (supervisor === undefined) return
  stoppingHost = supervisor.stop().finally(() => {
    if (hostSupervisor === supervisor) hostSupervisor = undefined
    stoppingHost = undefined
  })
  await stoppingHost
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
  const window = mainWindow ?? startupWindow?.window
  if (window?.isMinimized()) window.restore()
  window?.show()
  window?.focus()
})

const launchProduct = async (): Promise<void> => {
  cancelled = false
  publishStartup({ mode: 'starting' })
  try {
    const origin = await startProductHost(productRelease)
    if (cancelled || quitting) return
    const manager = await DesktopInstanceManager.create({
      localOrigin: origin,
      release: productRelease,
      localHostStatus: localHostLifecycle.status,
    })
    if (cancelled || quitting) {
      manager.dispose()
      manager.window.destroy()
      return
    }
    instanceManager = manager
    detachLocalHostLifecycle = localHostLifecycle.subscribe((status) => manager.commitLocalHostStatus(status))
    mainWindow = manager.window
    mainWindow.on('closed', () => {
      detachLocalHostLifecycle?.()
      detachLocalHostLifecycle = undefined
      mainWindow = undefined
      instanceManager = undefined
    })
    startupWindow?.window.destroy()
    startupWindow = undefined
  } catch (error) {
    await stopProductHost()
    if (!cancelled && !quitting)
      publishStartup({
        mode: 'failed',
        ...(startupState.observation === undefined ? {} : { observation: startupState.observation }),
        errorSummary: error instanceof Error ? error.message : String(error),
      })
  }
}

const beginStartup = (): void => {
  startupTask = launchProduct().finally(() => {
    startupTask = undefined
  })
}

const onStartupAction = async (action: StartupAction): Promise<void> => {
  if (action === 'exit') {
    app.quit()
    return
  }
  if (action === 'retry') {
    beginStartup()
    return
  }
  if (action === 'cancel') {
    cancelled = true
    publishStartup({ ...startupState, mode: 'cancelling' })
    await stopProductHost()
    await startupTask
    if (!quitting) publishStartup({ ...startupState, mode: 'failed', errorSummary: '启动已安全停止，可以重试。' })
    return
  }
  const backupId = startupState.observation?.progress?.status.backupId
  if (backupId === undefined || restoreTask !== undefined) return
  publishStartup({ ...startupState, mode: 'restoring' })
  restoreTask = restoreHostBackup({
    backupId,
    stopHost: stopProductHost,
    spawnRestore: (args) => forkServer(args, {}, randomUUID()).supervised,
  })
    .then(() => {
      publishStartup({ ...startupState, mode: 'restored' })
    })
    .catch((error: unknown) => {
      publishStartup({
        ...startupState,
        mode: 'failed',
        errorSummary: error instanceof Error ? error.message : String(error),
      })
    })
    .finally(() => {
      restoreTask = undefined
    })
  await restoreTask
}

void app
  .whenReady()
  .then(async () => {
    if (!gotLock) return
    app.setAppUserModelId(desktopDistribution.appId)
    startupWindow = new HostStartupWindow(startupState, onStartupAction)
    startupWindow.window.on('close', (event) => {
      if (startupState.mode === 'restoring' || startupState.mode === 'cancelling') {
        event.preventDefault()
        return
      }
      event.preventDefault()
      app.quit()
    })
    await startupWindow.load()
    beginStartup()
  })
  .catch((error: unknown) => {
    dialog.showErrorBox('NekroNXT 启动界面无法打开', error instanceof Error ? error.message : String(error))
    app.quit()
  })

app.on('activate', () => {
  if (mainWindow !== undefined) {
    mainWindow.show()
    return
  }
  if (startupWindow !== undefined) {
    startupWindow.window.show()
    return
  }
  app.quit()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (quitting && shutdownTask === undefined) return
  event.preventDefault()
  if (shutdownTask !== undefined) return
  quitting = true
  cancelled = true
  if (startupState.mode !== 'restoring' && startupState.mode !== 'restored')
    publishStartup({ ...startupState, mode: 'cancelling' })
  detachLocalHostLifecycle?.()
  detachLocalHostLifecycle = undefined
  instanceManager?.dispose()
  shutdownTask = (async () => {
    await stopProductHost()
    await startupTask
    await restoreTask
  })().finally(() => {
    shutdownTask = undefined
    startupWindow?.window.destroy()
    startupWindow = undefined
    app.quit()
  })
})
