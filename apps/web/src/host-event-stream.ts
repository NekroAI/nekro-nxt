export const HOST_EVENT_STREAM_EVENTS = [
  'channel-fact',
  'runtime',
  'extensions-changed',
  'dsh-plugins-changed',
  'dsh-plugin-operation',
  'dynamic-changed',
  'status',
  'dsh-settings-changed',
  'dsh-credentials-changed',
  'binding-change',
] as const

export type HostEventStreamEvent = 'open' | 'error' | (typeof HOST_EVENT_STREAM_EVENTS)[number]
export type HostEventStreamListener = (event: unknown) => void
export type HostEventStreamHandlers = Partial<Readonly<Record<HostEventStreamEvent, HostEventStreamListener>>>

interface OnlineEventTarget {
  addEventListener(type: 'online', listener: () => void): void
  removeEventListener(type: 'online', listener: () => void): void
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
}

const defaultOnlineTarget = (): OnlineEventTarget | null => (typeof window === 'undefined' ? null : window)

const EVENT_SOURCE_CONNECTING = 0

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
  #source: HostEventSource | undefined
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined
  #reconnectAttempt = 0

  constructor(options: HostEventStreamOptions = {}) {
    this.#createEventSource = options.createEventSource ?? (() => new EventSource('/api/events'))
    this.#reconnectDelaysMs = options.reconnectDelaysMs ?? [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]
    if (this.#reconnectDelaysMs.length === 0 || this.#reconnectDelaysMs.some((delay) => delay < 0)) {
      throw new TypeError('Host SSE reconnect delays must contain non-negative values.')
    }
    this.#nativeReconnectGraceMs = options.nativeReconnectGraceMs ?? 5_000
    if (this.#nativeReconnectGraceMs < 0) throw new TypeError('Host SSE native reconnect grace must be non-negative.')
    this.#onlineTarget = options.onlineTarget === undefined ? defaultOnlineTarget() : options.onlineTarget
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
    this.#connect()
  }

  #stop(): void {
    this.#onlineTarget?.removeEventListener('online', this.#onlineListener)
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
    source.addEventListener('open', (event) => {
      if (source !== this.#source) return
      this.#clearReconnectTimer()
      this.#reconnectAttempt = 0
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
        if (source === this.#source) this.#publish(type, event)
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
    for (const handlers of this.#subscriptions) handlers[type]?.(event)
  }
}

export const productHostEventStream = new HostEventStream()
