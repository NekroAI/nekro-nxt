import { ChannelEventIdSchema, ChannelIdSchema, HostSseEventSchema } from '@nekro-nxt/contracts'
import { describe, expect, it } from 'vitest'
import { HostSseHub, parseLastEventId, renderSse, SSE_CLIENT_QUEUE_BUDGET, SSE_REPLAY_LIMIT } from '../src/sse-hub.ts'

class MemoryResponse {
  readonly chunks: string[] = []
  write(chunk: string): boolean {
    this.chunks.push(chunk)
    return true
  }
}

class BackpressuredResponse {
  readonly chunks: string[] = []
  ended = false
  #drain: (() => void) | undefined
  #first = true

  write(chunk: string): boolean {
    this.chunks.push(chunk)
    if (!this.#first) return true
    this.#first = false
    return false
  }

  once(event: 'drain', listener: () => void): void {
    if (event === 'drain') this.#drain = listener
  }

  drain(): void {
    const listener = this.#drain
    this.#drain = undefined
    listener?.()
  }

  end(): void {
    this.ended = true
  }
}

const channelId = ChannelIdSchema.parse('chn_ssehub')
const inboundEventId = ChannelEventIdSchema.parse('evt_one')

describe('HostSseHub', () => {
  it('parses Last-Event-ID and ignores junk', () => {
    expect(parseLastEventId('host-a:12')).toEqual({ epoch: 'host-a', sequence: 12 })
    expect(parseLastEventId(['host-a:12', 'host-a:13'])).toEqual({ epoch: 'host-a', sequence: 12 })
    expect(parseLastEventId('12')).toEqual({ epoch: 'legacy', sequence: 12 })
    expect(parseLastEventId('0')).toBeUndefined()
    expect(parseLastEventId('host-a:0')).toBeUndefined()
    expect(parseLastEventId('id:1')).toEqual({ epoch: 'id', sequence: 1 })
    expect(parseLastEventId('id::1')).toBeUndefined()
    expect(parseLastEventId(undefined)).toBeUndefined()
  })

  it('assigns ids to replayable frames and omits them from status', () => {
    const hub = new HostSseHub(SSE_REPLAY_LIMIT, 'host-a')
    const client = new MemoryResponse()
    hub.add(client)
    const statusId = hub.publish({ event: 'status', data: { ok: true, message: '已连接', replay: 'none' } })
    const factId = hub.publish({
      event: 'channel-fact',
      data: {
        channelId,
        revision: 1,
        items: [
          {
            kind: 'inbound',
            sourceId: inboundEventId,
            message: {
              id: inboundEventId,
              channelId,
              role: 'member',
              parts: [{ type: 'text', text: '你好' }],
              occurredAt: 1,
            },
          },
        ],
      },
    })
    expect(statusId).toBeUndefined()
    expect(factId).toBe('host-a:1')
    expect(client.chunks[0]).toBe(renderSse({ event: 'status', data: { ok: true, message: '已连接', replay: 'none' } }))
    expect(client.chunks[1]?.startsWith('id: host-a:1\n')).toBe(true)
    const dataLine = client.chunks[1]?.split('\n').find((line) => line.startsWith('data: '))
    const payload: unknown = dataLine === undefined ? undefined : JSON.parse(dataLine.slice(6))
    expect(HostSseEventSchema.parse({ event: 'channel-fact', data: payload }))
  })

  it('replays frames after Last-Event-ID and expires when the window moved on', () => {
    const hub = new HostSseHub(2, 'host-a')
    hub.publish({
      event: 'runtime',
      data: {
        channelId,
        phase: 'idle',
        summary: '智能体当前空闲。',
        pendingInjectCount: 0,
        turns: [],
        revision: 1,
      },
    })
    hub.publish({
      event: 'runtime',
      data: {
        channelId,
        phase: 'thinking',
        summary: '智能体正在处理当前消息。',
        pendingInjectCount: 0,
        turns: [],
        revision: 2,
      },
    })
    hub.publish({
      event: 'runtime',
      data: {
        channelId,
        phase: 'using-tool',
        summary: '智能体正在使用发送频道消息。',
        pendingInjectCount: 0,
        turns: [],
        revision: 3,
      },
    })
    hub.publish({
      event: 'runtime',
      data: {
        channelId,
        phase: 'idle',
        summary: '智能体当前空闲。',
        pendingInjectCount: 0,
        turns: [],
        revision: 4,
      },
    })
    expect(hub.replaySince(undefined).status).toBe('none')
    expect(hub.replaySince({ epoch: 'host-a', sequence: 1 }).status).toBe('expired')
    expect(hub.replaySince({ epoch: 'old-host', sequence: 4 }).status).toBe('expired')
    expect(hub.replaySince({ epoch: 'host-a', sequence: 99 }).status).toBe('expired')
    const complete = hub.replaySince({ epoch: 'host-a', sequence: 3 })
    expect(complete.status).toBe('complete')
    expect(complete.frames).toHaveLength(1)
    expect(complete.frames[0]?.startsWith('id: host-a:4\n')).toBe(true)
    expect(SSE_REPLAY_LIMIT).toBeGreaterThan(2)
  })

  it('queues frames while a client is backpressured and flushes them on drain', () => {
    const hub = new HostSseHub(SSE_REPLAY_LIMIT, 'host-a')
    const client = new BackpressuredResponse()
    hub.add(client)

    hub.publish({ event: 'status', data: { ok: true, message: '第一帧' } })
    hub.publish({ event: 'status', data: { ok: true, message: '第二帧' } })
    expect(client.chunks).toHaveLength(1)

    client.drain()
    expect(client.chunks).toHaveLength(2)
    expect(client.chunks[1]).toContain('第二帧')
  })

  it('disconnects a slow client before its userspace queue can grow without bound', () => {
    const hub = new HostSseHub(SSE_REPLAY_LIMIT, 'host-a')
    const client = new BackpressuredResponse()
    hub.add(client)

    hub.write(client, 'blocked')
    hub.write(client, 'x'.repeat(SSE_CLIENT_QUEUE_BUDGET + 1))

    expect(hub.size).toBe(0)
    expect(client.ended).toBe(true)
  })
})
