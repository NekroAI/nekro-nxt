export interface SupervisedHostProcess {
  once(event: 'exit', listener: (code: number) => void): unknown
  kill(): boolean
}

export interface HostRestartNotice {
  readonly attempt: number
  readonly delayMs: number
  readonly cause: Error
}

export interface HostSupervisorOptions {
  readonly origin: string
  readonly spawnHost: (origin: string) => SupervisedHostProcess
  readonly waitUntilReady: (origin: string, signal: AbortSignal) => Promise<void>
  readonly delay?: (delayMs: number, signal: AbortSignal) => Promise<void>
  readonly now?: () => number
  readonly restartDelaysMs?: readonly number[]
  readonly crashWindowMs?: number
  readonly maxRestartAttempts?: number
  readonly onRestarting?: (notice: HostRestartNotice) => void
  readonly onRecovered?: (attempt: number) => void
  readonly onFatal?: (error: Error) => void
}

interface HostLaunch {
  readonly process: SupervisedHostProcess
  readonly exited: Promise<{ readonly code: number }>
  hasExited(): boolean
}

const DEFAULT_RESTART_DELAYS_MS = [500, 1_000, 2_000, 5_000, 5_000] as const
const DEFAULT_CRASH_WINDOW_MS = 60_000
const DEFAULT_MAX_RESTART_ATTEMPTS = 5

const errorFrom = (cause: unknown, fallback: string): Error =>
  cause instanceof Error ? cause : new Error(typeof cause === 'string' && cause.trim() ? cause : fallback)

