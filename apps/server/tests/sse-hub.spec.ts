import { ChannelIdSchema, HostSseEventSchema } from '@nekro-nxt/contracts'
import { describe, expect, it } from 'vitest'
import { HostSseHub, parseLastEventId, renderSse, SSE_REPLAY_LIMIT } from '../src/sse-hub.ts'

class MemoryResponse {
  readonly chunks: string[] = []
  write(chunk: string): boolean {
    this.chunks.push(chunk)
    return true
  }
}

const channelId = ChannelIdSchema.parse('chn_ssehub')

describe('HostSseHub', () => {
  it('parses Last-Event-ID and ignores junk', () => {
    expect(parseLastEventId('12')).toBe(12)
    expect(parseLastEventId(['12', '13'])).toBe(12)
    expect(parseLastEventId('0')).toBeUndefined()
    expect(parseLastEventId('id:1')).toBeUndefined()
    expect(parseLastEventId(undefined)).toBeUndefined()
  })

  it('assigns ids to replayable frames and omits them from status', () => {
    const hub = new HostSseHub()
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
            sourceId: 'evt_one',
            message: {
              id: 'evt_one',
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
    expect(factId).toBe(1)
    expect(client.chunks[0]).toBe(renderSse({ event: 'status', data: { ok: true, message: '已连接', replay: 'none' } }))
    expect(client.chunks[1]?.startsWith('id: 1\n')).toBe(true)
    const dataLine = client.chunks[1]?.split('\n').find((line) => line.startsWith('data: '))
    const payload: unknown = dataLine === undefined ? undefined : JSON.parse(dataLine.slice(6))
    expect(HostSseEventSchema.parse({ event: 'channel-fact', data: payload }))
  })

  it('replays frames after Last-Event-ID and expires when the window moved on', () => {
    const hub = new HostSseHub(2)
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
    expect(hub.replaySince(1).status).toBe('expired')
    const complete = hub.replaySince(3)
    expect(complete.status).toBe('complete')
    expect(complete.frames).toHaveLength(1)
    expect(complete.frames[0]?.startsWith('id: 4\n')).toBe(true)
    expect(SSE_REPLAY_LIMIT).toBeGreaterThan(2)
  })
})
