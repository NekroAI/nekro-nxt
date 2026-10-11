import { hostReleaseGuard } from './host-release-guard.js'
export const HOST_EVENT_STREAM_EVENTS = [
  'snapshot-changed',
  'channel-fact',
  'connection-fact',
  'runtime',
  'extensions-changed',
  'dsh-plugins-changed',
  'dsh-plugin-operation',
  'dynamic-changed',
  'status',
  'dsh-settings-changed',
  'dsh-credentials-changed',
  'binding-change',
  'attention-changed',
] as const

export type HostEventStreamEvent = 'open' | 'error' | (typeof HOST_EVENT_STREAM_EVENTS)[number]
export type HostEventStreamListener = (event: unknown) => void
export type HostEventStreamHandlers = Partial<Readonly<Record<HostEventStreamEvent, HostEventStreamListener>>>

interface OnlineEventTarget {
  addEventListener(type: 'online', listener: () => void): void
  removeEventListener(type: 'online', listener: () => void): void
}

interface VisibilityTarget {
  readonly visibilityState: string
  addEventListener(type: 'visibilitychange', listener: () => void): void
  removeEventListener(type: 'visibilitychange', listener: () => void): void
}

interface HostEventSource {
  readonly readyState: number
  addEventListener(type: string, listener: (event: Event) => void): void
  close(): void
}

export interface HostEventStreamOptions {
  readonly createEventSource?: (() => HostEventSource) | undefined
  readonly reconnectDelaysMs?: readonly number[] | undefined
  readonly nativeReconnectGraceMs?: number | undefined
  readonly onlineTarget?: OnlineEventTarget | null | undefined
  /** An open connection that delivers no frame (the Server sends a heartbeat every 15 s) for this long is replaced. */
  readonly staleAfterMs?: number | undefined
  /** A page that returns to the foreground after this long without a frame reconnects at once. */
  readonly resumeAfterMs?: number | undefined
  readonly visibilityTarget?: VisibilityTarget | null | undefined
}

const defaultOnlineTarget = (): OnlineEventTarget | null => (typeof window === 'undefined' ? null : window)
const defaultVisibilityTarget = (): VisibilityTarget | null => (typeof document === 'undefined' ? null : document)

const EVENT_SOURCE_CONNECTING = 0
const EVENT_SOURCE_OPEN = 1

/**
 * Owns the browser's single Host SSE connection.
 *
 * Native EventSource retry remains the first recovery path so Last-Event-ID is
 * preserved across ordinary network interruptions. Some intermediaries turn a
 * failed upstream connection into an HTTP error, which permanently closes the
 * EventSource. In that case, or when native retry stays stuck for too long, the
 * stream recreates the EventSource with bounded backoff. Consumers reconcile
 * authoritative REST projections after every open, so replacing the browser
 * object cannot leave gaps in channel facts or runtime state.
 */
