import { randomUUID } from 'node:crypto'
import { HostSseEventSchema, type HostSseEvent } from '@nekro-nxt/contracts'

export const SSE_REPLAY_LIMIT = 512
export const SSE_RUNTIME_FRAME_BUDGET = 48 * 1024
export const SSE_FACT_FRAME_BUDGET = 48 * 1024
export const SSE_FACT_COALESCE_MS = 80
export const SSE_CLIENT_QUEUE_BUDGET = 512 * 1024

export interface SseClient {
  write(chunk: string): unknown
  once?(event: 'drain', listener: () => void): unknown
  end?(): unknown
}

export interface SseCursor {
  readonly epoch: string
  readonly sequence: number
}

interface SseClientState {
  blocked: boolean
  queue: string[]
  queuedBytes: number
}

const REPLAYABLE_EVENTS = new Set<HostSseEvent['event']>([
  'channel-fact',
  'runtime',
  'extensions-changed',
  'dsh-settings-changed',
  'dsh-credentials-changed',
  'binding-change',
])

export const renderSse = (payload: HostSseEvent, id?: string): string => {
  const parsed = HostSseEventSchema.parse(payload)
  const body = `event: ${parsed.event}\ndata: ${JSON.stringify(parsed.data)}\n\n`
  return id === undefined ? body : `id: ${id}\n${body}`
}

export const parseLastEventId = (header: string | readonly string[] | undefined): SseCursor | undefined => {
  const raw = typeof header === 'string' ? header : header?.[0]
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  const current = /^([a-zA-Z0-9_-]{1,100}):([1-9]\d*)$/u.exec(trimmed)
  if (current) {
    const sequence = Number(current[2])
    return Number.isSafeInteger(sequence) ? { epoch: current[1]!, sequence } : undefined
  }
  if (!/^[1-9]\d*$/u.test(trimmed)) return undefined
  const sequence = Number(trimmed)
  return Number.isSafeInteger(sequence) ? { epoch: 'legacy', sequence } : undefined
}

export const isReplayableSseEvent = (event: HostSseEvent['event']): boolean => REPLAYABLE_EVENTS.has(event)

export type SseReplayStatus = 'none' | 'complete' | 'expired'

export class HostSseHub {
  #nextId = 1
  readonly #buffer: Array<{ readonly id: number; readonly frame: string }> = []
  readonly #clients = new Set<SseClient>()
  readonly #clientStates = new Map<SseClient, SseClientState>()
  readonly #limit: number
  readonly #epoch: string

  constructor(limit = SSE_REPLAY_LIMIT, epoch: string = randomUUID()) {
    this.#limit = limit
    if (!/^[a-zA-Z0-9_-]{1,100}$/u.test(epoch)) throw new TypeError('SSE epoch is invalid.')
    this.#epoch = epoch
  }

  get size(): number {
    return this.#clients.size
  }

  add(client: SseClient): void {
    this.#clients.add(client)
    this.#clientStates.set(client, { blocked: false, queue: [], queuedBytes: 0 })
  }

  remove(client: SseClient): void {
    this.#clients.delete(client)
    this.#clientStates.delete(client)
  }

  publish(event: HostSseEvent): string | undefined {
    if (!isReplayableSseEvent(event.event)) {
      this.#writeAll(renderSse(event))
      return undefined
    }
    const id = this.#nextId
    this.#nextId += 1
    const cursor = `${this.#epoch}:${id}`
    const frame = renderSse(event, cursor)
    this.#buffer.push({ id, frame })
    if (this.#buffer.length > this.#limit) this.#buffer.shift()
    this.#writeAll(frame)
    return cursor
  }

  replaySince(cursor: SseCursor | undefined): {
    readonly status: SseReplayStatus
    readonly frames: readonly string[]
  } {
    if (cursor === undefined) return { status: 'none', frames: [] }
    if (cursor.epoch !== this.#epoch) return { status: 'expired', frames: [] }
    const lastEventId = cursor.sequence
    const latest = this.#nextId - 1
    if (lastEventId > latest) return { status: 'expired', frames: [] }
    const oldest = this.#buffer[0]?.id
    if (oldest !== undefined && lastEventId < oldest - 1) return { status: 'expired', frames: [] }
    if (this.#buffer.length === 0 && lastEventId < this.#nextId - 1) return { status: 'expired', frames: [] }
    return {
      status: 'complete',
      frames: this.#buffer.filter((entry) => entry.id > lastEventId).map((entry) => entry.frame),
    }
  }

  write(client: SseClient, chunk: string): void {
    const state = this.#clientStates.get(client)
    if (state?.blocked) {
      this.#enqueue(client, state, chunk)
      return
    }
    try {
      const writable = client.write(chunk)
      if (writable === false && state) {
        if (!client.once) {
          this.#disconnect(client)
          return
        }
        state.blocked = true
        client.once('drain', () => this.#drain(client))
      }
    } catch {
      this.#disconnect(client)
    }
  }

  #writeAll(frame: string): void {
    for (const client of this.#clients) this.write(client, frame)
  }

  #enqueue(client: SseClient, state: SseClientState, chunk: string): void {
    const queuedBytes = state.queuedBytes + Buffer.byteLength(chunk, 'utf8')
    if (queuedBytes > SSE_CLIENT_QUEUE_BUDGET) {
      this.#disconnect(client)
      return
    }
    state.queue.push(chunk)
    state.queuedBytes = queuedBytes
  }

  #drain(client: SseClient): void {
    const state = this.#clientStates.get(client)
    if (!state) return
    state.blocked = false
    while (!state.blocked && state.queue.length > 0) {
      const chunk = state.queue.shift()!
      state.queuedBytes -= Buffer.byteLength(chunk, 'utf8')
      this.write(client, chunk)
    }
  }

  #disconnect(client: SseClient): void {
    this.remove(client)
    try {
      client.end?.()
    } catch {
      // The connection is already unusable.
    }
  }
}
