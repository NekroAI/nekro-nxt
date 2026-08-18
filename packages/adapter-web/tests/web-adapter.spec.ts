import {
  ChannelEventIdSchema,
  ChannelIdSchema,
  ConnectionIdSchema,
  LogicalMessageIdSchema,
  PhysicalDeliveryIdSchema,
} from '@nekro-nxt/contracts'
import { parseAdapterConnectionConfiguration } from '@nekro-nxt/adapter-sdk'
import { describe, expect, it } from 'vitest'
import { createWebAdapterConnection, WEB_CONNECTION_DEFINITION, WEB_CONNECTION_DESCRIPTOR } from '../src/index.ts'

describe('Internal Web Adapter', () => {
  it('models the system-managed Web Adapter as an empty configuration and credential definition', () => {
    expect(parseAdapterConnectionConfiguration(WEB_CONNECTION_DEFINITION, {})).toEqual({
      configuration: {},
      credentials: {},
    })
    expect(WEB_CONNECTION_DESCRIPTOR.configSchema).toEqual({
      schemaVersion: 1,
      type: 'object',
      required: [],
      properties: {},
    })
  })

  it('normalizes browser messages and commits them through Core', async () => {
    const accepted: unknown[] = []
    const adapter = createWebAdapterConnection(
      ConnectionIdSchema.parse('con_web'),
      (event) => {
        accepted.push(event)
        return Promise.resolve({
          channelEventId: ChannelEventIdSchema.parse('evt_1'),
          inserted: true,
        })
      },
      () => 123,
    )
    await adapter.start()
    await adapter.postMessage({
      channelId: ChannelIdSchema.parse('chn_web'),
      clientEventId: 'client-1',
      parts: [{ type: 'text', text: '你好' }],
    })
    expect(accepted).toEqual([
      expect.objectContaining({
        adapterKey: 'web',
        dedupeKey: 'web-event:client-1',
      }),
    ])
  })

  it('publishes only physical Outbox deliveries and contains live-listener failures', async () => {
    const adapter = createWebAdapterConnection(ConnectionIdSchema.parse('con_web'), () =>
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
        deliveryId: PhysicalDeliveryIdSchema.parse('phy_1'),
        logicalMessageId: LogicalMessageIdSchema.parse('msg_1'),
        connectionId: ConnectionIdSchema.parse('con_web'),
        channelId: ChannelIdSchema.parse('chn_web'),
        parts: [{ type: 'text', text: '已发送' }],
      },
      new AbortController().signal,
    )
    expect(receipt).toEqual({ status: 'sent', platformMessageId: 'web-message-1' })
    expect(observed).toEqual(['web-message-1'])
  })
})
