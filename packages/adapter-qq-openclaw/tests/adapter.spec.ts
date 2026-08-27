import {
  parseAdapterConnectionConfiguration,
  type AdapterConnectionContext,
  type AdapterInboundEvent,
} from '@nekro-nxt/adapter-sdk'
import {
  AssetIdSchema,
  ChannelEventIdSchema,
  ChannelIdSchema,
  ChannelMemberIdSchema,
  ConnectionIdSchema,
  LogicalMessageIdSchema,
  PhysicalDeliveryIdSchema,
} from '@nekro-nxt/contracts'
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  QQ_OPENCLAW_CONNECTION_DEFINITION,
  QQ_OPENCLAW_CONNECTION_DESCRIPTOR,
  QQOpenClawConnection,
  splitQQMarkdownAtoms,
  type QQAssetSource,
  type QQIdentityDirectory,
  type QQInboundBridge,
  type QQOpenClawTransport,
} from '../src/index.ts'
import type { QQOpenClawConnectionConfigurationSchema, QQOpenClawCredentialsSchema } from '../src/index.ts'

const connectionId = ConnectionIdSchema.parse('con_qq')
const channelId = ChannelIdSchema.parse('chn_qq')
const memberId = ChannelMemberIdSchema.parse('mbr_qq')

const context: AdapterConnectionContext = {
  connectionId,
  now: () => 100,
  acceptInbound: () => Promise.reject(new Error('not used')),
}

