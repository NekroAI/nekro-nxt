import type { AdapterConnectionHostContext, AdapterFailureKind } from '@nekro-nxt/adapter-sdk'
import { randomUUID } from 'node:crypto'
import WebSocket, { type RawData } from 'ws'
import { z } from 'zod'
import { WECOM_AI_BOT_ENDPOINT } from './definition.js'

const MAX_FRAME_BYTES = 2 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 15_000
const ACCOUNT_STATE_KEY = 'wecom-ai-bot/account-lock-v1'

export type WeComObject = Readonly<Record<string, unknown>>

export class WeComTransportError extends Error {
  constructor(
    message: string,
    readonly kind: AdapterFailureKind | 'unknown',
    readonly submitted: boolean,
    readonly errcode?: number,
  ) {
    super(message)
    this.name = 'WeComTransportError'
  }
}

interface RequestItem {
  readonly cmd: string
  readonly body?: WeComObject
  readonly reqId: string
  readonly resolve: (frame: WeComObject) => void
  readonly reject: (error: WeComTransportError) => void
  submitted: boolean
  timer?: ReturnType<typeof setTimeout>
}

const ObjectSchema = z.record(z.string(), z.unknown())
export const weComObject = (input: unknown): WeComObject | undefined => {
  const parsed = ObjectSchema.safeParse(input)
  return parsed.success ? parsed.data : undefined
}

const rawText = (data: RawData): string => {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return data.toString('utf8')
}

const responseError = (frame: WeComObject, submitted: boolean): WeComTransportError => {
  const errcode = typeof frame['errcode'] === 'number' ? frame['errcode'] : undefined
  const errmsg = typeof frame['errmsg'] === 'string' ? frame['errmsg'] : '企业微信请求失败。'
  const normalized = errmsg.toLowerCase()
  const kind: AdapterFailureKind = /频率|限流|rate|limit/u.test(normalized)
    ? 'rate-limited'
    : /secret|auth|credential|凭证|认证/u.test(normalized)
      ? 'authentication'
      : /参数|invalid|missing|格式/u.test(normalized)
        ? 'invalid'
        : /system|busy|timeout|内部/u.test(normalized)
          ? 'transient'
          : 'permanent'
  return new WeComTransportError(`${errmsg}（errcode ${errcode ?? 'unknown'}）`, kind, submitted, errcode)
}

export interface WeComWebSocketClientOptions {
  readonly context: AdapterConnectionHostContext
  readonly botId: string
  readonly secret: string
  readonly onFrame: (frame: WeComObject) => Promise<void>
  readonly endpoint?: string
  readonly requestTimeoutMs?: number
  readonly heartbeatIntervalMs?: number
  readonly reconnectDelaysMs?: readonly number[]
}

export class WeComWebSocketClient {
  readonly #context: AdapterConnectionHostContext
  readonly #botId: string
  readonly #secret: string
  readonly #onFrame: WeComWebSocketClientOptions['onFrame']
  readonly #endpoint: string
  readonly #requestTimeoutMs: number
  readonly #heartbeatIntervalMs: number
  readonly #reconnectDelaysMs: readonly number[]
  readonly #queues = new Map<string, RequestItem[]>()
  readonly #pending = new Map<string, RequestItem>()
  readonly #ambiguousReqIds = new Set<string>()
  #eventQueue = Promise.resolve()
  #socket: WebSocket | undefined
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined
  #generation = 0
  #reconnectAttempt = 0
  #authFailures = 0
  #missedHeartbeats = 0
  #started = false
  #stopping = false
  #authenticated = false
  #terminalConflict = false
  #authFailureClose = false

  constructor(options: WeComWebSocketClientOptions) {
    this.#context = options.context
    this.#botId = options.botId
    this.#secret = options.secret
    this.#onFrame = options.onFrame
    this.#endpoint = options.endpoint ?? WECOM_AI_BOT_ENDPOINT
    this.#requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000
    this.#reconnectDelaysMs = options.reconnectDelaysMs ?? [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]
  }

  get connected(): boolean {
    return this.#authenticated && this.#socket?.readyState === WebSocket.OPEN
  }

