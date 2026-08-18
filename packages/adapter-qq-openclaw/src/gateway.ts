import type { AdapterRuntimeStateStore } from '@nekro-nxt/adapter-sdk'
import { JsonValueSchema, type ConnectionId } from '@nekro-nxt/contracts'
import { z } from 'zod'

export const QQ_GATEWAY_INTENTS = (1 << 25) | (1 << 12) | (1 << 30) | (1 << 26)

const gatewayPayloadSchema = z
  .object({
    op: z.number().int(),
    d: z.unknown().optional(),
    s: z.number().int().nonnegative().optional(),
    t: z.string().optional(),
  })
  .passthrough()

export type QQGatewayPayload = z.infer<typeof gatewayPayloadSchema>

export interface QQGatewayCheckpoint {
  readonly appId: string
  readonly sessionId: string
  readonly sequence: number
  readonly savedAt: number
}

const qqGatewayCheckpointSchema = z
  .object({
    appId: z.string().min(1),
    sessionId: z.string().min(1),
    sequence: z.number().int().nonnegative(),
    savedAt: z.number().int().nonnegative(),
  })
  .strict()

export const QQ_GATEWAY_RUNTIME_STATE_KEY = 'qq-openclaw.gateway-session'

export interface QQGatewayCheckpointStore {
  load(): Promise<QQGatewayCheckpoint | undefined>
  save(checkpoint: QQGatewayCheckpoint): Promise<void>
  clear(): Promise<void>
}

export const createQQGatewayCheckpointStore = (
  connectionId: ConnectionId,
  states: AdapterRuntimeStateStore,
): QQGatewayCheckpointStore => ({
  load: async () => {
    const value = await states.load(connectionId, QQ_GATEWAY_RUNTIME_STATE_KEY)
    if (value === undefined) return undefined
    const parsed = qqGatewayCheckpointSchema.safeParse(value)
    if (parsed.success) return parsed.data
    await states.clear(connectionId, QQ_GATEWAY_RUNTIME_STATE_KEY)
    return undefined
  },
  save: async (checkpoint) => {
    const parsed = qqGatewayCheckpointSchema.parse(checkpoint)
    const value = JsonValueSchema.parse(parsed)
    await states.save(connectionId, QQ_GATEWAY_RUNTIME_STATE_KEY, value, parsed.savedAt)
  },
  clear: () => states.clear(connectionId, QQ_GATEWAY_RUNTIME_STATE_KEY),
})

export interface QQGatewaySocket {
  readonly messages: AsyncIterable<string>
  send(payload: string): Promise<void>
  close(code?: number, reason?: string): Promise<void>
}

export interface QQGatewaySocketFactory {
  connect(url: string, signal: AbortSignal): Promise<QQGatewaySocket>
}

export interface QQGatewayAccess {
  gatewayUrl(signal: AbortSignal): Promise<string>
  accessToken(signal: AbortSignal): Promise<string>
}

export interface QQGatewayClock {
  now(): number
  sleep(delayMs: number, signal: AbortSignal): Promise<void>
  setInterval(callback: () => void, intervalMs: number): () => void
}

export interface QQGatewayStatus {
  readonly state: 'stopped' | 'connecting' | 'connected' | 'reconnecting' | 'failed'
  readonly sessionId?: string
  readonly sequence?: number
  readonly resumed?: boolean
  readonly lastError?: string
}

export interface QQGatewayClientOptions {
  readonly appId: string
  readonly access: QQGatewayAccess
  readonly sockets: QQGatewaySocketFactory
  readonly checkpoints: QQGatewayCheckpointStore
  readonly clock: QQGatewayClock
  readonly onDispatch: (
    eventType: string,
    data: Readonly<Record<string, unknown>>,
    context: { readonly sequence?: number; readonly signal: AbortSignal },
  ) => Promise<boolean>
  readonly onStatus?: (status: QQGatewayStatus) => void
  readonly maxDispatchAttempts?: number
  readonly onQuarantine?: (input: {
    readonly eventType: string
    readonly sequence?: number
    readonly errorSummary: string
  }) => Promise<void>
  readonly resumeTtlMs?: number
  readonly initialReconnectDelayMs?: number
  readonly maxReconnectDelayMs?: number
}

const gatewayDataSchema = z.record(z.string(), z.unknown())