describe('QQ OpenClaw Adapter', () => {
  it('derives QQ configuration, credentials, UI fields, and creator inputs from the same definition', () => {
    const parsed = parseAdapterConnectionConfiguration(QQ_OPENCLAW_CONNECTION_DEFINITION, {
      configuration: { appId: ' app-id ', proactiveSend: true },
      credentials: { clientSecretCredentialRef: 'client-secret' },
    })
    expect(parsed).toEqual({
      configuration: {
        appId: 'app-id',
        proactiveSend: true,
        markdown: true,
        maxTextLength: 1800,
        maxTextBytes: 7200,
      },
      credentials: { clientSecretCredentialRef: 'client-secret' },
    })
    expect(QQ_OPENCLAW_CONNECTION_DESCRIPTOR.configSchema).toEqual({
      schemaVersion: 1,
      type: 'object',
      required: ['appId', 'clientSecretCredentialRef'],
      properties: {
        appId: { type: 'string', title: 'App ID' },
        clientSecretCredentialRef: {
          type: 'credential-reference',
          credentialKey: 'clientSecret',
          title: 'Client Secret',
        },
        proactiveSend: { type: 'boolean', title: '允许主动发送', default: false },
        markdown: { type: 'boolean', title: '使用 Markdown', default: true },
        maxTextLength: { type: 'number', title: '单条字符上限', default: 1800 },
        maxTextBytes: { type: 'number', title: '单条 UTF-8 字节上限', default: 7200 },
      },
    })
    expectTypeOf(parsed.configuration).toEqualTypeOf<ReturnType<typeof QQOpenClawConnectionConfigurationSchema.parse>>()
    expectTypeOf(parsed.credentials).toEqualTypeOf<ReturnType<typeof QQOpenClawCredentialsSchema.parse>>()
    expect(QQ_OPENCLAW_CONNECTION_DEFINITION.create(parsed.configuration, parsed.credentials)).toEqual({
      appId: 'app-id',
      proactiveSend: true,
      markdown: true,
      maxTextLength: 1800,
      maxTextBytes: 7200,
      clientSecret: 'client-secret',
    })
  })

  it('keeps QQ Mention atomic and treats legacy AT markup as ordinary text', () => {
    const chunks = splitQQMarkdownAtoms(
      [
        { kind: 'text', value: '前文🙂[@id:legacy@]' },
        { kind: 'mention', value: '<@OPENID-123456>' },
        { kind: 'text', value: '后文🙂🙂🙂🙂🙂🙂' },
      ],
      24,
    )
    expect(chunks.join('')).toContain('[@id:legacy@]')
    expect(chunks.filter((chunk) => chunk.includes('<@OPENID-123456>'))).toHaveLength(1)
    expect(chunks.some((chunk) => chunk.includes('<@OPENID-123456') && !chunk.includes('>'))).toBe(false)
    const url = 'https://example.test/path?q=qq-openclaw'
    const urlChunks = splitQQMarkdownAtoms(
      [
        { kind: 'text', value: '前文前文前文' },
        { kind: 'text', value: url },
        { kind: 'text', value: '后文后文后文' },
      ],
      48,
    )
    expect(urlChunks.filter((chunk) => chunk.includes(url))).toHaveLength(1)
  })

  it('plans Markdown with <@openid>, consumes passive quota and sends media only after upload', async () => {
    const sent: unknown[] = []
    const directory: QQIdentityDirectory = {
      resolveTarget: (connection, channel) =>
        Promise.resolve(
          connection === connectionId && channel === channelId ? { kind: 'group', openId: 'group-1' } : undefined,
        ),
      resolveMemberOpenId: (connection, channel, member) =>
        Promise.resolve(
          connection === connectionId && channel === channelId && member === memberId ? 'member-openid' : undefined,
        ),
      resolvePlatformMessageId: () => Promise.resolve(undefined),
    }
    const assets: QQAssetSource = {
      read: () => Promise.resolve({ bytes: new Uint8Array([1, 2, 3]), mediaType: 'video/mp4' }),
    }
    const transport: QQOpenClawTransport = {
      start: () => Promise.resolve(),
      stop: () => Promise.resolve(),
      sendText: (input) => {
        sent.push(input)
        return Promise.resolve({ platformMessageId: 'qq-text-1' })
      },
      upload: (input) => {
        sent.push({ upload: input.mediaType, fileName: input.fileName })
        return Promise.resolve({ fileInfo: 'file-info' })
      },
      sendMedia: (input) => {
        sent.push(input)
        return Promise.resolve({ platformMessageId: 'qq-media-1' })
      },
    }
    const adapter = new QQOpenClawConnection(
      context,
      {
        appId: 'app',
        clientSecretCredentialRef: 'credential:qq',
        proactiveSend: false,
        markdown: true,
        maxTextLength: 40,
        maxAssetBytes: 1024,
        passiveReplyTtlMs: 1000,
        passiveReplyLimit: 2,
      },
      { directory, assets, transport },
    )
    await adapter.start()
    adapter.observeReplyContext('inbound-1', { remainingReplies: 2, expiresAt: 1000 })
    const planned = await adapter.planOutbound({
      connectionId,
      channelId,
      parts: [
        { type: 'text', text: '你好 ' },
        { type: 'mention', memberId },
        { type: 'text', text: ' 请查看' },
        { type: 'file', assetId: AssetIdSchema.parse('ast_video'), name: 'clip.mp4' },
      ],
    })
    expect(planned).toEqual([
      { parts: [{ type: 'text', text: '你好 <@member-openid> 请查看' }] },
      { parts: [{ type: 'file', assetId: 'ast_video', name: 'clip.mp4' }] },
    ])
    const request = (plan: (typeof planned)[number], sequence: number) => ({
      deliveryId: PhysicalDeliveryIdSchema.parse(`phy_${sequence}`),
      logicalMessageId: LogicalMessageIdSchema.parse('msg_1'),
      connectionId,
      channelId,
      parts: plan.parts,
      ...(plan.adapterContext === undefined ? {} : { adapterContext: plan.adapterContext }),
      replyTo: 'inbound-1',
    })
    await expect(adapter.deliver(request(planned[0]!, 1), new AbortController().signal)).resolves.toMatchObject({
      status: 'sent',
      platformMessageId: 'qq-text-1',
    })
    await expect(adapter.deliver(request(planned[1]!, 2), new AbortController().signal)).resolves.toMatchObject({
      status: 'sent',
      platformMessageId: 'qq-media-1',
    })
    expect(sent).toEqual([
      expect.objectContaining({
        content: '你好 <@member-openid> 请查看',
        replyMessageId: 'inbound-1',
        messageSequence: 1,
      }),
      { upload: 'video/mp4', fileName: 'clip.mp4' },
      expect.objectContaining({ fileInfo: 'file-info', replyMessageId: 'inbound-1', messageSequence: 2 }),
    ])
    await expect(adapter.deliver(request(planned[0]!, 3), new AbortController().signal)).resolves.toMatchObject({
      status: 'failed',
      failure: { kind: 'permanent' },
    })
    await adapter.stop()
  })

  it('rejects a member from another Connection before creating Outbox deliveries', async () => {
    const adapter = new QQOpenClawConnection(
      context,
      {
        appId: 'app',
        clientSecretCredentialRef: 'credential:qq',
        proactiveSend: true,
        markdown: true,
        maxTextLength: 100,
        maxAssetBytes: 1024,
        passiveReplyTtlMs: 1000,
        passiveReplyLimit: 1,
      },
      {
        directory: {
          resolveTarget: () => Promise.resolve({ kind: 'group', openId: 'group-1' }),
          resolveMemberOpenId: () => Promise.resolve(undefined),
          resolvePlatformMessageId: () => Promise.resolve(undefined),
        },
        assets: { read: () => Promise.reject(new Error('not used')) },
        transport: {
          start: () => Promise.resolve(),
          stop: () => Promise.resolve(),
          sendText: () => Promise.reject(new Error('must not send')),
          upload: () => Promise.reject(new Error('must not upload')),
          sendMedia: () => Promise.reject(new Error('must not send')),
        },
      },
    )
    await expect(
      adapter.planOutbound({ connectionId, channelId, parts: [{ type: 'mention', memberId }] }),
    ).rejects.toThrow('unknown in this Connection')
  })

  it('maps normalized Quote IDs to a private PhysicalDelivery context before commit', async () => {
    const sent: unknown[] = []
    const adapter = new QQOpenClawConnection(
      context,
      {
        appId: 'app',
        clientSecretCredentialRef: 'credential:qq',
        proactiveSend: true,
        markdown: true,
        maxTextLength: 100,
        maxAssetBytes: 1024,
        passiveReplyTtlMs: 1000,
        passiveReplyLimit: 1,
      },
      {
        directory: {
          resolveTarget: () => Promise.resolve({ kind: 'group', openId: 'group-1' }),
          resolveMemberOpenId: () => Promise.resolve(undefined),
          resolvePlatformMessageId: (_connection, _channel, logicalMessageId) =>
            Promise.resolve(
              logicalMessageId === LogicalMessageIdSchema.parse('msg_inbound') ? 'qq-inbound' : undefined,
            ),
        },
        assets: { read: () => Promise.reject(new Error('not used')) },
        transport: {
          start: () => Promise.resolve(),
          stop: () => Promise.resolve(),
          sendText: (input) => {
            sent.push(input)
            return Promise.resolve({ platformMessageId: 'qq-reply' })
          },
          upload: () => Promise.reject(new Error('not used')),
          sendMedia: () => Promise.reject(new Error('not used')),
        },
      },
    )
    await adapter.start()
    adapter.observeReplyContext('qq-inbound', { expiresAt: 1000, remainingReplies: 1 })
    const [plan] = await adapter.planOutbound({
      connectionId,
      channelId,
      parts: [
        { type: 'quote', messageId: LogicalMessageIdSchema.parse('msg_inbound') },
        { type: 'text', text: '引用回复' },
      ],
    })
    expect(plan).toEqual({
      parts: [{ type: 'text', text: '引用回复' }],
      adapterContext: { replyPlatformMessageId: 'qq-inbound', replyMode: 'passive' },
    })
    await expect(
      adapter.deliver(
        {
          deliveryId: PhysicalDeliveryIdSchema.parse('phy_quote'),
          logicalMessageId: LogicalMessageIdSchema.parse('msg_outbound'),
          connectionId,
          channelId,
          parts: plan!.parts,
          ...(plan!.adapterContext === undefined ? {} : { adapterContext: plan!.adapterContext }),
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ status: 'sent' })
    expect(sent).toEqual([expect.objectContaining({ replyMessageId: 'qq-inbound', messageSequence: 1 })])
    const proactivePlans = await adapter.planOutbound({
      connectionId,
      channelId,
      parts: [
        { type: 'quote', messageId: LogicalMessageIdSchema.parse('msg_inbound') },
        { type: 'text', text: '额度不足时整组主动发送' },
        { type: 'file', assetId: AssetIdSchema.parse('ast_proactive') },
      ],
    })
    expect(proactivePlans).toHaveLength(2)
    expect(
      proactivePlans.every(
        ({ adapterContext }) =>
          typeof adapterContext === 'object' &&
          adapterContext !== null &&
          !Array.isArray(adapterContext) &&
          adapterContext['replyMode'] === 'proactive',
      ),
    ).toBe(true)
    await adapter.stop()
  })

  it('consumes passive reply quota only after success and never reuses a reserved msg_seq', async () => {
    const sequences: number[] = []
    let attempts = 0
    const adapter = new QQOpenClawConnection(
      context,
      {
        appId: 'app',
        clientSecretCredentialRef: 'credential:qq',
        proactiveSend: false,
        markdown: true,
        maxTextLength: 100,
        maxAssetBytes: 1024,
        passiveReplyTtlMs: 1000,
        passiveReplyLimit: 1,
      },
      {
        directory: {
          resolveTarget: () => Promise.resolve({ kind: 'group', openId: 'group-1' }),
          resolveMemberOpenId: () => Promise.resolve(undefined),
          resolvePlatformMessageId: () => Promise.resolve(undefined),
        },
        assets: { read: () => Promise.reject(new Error('not used')) },
        transport: {
          start: () => Promise.resolve(),
          stop: () => Promise.resolve(),
          sendText: ({ messageSequence }) => {
            sequences.push(messageSequence ?? -1)
            attempts += 1
            return attempts === 1
              ? Promise.reject(new Error('failed before confirmation'))
              : Promise.resolve({ platformMessageId: 'sent-after-retry' })
          },
          upload: () => Promise.reject(new Error('not used')),
          sendMedia: () => Promise.reject(new Error('not used')),
        },
      },
    )
    await adapter.start()
    adapter.observeReplyContext('inbound-budget', { expiresAt: 1000, remainingReplies: 1 })
    const request = {
      deliveryId: PhysicalDeliveryIdSchema.parse('phy_budget'),
      logicalMessageId: LogicalMessageIdSchema.parse('msg_budget'),
      connectionId,
      channelId,
      parts: [{ type: 'text' as const, text: '测试' }],
      replyTo: 'inbound-budget',
    }
    await expect(adapter.deliver(request, new AbortController().signal)).resolves.toMatchObject({
      status: 'failed',
      failure: { kind: 'transient' },
    })
    adapter.observeReplyContext('inbound-budget', { expiresAt: 1000, remainingReplies: 1 })
    await expect(adapter.deliver(request, new AbortController().signal)).resolves.toMatchObject({
      status: 'sent',
    })
    await expect(adapter.deliver(request, new AbortController().signal)).resolves.toMatchObject({
      status: 'failed',
      failure: { kind: 'permanent' },
    })
    expect(sequences).toEqual([1, 2])
    await adapter.stop()
  })

  it('commits structured group inbound content, real Mention identity, ordinary video files and quote facts', async () => {
    const accepted: AdapterInboundEvent[] = []
    const inboundContext: AdapterConnectionContext = {
      connectionId,
      now: () => 500,
      acceptInbound: (event) => {
        accepted.push(event)
        return Promise.resolve({
          channelEventId: ChannelEventIdSchema.parse('evt_1'),
          inserted: true,
        })
      },
    }
    const bridge: QQInboundBridge = {
      ensureTarget: () => Promise.resolve(channelId),
      ensureMember: ({ openId }) => Promise.resolve(ChannelMemberIdSchema.parse(`mbr_${openId.replaceAll('-', '')}`)),
      importAttachment: ({ fileName, mediaType }) =>
        Promise.resolve({
          assetId: AssetIdSchema.parse(`ast_${(fileName ?? 'unknown').replaceAll('.', '')}`),
          mediaType: mediaType ?? 'application/octet-stream',
          ...(fileName === undefined ? {} : { fileName }),
        }),
      resolveQuote: () =>
        Promise.resolve({ messageId: LogicalMessageIdSchema.parse('msg_quoted'), authoredByAgent: true }),
    }
    const adapter = new QQOpenClawConnection(
      inboundContext,
      {
        appId: 'bot-openid',
        clientSecretCredentialRef: 'credential:qq',
        proactiveSend: false,
        markdown: true,
        maxTextLength: 100,
        maxAssetBytes: 1024,
        passiveReplyTtlMs: 1000,
        passiveReplyLimit: 2,
      },
      {
        directory: {
          resolveTarget: () => Promise.resolve(undefined),
          resolveMemberOpenId: () => Promise.resolve(undefined),
          resolvePlatformMessageId: () => Promise.resolve(undefined),
        },
        assets: { read: () => Promise.reject(new Error('not used')) },
        transport: {
          start: () => Promise.resolve(),
          stop: () => Promise.resolve(),
          sendText: () => Promise.reject(new Error('not used')),
          upload: () => Promise.reject(new Error('not used')),
          sendMedia: () => Promise.reject(new Error('not used')),
        },
        inbound: bridge,
      },
    )
    await adapter.start()
    await expect(
      adapter.receive({
        eventType: 'GROUP_AT_MESSAGE_CREATE',
        platformMessageId: 'qq-inbound-1',
        target: { kind: 'group', openId: 'group-openid' },
        senderOpenId: 'sender-openid',
        content: '<@bot-openid> 请和 @成员乙 一起看',
        mentions: [
          { openId: 'bot-openid', bot: true },
          { openId: 'other-openid', displayName: '成员乙' },
        ],
        attachments: [
          { url: 'https://cdn.test/image.png', fileName: 'image.png', mediaType: 'image/png' },
          { url: 'https://cdn.test/movie.mp4', fileName: 'movie.mp4', mediaType: 'video/mp4' },
        ],
        platformReference: 'ref-1',
        platformSequence: 8,
        platformTimestamp: 400,
      }),
    ).resolves.toMatchObject({ inserted: true })
    expect(accepted).toEqual([
      expect.objectContaining({
        channelId,
        platformEventId: 'GROUP_AT_MESSAGE_CREATE:qq-inbound-1',
        platformMessageId: 'qq-inbound-1',
        senderMemberId: 'mbr_senderopenid',
        parts: [
          { type: 'mention', memberId: 'mbr_botopenid' },
          { type: 'text', text: ' 请和 ' },
          { type: 'mention', memberId: 'mbr_otheropenid' },
          { type: 'text', text: ' 一起看' },
          { type: 'image', assetId: 'ast_imagepng', alt: 'image.png' },
          { type: 'file', assetId: 'ast_moviemp4', name: 'movie.mp4' },
          { type: 'quote', messageId: 'msg_quoted' },
        ],
        dedupeKey: 'qq-openclaw:GROUP_AT_MESSAGE_CREATE:qq-inbound-1',
        facts: { mentionedBot: true, replyToBot: true, targetKind: 'group' },
        assetOccurrences: [
          { partIndex: 4, assetId: 'ast_imagepng' },
          { partIndex: 5, assetId: 'ast_moviemp4' },
        ],
      }),
    ])
    await adapter.stop()
  })

  it('collects ordinary group messages without forcing an intelligent-agent trigger', async () => {
    const accepted: AdapterInboundEvent[] = []
    const adapter = new QQOpenClawConnection(
      {
        connectionId,
        now: () => 100,
        acceptInbound: (event) => {
          accepted.push(event)
          return Promise.resolve({
            channelEventId: ChannelEventIdSchema.parse('evt_ordinary'),
            inserted: accepted.length === 1,
          })
        },
      },
      {
        appId: 'bot-openid',
        clientSecretCredentialRef: 'credential:qq',
        proactiveSend: false,
        markdown: true,
        maxTextLength: 100,
        maxAssetBytes: 1024,
        passiveReplyTtlMs: 1000,
        passiveReplyLimit: 1,
      },
      {
        directory: {
          resolveTarget: () => Promise.resolve(undefined),
          resolveMemberOpenId: () => Promise.resolve(undefined),
          resolvePlatformMessageId: () => Promise.resolve(undefined),
        },
        assets: { read: () => Promise.reject(new Error('not used')) },
        transport: {
          start: () => Promise.resolve(),
          stop: () => Promise.resolve(),
          sendText: () => Promise.reject(new Error('not used')),
          upload: () => Promise.reject(new Error('not used')),
          sendMedia: () => Promise.reject(new Error('not used')),
        },
        inbound: {
          ensureTarget: () => Promise.resolve(channelId),
          ensureMember: () => Promise.resolve(memberId),
          importAttachment: () => Promise.reject(new Error('not used')),
          resolveQuote: () => Promise.resolve(undefined),
        },
      },
    )
    await adapter.start()
    const ordinary = {
      eventType: 'GROUP_MESSAGE_CREATE' as const,
      platformMessageId: 'ordinary-1',
      target: { kind: 'group' as const, openId: 'group-openid' },
      senderOpenId: 'member-openid',
      content: '普通群消息',
      platformTimestamp: 90,
    }
    await adapter.receive(ordinary)
    await adapter.receive(ordinary)
    expect(accepted).toHaveLength(2)
    expect(accepted[0]).toMatchObject({
      facts: { mentionedBot: false, replyToBot: false, targetKind: 'group' },
      dedupeKey: 'qq-openclaw:GROUP_MESSAGE_CREATE:ordinary-1',
    })
    expect(accepted[1]?.dedupeKey).toBe(accepted[0]?.dedupeKey)
    await adapter.stop()
  })
})
