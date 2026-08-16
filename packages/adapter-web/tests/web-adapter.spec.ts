import type {
  ChannelEventId,
  ChannelId,
  ConnectionId,
  LogicalMessageId,
  PhysicalDeliveryId,
} from '@nekro-nxt/contracts'
import { describe, expect, it } from 'vitest'
import { createWebAdapterConnection } from '../src/index.ts'

describe('Internal Web Adapter', () => {
  it('normalizes browser messages and commits the client checkpoint through Core', async () => {
    const accepted: unknown[] = []
    const adapter = createWebAdapterConnection(
      'connection-web' as ConnectionId,
      (event) => {
        accepted.push(event)
        return Promise.resolve({
          channelEventId: 'channel-event-1' as ChannelEventId,
          inserted: true,
          checkpointCommitted: true,
        })
      },
      () => 123,
    )
    await adapter.start()
    await adapter.postMessage({
      channelId: 'channel-web' as ChannelId,
      clientEventId: 'client-1',
      parts: [{ type: 'text', text: '你好' }],
    })
    expect(accepted).toEqual([
      expect.objectContaining({
        adapterKey: 'web',
        dedupeKey: 'web-event:client-1',
        checkpoint: { clientEventId: 'client-1' },
      }),
    ])
  })

  it('publishes only physical Outbox deliveries and contains live-listener failures', async () => {
    const adapter = createWebAdapterConnection('connection-web' as ConnectionId, () =>
      Promise.reject(new Error('unused')),
    )
    const observed: string[] = []
    adapter.subscribe(() => {
      throw new Error('disconnected browser')
    })
    adapter.subscribe(({ platformMessageId }) => {
      observed.push(platformMessageId)
    })
    await adapter.start()
    const receipt = await adapter.deliver(
      {
        deliveryId: 'delivery-1' as PhysicalDeliveryId,
        logicalMessageId: 'logical-1' as LogicalMessageId,
        connectionId: 'connection-web' as ConnectionId,
        channelId: 'channel-web' as ChannelId,
        parts: [{ type: 'text', text: '已发送' }],
        attempt: 1,
      },
      new AbortController().signal,
    )
    expect(receipt).toEqual({ status: 'sent', platformMessageId: 'web-message-1' })
    expect(observed).toEqual(['web-message-1'])
  })
})
