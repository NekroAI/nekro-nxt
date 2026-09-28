import { abortableDelay, type SupervisedHostProcess } from './host-supervisor.js'

/** Validated projection of the Server's versioned progress file; no management protocol changes. */
export interface HostUpgradeProgress {
  readonly format: 'nxt.host-upgrade-progress'
  readonly version: 1
  readonly releaseId: string
  readonly runId: string
  readonly pid: number
  readonly updatedAt: number
  readonly status: {
    readonly phase: 'idle' | 'preflight' | 'backup' | 'migrating' | 'checking' | 'activating' | 'ready' | 'recovery'
    readonly backupId?: string
    readonly currentStepId?: string
    readonly errorSummary?: string
    readonly progress?: { readonly completed: number; readonly total?: number; readonly unit: 'bytes' | 'items' }
  }
}

export interface HostLaunchIdentity {
  readonly releaseId: string
  readonly runId: string
  /** utilityProcess.pid is unavailable until its spawn event. */
  readonly pid: number | undefined
}

export interface HostStartupObservation {
  readonly progress?: HostUpgradeProgress
  readonly stalled: boolean
}

export const HOST_STARTUP_TIMEOUT_MS = 60_000
export const HOST_PROGRESS_STALLED_MS = 120_000
const phases = new Set(['idle', 'preflight', 'backup', 'migrating', 'checking', 'activating', 'ready', 'recovery'])
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
const nonnegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
const optionalText = (value: unknown): value is string | undefined =>
  value === undefined || (typeof value === 'string' && value.length <= 4_096)
const isPhase = (value: unknown): value is HostUpgradeProgress['status']['phase'] =>
  typeof value === 'string' && phases.has(value)

export const parseHostUpgradeProgress = (value: unknown): HostUpgradeProgress | undefined => {
  if (!record(value) || value['format'] !== 'nxt.host-upgrade-progress' || value['version'] !== 1) return undefined
  const status = value['status']
  if (
    typeof value['releaseId'] !== 'string' ||
    !value['releaseId'] ||
    typeof value['runId'] !== 'string' ||
    !value['runId'] ||
    typeof value['pid'] !== 'number' ||
    !Number.isSafeInteger(value['pid']) ||
    value['pid'] <= 0 ||
    !nonnegative(value['updatedAt']) ||
    !record(status) ||
    !isPhase(status['phase']) ||
    !optionalText(status['backupId']) ||
    !optionalText(status['currentStepId']) ||
    !optionalText(status['errorSummary'])
  )
    return undefined
  const progress = status['progress']
  let counter: HostUpgradeProgress['status']['progress']
  if (progress !== undefined) {
    if (
      !record(progress) ||
      !nonnegative(progress['completed']) ||
      (progress['total'] !== undefined &&
        (!nonnegative(progress['total']) || progress['total'] < progress['completed'])) ||
      (progress['unit'] !== 'bytes' && progress['unit'] !== 'items')
    )
      return undefined
    counter = {
      completed: progress['completed'],
      unit: progress['unit'],
      ...(progress['total'] === undefined ? {} : { total: progress['total'] }),
    }
  }
  return {
    format: 'nxt.host-upgrade-progress',
    version: 1,
    releaseId: value['releaseId'],
    runId: value['runId'],
    pid: value['pid'],
    updatedAt: value['updatedAt'],
    status: {
      phase: status['phase'],
      ...(status['backupId'] === undefined ? {} : { backupId: status['backupId'] }),
      ...(status['currentStepId'] === undefined ? {} : { currentStepId: status['currentStepId'] }),
      ...(status['errorSummary'] === undefined ? {} : { errorSummary: status['errorSummary'] }),
      ...(counter === undefined ? {} : { progress: counter }),
    },
  }
}

/** A heartbeat proves liveness; only a phase/step/counter change proves useful progress. */
export class HostStartupMonitor {
  readonly #startedAt: number
  #latest: HostUpgradeProgress | undefined
  #lastAdvanceAt: number
  #signature = ''
  #readyAt: number | undefined

  constructor(startedAt: number) {
    this.#startedAt = startedAt
    this.#lastAdvanceAt = startedAt
  }

