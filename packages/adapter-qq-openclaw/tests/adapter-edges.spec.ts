import type { AdapterConnectionContext, AdapterInboundEvent } from '@nekro-nxt/adapter-sdk'
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
  QQOpenClawConnection,
  QQReplyBudget,
  QQTransportError,
  splitQQMarkdownAtoms,
  type QQAssetSource,
  type QQIdentityDirectory,
  type QQInboundBridge,
  type QQOpenClawConfig,
  type QQOpenClawTransport,
} from '../src/index.ts'

const connectionId = ConnectionIdSchema.parse('con_edges')
const channelId = ChannelIdSchema.parse('chn_edges')
const memberId = ChannelMemberIdSchema.parse('mbr_edges')
const otherConnectionId = ConnectionIdSchema.parse('con_other')

const baseConfig: QQOpenClawConfig = {
  appId: 'app',
  clientSecretCredentialRef: 'credential:qq',
  proactiveSend: false,
  markdown: true,
  maxTextLength: 32,
  maxTextBytes: 7200,
  maxAssetBytes: 8,
  passiveReplyTtlMs: 100,
  passiveReplyLimit: 1,
}

const makeTransport = (overrides: Partial<QQOpenClawTransport> = {}): QQOpenClawTransport => ({
  start: () => Promise.resolve(),
  stop: () => Promise.resolve(),
  sendText: () => Promise.resolve({ platformMessageId: 'text-edge' }),
  upload: () => Promise.resolve({ fileInfo: 'file-edge' }),
  sendMedia: () => Promise.resolve({ platformMessageId: 'media-edge' }),
  ...overrides,
})

const makeDirectory = (overrides: Partial<QQIdentityDirectory> = {}): QQIdentityDirectory => ({
  resolveTarget: () => Promise.resolve({ kind: 'group', openId: 'group-edge' }),
  resolveMemberOpenId: (_connection, _channel, member) =>
    Promise.resolve(member === memberId ? 'member-edge' : undefined),
  resolvePlatformMessageId: () => Promise.resolve('qq-quoted-edge'),
  ...overrides,
})

const makeAssets = (overrides: Partial<QQAssetSource> = {}): QQAssetSource => ({
  read: () => Promise.resolve({ bytes: new Uint8Array([1, 2]), mediaType: 'image/png', fileName: 'image.png' }),
  ...overrides,
})

const makeContext = (overrides: Partial<AdapterConnectionContext> = {}): AdapterConnectionContext => ({
  connectionId,
  now: () => 100,
  acceptInbound: () => Promise.resolve({ channelEventId: ChannelEventIdSchema.parse('evt_edges'), inserted: true }),
  ...overrides,
})

interface AdapterOptions {
  readonly context?: AdapterConnectionContext
  readonly config?: Partial<QQOpenClawConfig>
  readonly directory?: Partial<QQIdentityDirectory>
  readonly assets?: Partial<QQAssetSource>
  readonly transport?: Partial<QQOpenClawTransport>
  readonly inbound?: QQInboundBridge
}

const makeAdapter = (options: AdapterOptions = {}) =>
  new QQOpenClawConnection(
    options.context ?? makeContext(),
    { ...baseConfig, ...options.config },
    {
      directory: makeDirectory(options.directory),
      assets: makeAssets(options.assets),
      transport: makeTransport(options.transport),
      ...(options.inbound === undefined ? {} : { inbound: options.inbound }),
    },
  )

const textRequest = (overrides: Partial<Parameters<QQOpenClawConnection['deliver']>[0]> = {}) => ({
  deliveryId: PhysicalDeliveryIdSchema.parse('phy_edges'),
  logicalMessageId: LogicalMessageIdSchema.parse('msg_edges'),
  connectionId,
  channelId,
  parts: [{ type: 'text' as const, text: 'hello' }],
  ...overrides,
})

