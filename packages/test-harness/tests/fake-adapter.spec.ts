import type { AdapterInboundEvent, AdapterConnectionContext, PhysicalDeliveryRequest } from '@nekro-nxt/adapter-sdk'
import {
  AssetIdSchema,
  ChannelEventIdSchema,
  ChannelIdSchema,
  ChannelMemberIdSchema,
  ConnectionIdSchema,
  LogicalMessageIdSchema,
  PhysicalDeliveryIdSchema,
} from '@nekro-nxt/contracts'
import { describe, expect, it } from 'vitest'
import {
  createFakeAdapterHostContext,
  FakeAdapterConnection,
  FakeAdapterTransport,
  FakeAdapterWebSocket,
  ScenarioDriver,
  VirtualClock,
} from '../src/index.ts'

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

  it('covers stopped, duplicate-start, aborted, and default-delivery lifecycle paths', async () => {
    const context: AdapterConnectionContext = {
      connectionId,
      now: () => 0,
      acceptInbound: () =>
        Promise.resolve({ channelEventId: ChannelEventIdSchema.parse('evt_lifecycle'), inserted: true }),
    }
    const adapter = new FakeAdapterConnection(context, {
      text: true,
      mentions: false,
      images: false,
      files: false,
      audio: false,
      replies: false,
      mixedContent: false,
      proactiveSend: true,
    })
    await expect(adapter.deliver(delivery(1), new AbortController().signal)).rejects.toThrow('not running')
    await adapter.start()
    await expect(adapter.start()).rejects.toThrow('already running')
    const aborted = new AbortController()
    aborted.abort()
    await expect(adapter.deliver(delivery(1), aborted.signal)).resolves.toMatchObject({ status: 'failed' })
    await expect(adapter.deliver(delivery(2), new AbortController().signal)).resolves.toEqual({
      status: 'sent',
      platformMessageId: 'fake-message-1',
    })
    await adapter.stop()
    await adapter.stop()
  })
})

