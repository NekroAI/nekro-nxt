import { HostSseEventSchema, type HostSseEvent } from '@nekro-nxt/contracts'

export const SSE_REPLAY_LIMIT = 512
export const SSE_RUNTIME_FRAME_BUDGET = 48 * 1024
export const SSE_FACT_COALESCE_MS = 80

export interface SseClient {
  write(chunk: string): unknown
}

const REPLAYABLE_EVENTS = new Set<HostSseEvent['event']>([
  'channel-fact',
  'runtime',
  'extensions-changed',
  'dsh-settings-changed',
  'dsh-credentials-changed',
  'binding-change',
])

export const renderSse = (payload: HostSseEvent, id?: number): string => {
  const parsed = HostSseEventSchema.parse(payload)
  const body = `event: ${parsed.event}\ndata: ${JSON.stringify(parsed.data)}\n\n`
  return id === undefined ? body : `id: ${id}\n${body}`
}

export const parseLastEventId = (header: string | readonly string[] | undefined): number | undefined => {
  const raw = typeof header === 'string' ? header : header?.[0]
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  if (!/^[1-9]\d*$/u.test(trimmed)) return undefined
  const value = Number(trimmed)
  return Number.isSafeInteger(value) ? value : undefined
}

export const isReplayableSseEvent = (event: HostSseEvent['event']): boolean => REPLAYABLE_EVENTS.has(event)

export type SseReplayStatus = 'none' | 'complete' | 'expired'

export class HostSseHub {
  #nextId = 1
  readonly #buffer: Array<{ readonly id: number; readonly frame: string }> = []
  readonly #clients = new Set<SseClient>()
  readonly #limit: number

  constructor(limit = SSE_REPLAY_LIMIT) {
    this.#limit = limit
  }

  get size(): number {
    return this.#clients.size
  }

  add(client: SseClient): void {
    this.#clients.add(client)
  }

  remove(client: SseClient): void {
    this.#clients.delete(client)
  }

  publish(event: HostSseEvent): number | undefined {
    if (!isReplayableSseEvent(event.event)) {
      this.#writeAll(renderSse(event))
      return undefined
    }
    const id = this.#nextId
    this.#nextId += 1
    const frame = renderSse(event, id)
    this.#buffer.push({ id, frame })
    if (this.#buffer.length > this.#limit) this.#buffer.shift()
    this.#writeAll(frame)
    return id
  }

  replaySince(lastEventId: number | undefined): {
    readonly status: SseReplayStatus
    readonly frames: readonly string[]
  } {
    if (lastEventId === undefined) return { status: 'none', frames: [] }
    const oldest = this.#buffer[0]?.id
    if (oldest !== undefined && lastEventId < oldest - 1) return { status: 'expired', frames: [] }
    if (this.#buffer.length === 0 && lastEventId < this.#nextId - 1) return { status: 'expired', frames: [] }
    return {
      status: 'complete',
      frames: this.#buffer.filter((entry) => entry.id > lastEventId).map((entry) => entry.frame),
    }
  }

  write(client: SseClient, chunk: string): void {
    try {
      client.write(chunk)
    } catch {
      this.#clients.delete(client)
    }
  }

  #writeAll(frame: string): void {
    for (const client of this.#clients) this.write(client, frame)
  }
}