export const abortableDelay = (delayMs: number, signal: AbortSignal): Promise<void> => {
  if (signal.aborted) return Promise.reject(errorFrom(signal.reason, 'Desktop Host delay was aborted.'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    const onAbort = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(errorFrom(signal.reason, 'Desktop Host delay was aborted.'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Keeps one Desktop Host origin stable while replacing an unexpectedly exited child process. */
export class HostSupervisor {
  readonly #options: Required<
    Pick<HostSupervisorOptions, 'delay' | 'now' | 'restartDelaysMs' | 'crashWindowMs' | 'maxRestartAttempts'>
  > &
    Omit<HostSupervisorOptions, 'delay' | 'now' | 'restartDelaysMs' | 'crashWindowMs' | 'maxRestartAttempts'>
  readonly #failures: number[] = []
  #lifecycle: AbortController | undefined
  #current: HostLaunch | undefined
  #supervision: Promise<void> | undefined

  constructor(options: HostSupervisorOptions) {
    const restartDelaysMs = options.restartDelaysMs ?? DEFAULT_RESTART_DELAYS_MS
    const crashWindowMs = options.crashWindowMs ?? DEFAULT_CRASH_WINDOW_MS
    const maxRestartAttempts = options.maxRestartAttempts ?? DEFAULT_MAX_RESTART_ATTEMPTS
    if (
      restartDelaysMs.length === 0 ||
      restartDelaysMs.some((delayMs) => !Number.isSafeInteger(delayMs) || delayMs < 0)
    ) {
      throw new TypeError('Desktop Host restart delays must be non-negative integers.')
    }
    if (!Number.isSafeInteger(crashWindowMs) || crashWindowMs <= 0) {
      throw new TypeError('Desktop Host crash window must be a positive integer.')
    }
    if (!Number.isSafeInteger(maxRestartAttempts) || maxRestartAttempts <= 0) {
      throw new TypeError('Desktop Host restart budget must be a positive integer.')
    }
    this.#options = {
      ...options,
      delay: options.delay ?? abortableDelay,
      now: options.now ?? Date.now,
      restartDelaysMs,
      crashWindowMs,
      maxRestartAttempts,
    }
  }

  get origin(): string {
    return this.#options.origin
  }

  async start(): Promise<void> {
    if (this.#lifecycle !== undefined) throw new Error('Desktop Host supervisor is already started.')
    const lifecycle = new AbortController()
    this.#lifecycle = lifecycle
    let launch: HostLaunch
    try {
      launch = this.#launch()
      this.#current = launch
      await this.#waitUntilReady(launch, lifecycle.signal)
    } catch (cause) {
      const failed = this.#current
      this.#current = undefined
      lifecycle.abort({ kind: 'startup-failed' })
      if (failed !== undefined) await this.#terminate(failed)
      this.#lifecycle = undefined
      throw errorFrom(cause, 'Desktop Host failed to start.')
    }
    this.#supervision = this.#supervise(launch, lifecycle.signal)
  }

  async stop(): Promise<void> {
    const lifecycle = this.#lifecycle
    if (lifecycle === undefined) return
    this.#lifecycle = undefined
    lifecycle.abort({ kind: 'desktop-stopping' })
    const current = this.#current
    this.#current = undefined
    if (current !== undefined) await this.#terminate(current)
    await this.#supervision
    this.#supervision = undefined
  }

  #launch(): HostLaunch {
    const process = this.#options.spawnHost(this.#options.origin)
    let exited = false
    let resolveExit!: (exit: { readonly code: number }) => void
    const exitPromise = new Promise<{ readonly code: number }>((resolve) => {
      resolveExit = resolve
    })
    process.once('exit', (code) => {
      if (exited) return
      exited = true
      resolveExit({ code })
    })
    return { process, exited: exitPromise, hasExited: () => exited }
  }

  async #waitUntilReady(launch: HostLaunch, lifecycleSignal: AbortSignal): Promise<void> {
    const readiness = new AbortController()
    const abortReadiness = (): void => readiness.abort(lifecycleSignal.reason)
    lifecycleSignal.addEventListener('abort', abortReadiness, { once: true })
    try {
      await Promise.race([
        this.#options.waitUntilReady(this.#options.origin, readiness.signal),
        launch.exited.then(({ code }) => {
          throw new Error(`Desktop Host exited before readiness (code ${code}).`)
        }),
      ])
    } finally {
      lifecycleSignal.removeEventListener('abort', abortReadiness)
      readiness.abort({ kind: 'readiness-settled' })
    }
  }

  async #supervise(initial: HostLaunch, signal: AbortSignal): Promise<void> {
    let active = initial
    while (!signal.aborted) {
      const { code } = await active.exited
      if (this.#current === active) this.#current = undefined
      if (signal.aborted) return
      let failure = new Error(`Desktop Host exited unexpectedly (code ${code}).`)
      while (!signal.aborted) {
        const restart = this.#registerFailure(failure)
        if (restart === undefined) return
        this.#options.onRestarting?.(restart)
        try {
          await this.#options.delay(restart.delayMs, signal)
        } catch (cause) {
          if (signal.aborted) return
          failure = errorFrom(cause, 'Desktop Host restart delay failed.')
          continue
        }
        if (signal.aborted) return
        let candidate: HostLaunch
        try {
          candidate = this.#launch()
          this.#current = candidate
          await this.#waitUntilReady(candidate, signal)
          active = candidate
          this.#options.onRecovered?.(restart.attempt)
          break
        } catch (cause) {
          const failed = this.#current
          this.#current = undefined
          if (failed !== undefined) await this.#terminate(failed)
          failure = errorFrom(cause, 'Desktop Host restart failed.')
        }
      }
    }
  }

  #registerFailure(cause: Error): HostRestartNotice | undefined {
    const now = this.#options.now()
    const earliest = now - this.#options.crashWindowMs
    while (this.#failures[0] !== undefined && this.#failures[0] < earliest) this.#failures.shift()
    this.#failures.push(now)
    const attempt = this.#failures.length
    if (attempt > this.#options.maxRestartAttempts) {
      this.#options.onFatal?.(
        new Error(
          `Desktop Host failed more than ${this.#options.maxRestartAttempts} times within ${this.#options.crashWindowMs} ms.`,
          { cause },
        ),
      )
      return undefined
    }
    const delayMs = this.#options.restartDelaysMs[Math.min(attempt - 1, this.#options.restartDelaysMs.length - 1)] ?? 0
    return { attempt, delayMs, cause }
  }

  async #terminate(launch: HostLaunch): Promise<void> {
    if (!launch.hasExited()) {
      try {
        launch.process.kill()
      } catch {
        // The process can cross the exit boundary between hasExited() and kill().
      }
    }
    await launch.exited
  }
}