describe('Fake Adapter transport and Host context', () => {
  it('owns HTTP responses and fully retractable WebSocket resources', async () => {
    const transport = new FakeAdapterTransport()
    transport.queueResponse({ status: 201, headers: { location: '/fixture' }, body: new Uint8Array([9]) })
    const requestBytes = new Uint8Array([1, 2])
    await expect(
      transport.request({ url: 'https://example.invalid/bytes', method: 'POST', body: requestBytes }),
    ).resolves.toMatchObject({ status: 201 })
    await expect(transport.request({ url: 'https://example.invalid/text', body: 'fixture' })).resolves.toEqual({
      status: 200,
      headers: {},
      body: new Uint8Array(),
    })
    expect(transport.requests[0]?.body).toEqual(new Uint8Array([1, 2]))
    expect(transport.requests[0]?.body).not.toBe(requestBytes)

    const connection = await transport.connectWebSocket()
    const socket = transport.sockets[0]!
    expect(connection).toBe(socket)
    const events: string[] = []
    const unsubscribe = socket.subscribe((event) => events.push(event.type))
    socket.emit({ type: 'open' })
    await socket.send('hello')
    await socket.send(new Uint8Array([3]))
    expect(socket.sent).toEqual(['hello', new Uint8Array([3])])
    expect(() => transport.assertIdle()).toThrow('1 active socket')
    await socket.close(1001, 'fixture complete')
    expect(events).toEqual(['open', 'close'])
    expect(() => transport.assertIdle()).toThrow('1 active socket')
    unsubscribe()
    expect(socket.listenerCount()).toBe(0)
    transport.assertIdle()
    await socket.close()
    await expect(socket.send('late')).rejects.toThrow('closed')

    const standalone = new FakeAdapterWebSocket()
    await standalone.close()
  })

  it('provides every scoped Host service without leaking credentials or resources', async () => {
    const harness = createFakeAdapterHostContext()
    expect(harness.context.now()).toBe(1)
    const channelId = await harness.context.channels.ensure({
      platformChannelId: 'fixture-room',
      kind: 'group',
      displayName: 'Fixture Room',
      observedAt: 1,
    })
    expect(
      await harness.context.channels.ensure({
        platformChannelId: 'fixture-room',
        kind: 'direct',
        observedAt: 2,
      }),
    ).toBe(channelId)
    await harness.context.channels.updateDisplayName(channelId, 'Renamed Fixture Room')
    expect(await harness.context.channels.resolvePlatformChannelId(channelId)).toBe('fixture-room')
    expect(await harness.context.channels.resolveKind(channelId)).toBe('group')
    expect(
      await harness.context.channels.resolvePlatformChannelId(ChannelIdSchema.parse('chn_unknown')),
    ).toBeUndefined()

    const memberId = await harness.context.members.ensure({
      channelId,
      platformUserId: 'fixture-user',
      displayName: 'Fixture User',
      observedAt: 1,
    })
    expect(await harness.context.members.ensure({ channelId, platformUserId: 'fixture-user', observedAt: 2 })).toBe(
      memberId,
    )
    expect(await harness.context.members.resolvePlatformUserId(channelId, memberId)).toBe('fixture-user')
    expect(
      await harness.context.members.resolvePlatformUserId(channelId, ChannelMemberIdSchema.parse('mbr_unknown')),
    ).toBeUndefined()

    const committed = await harness.context.acceptInbound({
      ...inbound(3),
      connectionId: harness.context.connectionId,
      channelId,
    })
    expect(committed).toMatchObject({ inserted: true })
    expect(harness.events[0]?.dedupeKey).toBe('event:event-3')

    const logicalMessageId = LogicalMessageIdSchema.parse('msg_fixture')
    expect(await harness.context.messages.resolvePlatformMessage(channelId, 'platform-message')).toBeUndefined()
    expect(await harness.context.messages.resolvePlatformMessageId(channelId, logicalMessageId)).toBeUndefined()
    expect(await harness.context.messages.resolveLogicalMessage(channelId, logicalMessageId)).toBeUndefined()

    const imported = await harness.context.assets.importBytes({
      bytes: new Uint8Array([1, 2, 3]),
      declaredMediaType: 'image/png',
    })
    expect(imported).toMatchObject({ mediaType: 'image/png', byteSize: 3 })
    await expect(harness.context.assets.importBytes({ bytes: new Uint8Array() })).resolves.toMatchObject({
      mediaType: 'application/octet-stream',
    })
    await expect(
      harness.context.assets.read({ assetId: AssetIdSchema.parse('ast_fixture'), channelId }),
    ).resolves.toMatchObject({ byteSize: 1 })
    await expect(
      harness.context.assets.fetchRemoteBytes({ url: 'https://example.invalid/asset', maxBytes: 10 }),
    ).resolves.toMatchObject({ declaredMediaType: 'application/octet-stream' })

    harness.credentials.set('credential-ref', 'secret-value')
    await expect(harness.context.credentials.resolve('credential-ref')).resolves.toBe('secret-value')
    await expect(harness.context.credentials.resolve('missing-ref')).rejects.toThrow('Unknown Fake credential')
    expect(await harness.context.state.load('cursor')).toBeUndefined()
    await harness.context.state.save('cursor', { page: 2 })
    expect(await harness.context.state.load('cursor')).toEqual({ page: 2 })
    await harness.context.state.clear('cursor')
    expect(await harness.context.state.load('cursor')).toBeUndefined()
    harness.context.diagnostics.publish({ status: 'connected', details: { mode: 'fixture' } })
    expect(harness.diagnostics).toEqual([{ status: 'connected', details: { mode: 'fixture' } }])
    harness.assertIdle()

    const cancel = harness.clock.setTimeout(() => undefined, 10)
    expect(() => harness.assertIdle()).toThrow('1 timer')
    cancel()
    harness.assertIdle()
  })
})

describe('VirtualClock edge conditions', () => {
  it('validates time and removes cancelled tasks from pending work', () => {
    expect(() => new VirtualClock(Number.NaN)).toThrow('must be finite')
    const clock = new VirtualClock()
    expect(() => clock.setTimeout(() => undefined, -1)).toThrow('non-negative')
    expect(() => clock.setTimeout(() => undefined, Number.POSITIVE_INFINITY)).toThrow('non-negative')
    expect(() => clock.advanceBy(-1)).toThrow('non-negative')
    expect(() => clock.advanceBy(Number.NaN)).toThrow('non-negative')
    const calls: string[] = []
    const cancel = clock.setTimeout(() => calls.push('cancelled'), 1)
    clock.setTimeout(() => calls.push('active'), 2)
    cancel()
    expect(clock.pendingCount()).toBe(1)
    clock.advanceBy(3)
    expect(calls).toEqual(['active'])
    expect(clock.pendingCount()).toBe(0)
    clock.advanceBy(0)
  })

  it('rejects scenarios in the past and clears completed actions', async () => {
    const clock = new VirtualClock(10)
    const driver = new ScenarioDriver(clock)
    expect(() => driver.schedule(9, 'past', () => undefined)).toThrow('must not precede now')
    expect(() => driver.schedule(Number.NaN, 'invalid', () => undefined)).toThrow('must not precede now')
    driver.schedule(10, 'now', () => undefined)
    expect(await driver.run()).toEqual(['now'])
    expect(await driver.run()).toEqual([])
    expect(await new ScenarioDriver().run()).toEqual([])
  })
})
