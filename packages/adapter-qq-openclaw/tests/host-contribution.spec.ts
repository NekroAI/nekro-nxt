import type { AdapterConnectionHostContext } from '@nekro-nxt/adapter-sdk'
import { AssetIdSchema, ChannelIdSchema, LogicalMessageIdSchema, PhysicalDeliveryIdSchema } from '@nekro-nxt/contracts'
import { createFakeAdapterHostContext } from '@nekro-nxt/test-harness'
import { describe, expect, it, vi } from 'vitest'
import { createQQOpenClawHostContribution, QQOpenClawRuntime } from '../src/index.ts'

const jsonBody = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value))

const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the QQ Host contribution.')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('QQ OpenClaw Host contribution', () => {
  it('rejects a missing credential reference before creating a Runtime', () => {
    const fixture = createFakeAdapterHostContext()
    const contribution = createQQOpenClawHostContribution()
    expect(() =>
      contribution.create(fixture.context, {
        configuration: { appId: 'fixture-app' },
        credentialRefs: {},
      }),
    ).toThrow('凭据不可用')
  })

  it('uses only Host services for Gateway inbound, media, quotes, diagnostics and outbound', async () => {
    const fixture = createFakeAdapterHostContext()
    fixture.credentials.set('credential:fixture', 'fixture-secret')
    fixture.transport.queueResponse({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: jsonBody({ access_token: 'fixture-token', expires_in: 7_200 }),
    })
    fixture.transport.queueResponse({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: jsonBody({ url: 'wss://gateway.example.test' }),
    })

    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const context: AdapterConnectionHostContext = {
      ...fixture.context,
      logger,
      messages: {
        ...fixture.context.messages,
        resolvePlatformMessage: (
          _channelId: Parameters<typeof fixture.context.messages.resolvePlatformMessage>[0],
          reference: string,
        ) =>
          Promise.resolve(
            reference === 'referenced-message'
              ? { logicalMessageId: LogicalMessageIdSchema.parse('msg_FIXTURE'), authoredByAgent: true }
              : undefined,
          ),
        resolvePlatformMessageId: (
          _channelId: Parameters<typeof fixture.context.messages.resolvePlatformMessageId>[0],
          logicalMessageId: string,
        ) => Promise.resolve(logicalMessageId === 'msg_DIRECTREPLY' ? 'fixture-direct-message' : undefined),
      },
      assets: {
        ...fixture.context.assets,
        fetchRemoteBytes: () =>
          Promise.resolve({
            bytes: new Uint8Array([1, 2, 3]),
            declaredMediaType: 'image/png',
            filename: 'fixture.png',
          }),
      },
    }
    const contribution = createQQOpenClawHostContribution()
    const runtime = await contribution.create(context, {
      configuration: {
        appId: 'fixture-app',
        proactiveSend: true,
        markdown: true,
        maxTextLength: 1_800,
        maxTextBytes: 7_200,
      },
      credentialRefs: { clientSecret: 'credential:fixture' },
    })
    expect(runtime).toBeInstanceOf(QQOpenClawRuntime)
    if (!(runtime instanceof QQOpenClawRuntime)) throw new TypeError('Expected the QQ OpenClaw Runtime.')
    expect(runtime.capabilities.outbound.proactiveSend).toBe(true)

    await runtime.start()
    await waitFor(() => fixture.transport.sockets.length === 1)
    const socket = fixture.transport.sockets[0]!
    socket.emit({ type: 'open' })
    socket.emit({ type: 'message', data: JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }) })
    socket.emit({
      type: 'message',
      data: JSON.stringify({ op: 0, t: 'READY', s: 1, d: { session_id: 'fixture-session' } }),
    })
    socket.emit({
      type: 'message',
      data: JSON.stringify({
        op: 0,
        t: 'GROUP_MESSAGE_CREATE',
        s: 2,
        d: {
          id: 'fixture-message',
          group_openid: 'fixture-group',
          group_name: '示例群聊',
          author: { member_openid: 'fixture-member', nickname: '示例成员' },
          content: '带引用和图片的消息',
          message_scene: { ext: { ref_msg_idx: 'referenced-message' } },
          attachments: [{ url: 'https://cdn.example.test/fixture.png' }],
          timestamp: 1,
        },
      }),
    })
    socket.emit({
      type: 'message',
      data: new TextEncoder().encode(
        JSON.stringify({
          op: 0,
          t: 'C2C_MESSAGE_CREATE',
          s: 3,
          d: {
            id: 'fixture-direct-message',
            message_scene: { ext: ['msg_idx=REFIDX_fixture_direct'] },
            author: { user_openid: 'fixture-direct-user' },
            content: '私聊消息',
            message_type: 103,
            attachments: [
              {
                url: 'https://cdn.example.test/fixture-file',
                content_type: 'application/octet-stream',
                filename: 'fixture.bin',
              },
            ],
            timestamp: 'not-a-time',
          },
        }),
      ),
    })
    socket.emit({
      type: 'message',
      data: JSON.stringify({
        op: 0,
        t: 'GROUP_MESSAGE_CREATE',
        s: 4,
        d: {
          id: 'fixture-message-with-missing-quote',
          group_openid: 'fixture-group',
          author: { member_openid: 'fixture-member' },
          content: '引用目标不存在',
          message_scene: { ext: { ref_msg_idx: 'missing-message' } },
          timestamp: 2,
        },
      }),
    })
    await waitFor(() => fixture.events.length === 3)
    expect(fixture.events[0]?.parts.map(({ type }) => type)).toEqual(['text', 'image', 'quote'])
    expect(fixture.events[0]?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: '带引用和图片的消息' }),
        expect.objectContaining({ type: 'image', assetId: 'ast_HARNESS' }),
        expect.objectContaining({ type: 'quote', messageId: 'msg_FIXTURE' }),
      ]),
    )
    expect(fixture.channels.has('group:fixture-group')).toBe(true)
    expect(fixture.channels.has('c2c:fixture-direct-user')).toBe(true)
    expect(fixture.members.size).toBe(2)
    expect(fixture.events[2]?.parts.some(({ type }) => type === 'quote')).toBe(false)
    expect(fixture.states.size).toBeGreaterThan(0)
    expect(fixture.diagnostics.some(({ status }) => status === 'connected')).toBe(true)
    expect(fixture.diagnostics.some(({ details }) => details?.['quoteReason'])).toBe(false)
    expect(logger.debug).toHaveBeenCalledWith('引用消息缺少定位信息，已保留可用预览', {
      reason: 'reference-field-missing',
    })
    expect(logger.warn).not.toHaveBeenCalled()

    const channelId = ChannelIdSchema.parse(fixture.channels.get('group:fixture-group'))
    const plans = await runtime.planOutbound({
      connectionId: fixture.context.connectionId,
      channelId,
      parts: [{ type: 'text', text: '发送测试' }],
    })
    expect(plans).toHaveLength(1)
    fixture.transport.queueResponse({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: jsonBody({ id: 'fixture-outbound' }),
    })
    await expect(runtime.testSend(channelId, new AbortController().signal)).resolves.toBe('fixture-outbound')
    expect(fixture.transport.requests.some(({ url }) => url.includes('/v2/groups/fixture-group/messages'))).toBe(true)

    const directChannelId = ChannelIdSchema.parse(fixture.channels.get('c2c:fixture-direct-user'))
    const directMemberId = await context.members.ensure({
      channelId: directChannelId,
      platformUserId: 'fixture-direct-user',
      observedAt: fixture.context.now(),
    })
    const directPlans = await runtime.planOutbound({
      connectionId: fixture.context.connectionId,
      channelId: directChannelId,
      parts: [
        { type: 'mention', memberId: directMemberId },
        { type: 'text', text: '私聊发送测试' },
      ],
      replyTo: LogicalMessageIdSchema.parse('msg_DIRECTREPLY'),
    })
    expect(directPlans).toHaveLength(1)
    fixture.transport.queueResponse({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: jsonBody({ id: 'fixture-direct-outbound' }),
    })
    await expect(runtime.testSend(directChannelId, new AbortController().signal)).resolves.toBe(
      'fixture-direct-outbound',
    )

    for (const response of [
      {
        upload_id: 'upload-fixture',
        block_size: 1,
        parts: [{ index: 1, offset: 0, size: 1, url: 'https://upload.example.test/part' }],
      },
      {},
      {},
      { file_info: 'file-fixture' },
      { id: 'fixture-media-outbound' },
    ]) {
      fixture.transport.queueResponse({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: jsonBody(response),
      })
    }
    await expect(
      runtime.deliver(
        {
          deliveryId: PhysicalDeliveryIdSchema.parse('phy_MEDIAFIXTURE'),
          logicalMessageId: LogicalMessageIdSchema.parse('msg_MEDIAFIXTURE'),
          connectionId: fixture.context.connectionId,
          channelId,
          parts: [{ type: 'image', assetId: AssetIdSchema.parse('ast_HARNESS') }],
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ status: 'sent', platformMessageId: 'fixture-media-outbound' })

    const unknownChannelId = ChannelIdSchema.parse('chn_UNKNOWN')
    fixture.channels.set('invalid-platform-channel', unknownChannelId)
    await expect(runtime.testSend(unknownChannelId, new AbortController().signal)).rejects.toThrow(
      'diagnostic target is unknown',
    )

    const failedDelivery = await runtime.deliver(
      {
        deliveryId: PhysicalDeliveryIdSchema.parse('phy_FIXTURE'),
        logicalMessageId: LogicalMessageIdSchema.parse('msg_OUTBOUND'),
        connectionId: fixture.context.connectionId,
        channelId,
        parts: [{ type: 'quote', messageId: LogicalMessageIdSchema.parse('msg_FIXTURE') }],
      },
      new AbortController().signal,
    )
    expect(failedDelivery.status).toBe('failed')
    if (failedDelivery.status !== 'failed') throw new TypeError('Expected the invalid quote delivery to fail.')
    expect(failedDelivery.failure.kind).toBe('transient')
    expect(failedDelivery.failure.message).toContain('cannot deliver')

    socket.emit({ type: 'close', code: 1000, reason: 'fixture complete' })
    await runtime.stop()
    fixture.assertIdle()
  })
})
