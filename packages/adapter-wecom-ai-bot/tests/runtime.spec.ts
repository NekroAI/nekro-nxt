import { AssetIdSchema, LogicalMessageIdSchema, PhysicalDeliveryIdSchema } from '@nekro-nxt/contracts'
import { createCipheriv } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer, type RawData } from 'ws'
import { decryptWeComMedia, splitWeComMarkdown, WeComAiBotRuntime } from '../src/runtime.ts'
import { weComObject } from '../src/transport.ts'
import { createFakeContext, waitFor } from './helpers.ts'

const servers: WebSocketServer[] = []
const rawText = (raw: RawData): string =>
  Array.isArray(raw)
    ? Buffer.concat(raw).toString('utf8')
    : raw instanceof ArrayBuffer
      ? Buffer.from(raw).toString('utf8')
      : raw.toString('utf8')

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          for (const client of server.clients) client.terminate()
          server.close(() => resolve())
        }),
    ),
  )
})

const protocol = async (
  responseFor?: (request: Record<string, unknown>) => Readonly<Record<string, unknown>> | undefined,
) => {
  const server = new WebSocketServer({ port: 0 })
  const requests: Record<string, unknown>[] = []
  servers.push(server)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const request = weComObject(JSON.parse(rawText(raw)))
      if (!request) return
      requests.push(request)
      const headers = weComObject(request['headers'])
      const cmd = request['cmd']
      const customResponse = responseFor?.(request)
      const body =
        cmd === 'aibot_upload_media_init'
          ? { upload_id: 'upload-fixture' }
          : cmd === 'aibot_upload_media_finish'
            ? { media_id: 'media-fixture', type: 'file' }
            : undefined
      socket.send(JSON.stringify(customResponse ?? { headers, errcode: 0, errmsg: 'ok', ...(body ? { body } : {}) }))
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture server did not bind TCP.')
  return {
    server,
    endpoint: `ws://127.0.0.1:${address.port}/`,
    requests,
    send(frame: unknown) {
      ;[...server.clients][0]!.send(JSON.stringify(frame))
    },
  }
}

const encrypt = (plain: Uint8Array, key: Buffer): Uint8Array => {
  const padding = 32 - (plain.byteLength % 32 || 32) || 32
  const padded = Buffer.concat([Buffer.from(plain), Buffer.alloc(padding, padding)])
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16))
  cipher.setAutoPadding(false)
  return new Uint8Array(Buffer.concat([cipher.update(padded), cipher.final()]))
}