  observe(value: unknown, identity: HostLaunchIdentity, now: number): HostStartupObservation {
    const progress = parseHostUpgradeProgress(value)
    if (
      progress !== undefined &&
      identity.pid !== undefined &&
      progress.pid === identity.pid &&
      progress.releaseId === identity.releaseId &&
      progress.runId === identity.runId &&
      progress.updatedAt >= this.#startedAt &&
      progress.updatedAt <= now + 5_000 &&
      progress.updatedAt >= (this.#latest?.updatedAt ?? 0)
    ) {
      // Never extend a deadline into the future on a malformed clock value.
      this.#latest = { ...progress, updatedAt: Math.min(progress.updatedAt, now) }
      if (progress.status.phase === 'ready') this.#readyAt ??= now
      const signature = JSON.stringify([progress.status.phase, progress.status.currentStepId, progress.status.progress])
      if (signature !== this.#signature) {
        this.#signature = signature
        this.#lastAdvanceAt = now
      }
    }
    const latest = this.#latest
    if (latest?.status.phase === 'recovery') {
      throw new Error(latest.status.errorSummary || '本地服务升级未完成，请查看诊断后重试或恢复备份。')
    }
    const upgrading = latest !== undefined && latest.status.phase !== 'idle' && latest.status.phase !== 'ready'
    const deadline = upgrading
      ? latest.updatedAt + HOST_STARTUP_TIMEOUT_MS
      : (this.#readyAt ?? this.#startedAt) + HOST_STARTUP_TIMEOUT_MS
    if (now >= deadline) {
      throw new Error(upgrading ? '升级进度心跳已中断超过 60 秒。' : '本地服务未能在 60 秒内完成启动。')
    }
    return {
      ...(latest === undefined ? {} : { progress: latest }),
      stalled: upgrading && now - this.#lastAdvanceAt >= HOST_PROGRESS_STALLED_MS,
    }
  }
}

export interface WaitForHostOptions {
  readonly origin: string
  readonly identity: () => HostLaunchIdentity
  readonly signal: AbortSignal
  readonly readProgress: () => Promise<unknown>
  readonly onObservation: (observation: HostStartupObservation) => void
  readonly probeReady: (signal: AbortSignal) => Promise<unknown>
  readonly now?: () => number
  readonly delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>
}

export async function waitForHostReady(options: WaitForHostOptions): Promise<void> {
  const now = options.now ?? Date.now
  const monitor = new HostStartupMonitor(now())
  const delay = options.delay ?? abortableDelay
  while (true) {
    options.signal.throwIfAborted()
    const value = await options.readProgress().catch(() => undefined)
    options.signal.throwIfAborted()
    // Report even a terminal recovery snapshot, so a verified backup remains available in the UI.
    const parsed = parseHostUpgradeProgress(value)
    const identity = options.identity()
    if (
      parsed?.status.phase === 'recovery' &&
      parsed.pid === identity.pid &&
      parsed.runId === identity.runId &&
      parsed.releaseId === identity.releaseId &&
      parsed.updatedAt >= now() - HOST_STARTUP_TIMEOUT_MS &&
      parsed.updatedAt <= now() + 5_000
    ) {
      options.onObservation({ progress: parsed, stalled: false })
    }
    const observation = monitor.observe(value, identity, now())
    options.onObservation(observation)
    let body: unknown
    try {
      body = await options.probeReady(options.signal)
    } catch {
      options.signal.throwIfAborted()
    }
    if (record(body) && body['status'] === 'ready' && body['releaseId'] === identity.releaseId) return
    await delay(200, options.signal)
  }
}

export const isUpgradeBackupId = (value: string): boolean => /^runtime-[a-f0-9]{32}$/u.test(value)

export type StartupAction = 'retry' | 'cancel' | 'restore' | 'exit'
export interface StartupViewState {
  readonly mode: 'starting' | 'cancelling' | 'failed' | 'restoring' | 'restored'
  readonly observation?: HostStartupObservation
  readonly errorSummary?: string
  readonly diagnostics: string
}

export const allowedStartupActions = (state: StartupViewState): readonly StartupAction[] => {
  switch (state.mode) {
    case 'starting':
      return ['cancel']
    case 'failed':
      return state.observation?.progress?.status.backupId !== undefined &&
        isUpgradeBackupId(state.observation.progress.status.backupId)
        ? ['retry', 'restore', 'exit']
        : ['retry', 'exit']
    case 'restored':
      return ['exit']
    case 'cancelling':
    case 'restoring':
      return []
  }
}

/** Owns a maintenance child until exit. Exit zero is the only successful restore commit. */
export async function restoreHostBackup(options: {
  readonly backupId: string
  readonly stopHost: () => Promise<void>
  readonly spawnRestore: (args: readonly string[]) => SupervisedHostProcess
}): Promise<void> {
  if (!isUpgradeBackupId(options.backupId)) throw new Error('升级恢复点标识无效。')
  await options.stopHost()
  const child = options.spawnRestore(['--restore-upgrade', options.backupId])
  const code = await new Promise<number>((resolve) => child.once('exit', resolve))
  if (code !== 0) throw new Error(`升级备份恢复未完成（退出码 ${code}）。请查看诊断后重试。`)
}