  async start(): Promise<void> {
    if (this.#started) throw new Error('企业微信长连接已经启动。')
    const locked = weComObject(await this.#context.state.load(ACCOUNT_STATE_KEY))
    const lockedBotId = typeof locked?.['botId'] === 'string' ? locked['botId'] : undefined
    if (lockedBotId !== undefined && lockedBotId !== this.#botId) {
      this.#publish('failed', '这个 Connection 已绑定另一个 BotID，无法静默切换机器人账号。')
      throw new Error('企业微信 Connection BotID 已发生变化。')
    }
    if (lockedBotId === undefined) await this.#context.state.save(ACCOUNT_STATE_KEY, { botId: this.#botId })
    this.#started = true
    this.#stopping = false
    this.#publish('connecting')
    this.#connect()
  }

  async stop(): Promise<void> {
    if (!this.#started && !this.#socket) return
    this.#started = false
    this.#stopping = true
    this.#generation += 1
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer)
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer)
    this.#reconnectTimer = undefined
    this.#heartbeatTimer = undefined
    this.#rejectAll('企业微信长连接已停止。')
    const socket = this.#socket
    this.#socket = undefined
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        const done = (): void => resolve()
        socket.once('close', done)
        socket.close(1000, 'NekroNXT stopping')
        if (socket.readyState === WebSocket.CLOSED) done()
      })
    }
    await this.#eventQueue
    this.#authenticated = false
    this.#publish('stopped')
  }

  stopForConflict(): void {
    this.#terminalConflict = true
    this.#started = false
    this.#publish('failed', '同一 BotID 已建立新的长连接；当前连接已停止重连。', {
      failure: 'connection-conflict',
    })
    this.#socket?.close(1008, 'duplicate bot connection')
  }

  request(cmd: string, body?: WeComObject, reqId = this.createRequestId(cmd)): Promise<WeComObject> {
    if (this.#ambiguousReqIds.has(reqId)) {
      return Promise.reject(
        new WeComTransportError('该企业微信请求链已有无法确认的结果，已停止后续更新。', 'unknown', false),
      )
    }
    return new Promise((resolve, reject) => {
      const item: RequestItem = {
        cmd,
        ...(body === undefined ? {} : { body }),
        reqId,
        resolve,
        reject,
        submitted: false,
      }
      const queue = this.#queues.get(reqId) ?? []
      queue.push(item)
      this.#queues.set(reqId, queue)
      if (queue.length === 1) this.#dispatch(item)
    })
  }

  createRequestId(prefix: string): string {
    return `${prefix}:${this.#context.connectionId}:${randomUUID()}`
  }

  #connect(): void {
    if (!this.#started || this.#stopping || this.#terminalConflict) return
    const generation = ++this.#generation
    const socket = new WebSocket(this.#endpoint, { maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false })
    this.#socket = socket
    socket.on('open', () => void this.#authenticate(generation, socket))
    socket.on('message', (data, isBinary) => this.#receive(generation, socket, data, isBinary))
    socket.on('error', () => undefined)
    socket.on('close', () => this.#closed(generation, socket))
  }

  async #authenticate(generation: number, socket: WebSocket): Promise<void> {
    if (generation !== this.#generation || socket !== this.#socket || this.#stopping) return
    try {
      await this.request('aibot_subscribe', { bot_id: this.#botId, secret: this.#secret })
      if (generation !== this.#generation || socket !== this.#socket) return
      this.#authenticated = true
      this.#authFailureClose = false
      this.#authFailures = 0
      this.#reconnectAttempt = 0
      this.#missedHeartbeats = 0
      this.#startHeartbeat()
      this.#publish('connected')
    } catch (error) {
      this.#authFailureClose = error instanceof WeComTransportError && error.errcode !== undefined
      if (this.#authFailureClose) this.#authFailures += 1
      socket.close(1008, 'subscription failed')
    }
  }

  #dispatch(item: RequestItem): void {
    const socket = this.#socket
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      this.#finishItem(item, new WeComTransportError('企业微信长连接尚未建立。', 'transient', false))
      return
    }
    const frame = {
      cmd: item.cmd,
      headers: { req_id: item.reqId },
      ...(item.body === undefined ? {} : { body: item.body }),
    }
    try {
      socket.send(JSON.stringify(frame), (error) => {
        if (error && this.#pending.get(item.reqId) === item) {
          item.submitted = false
          this.#finishItem(item, new WeComTransportError('企业微信请求写入失败。', 'transient', false))
        }
      })
      item.submitted = true
      item.timer = setTimeout(() => {
        this.#finishItem(item, new WeComTransportError('企业微信请求等待回执超时。', 'unknown', true))
      }, this.#requestTimeoutMs)
      this.#pending.set(item.reqId, item)
    } catch {
      this.#finishItem(item, new WeComTransportError('企业微信请求写入失败。', 'transient', false))
    }
  }

  #receive(generation: number, socket: WebSocket, data: RawData, isBinary: boolean): void {
    if (generation !== this.#generation || socket !== this.#socket || this.#stopping) return
    if (isBinary) {
      socket.close(1003, 'binary frame rejected')
      this.#publish('failed', '企业微信连接发送了不支持的二进制帧。')
      return
    }
    let frame: WeComObject | undefined
    try {
      frame = weComObject(z.json().parse(JSON.parse(rawText(data))))
    } catch {
      this.#publishCurrent('企业微信连接发送了无效 JSON。')
      return
    }
    if (!frame) return
    const headers = weComObject(frame['headers'])
    const reqId = typeof headers?.['req_id'] === 'string' ? headers['req_id'] : undefined
    if (!frame['cmd'] && reqId) {
      const item = this.#pending.get(reqId)
      if (!item) return
      const errcode = frame['errcode']
      this.#finishItem(item, errcode === 0 ? undefined : responseError(frame, true), frame)
      return
    }
    this.#eventQueue = this.#eventQueue
      .then(() => this.#onFrame(frame))
      .catch((error: unknown) => this.#publishCurrent(error instanceof Error ? error.message : String(error)))
  }

  #finishItem(item: RequestItem, error?: WeComTransportError, frame?: WeComObject): void {
    if (item.timer) clearTimeout(item.timer)
    if (this.#pending.get(item.reqId) === item) this.#pending.delete(item.reqId)
    const queue = this.#queues.get(item.reqId)
    if (queue?.[0] === item) queue.shift()
    const ambiguous = error?.kind === 'unknown'
    if (ambiguous) this.#ambiguousReqIds.add(item.reqId)
    if (!queue || queue.length === 0 || ambiguous) this.#queues.delete(item.reqId)
    if (error) item.reject(error)
    else item.resolve(frame ?? {})
    if (ambiguous && queue) {
      for (const queued of queue.splice(0)) {
        if (queued.timer) clearTimeout(queued.timer)
        queued.reject(new WeComTransportError('前序企业微信请求结果无法确认，已停止后续更新。', 'unknown', false))
      }
      return
    }
    const next = queue?.[0]
    if (next) queueMicrotask(() => this.#dispatch(next))
  }

  #startHeartbeat(): void {
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer)
    this.#heartbeatTimer = setInterval(() => {
      if (!this.connected) return
      if (this.#missedHeartbeats >= 2) {
        this.#socket?.terminate()
        return
      }
      this.#missedHeartbeats += 1
      void this.request('ping').then(
        () => {
          this.#missedHeartbeats = 0
        },
        () => undefined,
      )
    }, this.#heartbeatIntervalMs)
  }

  #closed(generation: number, socket: WebSocket): void {
    if (generation !== this.#generation || socket !== this.#socket) return
    this.#socket = undefined
    this.#authenticated = false
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer)
    this.#heartbeatTimer = undefined
    this.#rejectAll('企业微信连接在回执前断开。')
    if (this.#stopping || !this.#started || this.#terminalConflict) return
    if (this.#authFailureClose && this.#authFailures >= 3) {
      this.#publish('failed', 'BotID 或 Secret 认证连续失败，请检查连接凭据。')
      this.#started = false
      return
    }
    const index = Math.min(this.#reconnectAttempt, this.#reconnectDelaysMs.length - 1)
    const delay = this.#reconnectDelaysMs[index] ?? 30_000
    this.#reconnectAttempt += 1
    this.#publish('reconnecting', `连接断开，${delay}ms 后重连。`)
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined
      this.#connect()
    }, delay)
  }

  #rejectAll(message: string): void {
    const items = [...new Set([...this.#queues.values()].flat())]
    for (const [reqId, queue] of this.#queues) {
      if (queue.some(({ submitted }) => submitted)) this.#ambiguousReqIds.add(reqId)
    }
    this.#queues.clear()
    this.#pending.clear()
    for (const item of items) {
      if (item.timer) clearTimeout(item.timer)
      item.reject(
        new WeComTransportError(`${message}（${item.cmd}）`, item.submitted ? 'unknown' : 'transient', item.submitted),
      )
    }
  }

  #publishCurrent(message?: string): void {
    this.#publish(this.connected ? 'connected' : 'reconnecting', message)
  }

  #publish(
    status: 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'stopped',
    message?: string,
    details?: Readonly<Record<string, string>>,
  ): void {
    this.#context.diagnostics.publish({
      status,
      ...(message ? { message } : {}),
      accountId: this.#botId,
      implementation: { name: '企业微信智能机器人长连接', protocolVersion: 'official-websocket' },
      ...(details ? { details } : {}),
    })
  }
}