const dataObject = (value: unknown): Readonly<Record<string, unknown>> => {
  const parsed = gatewayDataSchema.safeParse(value)
  return parsed.success ? parsed.data : {}
}

export const parseQQGatewayPayload = (input: string): QQGatewayPayload => gatewayPayloadSchema.parse(JSON.parse(input))

/** Owns Gateway identify/resume, heartbeat, reconnect and post-commit sequence checkpoints. */
export class QQGatewayClient {
  readonly #options: QQGatewayClientOptions
  readonly #resumeTtlMs: number
  readonly #initialReconnectDelayMs: number
  readonly #maxReconnectDelayMs: number
  readonly #maxDispatchAttempts: number
  readonly #dispatchAttempts = new Map<string, number>()
  #sessionId: string | undefined
  #sequence: number | undefined
  #loadedCheckpoint = false
  #controller: AbortController | undefined
  #task: Promise<void> | undefined

  constructor(options: QQGatewayClientOptions) {
    this.#options = options
    this.#resumeTtlMs = options.resumeTtlMs ?? 5 * 60 * 1000
    this.#initialReconnectDelayMs = options.initialReconnectDelayMs ?? 2_000
    this.#maxReconnectDelayMs = options.maxReconnectDelayMs ?? 60_000
    this.#maxDispatchAttempts = options.maxDispatchAttempts ?? 3
    if (!Number.isSafeInteger(this.#maxDispatchAttempts) || this.#maxDispatchAttempts < 1) {
      throw new TypeError('QQ Gateway maxDispatchAttempts must be a positive integer.')
    }
  }

  start(): Promise<void> {
    if (this.#task) return Promise.reject(new Error('QQ Gateway is already running.'))
    const controller = new AbortController()
    this.#controller = controller
    this.#task = this.#run(controller.signal).finally(() => {
      this.#task = undefined
      this.#controller = undefined
    })
    return Promise.resolve()
  }

