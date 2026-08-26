import { WebSocketServer, type RawData } from 'ws'
import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { AssetIdSchema, LogicalMessageIdSchema, PhysicalDeliveryIdSchema } from '@nekro-nxt/contracts'
import { OneBot11Runtime } from '../src/runtime.ts'
import { createFakeContext, waitFor } from './helpers.ts'

const servers: WebSocketServer[] = []
const RequestSchema = z.record(z.string(), z.unknown())
const decodeRequest = (raw: RawData): Record<string, unknown> =>
  RequestSchema.parse(
    JSON.parse(
      Array.isArray(raw)
        ? Buffer.concat(raw).toString('utf8')
        : raw instanceof ArrayBuffer
          ? Buffer.from(raw).toString('utf8')
          : raw.toString('utf8'),
    ),
  )

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

const protocolEndpoint = async () => {
  const server = new WebSocketServer({ port: 0 })
  const requests: Record<string, unknown>[] = []
  servers.push(server)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const request = decodeRequest(raw)
      requests.push(request)
      const action = request['action']
      const data =
        action === 'get_login_info'
          ? { user_id: '91001' }
          : action === 'get_version_info'
            ? { app_name: 'Fixture', protocol_version: 'v11' }
            : typeof action === 'string' && action.startsWith('send_')
              ? { message_id: 'sent-message-1' }
              : {}
      socket.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: request['echo'] }))
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture server did not bind TCP.')
  return { server, endpoint: `ws://127.0.0.1:${address.port}/`, requests }
}

