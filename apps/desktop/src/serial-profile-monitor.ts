import type { InstanceStatus } from './instance-profiles.js'

export interface ProfileMonitorTarget {
  readonly id: string
  readonly kind: 'local' | 'remote'
  readonly generation: number
  readonly notificationsEnabled: boolean
  readonly status: InstanceStatus
}

export interface SerialProfileMonitorOptions<NotificationResult> {
  readonly intervalMs?: number
  readonly getTargets: () => readonly ProfileMonitorTarget[]
  readonly isCurrent: (target: ProfileMonitorTarget) => boolean
  readonly probeRemote: (target: ProfileMonitorTarget, signal: AbortSignal) => Promise<InstanceStatus>
  readonly statusFromProbeError: (cause: unknown) => InstanceStatus
  readonly commitRemoteStatus: (target: ProfileMonitorTarget, status: InstanceStatus) => void
  readonly readNotifications: (target: ProfileMonitorTarget, signal: AbortSignal) => Promise<NotificationResult>
  readonly commitNotifications: (target: ProfileMonitorTarget, result: NotificationResult) => void
  readonly onNotificationError?: (target: ProfileMonitorTarget, cause: unknown) => void
  readonly onCycleError?: (cause: unknown) => void
  readonly schedule?: (callback: () => void, delayMs: number) => unknown
  readonly clearSchedule?: (handle: unknown) => void
}

const DEFAULT_INTERVAL_MS = 5_000

/** Runs one complete profile cycle at a time and schedules the next cycle only after settlement. */
export class SerialProfileMonitor<NotificationResult> {
  readonly #options: SerialProfileMonitorOptions<NotificationResult>
  readonly #intervalMs: number
  #lifecycle: AbortController | undefined
  #cycle: Promise<void> | undefined
  #cancelScheduled: (() => void) | undefined

  constructor(options: SerialProfileMonitorOptions<NotificationResult>) {
    this.#options = options
    this.#intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
    if (!Number.isSafeInteger(this.#intervalMs) || this.#intervalMs < 0) {
      throw new TypeError('Desktop profile monitor interval must be a non-negative integer.')
    }
  }

  start(): void {
    if (this.#lifecycle !== undefined) return
    this.#lifecycle = new AbortController()
    this.#startCycle()
  }

  stop(): void {
    const lifecycle = this.#lifecycle
    if (lifecycle === undefined) return
    this.#lifecycle = undefined
    lifecycle.abort({ kind: 'desktop-profile-monitor-stopping' })
    this.#cancelScheduled?.()
    this.#cancelScheduled = undefined
  }

  async settled(): Promise<void> {
    await this.#cycle
  }

  #startCycle(): void {
    const lifecycle = this.#lifecycle
    if (lifecycle === undefined || this.#cycle !== undefined) return
    this.#cancelScheduled = undefined
    const cycle = this.#runCycle(lifecycle.signal)
      .catch((cause: unknown) => {
        if (lifecycle.signal.aborted) return
        try {
          this.#options.onCycleError?.(cause)
        } catch {
          // Diagnostics must not turn a contained monitor failure into an unhandled rejection.
        }
      })
      .finally(() => {
        if (this.#cycle === cycle) this.#cycle = undefined
        if (this.#lifecycle !== lifecycle || lifecycle.signal.aborted) return
        if (this.#options.schedule) {
          const handle = this.#options.schedule(() => this.#startCycle(), this.#intervalMs)
          const clearSchedule = this.#options.clearSchedule
          if (clearSchedule) this.#cancelScheduled = () => clearSchedule(handle)
        } else {
          const handle = setTimeout(() => this.#startCycle(), this.#intervalMs)
          this.#cancelScheduled = () => clearTimeout(handle)
        }
      })
    this.#cycle = cycle
  }

  async #runCycle(signal: AbortSignal): Promise<void> {
    for (const target of this.#options.getTargets()) {
      if (signal.aborted) return
      let available = target.status === 'ready'
      if (target.kind === 'remote') {
        let status: InstanceStatus
        try {
          status = await this.#options.probeRemote(target, signal)
        } catch (cause) {
          if (signal.aborted) return
          status = this.#options.statusFromProbeError(cause)
        }
        if (!this.#options.isCurrent(target)) continue
        this.#options.commitRemoteStatus(target, status)
        available = status === 'ready'
      }
      if (!target.notificationsEnabled || !available || !this.#options.isCurrent(target)) continue
      try {
        const result = await this.#options.readNotifications(target, signal)
        if (this.#options.isCurrent(target)) this.#options.commitNotifications(target, result)
      } catch (cause) {
        if (!signal.aborted && this.#options.isCurrent(target)) this.#options.onNotificationError?.(target, cause)
      }
    }
  }
}
