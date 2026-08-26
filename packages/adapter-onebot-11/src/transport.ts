import type {
  AdapterConnectionHostContext,
  AdapterFailureKind,
  AdapterOptionalCapabilityStatus,
} from '@nekro-nxt/adapter-sdk'
import type { JsonValue } from '@nekro-nxt/contracts'
import { randomUUID } from 'node:crypto'
import WebSocket, { type RawData } from 'ws'
import { z } from 'zod'

const MAX_FRAME_BYTES = 16 * 1024 * 1024
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const ACCOUNT_STATE_KEY = 'onebot-11/account-lock'

export type OneBotObject = Readonly<Record<string, unknown>>

export class OneBotActionError extends Error {
  constructor(
    message: string,
    readonly kind: AdapterFailureKind | 'unsupported' | 'unknown',
    readonly submitted: boolean,
    readonly retcode?: number,
  ) {
    super(message)
    this.name = 'OneBotActionError'
  }
}

interface PendingAction {
  readonly action: string
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

export interface OneBotWebSocketClientOptions {
  readonly context: AdapterConnectionHostContext
  readonly endpoint: string
  readonly accessToken?: string
  readonly onEvent: (event: OneBotObject) => Promise<void>
  readonly requestTimeoutMs?: number
  readonly reconnectDelaysMs?: readonly number[]
}

const OneBotObjectSchema = z.record(z.string(), z.unknown())
const objectValue = (value: unknown): OneBotObject | undefined => {
  const parsed = OneBotObjectSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

const rawDataText = (data: RawData): string => {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return data.toString('utf8')
}

const stringId = (value: unknown): string | undefined => {
  if (typeof value === 'string' && value.length > 0) return value
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  return undefined
}

const responseFailure = (input: OneBotObject): OneBotActionError => {
  const retcode = typeof input['retcode'] === 'number' ? input['retcode'] : undefined
  const wording = [input['message'], input['wording']]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
  const normalized = wording.toLowerCase()
  const unsupported =
    retcode === 1404 ||
    retcode === 404 ||
    /unsupported|not support|unknown action|不支持|未实现|不存在/u.test(normalized)
  const kind: OneBotActionError['kind'] = unsupported
    ? 'unsupported'
    : retcode === 1401 || /token|auth|unauthor/u.test(normalized)
      ? 'authentication'
      : retcode === 1400
        ? 'invalid'
        : retcode === 1408 || /rate|频率|限流/u.test(normalized)
          ? 'rate-limited'
          : retcode !== undefined && retcode >= 1000 && retcode < 2000
            ? 'permanent'
            : 'transient'
  return new OneBotActionError(
    wording || `OneBot Action 失败（retcode ${retcode ?? 'unknown'}）。`,
    kind,
    true,
    retcode,
  )
}

/** One forward Universal WebSocket with echo correlation and strict quiescent stop. */
export class OneBotWebSocketClient {
  readonly #context: AdapterConnectionHostContext
  readonly #endpoint: string
  readonly #accessToken: string | undefined
  readonly #onEvent: OneBotWebSocketClientOptions['onEvent']
  readonly #requestTimeoutMs: number
  readonly #reconnectDelaysMs: readonly number[]
  readonly #pending = new Map<string, PendingAction>()
  readonly #optionalCapabilities = new Map<string, AdapterOptionalCapabilityStatus>()
  #eventQueue: Promise<void> = Promise.resolve()
  #socket: WebSocket | undefined
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined
  #connectGeneration = 0
  #reconnectAttempt = 0
  #started = false
  #stopping = false
  #terminalAccountChange = false
  #selfId: string | undefined
  #version: OneBotObject | undefined

  constructor(options: OneBotWebSocketClientOptions) {
    const endpoint = new URL(options.endpoint)
    if (endpoint.protocol !== 'ws:' && endpoint.protocol !== 'wss:') {
      throw new TypeError('OneBot Endpoint must use ws:// or wss://.')
    }
    this.#context = options.context
    this.#endpoint = endpoint.toString()
    this.#accessToken = options.accessToken
    this.#onEvent = options.onEvent
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.#reconnectDelaysMs = options.reconnectDelaysMs ?? [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]
  }

  get connected(): boolean {
    return this.#socket?.readyState === WebSocket.OPEN && this.#selfId !== undefined
  }

  get accountId(): string | undefined {
    return this.#selfId
  }

  optionalCapability(action: string): AdapterOptionalCapabilityStatus {
    return this.#optionalCapabilities.get(action) ?? 'unknown'
  }

  reportWarning(message: string, details?: Readonly<Record<string, JsonValue>>): void {
    this.#publish(this.connected ? 'connected' : 'reconnecting', message, this.#selfId, this.#version, details)
  }

  reportDetails(details: Readonly<Record<string, JsonValue>>): void {
    this.#publish(this.connected ? 'connected' : 'reconnecting', undefined, this.#selfId, this.#version, details)
  }

  start(): Promise<void> {
    if (this.#started) throw new Error('OneBot WebSocket client is already started.')
    this.#started = true
    this.#stopping = false
    this.#publish('connecting')
    this.#connect()
    return Promise.resolve()
  }

  async stop(): Promise<void> {
    if (!this.#started || this.#stopping) return
    this.#stopping = true
    this.#started = false
    this.#connectGeneration += 1
    if (this.#reconnectTimer !== undefined) clearTimeout(this.#reconnectTimer)
    this.#reconnectTimer = undefined
    this.#rejectPending('OneBot 连接已停止。')
    const socket = this.#socket
    this.#socket = undefined
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        const finish = (): void => resolve()
        socket.once('close', finish)
        socket.close(1000, 'NekroNXT stopping')
        if (socket.readyState === WebSocket.CLOSED) finish()
      })
    }
    await this.#eventQueue
    this.#selfId = undefined
    this.#publish('stopped')
  }

  call(action: string, params: OneBotObject = {}): Promise<unknown> {
    const socket = this.#socket
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new OneBotActionError('OneBot WebSocket 尚未连接。', 'transient', false))
    }
    const echo = `${this.#context.connectionId}:${randomUUID()}`
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(echo)
        reject(new OneBotActionError(`OneBot Action ${action} 等待回执超时。`, 'unknown', true))
      }, this.#requestTimeoutMs)
      this.#pending.set(echo, { action, resolve, reject, timer })
      socket.send(JSON.stringify({ action, params, echo }), (error) => {
        if (!error) return
        const pending = this.#pending.get(echo)
        if (!pending) return
        clearTimeout(pending.timer)
        this.#pending.delete(echo)
        reject(new OneBotActionError(`OneBot Action ${action} 写入失败。`, 'transient', false))
      })
    })
  }

  async callOptional(action: string, params: OneBotObject): Promise<unknown> {
    if (this.#optionalCapabilities.get(action) === 'unsupported') {
      throw new OneBotActionError(`协议端不支持 ${action}。`, 'unsupported', false)
    }
    try {
      const result = await this.call(action, params)
      this.#optionalCapabilities.set(action, 'available')
      this.#publishCurrent()
      return result
    } catch (error) {
      if (error instanceof OneBotActionError && error.kind === 'unsupported') {
        this.#optionalCapabilities.set(action, 'unsupported')
        this.#publishCurrent()
      }
      throw error
    }
  }

  #connect(): void {
    if (!this.#started || this.#stopping || this.#terminalAccountChange) return
    const generation = ++this.#connectGeneration
    const socket = new WebSocket(this.#endpoint, {
      headers: this.#accessToken === undefined ? undefined : { Authorization: `Bearer ${this.#accessToken}` },
      maxPayload: MAX_FRAME_BYTES,
      perMessageDeflate: false,
    })
    this.#socket = socket
    socket.on('open', () => void this.#initialize(generation, socket))
    socket.on('message', (data, isBinary) => this.#receive(generation, data, isBinary))
    socket.on('error', () => {
      // close owns diagnostics and reconnect scheduling.
    })
    socket.on('close', (_code, reason) => this.#closed(generation, socket, reason.toString()))
  }

  async #initialize(generation: number, socket: WebSocket): Promise<void> {
    if (generation !== this.#connectGeneration || socket !== this.#socket || this.#stopping) return
    try {
      const login = objectValue(await this.call('get_login_info'))
      const version = objectValue(await this.call('get_version_info'))
      const selfId = stringId(login?.['user_id'])
      if (!selfId) throw new OneBotActionError('get_login_info 未返回有效 user_id。', 'invalid', true)
      const locked = objectValue(await this.#context.state.load(ACCOUNT_STATE_KEY))
      const lockedSelfId = stringId(locked?.['selfId'])
      if (lockedSelfId !== undefined && lockedSelfId !== selfId) {
        this.#terminalAccountChange = true
        this.#publish('failed', 'Endpoint 连接到了另一个账号；为避免频道归属混淆，已拒绝继续运行。', selfId, version)
        socket.close(1008, 'account changed')
        return
      }
      if (lockedSelfId === undefined) await this.#context.state.save(ACCOUNT_STATE_KEY, { selfId })
      this.#selfId = selfId
      this.#version = version
      this.#reconnectAttempt = 0
      this.#publish('connected', undefined, selfId, version)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.#publish('failed', message)
      socket.close(1011, 'initialization failed')
    }
  }

  #receive(generation: number, data: RawData, isBinary: boolean): void {
    if (generation !== this.#connectGeneration || this.#stopping) return
    if (isBinary) {
      this.#publish('failed', '协议端发送了二进制帧；OneBot 11 连接只接受 JSON 文本。')
      this.#socket?.close(1003, 'binary frame rejected')
      return
    }
    let parsed: unknown
    try {
      parsed = z.json().parse(JSON.parse(rawDataText(data)))
    } catch {
      this.#publish('failed', '协议端发送了无效 JSON。')
      return
    }
    const object = objectValue(parsed)
    if (!object) return
    const echo = typeof object['echo'] === 'string' ? object['echo'] : undefined
    if (echo !== undefined) {
      const pending = this.#pending.get(echo)
      if (!pending) return
      clearTimeout(pending.timer)
      this.#pending.delete(echo)
      const status = object['status']
      const retcode = object['retcode']
      if ((status === 'ok' || status === undefined) && (retcode === 0 || retcode === undefined)) {
        pending.resolve(object['data'])
      } else pending.reject(responseFailure(object))
      return
    }
    this.#eventQueue = this.#eventQueue
      .then(() => this.#onEvent(object))
      .catch((error: unknown) => this.#publishCurrent(error instanceof Error ? error.message : String(error)))
  }

  #closed(generation: number, socket: WebSocket, reason: string): void {
    if (generation !== this.#connectGeneration || socket !== this.#socket) return
    this.#socket = undefined
    this.#selfId = undefined
    this.#rejectPending('OneBot WebSocket 在 Action 回执前断开。')
    if (this.#stopping || !this.#started || this.#terminalAccountChange) return
    const index = Math.min(this.#reconnectAttempt, this.#reconnectDelaysMs.length - 1)
    const delay = this.#reconnectDelaysMs[index] ?? 30_000
    this.#reconnectAttempt += 1
    this.#publish('reconnecting', reason || `连接断开，${delay}ms 后重连。`)
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined
      this.#connect()
    }, delay)
  }

  #rejectPending(message: string): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new OneBotActionError(`${message}（${pending.action}）`, 'unknown', true))
    }
    this.#pending.clear()
  }

  #publishCurrent(message?: string): void {
    this.#publish(this.connected ? 'connected' : 'reconnecting', message, this.#selfId, this.#version)
  }

  #publish(
    status: 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'stopped',
    message?: string,
    accountId?: string,
    version?: OneBotObject,
    details?: Readonly<Record<string, JsonValue>>,
  ): void {
    this.#context.diagnostics.publish({
      status,
      ...(message === undefined ? {} : { message }),
      ...(accountId === undefined ? {} : { accountId }),
      ...(version === undefined
        ? {}
        : {
            implementation: {
              ...(typeof version['app_name'] === 'string' ? { name: version['app_name'] } : {}),
              ...(typeof version['app_version'] === 'string' ? { version: version['app_version'] } : {}),
              ...(typeof version['protocol_version'] === 'string'
                ? { protocolVersion: version['protocol_version'] }
                : {}),
            },
          }),
      optionalCapabilities: Object.fromEntries(this.#optionalCapabilities),
      ...(details === undefined ? {} : { details }),
    })
  }
}

export const oneBotStringId = stringId
export const oneBotObject = objectValue
