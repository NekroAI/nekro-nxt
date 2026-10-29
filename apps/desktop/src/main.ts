import { app, dialog, shell, utilityProcess, type BrowserWindow, type UtilityProcess } from 'electron'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DataDirectoryService } from './data-directory-service.js'
import { dataLocationFiles, resolveDesktopUserData } from './data-location.js'
import {
  decideStartup,
  moveOwnerAlive,
  parseDataMoveRecord,
  processAlive,
  removeMigrationSession,
  serializeDataMoveRecord,
  type DataMoveRecord,
  withoutRewrites,
  type StartupDecision,
} from './data-move.js'
import { runDataMoveMode } from './data-move-mode.js'
import { DataMoveWindow, type DataMoveViewState } from './data-move-window.js'
import { systemStorageFacts } from './storage-location.js'
import {
  desktopDataRoot,
  getDesktopDistribution,
  parseProductRelease,
  resolveProductReleasePath,
  type ProductRelease,
} from './distribution.js'
import { HostSupervisor, type SupervisedHostProcess } from './host-supervisor.js'
import { waitForHostShutdown, type HostStopWaitReason } from './host-shutdown.js'
import { DesktopInstanceManager } from './instance-manager.js'
import { LocalHostLifecycleRelay } from './local-host-state.js'
import { readRememberedPort, rememberPort, reserveLoopbackPort } from './local-port.js'
import {
  parseHostUpgradeProgress,
  restoreHostBackup,
  waitForHostReady,
  type HostStartupObservation,
  type StartupAction,
  type StartupViewState,
} from './host-startup.js'
import { HostStartupWindow } from './startup-window.js'
import { DesktopWindowLifecycle, type WindowTrayActions } from './window-lifecycle.js'
import { createWindowsTray } from './windows-tray.js'

const LOOPBACK_HOST = '127.0.0.1'

const showHostStopWaiting = (reason: HostStopWaitReason, signal: AbortSignal): void => {
  app.focus({ steal: true })
  void dialog
    .showMessageBox({
      type: 'warning',
      title: 'NekroNXT 尚未退出',
      message: reason === 'protected-operation' ? '正在等待本地数据操作安全结束' : '本地服务尚未停止',
      detail:
        reason === 'protected-operation'
          ? '启动、升级或备份恢复仍未结束。完成后会继续退出，请勿强制关闭或同时打开另一份本地数据。'
          : '已尝试终止本地服务，但尚未收到退出确认。请检查系统进程状态；服务停止后会继续退出。',
      buttons: ['继续等待'],
      signal,
    })
    .catch((error: unknown) => console.error('[desktop] 无法显示退出等待提示。', error))
}

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
let windowLifecycle: DesktopWindowLifecycle | undefined

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

/** The port the local Host used last, so its pages keep the same origin and their browser storage. */
const localPortPath = (): string => path.join(app.getPath('userData'), 'local-host-port.json')

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
      NEKRO_HOST_KIND: 'desktop',
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
      forceKill: () => {
        const pid = child.pid
        if (pid === undefined) return
        if (process.platform === 'win32') {
          if (!child.kill()) throw new Error('无法终止本地 Host。')
        } else {
          process.kill(pid, 'SIGKILL')
        }
      },
    },
  }
}

