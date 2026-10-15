import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { ChannelProcessingReminderProjection } from '../src/channel-reply-guard.js'

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

const fixture = () => {
  const projection = new ChannelProcessingReminderProjection()
  const events: SessionEvent[] = []
  let seq = 0
  let turn = 1
  const append = (event: DistributiveOmit<SessionEvent, 'seq'>) => {
    const committed: SessionEvent = { ...event, seq: SessionSeq(++seq) }
    events.push(committed)
    projection.append(committed)
  }
  const start = (next = 1, time = 1_000) => {
    turn = next
    append({ type: 'turn/start', time, data: { turn } })
    admit()
  }
  const admit = () =>
    append({
      type: 'user/message',
      surfaceOp: 'append',
      time: 1_001,
      data: createUserMessage({
        content: [{ type: 'text', text: '测试消息' }],
        source: { kind: 'nekro-nxt-channel', admissionId: 'adm_TEST', channelEventIds: ['evt_TEST'] },
      }),
    })
  const call = (name = 'lookup', args: unknown = {}, id = 'root') =>
    append({
      type: 'tool/call',
      time: 1_002,
      data: { turn, step: 1, callId: ToolCallId(id), name, arguments: JSON.stringify(args) },
    })
  const result = (time = 61_000, deliveryState = 'failed', id = 'root') =>
    append({
      type: 'tool/result',
      surfaceOp: 'append',
      time,
      data: {
        turn,
        step: 1,
        message: createToolResultMessage({ callId: ToolCallId(id), content: [], isError: false }),
        meta: { deliveryState },
      },
    })
  const nested = (deliveryState: string, target = 'current', root = 'root') =>
    append({
      type: 'tool/ptc-dispatch',
      time: 61_000,
      data: {
        rootCallId: ToolCallId(root),
        parentCallId: ToolCallId(root),
        subCallId: ToolCallId('nested'),
        name: 'send_channel_message',
        arguments: { target: { type: target } },
        isError: false,
        content: [],
        meta: { deliveryState },
      },
    })
  return { projection, events, append, start, admit, call, result, nested }
}

describe('channel processing reminder event projection', () => {
  it('waits for a root result at the threshold and never uses elapsed wall time alone', () => {
    const f = fixture()
    f.start()
    f.call()
    expect(f.projection.shouldRemind(1)).toBe(false)
    f.result(60_999)
    expect(f.projection.shouldRemind(1)).toBe(false)
    f.call('lookup', {}, 'second')
    f.result(61_000, 'failed', 'second')
    expect(f.projection.shouldRemind(1)).toBe(true)
  })

  it('waits for the PTC root and all sibling root calls, including forwarding tools', () => {
    const f = fixture()
    f.start()
    f.call('run_code')
    f.call('forward_context', {}, 'sibling')
    f.nested('failed')
    expect(f.projection.shouldRemind(1)).toBe(false)
    f.result()
    expect(f.projection.shouldRemind(1)).toBe(false)
    f.result(61_001, 'failed', 'sibling')
    expect(f.projection.shouldRemind(1)).toBe(true)
  })

  it.each(['sent', 'partially-sent'])('suppresses current-channel %s sends, direct and PTC', (status) => {
    for (const ptc of [false, true]) {
      const f = fixture()
      f.start()
      f.call(ptc ? 'run_code' : 'send_channel_message', { target: { type: 'current' } })
      if (ptc) f.nested(status)
      f.result(61_000, status)
      f.admit()
      expect(f.projection.shouldRemind(1)).toBe(false)
    }
  })

  it.each(['failed', 'unknown'])('does not count %s as a confirmed send', (status) => {
    const f = fixture()
    f.start()
    f.call('send_channel_message', { target: { type: 'current' } })
    f.result(61_000, status)
    expect(f.projection.shouldRemind(1)).toBe(true)
  })

  it('does not count sends to other channels or foreign PTC roots', () => {
    for (const ptc of [false, true]) {
      const f = fixture()
      f.start()
      f.call(ptc ? 'run_code' : 'send_channel_message', { target: { type: 'channel', channelId: 'chn_OTHER' } })
      if (ptc) {
        f.nested('sent', 'channel')
        f.nested('sent', 'current', 'old-root')
      }
      f.result(61_000, 'sent')
      expect(f.projection.shouldRemind(1)).toBe(true)
    }
  })

  it('deduplicates committed reminders across inject and replay, resets on a new turn', () => {
    const f = fixture()
    f.start()
    f.call()
    f.result()
    f.append({
      type: 'user/message',
      surfaceOp: 'append',
      time: 61_001,
      data: createUserMessage({
        content: [],
        source: { kind: 'nekro-nxt-channel-processing-reminder', turn: 1 },
      }),
    })
    f.admit()
    f.call('lookup', {}, 'second')
    f.result(120_000, 'failed', 'second')
    const replay = new ChannelProcessingReminderProjection()
    for (const event of f.events) replay.append(event)
    expect(replay.shouldRemind(1)).toBe(false)
    expect(f.projection.shouldRemind(1)).toBe(false)
    f.start(2, 200_000)
    f.result(260_000) // late old root, not a result of this turn
    expect(f.projection.shouldRemind(2)).toBe(false)
    f.call()
    f.result(259_999)
    expect(f.projection.shouldRemind(2)).toBe(false)
    f.call('lookup', {}, 'next')
    f.result(260_000, 'failed', 'next')
    expect(f.projection.shouldRemind(2)).toBe(true)
    expect(f.projection.shouldRemind(1)).toBe(false)
  })

  it('does not reuse a preceding result after model output or turn end', () => {
    const f = fixture()
    f.start()
    f.call()
    f.result()
    f.append({
      type: 'assistant/message',
      surfaceOp: 'append',
      time: 62_000,
      data: {
        turn: 1,
        step: 2,
        message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [] }),
        stream: [],
      },
    })
    expect(f.projection.shouldRemind(1)).toBe(false)
    expect(f.projection.previousStepAttemptedToStop(1, 2)).toBe(true)
    f.append({ type: 'turn/end', time: 63_000, data: { turn: 1, reason: { kind: 'completed' } } })
    expect(f.projection.shouldRemind(1)).toBe(false)
  })
})
