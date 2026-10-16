import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AdapterConnectionHostContext } from '@nekro-nxt/adapter-sdk'
import {
  AssetIdSchema,
  ChannelIdSchema,
  EpisodeIdSchema,
  LogicalMessageIdSchema,
  OutboundIntentIdSchema,
  PhysicalDeliveryIdSchema,
  type JsonValue,
} from '@nekro-nxt/contracts'
import { CoreService } from '@nekro-nxt/core'
import { openMigratedCoreDatabase, SqliteCoreRepository } from '@nekro-nxt/storage-sqlite'
import { createFakeAdapterHostContext } from '@nekro-nxt/test-harness'
import { QQOpenClawConnection, decodeQQInboundMessage, type QQQuoteDiagnostic } from '../src/index.ts'
import { createQQIdentityDirectory } from '../src/host-contribution.ts'
import { QQQuoteIndex, QQ_QUOTE_INDEX_LIMIT } from '../src/quote-index.ts'

/** `at` is when the platform says the message was sent; QQ's passive reply window counts from it. */
const decode = (id: string, extra: Record<string, unknown> = {}, at = 100) =>
  decodeQQInboundMessage(
    'GROUP_MESSAGE_CREATE',
    {
      id,
      group_openid: 'fictional-group',
      author: { member_openid: 'fictional-member' },
      content: '虚构正文',
      ...extra,
    },
    { now: () => at },
  )!

const fixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'nxt-qq-quotes-'))
  const file = path.join(root, 'core.sqlite')
  let db = await openMigratedCoreDatabase(file)
  let repository = new SqliteCoreRepository(db)
  let core = new CoreService(repository)
  let now = 100
  const connection = core.createConnection({ adapterKey: 'qq-openclaw', config: {} })
  const fake = createFakeAdapterHostContext()
  const diagnostics: QQQuoteDiagnostic[] = []
  const context: AdapterConnectionHostContext = {
    ...fake.context,
    connectionId: connection.id,
    now: () => now,
    acceptChannelInbound: (event) => {
      const commit = core.appendInbound(event)
      return Promise.resolve({ channelEventId: commit.event.id, inserted: commit.inserted })
    },
    channels: {
      ...fake.context.channels,
      ensure: (input) => Promise.resolve(core.ensureChannel({ ...input, connectionId: connection.id }).id),
      resolvePlatformChannelId: (id) => Promise.resolve(core.getChannel(id)?.platformChannelId),
    },
    members: {
      ...fake.context.members,
      ensure: (input) =>
        Promise.resolve(core.observeChannelMember({ ...input, connectionId: connection.id }).member.id),
    },
    messages: {
      resolvePlatformMessage: (id, ref) => Promise.resolve(core.resolvePlatformMessage(connection.id, id, ref)),
      resolvePlatformMessageId: (id, logical) =>
        Promise.resolve(core.resolveLogicalMessagePlatformId(connection.id, id, logical)),
      resolveLogicalMessage: (id, logical) =>
        Promise.resolve(repository.resolveLogicalMessage(connection.id, id, logical)),
    },
    state: {
      load: (key) => repository.load(connection.id, key),
      save: (key, value) => repository.save(connection.id, key, value, now),
      clear: (key) => repository.clear(connection.id, key),
    },
  }
  let sent = 0
  const sendText = vi.fn(() =>
    Promise.resolve({ platformMessageId: `ROBOT1.0_out_${++sent}`, refIndex: `REFIDX_out_${sent}` }),
  )
  const make = (appId = 'fictional-app') => {
    const directory = createQQIdentityDirectory(context)
    return new QQOpenClawConnection(
      context,
      { appId, clientSecretCredentialRef: 'fixture:secret', proactiveSend: false },
      {
        directory,
        inbound: directory,
        assets: { read: () => Promise.resolve({ bytes: new Uint8Array([1]), mediaType: 'image/png' }) },
        transport: {
          start: async () => {},
          stop: async () => {},
          sendText,
          sendMedia: sendText,
          upload: () => Promise.resolve({ fileInfo: 'fictional-file' }),
        },
        onQuoteDiagnostic: (value) => diagnostics.push(value),
      },
    )
  }
  return {
    context,
    connection,
    make,
    sendText,
    diagnostics,
    get core() {
      return core
    },
    get repository() {
      return repository
    },
    setNow(value: number) {
      now = value
    },
    async reopen() {
      db.close()
      db = await openMigratedCoreDatabase(file)
      repository = new SqliteCoreRepository(db)
      core = new CoreService(repository)
    },
    async close() {
      db.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

describe('QQ quote history integration', () => {
  it('persists raw IDs separately from indexes, survives restart and resolves received and sent quotes through SQLite', async () => {
    const f = await fixture()
    let adapter = f.make()
    try {
      await adapter.start()
      const original = decode('ROBOT1.0_original', {
        message_scene: { ext: ['msg_idx=REFIDX_original', 'auth_token=fictional-sensitive'] },
      })
      const committed = await adapter.receive(original)
      const channelId = await f.context.channels.ensure({
        platformChannelId: 'group:fictional-group',
        kind: 'group',
        observedAt: 100,
      })
      const originalId = f.core.resolvePlatformMessage(
        f.connection.id,
        channelId,
        'ROBOT1.0_original',
      )!.logicalMessageId
      expect(f.core.resolvePlatformMessage(f.connection.id, channelId, 'REFIDX_original')).toBeUndefined()
      expect((await adapter.receive(original)).inserted).toBe(false)
      expect(JSON.stringify(await f.context.state.load('qq-quote-index-v1'))).not.toContain('fictional-sensitive')
      await adapter.stop()
      await f.reopen()
      adapter = f.make()
      await adapter.start()
      await adapter.receive(
        decode('ROBOT1.0_reply', { message_type: 103, message_scene: { ext: ['ref_msg_idx=REFIDX_original'] } }),
      )
      expect(f.repository.listChannelHistory(channelId).at(0)?.parts).toContainEqual({
        type: 'quote',
        messageId: originalId,
      })
      // A fresh message authorizes a reply quoting the old message, even after the original budget expired.
      f.setNow(400000)
      await adapter.receive(decode('ROBOT1.0_fresh', {}, 400000))
      const parts = [{ type: 'text' as const, text: '引用旧消息' }]
      const [plan] = await adapter.planOutbound({
        connectionId: f.connection.id,
        channelId,
        parts,
        replyTo: originalId,
      })
      expect(plan?.adapterContext).toMatchObject({
        referenceIndex: 'REFIDX_original',
        replyPlatformMessageId: 'ROBOT1.0_fresh',
      })
      const deliveryId = PhysicalDeliveryIdSchema.parse('phy_QUOTEFIXTURE')
      const logicalMessageId = LogicalMessageIdSchema.parse('msg_QUOTEFIXTURE')
      const agent = f.core.createAgent({
        displayName: '虚构智能体',
        persona: '',
        model: { provider: 'fake', model: 'fake' },
      })
      const episodeId = EpisodeIdSchema.parse('eps_QUOTEFIXTURE')
      const intentId = OutboundIntentIdSchema.parse('out_QUOTEFIXTURE')
      f.repository.createEpisode({
        id: episodeId,
        channelId,
        agentId: agent.definition.id,
        agentRevisionId: agent.revision.id,
        status: 'opening',
        openedAtEventId: committed.channelEventId,
        createdAt: 400000,
      })
      f.repository.createOutboundPlan(
        {
          id: intentId,
          logicalMessageId,
          agentRevisionId: agent.revision.id,
          episodeId,
          parts,
          state: 'planned',
          createdAt: 400000,
        },
        [{ id: deliveryId, intentId, sequence: 0, parts, state: 'planned' }],
      )
      f.repository.markIntentSending(intentId)
      f.repository.markDeliverySending(deliveryId)
      const receipt = await adapter.deliver(
        { deliveryId, logicalMessageId, connectionId: f.connection.id, channelId, ...plan! },
        new AbortController().signal,
      )
      expect(receipt.status).toBe('sent')
      f.repository.recordDeliveryReceipt(deliveryId, receipt, 400000)
      f.repository.completeOutboundIntent(intentId, 'sent')
      expect(f.sendText).toHaveBeenCalledWith(
        expect.objectContaining({ referenceIndex: 'REFIDX_original', replyMessageId: 'ROBOT1.0_fresh' }),
      )
      const [mediaPlan] = await adapter.planOutbound({
        connectionId: f.connection.id,
        channelId,
        replyTo: originalId,
        parts: [{ type: 'image', assetId: AssetIdSchema.parse('ast_QUOTEMEDIA') }],
      })
      await adapter.deliver(
        {
          deliveryId: PhysicalDeliveryIdSchema.parse('phy_QUOTEMEDIA'),
          logicalMessageId,
          connectionId: f.connection.id,
          channelId,
          ...mediaPlan!,
        },
        new AbortController().signal,
      )
      expect(f.sendText).toHaveBeenLastCalledWith(
        expect.objectContaining({ referenceIndex: 'REFIDX_original', fileInfo: 'fictional-file' }),
      )
      await adapter.stop()
      await f.reopen()
      adapter = f.make()
      await adapter.start()
      const replyCommit = await adapter.receive(
        decode('ROBOT1.0_to_bot', { message_scene: { ext: ['ref_msg_idx=REFIDX_out_1'] } }),
      )
      const quoted = f.repository
        .listChannelHistory(channelId)
        .find((entry) => entry.sourceId === replyCommit.channelEventId)!
      expect(quoted.parts).toContainEqual({ type: 'quote', messageId: logicalMessageId })
      expect(quoted.source === 'channel-event' && quoted.facts?.['replyToBot']).toBe(true)
      // The same reference string in a different channel must not resolve or borrow passive budget.
      const otherId = await f.context.channels.ensure({
        platformChannelId: 'group:other-fictional-group',
        kind: 'group',
        observedAt: 100,
      })
      await expect(
        adapter.planOutbound({ connectionId: f.connection.id, channelId: otherId, parts, replyTo: originalId }),
      ).rejects.toThrow('unknown in this Channel')
      const otherReceipt = await adapter.deliver(
        { deliveryId, logicalMessageId, connectionId: f.connection.id, channelId: otherId, parts },
        new AbortController().signal,
      )
      expect(otherReceipt.status).toBe('failed')
      await adapter.receive(
        decode('ROBOT1.0_other', {
          group_openid: 'other-fictional-group',
          message_scene: { ext: ['ref_msg_idx=REFIDX_out_1'] },
        }),
      )
      expect(f.repository.listChannelHistory(otherId)[0]?.parts).toContainEqual(
        expect.objectContaining({ kind: 'quote-preview' }),
      )
    } finally {
      await adapter.stop()
      await f.close()
    }
  })

  it('retains unknown previews without inventing quote IDs or bot Mention facts, and handles index persistence failure after send', async () => {
    const f = await fixture()
    const adapter = f.make()
    try {
      await adapter.start()
      await adapter.receive(
        decode('ROBOT1.0_preview', {
          content: '当前正文',
          message_type: 103,
          message_scene: { ext: ['ref_msg_idx=TMP_unknown'] },
          msg_elements: [{ content: '<@fictional-bot> 引用中的虚构正文', author: { username: '虚构成员' } }],
        }),
      )
      const channelId = await f.context.channels.ensure({
        platformChannelId: 'group:fictional-group',
        kind: 'group',
        observedAt: 100,
      })
      const entry = f.repository.listChannelHistory(channelId)[0]!
      expect(entry.parts).toEqual([
        { type: 'text', text: '当前正文' },
        expect.objectContaining({
          type: 'rich',
          kind: 'quote-preview',
          extension: { items: [{ sender: '虚构成员', text: '<@fictional-bot> 引用中的虚构正文' }] },
        }),
      ])
      expect(entry.source === 'channel-event' && entry.facts).toMatchObject({ mentionedBot: false, replyToBot: false })
      const save = vi.spyOn(f.context.state, 'save').mockRejectedValueOnce(new Error('fictional disk failure'))
      const result = await adapter.deliver(
        {
          deliveryId: PhysicalDeliveryIdSchema.parse('phy_SAVEFAIL'),
          logicalMessageId: LogicalMessageIdSchema.parse('msg_SAVEFAIL'),
          connectionId: f.connection.id,
          channelId,
          parts: [{ type: 'text', text: '已发送的虚构消息' }],
        },
        new AbortController().signal,
      )
      expect(result).toMatchObject({ status: 'sent', platformMessageId: 'ROBOT1.0_out_1' })
      expect(f.sendText).toHaveBeenCalledTimes(1)
      expect(f.diagnostics).toContainEqual({ reason: 'reference-index-save-failed', targetKind: 'group' })
      save.mockRestore()
      await adapter.receive(decode('ROBOT1.0_after', { message_scene: { ext: ['msg_idx=REFIDX_after'] } }))
      expect(JSON.stringify(await f.context.state.load('qq-quote-index-v1'))).toContain('REFIDX_out_1')
      await adapter.receive({ ...decode('ROBOT1.0_limited'), remainingReplies: 1 })
      // Other messages still have quota; move beyond their expiry before creating a one-slot context.
      f.setNow(900000)
      await adapter.receive({ ...decode('ROBOT1.0_only_one', {}, 900000), remainingReplies: 1 })
      await expect(
        adapter.planOutbound({
          connectionId: f.connection.id,
          channelId,
          parts: [
            { type: 'text', text: '两段投递' },
            { type: 'image', assetId: AssetIdSchema.parse('ast_QUOTEMEDIA') },
          ],
        }),
      ).rejects.toThrow('quota cannot cover')
      const logical = f.core.resolvePlatformMessage(f.connection.id, channelId, 'ROBOT1.0_preview')!.logicalMessageId
      await expect(
        adapter.planOutbound({
          connectionId: f.connection.id,
          channelId,
          replyTo: logical,
          parts: [{ type: 'text', text: '缺少索引' }],
        }),
      ).rejects.toThrow('引用信息不可用')
    } finally {
      await adapter.stop()
      await f.close()
    }
  })
})

describe('QQ quote preview and index boundaries', () => {
  it('keeps nested quote text, structured cards and media separate and bounds traversal', () => {
    const message = decode('ROBOT1.0_nested', {
      content: ' ',
      message_type: 103,
      message_scene: { ext: ['msg_idx=REFIDX_self', 'ref_msg_idx=TMP_fallback'] },
      msg_elements: [
        {
          msg_idx: 'REFIDX_original',
          content: '引用正文',
          author: { username: '虚构甲' },
          msg_elements: [
            {
              content: '嵌套引用',
              attachments: [{ url: 'https://example.test/voice.wav', content_type: 'audio/wav' }],
            },
          ],
        },
        { ark_data: JSON.stringify({ title: '虚构卡片', kv: [{ key: '#DESC#', value: '卡片摘要' }] }) },
      ],
    })
    expect(message).toMatchObject({
      platformMessageId: 'ROBOT1.0_nested',
      referenceIndex: 'REFIDX_self',
      platformReference: 'REFIDX_original',
    })
    expect(message.content).toBeUndefined()
    expect(message.quotePreview?.items).toEqual(
      expect.arrayContaining([
        { sender: '虚构甲', text: '引用正文' },
        { text: '嵌套引用' },
        { attachmentUrl: 'https://example.test/voice.wav', attachmentMediaType: 'audio/wav' },
      ]),
    )
    expect(message.quotePreview?.items?.find((item) => item.card)?.card?.title).toBe('虚构卡片')
    const forward = decode('ROBOT1.0_forward_quote', {
      message_type: 103,
      msg_elements: [{ content: '[卡片消息] 转发 摘要: 被引用的转发正文' }],
    })
    expect(forward.quotePreview?.items?.[0]?.text).toBe('被引用的转发正文')
    const huge = decode('ROBOT1.0_huge', {
      message_type: 103,
      msg_elements: Array.from({ length: 100 }, () => ({ content: '长'.repeat(10000) })),
    })
    expect(huge.quotePreview?.summary).toContain('部分引用预览')
    expect(JSON.stringify(huge.quotePreview).length).toBeLessThan(17000)
    const deep: Record<string, unknown> = { content: '深层' }
    deep['msg_elements'] = [deep]
    expect(decode('ROBOT1.0_depth', { message_type: 103, msg_elements: [deep] }).quotePreview?.items).toHaveLength(5)
    expect(
      decode('ROBOT1.0_empty', { message_type: 103, msg_elements: [{ ark_data: 'invalid JSON' }] }).quotePreview
        ?.summary,
    ).toContain('未提供引用内容')
  })

  it('serializes concurrent saves, isolates accounts, connections and channels, and bounds the durable journal', async () => {
    const memory = new Map<string, JsonValue>()
    const state = {
      load: (key: string) => Promise.resolve(memory.get(key)),
      save: (key: string, value: JsonValue) => {
        memory.set(key, structuredClone(value))
        return Promise.resolve()
      },
      clear: async () => {},
    }
    const channel = ChannelIdSchema.parse('chn_FIRST')
    const other = ChannelIdSchema.parse('chn_SECOND')
    const index = new QQQuoteIndex('fixture-app', state)
    await Promise.all([
      index.remember(channel, 'raw-first', 'ref-shared'),
      index.remember(other, 'raw-second', 'ref-shared'),
    ])
    expect(await new QQQuoteIndex('fixture-app', state).messageId(channel, 'ref-shared')).toBe('raw-first')
    expect(await index.messageId(other, 'ref-shared')).toBe('raw-second')
    expect(await new QQQuoteIndex('other-app', state).messageId(channel, 'ref-shared')).toBeUndefined()
    expect(await new QQQuoteIndex('fixture-app').messageId(channel, 'ref-shared')).toBeUndefined()
    memory.set('qq-quote-index-v1', {
      appId: 'fixture-app',
      entries: Array.from({ length: QQ_QUOTE_INDEX_LIMIT }, (_, n) => ({
        channelId: channel,
        messageId: `raw-${n}`,
        refIndex: `ref-${n}`,
      })),
    })
    const bounded = new QQQuoteIndex('fixture-app', state)
    await bounded.remember(channel, 'latest-raw', 'latest-ref')
    expect(await bounded.messageId(channel, 'ref-0')).toBeUndefined()
    expect(await bounded.refIndex(channel, 'latest-raw')).toBe('latest-ref')
    expect(JSON.stringify(memory.get('qq-quote-index-v1'))).not.toContain('raw-first')
  })
})
