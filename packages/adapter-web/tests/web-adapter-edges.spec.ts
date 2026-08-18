import {
  ChannelEventIdSchema,
  ChannelIdSchema,
  ChannelMemberIdSchema,
  ConnectionIdSchema,
  LogicalMessageIdSchema,
  PhysicalDeliveryIdSchema,
} from '@nekro-nxt/contracts'
import { describe, expect, it } from 'vitest'
import { createWebAdapterConnection } from '../src/index.ts'

describe('Internal Web Adapter lifecycle boundaries', () => {
  it('requires a running connection, preserves dedupe facts, and clears listeners on stop', async () => {
    const connectionId = ConnectionIdSchema.parse('con_webedges')
    const otherConnectionId = ConnectionIdSchema.parse('con_webother')
    const channelId = ChannelIdSchema.parse('chn_webedges')
    const memberId = ChannelMemberIdSchema.parse('mbr_webedges')
    const accepted: unknown[] = []
    const adapter = createWebAdapterConnection(
      connectionId,
      (event) => {
        accepted.push(event)
        return Promise.resolve({ channelEventId: ChannelEventIdSchema.parse('evt_webedges'), inserted: true })
      },
      () => 700,
    )
    const request = {
      deliveryId: PhysicalDeliveryIdSchema.parse('phy_webedges'),
      logicalMessageId: LogicalMessageIdSchema.parse('msg_webedges'),
      connectionId,
      channelId,
      parts: [{ type: 'text' as const, text: 'web outbound' }],
    }

    await expect(adapter.postMessage({ channelId, clientEventId: 'before-start', parts: [] })).rejects.toThrow(
      'not running',
    )
    await expect(adapter.deliver(request, new AbortController().signal)).rejects.toThrow('not running')
    await adapter.start()
    await expect(adapter.start()).rejects.toThrow('already running')
    await expect(adapter.postMessage({ channelId, clientEventId: '', parts: [] })).rejects.toThrow('must not be empty')

    await adapter.postMessage({
      channelId,
      clientEventId: 'client-edges',
      senderMemberId: memberId,
      parts: [{ type: 'text', text: 'first' }],
      replyToBot: true,
      receivedAt: 701,
    })
    await adapter.postMessage({
      channelId,
      clientEventId: 'client-edges',
      parts: [{ type: 'text', text: 'replayed' }],
    })
    expect(accepted).toHaveLength(2)
    expect(accepted[0]).toMatchObject({
      platformEventId: 'client-edges',
      senderMemberId: memberId,
      platformTimestamp: 701,
      receivedAt: 701,
      dedupeKey: 'web-event:client-edges',
      facts: { replyToBot: true },
    })
    expect(accepted[1]).toMatchObject({
      platformEventId: 'client-edges',
      platformTimestamp: 700,
      receivedAt: 700,
      dedupeKey: 'web-event:client-edges',
    })
    expect(accepted[1]).not.toHaveProperty('senderMemberId')
    expect(accepted[1]).not.toHaveProperty('facts')

    await expect(
      adapter.deliver({ ...request, connectionId: otherConnectionId }, new AbortController().signal),
    ).resolves.toEqual({
      status: 'failed',
      failure: { kind: 'invalid', message: 'Delivery targets another Connection.' },
    })
    const aborted = new AbortController()
    aborted.abort()
    await expect(adapter.deliver(request, aborted.signal)).resolves.toEqual({
      status: 'failed',
      failure: { kind: 'transient', message: 'Delivery aborted before publication.' },
    })

    const observed: string[] = []
    const unsubscribe = adapter.subscribe(({ platformMessageId }) => {
      observed.push(platformMessageId)
    })
    await expect(adapter.deliver(request, new AbortController().signal)).resolves.toEqual({
      status: 'sent',
      platformMessageId: 'web-message-1',
    })
    expect(unsubscribe()).toBe(true)
    await expect(adapter.deliver(request, new AbortController().signal)).resolves.toEqual({
      status: 'sent',
      platformMessageId: 'web-message-2',
    })
    expect(observed).toEqual(['web-message-1'])

    await adapter.stop()
    await expect(adapter.postMessage({ channelId, clientEventId: 'after-stop', parts: [] })).rejects.toThrow(
      'not running',
    )
    await expect(adapter.deliver(request, new AbortController().signal)).rejects.toThrow('not running')
    await adapter.stop()
  })
})