describe('WeCom AI bot protocol mapping', () => {
  it('splits UTF-8 Markdown and validates encrypted media padding', () => {
    const chunks = splitWeComMarkdown(`段落一\n\n${'企'.repeat(20)}`, 24)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('')).toBe(`段落一\n\n${'企'.repeat(20)}`)
    expect(chunks.every((chunk) => Buffer.byteLength(chunk) <= 24)).toBe(true)

    const key = Buffer.alloc(32, 7)
    const plain = new TextEncoder().encode('fixture-media')
    expect(decryptWeComMedia(encrypt(plain, key), key.toString('base64'))).toEqual(plain)
    expect(() => decryptWeComMedia(new Uint8Array(16), 'invalid')).toThrow(/AES Key/u)
  })

  it('maps text, mixed media, voice transcript and quote without persisting temporary secrets', async () => {
    const fixture = await protocol()
    const fake = createFakeContext()
    const key = Buffer.alloc(32, 9)
    const plain = new Uint8Array([8, 6, 7, 5, 3, 0, 9])
    fake.setRemoteBytes(encrypt(plain, key))
    const runtime = new WeComAiBotRuntime({
      context: fake.context,
      config: { botId: 'bot-fixture', secretCredentialRef: 'credential-fixture' },
      transport: { endpoint: fixture.endpoint, heartbeatIntervalMs: 60_000 },
    })
    await runtime.start()
    await waitFor(() => fake.diagnostics.some(({ status }) => status === 'connected'))
    fixture.send({
      cmd: 'aibot_msg_callback',
      headers: { req_id: 'callback-mixed' },
      body: {
        msgid: 'message-mixed',
        aibotid: 'bot-fixture',
        chatid: 'group-fixture',
        chattype: 'group',
        from: { userid: 'member-fixture' },
        msgtype: 'mixed',
        mixed: {
          msg_item: [
            { msgtype: 'text', text: { content: '图文内容' } },
            { msgtype: 'image', image: { url: 'https://media.example.test/fixture', aeskey: key.toString('base64') } },
          ],
        },
        quote: { msgtype: 'text', text: { content: '引用摘要' } },
      },
    })
    fixture.send({
      cmd: 'aibot_msg_callback',
      headers: { req_id: 'callback-voice' },
      body: {
        msgid: 'message-voice',
        aibotid: 'bot-fixture',
        chattype: 'single',
        from: { userid: 'member-voice' },
        msgtype: 'voice',
        voice: { content: '语音转写文本' },
      },
    })
    await waitFor(() => fake.events.length === 2)
    expect(fake.imported[0]).toEqual(plain)
    expect(fake.events[0]).toMatchObject({
      facts: { mentionedBot: true },
      parts: [
        { type: 'text', text: '图文内容' },
        { type: 'image', assetId: 'ast_WECOM1' },
        { type: 'rich', kind: 'quote-summary' },
      ],
      assetOccurrences: [{ partIndex: 1, assetId: 'ast_WECOM1' }],
    })
    expect(fake.events[1]?.parts).toEqual([expect.objectContaining({ type: 'rich', kind: 'voice-transcript' })])
    expect(JSON.stringify(fake.events)).not.toContain('aeskey')
    expect(JSON.stringify(fake.states)).not.toContain('media.example.test')
    await runtime.stop()
  })

  it('creates and consumes one streaming feedback lease before proactive sends', async () => {
    const fixture = await protocol()
    const fake = createFakeContext()
    const runtime = new WeComAiBotRuntime({
      context: fake.context,
      config: { botId: 'bot-stream', secretCredentialRef: 'credential-stream' },
      transport: { endpoint: fixture.endpoint, heartbeatIntervalMs: 60_000 },
    })
    await runtime.start()
    await waitFor(() => fake.diagnostics.some(({ status }) => status === 'connected'))
    fixture.send({
      cmd: 'aibot_msg_callback',
      headers: { req_id: 'callback-stream' },
      body: {
        msgid: 'message-stream',
        aibotid: 'bot-stream',
        chatid: 'group-stream',
        chattype: 'group',
        from: { userid: 'member-stream' },
        msgtype: 'text',
        text: { content: '@机器人账号 处理请求' },
      },
    })
    await waitFor(() => fake.events.length === 1)
    const channelId = fake.events[0]!.channelId
    await expect(
      runtime.interactions.startProcessingFeedback!({
        leaseId: 'lease-stream',
        channelId,
        platformMessageId: 'message-stream',
      }),
    ).resolves.toEqual({ status: 'succeeded' })
    const plans = await runtime.planOutbound({
      connectionId: fake.context.connectionId,
      channelId,
      parts: [{ type: 'text', text: '处理结果' }],
      processingFeedback: { leaseId: 'lease-stream', platformMessageId: 'message-stream' },
    })
    expect(plans).toHaveLength(1)
    expect(plans[0]?.consumesProcessingFeedback).toBe(true)
    await expect(
      runtime.deliver(
        {
          deliveryId: PhysicalDeliveryIdSchema.parse('phy_WECOMSTREAM'),
          logicalMessageId: LogicalMessageIdSchema.parse('msg_WECOMSTREAM'),
          connectionId: fake.context.connectionId,
          channelId,
          parts: plans[0]!.parts,
          ...(plans[0]!.adapterContext === undefined ? {} : { adapterContext: plans[0]!.adapterContext }),
          processingFeedback: { leaseId: 'lease-stream', platformMessageId: 'message-stream' },
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ status: 'sent' })
    const streamRequests = fixture.requests.filter(({ cmd }) => cmd === 'aibot_respond_msg')
    expect(streamRequests).toHaveLength(2)
    expect(streamRequests.map((request) => weComObject(request['headers'])?.['req_id'])).toEqual([
      'callback-stream',
      'callback-stream',
    ])
    expect(weComObject(streamRequests[1]?.['body'])?.['stream']).toMatchObject({
      content: '处理结果',
      finish: true,
    })
    await runtime.stop()
  })

  it('uploads zero-indexed chunks and sends media with an explicit chat type', async () => {
    const fixture = await protocol()
    const fake = createFakeContext()
    const bytes = new Uint8Array(600 * 1024).fill(3)
    Object.defineProperty(fake.context.assets, 'read', {
      value: () => Promise.resolve({ bytes, mediaType: 'application/pdf', byteSize: bytes.byteLength }),
    })
    const runtime = new WeComAiBotRuntime({
      context: fake.context,
      config: { botId: 'bot-upload', secretCredentialRef: 'credential-upload' },
      transport: { endpoint: fixture.endpoint, heartbeatIntervalMs: 60_000 },
    })
    await runtime.start()
    await waitFor(() => fake.diagnostics.some(({ status }) => status === 'connected'))
    fixture.send({
      cmd: 'aibot_msg_callback',
      headers: { req_id: 'callback-upload' },
      body: {
        msgid: 'message-upload',
        aibotid: 'bot-upload',
        chattype: 'single',
        from: { userid: 'member-upload' },
        msgtype: 'text',
        text: { content: '准备接收文件' },
      },
    })
    await waitFor(() => fake.events.length === 1)
    const channelId = fake.events[0]!.channelId
    const plans = await runtime.planOutbound({
      connectionId: fake.context.connectionId,
      channelId,
      parts: [{ type: 'file', assetId: AssetIdSchema.parse('ast_WECOMUPLOAD'), name: 'report.pdf' }],
    })
    await expect(
      runtime.deliver(
        {
          deliveryId: PhysicalDeliveryIdSchema.parse('phy_WECOMUPLOAD'),
          logicalMessageId: LogicalMessageIdSchema.parse('msg_WECOMUPLOAD'),
          connectionId: fake.context.connectionId,
          channelId,
          parts: plans[0]!.parts,
          ...(plans[0]!.adapterContext === undefined ? {} : { adapterContext: plans[0]!.adapterContext }),
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ status: 'sent' })
    const chunks = fixture.requests.filter(({ cmd }) => cmd === 'aibot_upload_media_chunk')
    expect(chunks.map((request) => weComObject(request['body'])?.['chunk_index'])).toEqual([0, 1])
    const send = fixture.requests.find(({ cmd }) => cmd === 'aibot_send_msg')!
    expect(send['body']).toMatchObject({ chat_type: 1, chatid: 'member-upload', msgtype: 'file' })
    Object.defineProperty(fake.context.assets, 'read', {
      value: () => Promise.resolve({ bytes: new Uint8Array([1]), mediaType: 'audio/mpeg', byteSize: 1 }),
    })
    await expect(
      runtime.planOutbound({
        connectionId: fake.context.connectionId,
        channelId,
        parts: [{ type: 'audio', assetId: AssetIdSchema.parse('ast_WECOMAUDIO') }],
      }),
    ).rejects.toThrow(/AMR/u)
    await runtime.stop()
  })

  it('preserves explicit platform error classification for outbound delivery', async () => {
    const fixture = await protocol((request) =>
      request['cmd'] === 'aibot_send_msg'
        ? { headers: request['headers'], errcode: 45009, errmsg: 'rate limit fixture' }
        : undefined,
    )
    const fake = createFakeContext()
    const runtime = new WeComAiBotRuntime({
      context: fake.context,
      config: { botId: 'bot-explicit-error', secretCredentialRef: 'credential-explicit-error' },
      transport: { endpoint: fixture.endpoint, heartbeatIntervalMs: 60_000 },
    })
    await runtime.start()
    await waitFor(() => fake.diagnostics.some(({ status }) => status === 'connected'))
    fixture.send({
      cmd: 'aibot_msg_callback',
      headers: { req_id: 'callback-explicit-error' },
      body: {
        msgid: 'message-explicit-error',
        aibotid: 'bot-explicit-error',
        chattype: 'single',
        from: { userid: 'member-explicit-error' },
        msgtype: 'text',
        text: { content: '触发发送错误分类测试' },
      },
    })
    await waitFor(() => fake.events.length === 1)
    const channelId = fake.events[0]!.channelId
    const plans = await runtime.planOutbound({
      connectionId: fake.context.connectionId,
      channelId,
      parts: [{ type: 'text', text: '测试消息' }],
    })
    await expect(
      runtime.deliver(
        {
          deliveryId: PhysicalDeliveryIdSchema.parse('phy_WECOMERROR'),
          logicalMessageId: LogicalMessageIdSchema.parse('msg_WECOMERROR'),
          connectionId: fake.context.connectionId,
          channelId,
          parts: plans[0]!.parts,
          ...(plans[0]!.adapterContext === undefined ? {} : { adapterContext: plans[0]!.adapterContext }),
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ status: 'failed', failure: { kind: 'rate-limited' } })
    await runtime.stop()
  })

  it('normalizes welcome, card and feedback events and stops on connection conflict', async () => {
    const fixture = await protocol()
    const fake = createFakeContext()
    const runtime = new WeComAiBotRuntime({
      context: fake.context,
      config: { botId: 'bot-events', secretCredentialRef: 'credential-events' },
      transport: { endpoint: fixture.endpoint, heartbeatIntervalMs: 60_000 },
    })
    await runtime.start()
    await waitFor(() => fake.diagnostics.some(({ status }) => status === 'connected'))
    for (const [index, event] of [
      { eventtype: 'enter_chat' },
      { eventtype: 'template_card_event', event_key: 'confirm', task_id: 'task-fixture' },
      {
        eventtype: 'feedback_event',
        feedback_event: { id: 'nxt-msg:msg_WECOMTARGET', type: 2, content: '需要补充', inaccurate_reason_list: [2, 4] },
      },
    ].entries()) {
      fixture.send({
        cmd: 'aibot_event_callback',
        headers: { req_id: `callback-event-${index}` },
        body: {
          msgid: `event-message-${index}`,
          aibotid: 'bot-events',
          chattype: 'single',
          from: { userid: 'member-events' },
          msgtype: 'event',
          event,
        },
      })
    }
    await waitFor(() => fake.events.length === 3)
    expect(fake.events.map(({ activityType }) => activityType)).toEqual([
      'conversation-entered',
      'card-action-invoked',
      'message-feedback-negative',
    ])
    expect(fake.events[2]).toMatchObject({
      targetLogicalMessageId: 'msg_WECOMTARGET',
      facts: { feedbackType: 2, inaccurateReasonList: [2, 4] },
    })
    fixture.send({
      cmd: 'aibot_event_callback',
      headers: { req_id: 'callback-conflict' },
      body: {
        msgid: 'event-conflict',
        aibotid: 'bot-events',
        chattype: 'single',
        from: { userid: 'member-events' },
        msgtype: 'event',
        event: { eventtype: 'disconnected_event' },
      },
    })
    await waitFor(() => fake.diagnostics.some(({ details }) => details?.['failure'] === 'connection-conflict'))
    expect(fake.events).toHaveLength(3)
    await runtime.stop()
  })
})