describe('OneBot 11 normalized inbound', () => {
  it('maps array messages and keeps poke while ordinary reactions are off by default', async () => {
    const protocol = await protocolEndpoint()
    const fake = createFakeContext()
    const runtime = new OneBot11Runtime({
      context: fake.context,
      config: { endpoint: protocol.endpoint, capturePokeEvents: true, captureMessageReactionEvents: false },
      transport: { reconnectDelaysMs: [5] },
    })
    await runtime.start()
    await waitFor(() => fake.diagnostics.some(({ status }) => status === 'connected'))
    const socket = [...protocol.server.clients][0]!
    socket.send(
      JSON.stringify({
        time: 100,
        self_id: '91001',
        post_type: 'message',
        message_type: 'group',
        group_id: '70001',
        user_id: '80001',
        message_id: 'message-1',
        sender: { nickname: '成员甲' },
        message: [
          { type: 'text', data: { text: '你好' } },
          { type: 'at', data: { qq: '91001' } },
        ],
      }),
    )
    socket.send(
      JSON.stringify({
        time: 101,
        post_type: 'notice',
        notice_type: 'group_msg_emoji_like',
        sub_type: 'add',
        group_id: '70001',
        user_id: '80001',
        message_id: 'message-1',
        emoji_id: '66',
      }),
    )
    socket.send(
      JSON.stringify({
        time: 102,
        post_type: 'notice',
        notice_type: 'notify',
        sub_type: 'poke',
        group_id: '70001',
        user_id: '80001',
        target_id: '91001',
      }),
    )
    await waitFor(() => fake.events.length === 2)
    await runtime.stop()
    expect(fake.events.find(({ kind }) => kind === 'message-created')).toMatchObject({
      kind: 'message-created',
      facts: { mentionedBot: true },
      parts: [{ type: 'text', text: '你好' }, { type: 'mention' }],
    })
    expect(fake.events.find(({ activityType }) => activityType === 'member-poked')).toMatchObject({
      kind: 'control',
      activityType: 'member-poked',
    })
  })

  it('does not parse CQ codes from string messages', async () => {
    const protocol = await protocolEndpoint()
    const fake = createFakeContext()
    const runtime = new OneBot11Runtime({
      context: fake.context,
      config: { endpoint: protocol.endpoint, capturePokeEvents: true, captureMessageReactionEvents: false },
    })
    await runtime.start()
    await waitFor(() => fake.diagnostics.some(({ status }) => status === 'connected'))
    ;[...protocol.server.clients][0]!.send(
      JSON.stringify({
        time: 100,
        post_type: 'message',
        message_type: 'private',
        user_id: '80002',
        message_id: 'message-2',
        message: '[CQ:image,file=unsafe]',
      }),
    )
    await waitFor(() => fake.events.length === 1)
    expect(fake.events[0]?.parts).toEqual([expect.objectContaining({ type: 'rich', kind: 'invalid-message-format' })])
    expect(fake.events[0]?.parts).not.toContainEqual(expect.objectContaining({ type: 'image' }))
    await runtime.stop()
  })

  it('accepts synthetic SnowLuma, NapCat and LLBot notice field variations', async () => {
    const protocol = await protocolEndpoint()
    const fake = createFakeContext()
    const runtime = new OneBot11Runtime({
      context: fake.context,
      config: { endpoint: protocol.endpoint, capturePokeEvents: true, captureMessageReactionEvents: true },
    })
    await runtime.start()
    await waitFor(() => fake.diagnostics.some(({ status }) => status === 'connected'))
    const names = ['snowluma-v1.9.13.notice.json', 'napcat-4.18.19.notice.json', 'llbot-8.1.9.notice.json']
    const socket = [...protocol.server.clients][0]!
    for (const name of names) {
      const content = await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
      socket.send(content)
    }
    await waitFor(() => fake.events.length === 3)
    await runtime.stop()
    expect(fake.events.map(({ activityType }) => activityType).sort()).toEqual([
      'member-card-changed',
      'member-muted',
      'message-reaction-added',
    ])
  })

  it('sends mixed array segments with a leading Reply and Base64 Assets', async () => {
    const protocol = await protocolEndpoint()
    const fake = createFakeContext()
    Object.defineProperty(fake.context.messages, 'resolvePlatformMessageId', {
      value: () => Promise.resolve('quoted-platform-message'),
    })
    const runtime = new OneBot11Runtime({
      context: fake.context,
      config: { endpoint: protocol.endpoint, capturePokeEvents: true, captureMessageReactionEvents: false },
    })
    await runtime.start()
    await waitFor(() => fake.diagnostics.some(({ status }) => status === 'connected'))
    const socket = [...protocol.server.clients][0]!
    socket.send(
      JSON.stringify({
        time: 100,
        post_type: 'message',
        message_type: 'group',
        group_id: 'fixture-group-outbound',
        user_id: 'fixture-member-outbound',
        message_id: 'fixture-message-outbound',
        message: [{ type: 'text', data: { text: '准备回复' } }],
      }),
    )
    await waitFor(() => fake.events.length === 1)
    const channelId = [...fake.channels.values()][0]!
    const memberId = [...fake.members.values()][0]!
    await expect(
      runtime.deliver(
        {
          deliveryId: PhysicalDeliveryIdSchema.parse('phy_TEST1'),
          logicalMessageId: LogicalMessageIdSchema.parse('msg_TEST1'),
          connectionId: fake.context.connectionId,
          channelId,
          replyTo: LogicalMessageIdSchema.parse('msg_QUOTE1'),
          parts: [
            { type: 'text', text: '收到' },
            { type: 'mention', memberId },
            { type: 'image', assetId: AssetIdSchema.parse('ast_IMAGE1') },
            { type: 'audio', assetId: AssetIdSchema.parse('ast_AUDIO1') },
          ],
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ status: 'sent', platformMessageId: 'sent-message-1' })
    const send = protocol.requests.find(({ action }) => action === 'send_group_msg')
    expect(send).toMatchObject({
      params: {
        group_id: 'fixture-group-outbound',
        message: [
          { type: 'reply', data: { id: 'quoted-platform-message' } },
          { type: 'text', data: { text: '收到' } },
          { type: 'at', data: { qq: 'fixture-member-outbound' } },
          { type: 'image', data: { file: 'base64://AQID' } },
          { type: 'record', data: { file: 'base64://AQID' } },
        ],
      },
    })
    await runtime.stop()
  })

  it('suppresses its own processing reaction loop and records lifecycle diagnostics only', async () => {
    const protocol = await protocolEndpoint()
    const fake = createFakeContext()
    const runtime = new OneBot11Runtime({
      context: fake.context,
      config: { endpoint: protocol.endpoint, capturePokeEvents: true, captureMessageReactionEvents: true },
    })
    await runtime.start()
    await waitFor(() => fake.diagnostics.some(({ status }) => status === 'connected'))
    const socket = [...protocol.server.clients][0]!
    socket.send(
      JSON.stringify({
        time: 100,
        post_type: 'message',
        message_type: 'group',
        group_id: 'fixture-group-feedback',
        user_id: 'fixture-member-feedback',
        message_id: 'fixture-message-feedback',
        message: [{ type: 'text', data: { text: '开始处理' } }],
      }),
    )
    await waitFor(() => fake.events.length === 1)
    const channelId = [...fake.channels.values()][0]!
    await expect(
      runtime.interactions.startProcessingFeedback({
        channelId,
        platformMessageId: 'fixture-message-feedback',
      }),
    ).resolves.toEqual({ status: 'succeeded' })
    await expect(
      runtime.interactions.retractOwnMessage({
        channelId,
        platformMessageId: 'fixture-own-message',
        clientRequestId: 'fixture-retract-request',
      }),
    ).resolves.toEqual({ status: 'succeeded' })
    socket.send(
      JSON.stringify({
        time: 101,
        post_type: 'notice',
        notice_type: 'group_msg_emoji_like',
        sub_type: 'add',
        group_id: 'fixture-group-feedback',
        user_id: '91001',
        message_id: 'fixture-message-feedback',
        emoji_id: '212',
      }),
    )
    socket.send(JSON.stringify({ time: 102, post_type: 'meta_event', meta_event_type: 'heartbeat' }))
    socket.send(
      JSON.stringify({
        time: 103,
        post_type: 'notice',
        notice_type: 'group_recall',
        group_id: 'fixture-group-feedback',
        user_id: '91001',
        operator_id: '91001',
        message_id: 'fixture-own-message',
      }),
    )
    socket.send(JSON.stringify({ time: 104, post_type: 'notice', notice_type: 'bot_offline' }))
    await waitFor(() => fake.diagnostics.some(({ details }) => details?.['platformStatus'] === 'offline'))
    expect(fake.events).toHaveLength(1)
    expect(protocol.requests).toContainEqual(
      expect.objectContaining({
        action: 'set_msg_emoji_like',
        params: { message_id: 'fixture-message-feedback', emoji_id: '212', set: true },
      }),
    )
    await runtime.stop()
  })
})