describe('QQ OpenClaw connection boundaries', () => {
  it('covers Markdown and reply-budget edge states without timers', () => {
    expect(splitQQMarkdownAtoms([], 16)).toEqual([])
    expect(splitQQMarkdownAtoms([{ kind: 'text', value: 'short' }], 16)).toEqual(['short'])
    expect(() => splitQQMarkdownAtoms([], 15)).toThrow('at least 16')
    expect(() => splitQQMarkdownAtoms([{ kind: 'mention', value: '<@this-token-is-too-long>' }], 16)).toThrow(
      'atomic Markdown token',
    )
    const codeChunks = splitQQMarkdownAtoms([{ kind: 'text', value: '```ts\n' + 'x'.repeat(50) + '\n```' }], 20)
    expect(codeChunks.length).toBeGreaterThan(1)
    expect(codeChunks.join('')).toContain('```ts')

    const budget = new QQReplyBudget()
    expect(budget.reserve(undefined, 0)).toBeUndefined()
    expect(budget.reserve('missing', 0)).toBeUndefined()
    budget.observe('reply', 100, 2)
    budget.observe('reply', 200, 1)
    expect(budget.available('reply', 0)).toBe(1)
    const first = budget.reserve('reply', 0)
    expect(first).toEqual({ messageId: 'reply', sequence: 1 })
    if (first === undefined) throw new Error('Expected the first reply reservation.')
    expect(budget.available('reply', 0)).toBe(0)
    expect(budget.reserve('reply', 0)).toBeUndefined()
    budget.release(first)
    const second = budget.reserve('reply', 0)
    expect(second).toEqual({ messageId: 'reply', sequence: 2 })
    if (second === undefined) throw new Error('Expected the second reply reservation.')
    budget.commit(second)
    expect(budget.available('reply', 0)).toBe(0)
    budget.commit(second)
    expect(budget.reserve('reply', 200)).toBeUndefined()
    expect(budget.available('reply', 200)).toBe(0)
  })

  it('keeps failed starts stopped and rejects invalid plans before delivery', async () => {
    let stops = 0
    const failing = makeAdapter({
      transport: makeTransport({
        start: () => Promise.reject(new Error('transport start failed')),
        stop: () => {
          stops += 1
          return Promise.resolve()
        },
      }),
    })
    await expect(failing.start()).rejects.toThrow('transport start failed')
    await expect(
      failing.sendDiagnosticText({ kind: 'group', openId: 'group' }, 'test', new AbortController().signal),
    ).rejects.toThrow('not running')
    await failing.stop()
    expect(stops).toBe(1)

    const adapter = makeAdapter({
      directory: {
        resolveTarget: () => Promise.resolve(undefined),
        resolvePlatformMessageId: () => Promise.resolve(undefined),
      },
    })
    await adapter.start()
    await expect(adapter.start()).rejects.toThrow('already running')
    await expect(adapter.resolveDiagnosticTarget(channelId)).rejects.toThrow('target is unknown')
    await expect(
      adapter.planOutbound({
        connectionId,
        channelId,
        replyTo: 'msg_reply',
        parts: [
          { type: 'quote', messageId: LogicalMessageIdSchema.parse('msg_quote') },
          { type: 'text', text: 'two refs' },
        ],
      }),
    ).rejects.toThrow('multiple quoted messages')
    const quotedOnly = makeAdapter({ directory: { resolvePlatformMessageId: () => Promise.resolve('qq-quote') } })
    await expect(
      quotedOnly.planOutbound({
        connectionId,
        channelId,
        parts: [{ type: 'quote', messageId: LogicalMessageIdSchema.parse('msg_quote') }],
      }),
    ).rejects.toThrow('requires content')
    await expect(
      adapter.planOutbound({
        connectionId,
        channelId,
        parts: [
          { type: 'quote', messageId: LogicalMessageIdSchema.parse('msg_quote') },
          { type: 'text', text: 'text' },
        ],
      }),
    ).rejects.toThrow('unknown in this Channel')
    const byteLimited = makeAdapter({ config: { maxTextBytes: 1 } })
    await expect(
      byteLimited.planOutbound({ connectionId, channelId, parts: [{ type: 'text', text: '🙂' }] }),
    ).rejects.toThrow('UTF-8 byte limit')
    await adapter.stop()
  })

  it('normalizes mentions, quotes, image/audio/file media, and empty-message fallbacks', async () => {
    const accepted: AdapterInboundEvent[] = []
    let attachmentIndex = 0
    const inbound: QQInboundBridge = {
      ensureTarget: () => Promise.resolve(channelId),
      ensureMember: ({ openId }) => Promise.resolve(ChannelMemberIdSchema.parse(`mbr_${openId.replaceAll('-', '')}`)),
      importAttachment: ({ fileName, mediaType }) => {
        const values = [
          {
            assetId: AssetIdSchema.parse('ast_image'),
            mediaType: mediaType ?? 'image/png',
            ...(fileName === undefined ? {} : { fileName }),
          },
          { assetId: AssetIdSchema.parse('ast_audio'), mediaType: mediaType ?? 'audio/mpeg' },
          {
            assetId: AssetIdSchema.parse('ast_file'),
            mediaType: mediaType ?? 'application/pdf',
            ...(fileName === undefined ? {} : { fileName }),
          },
        ]
        const value = values[attachmentIndex]
        if (value === undefined) throw new Error(`Unexpected attachment import at index ${attachmentIndex}.`)
        attachmentIndex += 1
        return Promise.resolve(value)
      },
      resolveQuote: () => Promise.resolve(undefined),
    }
    const adapter = makeAdapter({
      context: makeContext({
        now: () => 500,
        acceptInbound: (event) => {
          accepted.push(event)
          return Promise.resolve({
            channelEventId: ChannelEventIdSchema.parse(`evt_edges${accepted.length}`),
            inserted: false,
          })
        },
      }),
      inbound,
    })
    await adapter.start()
    await adapter.receive({
      eventType: 'C2C_MESSAGE_CREATE',
      platformMessageId: 'c2c-media',
      target: { kind: 'c2c', openId: 'user' },
      senderOpenId: 'sender',
      mentions: [{ openId: 'bot', bot: true }, { openId: 'member' }],
      attachments: [
        { url: 'https://cdn.test/image', fileName: 'image.png', mediaType: 'image/png' },
        { url: 'https://cdn.test/audio', mediaType: 'audio/mpeg' },
        { url: 'https://cdn.test/file', fileName: 'doc.pdf', mediaType: 'application/pdf' },
      ],
      platformReference: 'missing-quote',
      platformSequence: 3,
      platformTimestamp: 400,
      replyExpiresAt: 700,
      remainingReplies: 2,
    })
    expect(accepted[0]).toMatchObject({
      parts: [
        { type: 'mention', memberId: 'mbr_bot' },
        { type: 'mention', memberId: 'mbr_member' },
        { type: 'image', assetId: 'ast_image', alt: 'image.png' },
        { type: 'audio', assetId: 'ast_audio' },
        { type: 'file', assetId: 'ast_file', name: 'doc.pdf' },
      ],
      facts: { mentionedBot: true, replyToBot: false, targetKind: 'c2c' },
      assetOccurrences: [
        { partIndex: 2, assetId: 'ast_image' },
        { partIndex: 3, assetId: 'ast_audio' },
        { partIndex: 4, assetId: 'ast_file' },
      ],
    })

    await adapter.receive({
      eventType: 'GROUP_MESSAGE_CREATE',
      platformMessageId: 'group-empty',
      target: { kind: 'group', openId: 'group' },
      senderOpenId: 'sender',
      platformTimestamp: 400,
    })
    await adapter.receive({
      eventType: 'GROUP_AT_MESSAGE_CREATE',
      platformMessageId: 'group-mention-only',
      target: { kind: 'group', openId: 'group' },
      senderOpenId: 'sender',
      mentions: [{ openId: 'bot', bot: true }],
      platformTimestamp: 400,
    })
    expect(accepted[1]?.parts).toEqual([{ type: 'text', text: '该 QQ 消息包含暂不支持显示的内容。' }])
    expect(accepted[2]?.parts).toEqual([{ type: 'mention', memberId: 'mbr_bot' }])
    await adapter.stop()
  })

  it('reports lifecycle, media, typed transport, cancellation, and generic delivery failures', async () => {
    const noInbound = makeAdapter()
    await expect(
      noInbound.receive({
        eventType: 'C2C_MESSAGE_CREATE',
        platformMessageId: 'not-running',
        target: { kind: 'c2c', openId: 'user' },
        senderOpenId: 'sender',
        platformTimestamp: 1,
      }),
    ).rejects.toThrow('not running')
    await noInbound.start()
    await expect(
      noInbound.receive({
        eventType: 'C2C_MESSAGE_CREATE',
        platformMessageId: 'no-bridge',
        target: { kind: 'c2c', openId: 'user' },
        senderOpenId: 'sender',
        platformTimestamp: 1,
      }),
    ).rejects.toThrow('bridge is not configured')
    await noInbound.stop()

    const unknownTarget = makeAdapter({ directory: { resolveTarget: () => Promise.resolve(undefined) } })
    await unknownTarget.start()
    await expect(unknownTarget.deliver(textRequest(), new AbortController().signal)).resolves.toMatchObject({
      status: 'failed',
      failure: { kind: 'invalid' },
    })
    await unknownTarget.stop()

    const wrongConnection = makeAdapter()
    await wrongConnection.start()
    await expect(
      wrongConnection.deliver(textRequest({ connectionId: otherConnectionId }), new AbortController().signal),
    ).resolves.toMatchObject({ status: 'failed', failure: { kind: 'invalid' } })
    await wrongConnection.stop()

    const tooLarge = makeAdapter({
      config: { proactiveSend: true },
      assets: { read: () => Promise.resolve({ bytes: new Uint8Array(9), mediaType: 'image/png' }) },
    })
    await tooLarge.start()
    await expect(
      tooLarge.deliver(
        textRequest({ parts: [{ type: 'image', assetId: AssetIdSchema.parse('ast_big') }] }),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ status: 'failed', failure: { kind: 'transient' } })
    await tooLarge.stop()

    const malformed = makeAdapter({ config: { proactiveSend: true } })
    await malformed.start()
    await expect(
      malformed.deliver(
        textRequest({ parts: [{ type: 'quote', messageId: LogicalMessageIdSchema.parse('msg_quote') }] }),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ status: 'failed', failure: { kind: 'transient' } })
    await expect(
      malformed.deliver(textRequest({ parts: [{ type: 'text', text: 'a'.repeat(40) }] }), new AbortController().signal),
    ).resolves.toMatchObject({ status: 'failed', failure: { kind: 'transient' } })
    await malformed.stop()

    const rateLimited = makeAdapter({
      transport: makeTransport({
        sendText: () => Promise.reject(new QQTransportError('rate-limited', 'slow', { retryAfterMs: 99 })),
      }),
    })
    await rateLimited.start()
    rateLimited.observeReplyContext('reply-rate', { remainingReplies: 1, expiresAt: 1_000 })
    await expect(
      rateLimited.deliver(textRequest({ replyTo: 'reply-rate' }), new AbortController().signal),
    ).resolves.toEqual({
      status: 'failed',
      failure: { kind: 'rate-limited', message: 'slow', retryAfterMs: 99 },
    })
    await rateLimited.stop()

    const unknown = makeAdapter({
      transport: makeTransport({ sendText: () => Promise.reject(new QQTransportError('unknown', 'uncertain')) }),
    })
    await unknown.start()
    unknown.observeReplyContext('reply-unknown', { remainingReplies: 1, expiresAt: 1_000 })
    await expect(
      unknown.deliver(textRequest({ replyTo: 'reply-unknown' }), new AbortController().signal),
    ).resolves.toEqual({
      status: 'unknown',
      message: 'uncertain',
    })
    await unknown.stop()

    const aborted = new AbortController()
    aborted.abort()
    const cancellation = makeAdapter({
      transport: makeTransport({ sendText: () => Promise.reject(new Error('maybe sent')) }),
    })
    await cancellation.start()
    cancellation.observeReplyContext('reply-aborted', { remainingReplies: 1, expiresAt: 1_000 })
    await expect(cancellation.deliver(textRequest({ replyTo: 'reply-aborted' }), aborted.signal)).resolves.toEqual({
      status: 'unknown',
      message: 'QQ request may have been submitted before cancellation.',
    })
    await cancellation.stop()

    const generic = makeAdapter({
      config: { proactiveSend: true },
      transport: makeTransport({ sendText: () => Promise.reject(new Error('plain failure')) }),
    })
    await generic.start()
    await expect(generic.deliver(textRequest(), new AbortController().signal)).resolves.toEqual({
      status: 'failed',
      failure: { kind: 'transient', message: 'plain failure' },
    })
    await generic.stop()
  })
})