export class HostEventStream {
  readonly #subscriptions = new Set<HostEventStreamHandlers>()
  readonly #createEventSource: () => HostEventSource
  readonly #reconnectDelaysMs: readonly number[]
  readonly #nativeReconnectGraceMs: number
  readonly #onlineTarget: OnlineEventTarget | null
  readonly #onlineListener = (): void => this.reconnectNow()
  readonly #staleAfterMs: number
  readonly #resumeAfterMs: number
  readonly #visibilityTarget: VisibilityTarget | null
  readonly #visibilityListener = (): void => {
    if (this.#visibilityTarget?.visibilityState !== 'visible') return
    if (Date.now() - this.#lastFrameAt >= this.#resumeAfterMs) this.reconnectNow()
  }
  #source: HostEventSource | undefined
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined
  #reconnectAttempt = 0
  #watchdog: ReturnType<typeof setInterval> | undefined
  #lastFrameAt = 0

  constructor(options: HostEventStreamOptions = {}) {
    this.#createEventSource = options.createEventSource ?? (() => new EventSource('/api/events'))
    this.#reconnectDelaysMs = options.reconnectDelaysMs ?? [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]
    if (this.#reconnectDelaysMs.length === 0 || this.#reconnectDelaysMs.some((delay) => delay < 0)) {
      throw new TypeError('Host SSE reconnect delays must contain non-negative values.')
    }
    this.#nativeReconnectGraceMs = options.nativeReconnectGraceMs ?? 5_000
    if (this.#nativeReconnectGraceMs < 0) throw new TypeError('Host SSE native reconnect grace must be non-negative.')
    this.#onlineTarget = options.onlineTarget === undefined ? defaultOnlineTarget() : options.onlineTarget
    this.#staleAfterMs = options.staleAfterMs ?? 45_000
    this.#resumeAfterMs = options.resumeAfterMs ?? 20_000
    this.#visibilityTarget =
      options.visibilityTarget === undefined ? defaultVisibilityTarget() : options.visibilityTarget
  }

  subscribe(handlers: HostEventStreamHandlers): () => void {
    this.#subscriptions.add(handlers)
    if (this.#subscriptions.size === 1) this.#start()
    return () => {
      this.#subscriptions.delete(handlers)
      if (this.#subscriptions.size === 0) this.#stop()
    }
  }

  reconnectNow(): void {
    if (this.#subscriptions.size === 0) return
    this.#reconnectAttempt = 0
    this.#clearReconnectTimer()
    this.#replaceSource()
  }

  #start(): void {
    this.#onlineTarget?.addEventListener('online', this.#onlineListener)
    this.#visibilityTarget?.addEventListener('visibilitychange', this.#visibilityListener)
    this.#watchdog = setInterval(() => this.#checkStale(), Math.max(1_000, Math.floor(this.#staleAfterMs / 3)))
    this.#connect()
  }

  #stop(): void {
    this.#onlineTarget?.removeEventListener('online', this.#onlineListener)
    this.#visibilityTarget?.removeEventListener('visibilitychange', this.#visibilityListener)
    if (this.#watchdog !== undefined) clearInterval(this.#watchdog)
    this.#watchdog = undefined
    this.#clearReconnectTimer()
    this.#source?.close()
    this.#source = undefined
    this.#reconnectAttempt = 0
  }

  #connect(): void {
    if (this.#subscriptions.size === 0 || this.#source !== undefined) return
    let source: HostEventSource
    try {
      source = this.#createEventSource()
    } catch (cause) {
      this.#publish('error', cause)
      this.#scheduleReconnect(false)
      return
    }
    this.#source = source
    this.#lastFrameAt = Date.now()
    source.addEventListener('heartbeat', () => {
      if (source === this.#source) this.#lastFrameAt = Date.now()
    })
    source.addEventListener('open', (event) => {
      if (source !== this.#source) return
      this.#lastFrameAt = Date.now()
      this.#clearReconnectTimer()
      this.#reconnectAttempt = 0
      hostReleaseGuard.reconnect()
      this.#publish('open', event)
    })
    source.addEventListener('error', (event) => {
      if (source !== this.#source) return
      this.#publish('error', event)
      const nativeRetrying = source.readyState === EVENT_SOURCE_CONNECTING
      if (!nativeRetrying) {
        source.close()
        this.#source = undefined
      }
      this.#scheduleReconnect(nativeRetrying)
    })
    for (const type of HOST_EVENT_STREAM_EVENTS) {
      source.addEventListener(type, (event) => {
        if (source !== this.#source) return
        this.#lastFrameAt = Date.now()
        this.#publish(type, event)
      })
    }
  }

  #scheduleReconnect(nativeRetrying: boolean): void {
    if (this.#subscriptions.size === 0 || this.#reconnectTimer !== undefined) return
    const index = Math.min(this.#reconnectAttempt, this.#reconnectDelaysMs.length - 1)
    const configuredDelay = this.#reconnectDelaysMs[index] ?? 30_000
    const delay = nativeRetrying ? Math.max(configuredDelay, this.#nativeReconnectGraceMs) : configuredDelay
    this.#reconnectAttempt += 1
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined
      this.#replaceSource()
    }, delay)
  }

  /**
   * A connection a proxy or a sleeping network left half-open stays OPEN without delivering anything and never
   * reports an error; treat a long silence as a failure so the page says so and reconciles after reconnecting.
   */
  #checkStale(): void {
    const source = this.#source
    if (source === undefined || source.readyState !== EVENT_SOURCE_OPEN) return
    if (Date.now() - this.#lastFrameAt < this.#staleAfterMs) return
    this.#publish('error', new Error('Host event stream went silent.'))
    this.reconnectNow()
  }

  #replaceSource(): void {
    this.#source?.close()
    this.#source = undefined
    this.#connect()
  }

  #clearReconnectTimer(): void {
    if (this.#reconnectTimer !== undefined) clearTimeout(this.#reconnectTimer)
    this.#reconnectTimer = undefined
  }

  #publish(type: HostEventStreamEvent, event: unknown): void {
    for (const handlers of this.#subscriptions) {
      try {
        handlers[type]?.(event)
      } catch (cause) {
        console.error('Host event subscriber failed', cause)
      }
    }
  }
}

export const productHostEventStream = new HostEventStream()
