import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import {
  CHANNEL_PROCESSING_REMINDER_THRESHOLD_MS,
  shouldInjectChannelProcessingReminder,
} from '../src/channel-reply-guard.js'

const event = (type: string, time: number, data: Record<string, unknown> = {}): SessionEvent =>
  ({ seq: time, time, type, data }) as unknown as SessionEvent

const channelTurn = (toolResultTime: number, afterTool?: SessionEvent): readonly SessionEvent[] => [
  event('turn/start', 1_000, { turn: 3 }),
  event('user/message', 1_001, {
    source: { kind: 'nekro-nxt-channel', admissionId: 'adm_TEST', channelEventIds: ['evt_TEST'] },
  }),
  event('assistant/message', 1_002, { turn: 3 }),
  event('tool/result', toolResultTime, { turn: 3 }),
  ...(afterTool === undefined ? [] : [afterTool]),
]

describe('channel processing reminder', () => {
  it('waits for a tool result, triggers at 60 seconds, and only triggers once per turn', () => {
    expect(
      shouldInjectChannelProcessingReminder({
        events: channelTurn(1_000 + CHANNEL_PROCESSING_REMINDER_THRESHOLD_MS - 1),
        turn: 3,
        producedReply: false,
        hasReminder: false,
      }),
    ).toBe(false)
    expect(
      shouldInjectChannelProcessingReminder({
        events: channelTurn(1_000 + CHANNEL_PROCESSING_REMINDER_THRESHOLD_MS),
        turn: 3,
        producedReply: false,
        hasReminder: false,
      }),
    ).toBe(true)
    expect(
      shouldInjectChannelProcessingReminder({
        events: channelTurn(
          1_000 + CHANNEL_PROCESSING_REMINDER_THRESHOLD_MS,
          event('assistant/message', 62_000, { turn: 3 }),
        ),
        turn: 3,
        producedReply: false,
        hasReminder: false,
      }),
    ).toBe(false)
    expect(
      shouldInjectChannelProcessingReminder({
        events: channelTurn(1_000 + CHANNEL_PROCESSING_REMINDER_THRESHOLD_MS),
        turn: 3,
        producedReply: false,
        hasReminder: true,
      }),
    ).toBe(false)
  })

  it('skips the reminder after a channel message was produced in the same turn', () => {
    expect(
      shouldInjectChannelProcessingReminder({
        events: channelTurn(1_000 + CHANNEL_PROCESSING_REMINDER_THRESHOLD_MS),
        turn: 3,
        producedReply: true,
        hasReminder: false,
      }),
    ).toBe(false)
  })
})
