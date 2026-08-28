import { WebSocketServer, type RawData } from 'ws'
import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { AssetIdSchema, ChannelIdSchema, LogicalMessageIdSchema, PhysicalDeliveryIdSchema } from '@nekro-nxt/contracts'
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

const protocolEndpoint = async (
  respond?: (request: Record<string, unknown>) => Record<string, unknown> | undefined,
) => {
  const server = new WebSocketServer({ port: 0 })
  const requests: Record<string, unknown>[] = []
  servers.push(server)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const request = decodeRequest(raw)
      requests.push(request)
      const override = respond?.(request)
      if (override) {
        socket.send(JSON.stringify({ ...override, echo: request['echo'] }))
        return
      }
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
      runtime.interactions.startProcessingFeedback!({
        leaseId: 'lease-feedback',
        channelId,
        platformMessageId: 'fixture-message-feedback',
      }),
    ).resolves.toEqual({ status: 'succeeded' })
    await expect(
      runtime.interactions.retractOwnMessage!({
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

  it('maps rich message segments, downloadable media, replies and safe fallbacks', async () => {
    const protocol = await protocolEndpoint((request) =>
      request['action'] === 'get_forward_msg'
        ? {
            status: 'ok',
            retcode: 0,
            data: {
              messages: [
                {
                  content: [
                    { type: 'text', data: { text: '转发正文' } },
                    { type: 'forward', data: { id: 'nested-forward' } },
                  ],
                },
              ],
            },
          }
        : undefined,
    )
    const fake = createFakeContext()
    Object.defineProperty(fake.context.messages, 'resolvePlatformMessage', {
      value: (_channelId: unknown, platformMessageId: string) =>
        Promise.resolve(
          platformMessageId === 'resolved-reply'
            ? { logicalMessageId: LogicalMessageIdSchema.parse('msg_RESOLVED'), authoredByAgent: false }
            : undefined,
        ),
    })
    const fetched: { readonly url: string; readonly allowHttp: boolean | undefined }[] = []
    Object.defineProperty(fake.context.assets, 'fetchRemoteBytes', {
      value: ({ url, allowHttp }: { readonly url: string; readonly allowHttp?: boolean }) => {
        fetched.push({ url, allowHttp })
        if (url.endsWith('/failed')) return Promise.reject(new Error('fixture download failure'))
        return Promise.resolve({ bytes: new Uint8Array([4, 5, 6]), declaredMediaType: 'image/png' })
      },
    })
    const runtime = new OneBot11Runtime({
      context: fake.context,
      config: { endpoint: protocol.endpoint, capturePokeEvents: true, captureMessageReactionEvents: true },
    })
    await runtime.start()
    await waitFor(
      () => runtime['capabilities'] !== undefined && fake.diagnostics.some(({ status }) => status === 'connected'),
    )
    const socket = [...protocol.server.clients][0]!
    socket.send(
      JSON.stringify({
        time: '123',
        post_type: 'message',
        message_type: 'group',
        group_id: 70002,
        group_name: '测试频道',
        sender: { user_id: 80002, card: '成员乙', nickname: '备用昵称' },
        message_id: 20002,
        message: [
          null,
          { type: 'text', data: { text: '' } },
          { type: 'at', data: { qq: 'all' } },
          { type: 'at', data: { qq: 80003 } },
          { type: 'reply', data: { id: 'resolved-reply' } },
          { type: 'reply', data: { id: 'missing-reply' } },
          { type: 'image', data: {} },
          { type: 'record', data: {} },
          { type: 'image', data: { url: 'http://media.example.test/image' } },
          { type: 'record', data: { url: 'https://media.example.test/failed' } },
          { type: 'forward', data: {} },
          { type: 'forward', data: { id: 'root-forward' } },
          { type: 'json', data: { data: '{"prompt":"卡片标题"}' } },
          { type: 'xml', data: { data: '<unsafe>' } },
          { type: 'file', data: { name: '资料.txt' } },
          { type: 'custom_fixture', data: {} },
        ],
      }),
    )
    socket.send(
      JSON.stringify({
        time: -1,
        post_type: 'message',
        message_type: 'private',
        group_id: 'source-group',
        user_id: 'private-user',
        message_id: 'empty-message',
        message: [{ nope: true }],
      }),
    )
    await waitFor(() => fake.events.length === 2)
    expect(fetched).toEqual([
      { url: 'http://media.example.test/image', allowHttp: true },
      { url: 'https://media.example.test/failed', allowHttp: true },
    ])
    expect(fake.events[0]).toMatchObject({
      platformMessageId: '20002',
      platformTimestamp: 123_000,
      assetOccurrences: [{ partIndex: 6, assetId: 'ast_TEST1' }],
    })
    expect(fake.events[0]!.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'rich', kind: 'mention-all' }),
        expect.objectContaining({ type: 'mention' }),
        { type: 'quote', messageId: 'msg_RESOLVED' },
        expect.objectContaining({ type: 'rich', kind: 'unresolved-reply' }),
        expect.objectContaining({ type: 'image', assetId: 'ast_TEST1' }),
        expect.objectContaining({ type: 'rich', kind: 'record', summary: '语音下载失败。' }),
        expect.objectContaining({ type: 'rich', kind: 'forward' }),
        expect.objectContaining({ type: 'rich', kind: 'json', summary: 'JSON 卡片：卡片标题' }),
        expect.objectContaining({ type: 'rich', kind: 'file', summary: '文件：资料.txt' }),
        expect.objectContaining({ type: 'rich', kind: 'segment-custom_fixture' }),
      ]),
    )
    expect(fake.events[1]!.parts).toEqual([expect.objectContaining({ type: 'rich', kind: 'empty-message' })])
    expect(fake.states.size).toBeGreaterThan(1)
    await runtime.stop()
  })

  it('normalizes the supported notice families and downloads uploaded group files', async () => {
    const protocol = await protocolEndpoint((request) => {
      if (request['action'] === 'get_group_file_url') {
        return { status: 'ok', retcode: 0, data: { url: 'https://files.example.test/group-file' } }
      }
      if (request['action'] === 'get_group_member_info') {
        const params = RequestSchema.parse(request['params'])
        return {
          status: 'ok',
          retcode: 0,
          data: { user_id: params['user_id'], nickname: `昵称${String(params['user_id'])}`, card: '' },
        }
      }
      if (request['action'] === 'get_stranger_info') {
        const params = RequestSchema.parse(request['params'])
        return {
          status: 'ok',
          retcode: 0,
          data: { user_id: params['user_id'], nickname: `昵称${String(params['user_id'])}` },
        }
      }
      return undefined
    })
    const fake = createFakeContext()
    const renamed: string[] = []
    Object.defineProperty(fake.context.channels, 'updateDisplayName', {
      value: (_channelId: unknown, name: string) => {
        renamed.push(name)
        return Promise.resolve()
      },
    })
    Object.defineProperty(fake.context.assets, 'fetchRemoteBytes', {
      value: () => Promise.resolve({ bytes: new Uint8Array([7, 8]), declaredMediaType: 'application/octet-stream' }),
    })
    const runtime = new OneBot11Runtime({
      context: fake.context,
      config: { endpoint: protocol.endpoint, capturePokeEvents: true, captureMessageReactionEvents: true },
    })
    await runtime.start()
    await waitFor(() => fake.diagnostics.some(({ status }) => status === 'connected'))
    const socket = [...protocol.server.clients][0]!
    const notices = [
      { notice_type: 'friend_recall', user_id: 'friend-1', message_id: 'recall-1' },
      { notice_type: 'profile_like', operator_id: 'friend-1', operator_nick: '成员甲', times: 2 },
      {
        notice_type: 'group_increase',
        sub_type: 'invite',
        group_id: 'group-events',
        user_id: 'member-1',
        operator_id: 'inviter-1',
      },
      {
        notice_type: 'group_decrease',
        sub_type: 'kick',
        group_id: 'group-events',
        user_id: 'member-2',
        operator_id: 'admin-1',
      },
      {
        notice_type: 'group_ban',
        sub_type: 'ban',
        group_id: 'group-events',
        user_id: 'member-3',
        operator_id: 'admin-1',
        duration: '30',
      },
      {
        notice_type: 'group_ban',
        sub_type: 'lift_ban',
        group_id: 'group-events',
        user_id: 'member-3',
        operator_id: 'admin-1',
        duration: 0,
      },
      { notice_type: 'group_admin', sub_type: 'set', group_id: 'group-events', user_id: 'member-4' },
      { notice_type: 'group_admin', sub_type: 'unset', group_id: 'group-events', user_id: 'member-4' },
      {
        notice_type: 'group_card',
        group_id: 'group-events',
        user_id: 'member-4',
        card_old: '旧名片',
        card_new: '新名片',
      },
      { notice_type: 'notify', sub_type: 'title', group_id: 'group-events', user_id: 'member-5', title: '活跃成员' },
      {
        notice_type: 'notify',
        sub_type: 'group_name',
        group_id: 'group-events',
        user_id: 'admin-1',
        name_new: '新频道名',
      },
      {
        notice_type: 'group_upload',
        group_id: 'group-events',
        user_id: 'member-6',
        file: { id: 'file-1', busid: 2, name: '附件.bin', size: 1536 },
      },
      {
        notice_type: 'essence',
        sub_type: 'add',
        group_id: 'group-events',
        user_id: 'member-6',
        operator_id: 'admin-1',
        message_id: 'essence-1',
      },
      {
        notice_type: 'essence',
        sub_type: 'remove',
        group_id: 'group-events',
        user_id: 'member-6',
        operator_id: 'admin-1',
        message_id: 'essence-2',
      },
      { notice_type: 'friend_add', user_id: 'friend-2' },
    ]
    for (const [index, notice] of notices.entries()) {
      socket.send(JSON.stringify({ time: 200 + index, post_type: 'notice', ...notice }))
    }
    socket.send(JSON.stringify({ post_type: 'notice', notice_type: 'unknown_fixture', group_id: 'ignored' }))
    socket.send(JSON.stringify({ post_type: 'notice', notice_type: 'friend_add' }))
    await waitFor(() => fake.events.length === notices.length)
    expect(fake.events.map(({ activityType }) => activityType)).toEqual(
      expect.arrayContaining([
        'message-recalled',
        'profile-liked',
        'member-joined',
        'member-left',
        'member-muted',
        'member-unmuted',
        'member-admin-set',
        'member-admin-unset',
        'member-card-changed',
        'member-title-changed',
        'channel-name-changed',
        'file-uploaded',
        'essence-added',
        'essence-removed',
        'friend-added',
      ]),
    )
    expect(renamed).toEqual(['新频道名'])
    const joinedEvent = fake.events.find(({ activityType }) => activityType === 'member-joined')
    expect(joinedEvent).toMatchObject({
      facts: {
        subType: 'invite',
      },
      parts: [
        { type: 'mention' },
        { type: 'text', text: ' 受 ' },
        { type: 'mention' },
        { type: 'text', text: ' 邀请加入了频道。' },
      ],
    })
    const joinedSubjectMemberId = joinedEvent?.facts?.['subjectMemberId']
    const joinedOperatorMemberId = joinedEvent?.facts?.['operatorMemberId']
    expect(typeof joinedSubjectMemberId).toBe('string')
    expect(typeof joinedOperatorMemberId).toBe('string')
    if (typeof joinedSubjectMemberId === 'string') expect(joinedSubjectMemberId).toMatch(/^mbr_/u)
    if (typeof joinedOperatorMemberId === 'string') expect(joinedOperatorMemberId).toMatch(/^mbr_/u)
    expect(fake.events.find(({ activityType }) => activityType === 'member-left')?.parts).toEqual([
      expect.objectContaining({ type: 'mention' }),
      { type: 'text', text: ' 将 ' },
      expect.objectContaining({ type: 'mention' }),
      { type: 'text', text: ' 移出了频道。' },
    ])
    expect(fake.events.find(({ activityType }) => activityType === 'member-card-changed')?.parts).toEqual([
      expect.objectContaining({ type: 'mention' }),
      { type: 'text', text: ' 将群名片从「旧名片」改为「新名片」。' },
    ])
    expect(fake.events.find(({ activityType }) => activityType === 'channel-name-changed')?.parts).toEqual([
      expect.objectContaining({ type: 'mention' }),
      { type: 'text', text: ' 将频道名称改为「新频道名」。' },
    ])
    expect(fake.events.find(({ activityType }) => activityType === 'file-uploaded')).toMatchObject({
      facts: { fileSize: 1536 },
      parts: [
        { type: 'mention' },
        { type: 'text', text: ' 上传了文件：' },
        { type: 'file', assetId: 'ast_TEST1', name: '附件.bin' },
      ],
      assetOccurrences: [{ partIndex: 2, assetId: 'ast_TEST1' }],
    })
    expect(protocol.requests.some(({ action }) => action === 'get_group_member_info')).toBe(true)
    await runtime.stop()
  })

  it('returns stable failures for invalid outbound targets, unsupported parts and interaction errors', async () => {
    const protocol = await protocolEndpoint((request) => {
      const action = request['action']
      if (action === 'set_msg_emoji_like') return { status: 'failed', retcode: 1404, message: 'unsupported' }
      if (action === 'send_poke') return { status: 'failed', retcode: 1408, message: 'rate limited' }
      if (action === 'delete_msg') return { status: 'failed', retcode: 1, wording: 'temporary failure' }
      return undefined
    })
    const fake = createFakeContext()
    const runtime = new OneBot11Runtime({
      context: fake.context,
      config: {
        endpoint: protocol.endpoint,
        accessTokenCredentialRef: 'credential:onebot',
        capturePokeEvents: true,
        captureMessageReactionEvents: true,
      },
    })
    await runtime.start()
    await expect(runtime.start()).rejects.toThrow('already started')
    await waitFor(() => fake.diagnostics.some(({ status }) => status === 'connected'))
    const missingChannelId = ChannelIdSchema.parse('chn_MISSING')
    const request = {
      deliveryId: PhysicalDeliveryIdSchema.parse('phy_FAILURE'),
      logicalMessageId: LogicalMessageIdSchema.parse('msg_FAILURE'),
      connectionId: fake.context.connectionId,
      channelId: missingChannelId,
      parts: [{ type: 'text' as const, text: '测试' }],
    }
    const aborted = new AbortController()
    aborted.abort()
    await expect(runtime.deliver(request, aborted.signal)).resolves.toMatchObject({ status: 'failed' })
    await expect(runtime.deliver(request, new AbortController().signal)).resolves.toMatchObject({
      status: 'failed',
      failure: { kind: 'invalid' },
    })
    await expect(runtime.testSend(missingChannelId)).rejects.toMatchObject({ kind: 'invalid', submitted: false })
    await expect(
      runtime.interactions.startProcessingFeedback!({
        leaseId: 'lease-missing',
        channelId: missingChannelId,
        platformMessageId: 'missing',
      }),
    ).resolves.toMatchObject({ status: 'unsupported' })

    const socket = [...protocol.server.clients][0]!
    socket.send(
      JSON.stringify({
        post_type: 'message',
        message_type: 'group',
        group_id: 'failure-group',
        user_id: 'failure-member',
        message_id: 'failure-anchor',
        message: [{ type: 'text', data: { text: '锚点' } }],
      }),
    )
    await waitFor(() => fake.events.length === 1)
    const channelId = [...fake.channels.values()][0]!
    const memberId = [...fake.members.values()][0]!
    await expect(
      runtime.interactions.startProcessingFeedback!({
        leaseId: 'lease-failure',
        channelId,
        platformMessageId: 'failure-anchor',
      }),
    ).resolves.toMatchObject({ status: 'unsupported' })
    await expect(
      runtime.interactions.finishProcessingFeedback!({
        leaseId: 'lease-failure',
        channelId,
        platformMessageId: 'failure-anchor',
        reason: 'error',
      }),
    ).resolves.toMatchObject({ status: 'unsupported' })
    await expect(
      runtime.interactions.retractOwnMessage!({
        channelId,
        platformMessageId: 'own-message',
        clientRequestId: 'retract-failure',
      }),
    ).resolves.toMatchObject({ status: 'failed' })
    await expect(
      runtime.interactions.nudgeMember!({ channelId, memberId, clientRequestId: 'nudge-failure' }),
    ).resolves.toMatchObject({ status: 'failed' })

    Object.defineProperty(fake.context.members, 'resolvePlatformUserId', { value: () => Promise.resolve(undefined) })
    await expect(
      runtime.interactions.nudgeMember!({ channelId, memberId, clientRequestId: 'nudge-missing-member' }),
    ).resolves.toMatchObject({ status: 'failed' })

    Object.defineProperty(fake.context.assets, 'read', {
      value: () => Promise.resolve({ bytes: new Uint8Array(), mediaType: 'image/png', byteSize: 21 * 1024 * 1024 }),
    })
    await expect(
      runtime.deliver(
        { ...request, channelId, parts: [{ type: 'image', assetId: AssetIdSchema.parse('ast_TOOLARGE') }] },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ status: 'failed', failure: { kind: 'invalid' } })
    await expect(
      runtime.deliver(
        {
          ...request,
          channelId,
          parts: [{ type: 'rich', adapterKey: 'fixture', kind: 'card', summary: '卡片' }],
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ status: 'failed', failure: { kind: 'invalid' } })
    await runtime.stop()
    await runtime.stop()
    await expect(
      runtime.interactions.retractOwnMessage!({
        channelId,
        platformMessageId: 'after-stop',
        clientRequestId: 'retract-after-stop',
      }),
    ).resolves.toMatchObject({ status: 'failed' })
  })
})
