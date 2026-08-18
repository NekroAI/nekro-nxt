import type { AdapterInboundEvent, AdapterConnectionContext, PhysicalDeliveryRequest } from '@nekro-nxt/adapter-sdk'
import {
  ChannelEventIdSchema,
  ChannelIdSchema,
  ConnectionIdSchema,
  LogicalMessageIdSchema,
  PhysicalDeliveryIdSchema,
} from '@nekro-nxt/contracts'
import { describe, expect, it } from 'vitest'
import { FakeAdapterConnection, ScenarioDriver, VirtualClock } from '../src/index.ts'

const connectionId = ConnectionIdSchema.parse('con_test')
const channelId = ChannelIdSchema.parse('chn_test')

const inbound = (id: number): AdapterInboundEvent => ({
  connectionId,
  channelId,
  adapterKey: 'fake',
  platformEventId: `event-${id}`,
  kind: 'message-created',
  parts: [{ type: 'text', text: `message-${id}` }],
  platformSequence: id,
  platformTimestamp: id,
  receivedAt: id,
  dedupeKey: `event:event-${id}`,
})

const delivery = (id: number): PhysicalDeliveryRequest => ({
  deliveryId: PhysicalDeliveryIdSchema.parse(`phy_${id}`),
  logicalMessageId: LogicalMessageIdSchema.parse('msg_test'),
  connectionId,
  channelId,
  parts: [{ type: 'text', text: `outbound-${id}` }],
})

describe('FakeAdapterConnection', () => {
  it('uses the production inbound seam and preserves structured receipts', async () => {
    const accepted: string[] = []
    const context: AdapterConnectionContext = {
      connectionId,
      now: () => 0,
      acceptInbound: (event) => {
        accepted.push(event.dedupeKey)
        return Promise.resolve({
          channelEventId: ChannelEventIdSchema.parse(`evt_${accepted.length}`),
          inserted: accepted.length === 1,
        })
      },
    }
    const adapter = new FakeAdapterConnection(context)
    await adapter.start()
    await adapter.receive(inbound(1))
    await adapter.receive(inbound(1))

    adapter.queueReceipt({ status: 'unknown', message: 'response lost after submit' })
    expect(await adapter.deliver(delivery(1), new AbortController().signal)).toEqual({
      status: 'unknown',
      message: 'response lost after submit',
    })
    expect(adapter.deliveries).toHaveLength(1)
    expect(accepted).toEqual(['event:event-1', 'event:event-1'])

    await adapter.stop()
    await expect(adapter.receive(inbound(2))).rejects.toThrow('not running')
  })

  it('runs asynchronous gateway scenarios in deterministic virtual order', async () => {
    const clock = new VirtualClock(100)
    const driver = new ScenarioDriver(clock)
    const events: string[] = []
    driver.schedule(120, 'later', async () => {
      await Promise.resolve()
      events.push(`later@${clock.now()}`)
    })
    driver.schedule(110, 'first', () => {
      events.push(`first@${clock.now()}`)
    })
    driver.schedule(110, 'second', () => {
      events.push(`second@${clock.now()}`)
    })

    expect(await driver.run()).toEqual(['first', 'second', 'later'])
    expect(events).toEqual(['first@110', 'second@110', 'later@120'])
  })
})