let retryUpgradeOnce = false
const startProductHost = async (release: ProductRelease): Promise<string> => {
  const port = await reserveLoopbackPort(LOOPBACK_HOST, await readRememberedPort(localPortPath()))
  await rememberPort(localPortPath(), port).catch((error: unknown) => {
    console.warn('[desktop] 无法记录本地 Host 端口。', error)
  })
  if (cancelled || quitting) throw new Error('启动已取消。')
  const origin = `http://${LOOPBACK_HOST}:${port}`
  let identity: { releaseId: string; runId: string; pid: number | undefined } = {
    releaseId: release.releaseId,
    runId: '',
    pid: undefined,
  }
  const supervisor = new HostSupervisor({
    origin,
    onStopWaiting: showHostStopWaiting,
    spawnHost: () => {
      const runId = randomUUID()
      const args = retryUpgradeOnce ? ['--retry-upgrade'] : []
      retryUpgradeOnce = false
      const { child, supervised } = forkServer(
        args,
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

// The data directory is decided here, before anything opens it: environment override, then the pointer written by
// Settings → 存储, then the default. An unfinished move is finished or undone first (docs/guide/desktop.md).
const MOVE_FLAG = '--nxt-move-data'
const locationFiles = dataLocationFiles(app.getPath('appData'), desktopDistribution)
const readTextSync = (file: string): string | undefined => {
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}
const writeTextSync = (file: string, text: string): void => {
  const temporary = `${file}.tmp-${process.pid}`
  writeFileSync(temporary, text, { mode: 0o600 })
  renameSync(temporary, file)
}
const userDataResolution = resolveDesktopUserData({
  appDataRoot: app.getPath('appData'),
  distribution: desktopDistribution,
  override: process.env['NEKRO_DESKTOP_USER_DATA'],
  readText: readTextSync,
})
const readMoveRecordSync = (): DataMoveRecord | undefined => {
  try {
    const text = readTextSync(locationFiles.record)
    return text === undefined ? undefined : parseDataMoveRecord(text)
  } catch (error) {
    // A damaged record is ignored: the pointer alone decides where to start.
    console.error('[desktop] 数据目录迁移记录无法读取，按当前目录启动。', error)
    return undefined
  }
}
const startupMove: StartupDecision = (() => {
  if (userDataResolution.source === 'environment') return { kind: 'normal' }
  const record = readMoveRecordSync()
  return decideStartup({
    record,
    migrationFlag: process.argv.includes(MOVE_FLAG),
    pointerRoot: userDataResolution.root,
    ownerAlive: record !== undefined && moveOwnerAlive(record, Date.now(), processAlive),
  })
})()
const dataMoveMode = startupMove.kind === 'migrate' || startupMove.kind === 'undo'
const exitBeforeStart = (title: string, detail: string): void => {
  dialog.showErrorBox(title, detail)
  app.exit(0)
}
let startupBlocked = false
if (userDataResolution.pointerProblem !== undefined) {
  startupBlocked = true
  exitBeforeStart(
    'NekroNXT 无法确定数据目录',
    `无法读取 ${locationFiles.pointer}。修复或删除这个文件后重新打开；删除后会从默认位置 ${userDataResolution.defaultRoot} 启动。`,
  )
} else if (startupMove.kind === 'busy') {
  startupBlocked = true
  exitBeforeStart('NekroNXT 正在更改数据目录', '完成后会自动打开。')
} else if (startupMove.kind === 'finish' || startupMove.kind === 'abandon') {
  const record = withoutRewrites(startupMove.record)
  try {
    writeTextSync(
      locationFiles.record,
      serializeDataMoveRecord(
        startupMove.kind === 'finish'
          ? { ...record, phase: 'completed', finishedAt: record.finishedAt ?? Date.now() }
          : {
              ...record,
              phase: 'failed',
              failure: { message: '更改数据目录没有开始，数据目录没有变化。' },
              finishedAt: Date.now(),
            },
      ),
    )
  } catch (error) {
    console.error('[desktop] 无法更新数据目录迁移记录。', error)
  }
}
if (
  !startupBlocked &&
  !dataMoveMode &&
  userDataResolution.source === 'pointer' &&
  !existsSync(userDataResolution.root)
) {
  startupBlocked = true
  exitBeforeStart(
    'NekroNXT 找不到数据目录',
    `数据目录 ${userDataResolution.root} 不存在。如果它在外置盘上，连接后重新打开 NekroNXT。`,
  )
}
app.setPath('userData', dataMoveMode ? locationFiles.migrationSession : userDataResolution.root)

const gotLock = !startupBlocked && app.requestSingleInstanceLock()
if (!gotLock && !startupBlocked) app.quit()

/** Starts the app again without the migration flag and ends this process. */
const relaunchNormally = (extra: readonly string[] = []): void => {
  app.releaseSingleInstanceLock()
  app.relaunch({ args: [...process.argv.slice(1).filter((arg) => arg !== MOVE_FLAG), ...extra] })
  app.exit(0)
}

const dataDirectory = new DataDirectoryService({
  userData: userDataResolution.root,
  source: userDataResolution.source,
  files: locationFiles,
  storage: systemStorageFacts(),
  pickDirectory: async () => {
    const options = {
      title: '选择新的数据目录',
      buttonLabel: '选择',
      properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
    }
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
    return result.canceled ? undefined : result.filePaths[0]
  },
  stopHost: stopProductHost,
  relaunchForMove: () => relaunchNormally([MOVE_FLAG]),
  showItemInFolder: (target) => shell.showItemInFolder(target),
})

/**
 * Runs `integrity_check` on a copied database in the bundled server runtime, which owns SQLite access; the main process
 * opens no database itself.
 */
const checkSqliteWithServer = (file: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = utilityProcess.fork(serverEntry(), ['--check-sqlite', file], {
      serviceName: 'NekroNXT Data Check',
      stdio: 'pipe',
      env: { ...process.env, NEKRO_DATA: path.dirname(file) },
    })
    let output = ''
    child.stderr?.on('data', (chunk: Uint8Array) => {
      output += Buffer.from(chunk).toString('utf8')
    })
    child.once('exit', (code) => {
      if (code === 0) resolve()
      else {
        const reason = output
          .trim()
          .split('\n')
          .at(-1)
          ?.replace(/^\[nekro-nxt\] 启动失败：\s*/u, '')
        reject(new Error(reason || `exit ${code}`))
      }
    })
  })

const runMigrationWindow = async (decision: Extract<StartupDecision, { kind: 'migrate' | 'undo' }>): Promise<void> => {
  const record = decision.record
  const diagnostics = [
    `迁移记录：${locationFiles.record}`,
    `编号：${record.id}`,
    `方式：${record.method === 'move' ? '同盘移动' : '复制并校验'}`,
    `原目录：${record.source}`,
    `新目录：${record.target}`,
  ].join('\n')
  const initial: DataMoveViewState = {
    mode: decision.kind === 'undo' ? 'undoing' : 'moving',
    method: record.method,
    source: record.source,
    target: record.target,
    diagnostics,
  }
  const moveWindow = new DataMoveWindow(initial, () => relaunchNormally())
  await moveWindow.load()
  moveWindow.window.show()
  const result = await runDataMoveMode({
    files: locationFiles,
    record,
    kind: decision.kind,
    publish: (state) => moveWindow.update({ ...state, diagnostics }),
    checkSqlite: checkSqliteWithServer,
    relaunch: () => relaunchNormally(),
  })
  if (result === 'stopped') moveWindow.allowClose()
}

app.on('second-instance', () => {
  windowLifecycle?.show()
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
      dataDirectory,
    })
    if (cancelled || quitting) {
      manager.dispose()
      manager.window.destroy()
      return
    }
    instanceManager = manager
    detachLocalHostLifecycle = localHostLifecycle.subscribe((status) => manager.commitLocalHostStatus(status))
    mainWindow = manager.window
    windowLifecycle?.attach(mainWindow)
    windowLifecycle?.showWhenReady()
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
    retryUpgradeOnce = true
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
    if (!gotLock || quitting) return
    app.setAppUserModelId(desktopDistribution.appId)
    if (startupMove.kind === 'migrate' || startupMove.kind === 'undo') {
      await runMigrationWindow(startupMove)
      return
    }
    if (userDataResolution.source !== 'environment') void removeMigrationSession(locationFiles.migrationSession)
    windowLifecycle = new DesktopWindowLifecycle({
      platform: process.platform,
      isQuitting: () => quitting,
      quit: () => app.quit(),
      createTray: (actions: WindowTrayActions) =>
        createWindowsTray(productRelease.channel, desktopDistribution.productName, actions),
    })
    startupWindow = new HostStartupWindow(startupState, onStartupAction)
    windowLifecycle.attach(startupWindow.window)
    await startupWindow.load()
    if (quitting) return
    windowLifecycle.showWhenReady()
    beginStartup()
  })
  .catch((error: unknown) => {
    dialog.showErrorBox('NekroNXT 启动界面无法打开', error instanceof Error ? error.message : String(error))
    app.quit()
  })

app.on('activate', () => {
  windowLifecycle?.show()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || dataMoveMode) app.quit()
})

app.on('before-quit', (event) => {
  if (quitting && shutdownTask === undefined) return
  event.preventDefault()
  if (shutdownTask !== undefined) return
  quitting = true
  windowLifecycle?.dispose()
  cancelled = true
  if (startupState.mode !== 'restoring' && startupState.mode !== 'restored')
    publishStartup({ ...startupState, mode: 'cancelling' })
  detachLocalHostLifecycle?.()
  detachLocalHostLifecycle = undefined
  instanceManager?.dispose()
  shutdownTask = (async () => {
    await stopProductHost()
    await startupTask
    if (restoreTask !== undefined) await waitForHostShutdown({ exited: restoreTask, onWaiting: showHostStopWaiting })
  })().finally(() => {
    shutdownTask = undefined
    startupWindow?.window.destroy()
    startupWindow = undefined
    app.quit()
  })
})