  async stop(): Promise<void> {
    const task = this.#task
    if (!task) {
      this.#publish({ state: 'stopped' })
      return
    }
    this.#controller?.abort(new Error('QQ Gateway stopped.'))
    await task.catch((error: unknown) => {
      if (!this.#controller?.signal.aborted) throw error
    })
    this.#publish({ state: 'stopped' })
  }

  /** One connection attempt, exposed for deterministic Fake Gateway scenarios. */
  async connectOnce(signal: AbortSignal): Promise<'reconnect' | 'invalid-session' | 'closed'> {
    await this.#loadCheckpoint()
    this.#publish({ state: 'connecting' })
    const [url, token] = await Promise.all([
      this.#options.access.gatewayUrl(signal),
      this.#options.access.accessToken(signal),
    ])
    const socket = await this.#options.sockets.connect(url, signal)
    let heartbeatAck = true
    let cancelHeartbeat: (() => void) | undefined
    try {
      for await (const raw of socket.messages) {
        if (signal.aborted) throw signal.reason
        const payload = parseQQGatewayPayload(raw)
        if (payload.op === 10) {
          const interval = dataObject(payload.d)['heartbeat_interval']
          const heartbeatInterval = typeof interval === 'number' && interval >= 1_000 ? interval : 45_000
          await socket.send(JSON.stringify(this.#identifyOrResume(token)))
          cancelHeartbeat?.()
          cancelHeartbeat = this.#options.clock.setInterval(() => {
            if (!heartbeatAck) {
              void socket.close(4000, 'heartbeat acknowledgement timeout')
              return
            }
            heartbeatAck = false
            void socket.send(JSON.stringify({ op: 1, d: this.#sequence ?? null }))
          }, heartbeatInterval)
          continue
        }
        if (payload.op === 11) {
          heartbeatAck = true
          continue
        }
        if (payload.op === 7) return 'reconnect'
        if (payload.op === 9) {
          this.#sessionId = undefined
          this.#sequence = undefined
          await this.#options.checkpoints.clear()
          return 'invalid-session'
        }
        if (payload.op !== 0) continue
        if (payload.s !== undefined && this.#sequence !== undefined && payload.s <= this.#sequence) continue
        const eventType = payload.t ?? ''
        const data = dataObject(payload.d)
        if (eventType === 'READY') {
          const sessionId = data['session_id']
          if (typeof sessionId !== 'string' || !sessionId) throw new Error('QQ Gateway READY omitted session_id.')
          this.#sessionId = sessionId
          await this.#commitSequence(payload.s)
          this.#publish({
            state: 'connected',
            sessionId,
            ...(this.#sequence === undefined ? {} : { sequence: this.#sequence }),
            resumed: false,
          })
          continue
        }
        if (eventType === 'RESUMED') {
          await this.#commitSequence(payload.s)
          this.#publish({
            state: 'connected',
            ...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }),
            ...(this.#sequence === undefined ? {} : { sequence: this.#sequence }),
            resumed: true,
          })
          continue
        }
        const dispatchKey = `${payload.s ?? 'none'}:${eventType}`
        let committed: boolean
        try {
          committed = await this.#options.onDispatch(eventType, data, {
            ...(payload.s === undefined ? {} : { sequence: payload.s }),
            signal,
          })
          this.#dispatchAttempts.delete(dispatchKey)
        } catch (error) {
          const attempts = (this.#dispatchAttempts.get(dispatchKey) ?? 0) + 1
          this.#dispatchAttempts.set(dispatchKey, attempts)
          if (attempts < this.#maxDispatchAttempts) throw error
          const errorSummary = (error instanceof Error ? error.message : 'Unknown dispatch failure.').slice(0, 512)
          await this.#options.onQuarantine?.({
            eventType,
            ...(payload.s === undefined ? {} : { sequence: payload.s }),
            errorSummary,
          })
          this.#publish({
            state: 'connected',
            ...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }),
            ...(this.#sequence === undefined ? {} : { sequence: this.#sequence }),
            lastError: `Quarantined ${eventType} after ${attempts} failed attempts: ${errorSummary}`,
          })
          this.#dispatchAttempts.delete(dispatchKey)
          await this.#commitSequence(payload.s)
          continue
        }
        if (!committed) return 'reconnect'
        await this.#commitSequence(payload.s)
      }
      return 'closed'
    } finally {
      cancelHeartbeat?.()
      await socket.close()
    }
  }

  async #run(signal: AbortSignal): Promise<void> {
    let delay = this.#initialReconnectDelayMs
    while (!signal.aborted) {
      try {
        const outcome = await this.connectOnce(signal)
        if (signal.aborted) break
        this.#publish({ state: 'reconnecting', lastError: outcome })
        delay = this.#initialReconnectDelayMs
      } catch (error) {
        if (signal.aborted) break
        this.#publish({ state: 'reconnecting', lastError: error instanceof Error ? error.message : String(error) })
      }
      await this.#options.clock.sleep(delay, signal)
      delay = Math.min(Math.ceil(delay * 1.8), this.#maxReconnectDelayMs)
    }
  }

  #identifyOrResume(token: string): Readonly<Record<string, unknown>> {
    if (this.#sessionId && this.#sequence !== undefined) {
      return {
        op: 6,
        d: { token: `QQBot ${token}`, session_id: this.#sessionId, seq: this.#sequence },
      }
    }
    return {
      op: 2,
      d: {
        token: `QQBot ${token}`,
        intents: QQ_GATEWAY_INTENTS,
        shard: [0, 1],
        properties: { $os: 'node', $browser: 'nekro-nxt', $device: 'nekro-nxt' },
      },
    }
  }

  async #loadCheckpoint(): Promise<void> {
    if (this.#loadedCheckpoint) return
    this.#loadedCheckpoint = true
    const checkpoint = await this.#options.checkpoints.load()
    if (
      checkpoint &&
      checkpoint.appId === this.#options.appId &&
      this.#options.clock.now() - checkpoint.savedAt <= this.#resumeTtlMs
    ) {
      this.#sessionId = checkpoint.sessionId
      this.#sequence = checkpoint.sequence
    } else if (checkpoint) await this.#options.checkpoints.clear()
  }

  async #commitSequence(sequence: number | undefined): Promise<void> {
    if (sequence === undefined) return
    if (this.#sequence !== undefined && sequence <= this.#sequence) return
    this.#sequence = sequence
    if (!this.#sessionId) return
    await this.#options.checkpoints.save({
      appId: this.#options.appId,
      sessionId: this.#sessionId,
      sequence,
      savedAt: this.#options.clock.now(),
    })
  }

  #publish(status: QQGatewayStatus): void {
    this.#options.onStatus?.(status)
  }
}
