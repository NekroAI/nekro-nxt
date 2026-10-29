import { createFakeLocalChannelConnection } from '@nekro-nxt/test-harness'
import { ChannelRuntime, type AgentSessionDriver, type SendMessageInput } from '@nekro-nxt/channel-runtime'
import { CoreService } from '@nekro-nxt/core'
import {
  AgentIdSchema,
  AssetIdSchema,
  ChannelIdSchema,
  EpisodeIdSchema,
  ExtensionCapabilitiesSchema,
  ExtensionIdSchema,
  LogicalMessageIdSchema,
  type ExtensionCapabilities,
  type ExtensionId,
  type MessagePart,
} from '@nekro-nxt/contracts'
import type { Revision } from '@nekro-nxt/extension-runtime'
import type { NxtHostService, NxtOutboundHandler, NxtOutboundMessage } from '@nekro-nxt/extension-sdk'
import {
  openMigratedCoreDatabase,
  SqliteCoreRepository,
  type OutboundProcessingRecord,
} from '@nekro-nxt/storage-sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  checkOutboundVerificationAnswer,
  ExtensionOutboundProcessor,
  resolveOutboundOrder,
  verifyOutboundHandler,
  type ExtensionOutboundProcessorOptions,
  type OutboundProcessingStore,
} from '../src/extension-outbound.js'
import type { PersistentOutboundHandler } from '../src/persistent-extension-mounts.js'

const agentId = AgentIdSchema.parse('agt_OUTBOUND')
const channelId = ChannelIdSchema.parse('chn_OUTBOUND')
const episodeId = EpisodeIdSchema.parse('eps_OUTBOUND')
const text = (value: string): MessagePart => ({ type: 'text', text: value })

interface FakeExtension {
  readonly id: ExtensionId
  readonly name: string
  readonly outbound: ExtensionCapabilities['outbound']
  readonly handler: NxtOutboundHandler
}

const extension = (
  key: string,
  name: string,
  outbound: Record<string, unknown>,
  handler: NxtOutboundHandler,
): FakeExtension => ({
  id: ExtensionIdSchema.parse(`ext_${key}`),
  name,
  outbound: ExtensionCapabilitiesSchema.parse({ outbound: { timeoutMs: 200, ...outbound } }).outbound,
  handler,
})

const asHandler = (fake: FakeExtension, agent = agentId): PersistentOutboundHandler => ({
  agentId: agent,
  revision: { id: `xrv_${fake.id}`, extensionId: fake.id } as unknown as Revision,
  config: {},
  hostConfig: {},
  handler: fake.handler,
})

const memoryStore = (): OutboundProcessingStore & { readonly records: OutboundProcessingRecord[] } => {
  const records: OutboundProcessingRecord[] = []
  const replace = (record: OutboundProcessingRecord) => {
    records.splice(records.indexOf(records.find(({ id }) => id === record.id)!), 1, record)
  }
  return {
    records,
    getOutboundProcessingByRequest: (episode, clientRequestId) =>
      records.find((record) => record.episodeId === episode && record.clientRequestId === clientRequestId),
    saveOutboundProcessing: (record) => {
      const existing = records.find(
        (item) => item.episodeId === record.episodeId && item.clientRequestId === record.clientRequestId,
      )
      if (existing) return existing
      records.push(record)
      return record
    },
    linkOutboundProcessing: (id, intentId) => {
      const record = records.find((item) => item.id === id)
      if (record && record.outboundIntentId === undefined) replace({ ...record, outboundIntentId: intentId })
    },
    claimOutboundNotification: (intentId, at) => {
      const record = records.find((item) => item.outboundIntentId === intentId)
      if (record === undefined || record.notifiedAt !== undefined) return undefined
      const claimed = { ...record, notifiedAt: at }
      replace(claimed)
      return claimed
    },
  }
}

const processor = (
  extensions: readonly FakeExtension[],
  overrides: Partial<ExtensionOutboundProcessorOptions> = {},
) => {
  let sequence = 0
  const store = memoryStore()
  const logs: string[] = []
  const options: ExtensionOutboundProcessorOptions = {
    handlers: () => extensions.map((fake) => asHandler(fake)),
    describe: (handler) => {
      const fake = extensions.find(({ id }) => id === handler.revision.extensionId)!
      return {
        displayName: fake.name,
        capabilities: fake.outbound === undefined ? undefined : { outbound: fake.outbound },
      }
    },
    order: (_agent, ids) =>
      resolveOutboundOrder(
        [],
        extensions.map(({ id }) => id),
        ids,
      ),
    nxtFor: () => ({}) as NxtHostService,
    channel: (id) => ({ id, kind: 'group', displayName: '示例频道' }),
    triggeredBy: () => 'msg_TRIGGER',
    unsupported: (_channel, part) => (part.type === 'audio' ? '这个平台不能发送语音，请改用文字。' : undefined),
    canUseAsset: (assetId) => assetId === 'ast_USABLE',
    textOf: (parts) => parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join(''),
    store,
    now: () => 1000,
    nextId: () => `ID${++sequence}`,
    log: ({ displayName, message }) => logs.push(`${displayName}：${message}`),
    ...overrides,
  }
  return { processor: new ExtensionOutboundProcessor(options), store, logs }
}

const sent: SendMessageInput[] = []
const deliver = (input: SendMessageInput) => {
  sent.push(input)
  return Promise.resolve({
    logicalMessageId: LogicalMessageIdSchema.parse(`msg_SENT${sent.length}`),
    status: 'sent' as const,
    receipts: [],
  })
}
const send = (target: ExtensionOutboundProcessor, parts: readonly MessagePart[], clientRequestId = 'call-1') =>
  target.send({ agentId, channelId, episodeId, parts, clientRequestId, sourceTurnId: 'turn-1' }, deliver)

afterEach(() => {
  sent.length = 0
})

describe('outbound processing before sending', () => {
  it('runs transformers in order, each seeing the previous output, and reports who changed the message', async () => {
    const seen: string[] = []
    const translate = extension('TRANSLATE', '翻译', { transform: true }, (message) => {
      if (message.stage !== 'draft') return undefined
      seen.push(`翻译:${message.text}`)
      return { parts: [text(`hello (${message.text})`)] }
    })
    const sign = extension('SIGN', '署名', { transform: true }, (message) => {
      if (message.stage !== 'draft') return undefined
      seen.push(`署名:${message.text}`)
      return { parts: [...message.parts, text(' —— 示例署名')] }
    })
    const quiet = extension('QUIET', '旁观', { transform: true }, () => undefined)
    const { processor: target, store } = processor([translate, quiet, sign])

    const result = await send(target, [text('你好')])

    expect(seen).toEqual(['翻译:你好', '署名:hello (你好)'])
    expect(sent[0]?.parts).toEqual([text('hello (你好)'), text(' —— 示例署名')])
    expect(result).toMatchObject({
      status: 'sent',
      processing: { processedBy: ['翻译', '署名'], rewritten: true, followUps: [] },
    })
    expect(store.records[0]).toMatchObject({
      rewritten: true,
      draftParts: [text('你好')],
      processedBy: [
        { displayName: '翻译', changed: true },
        { displayName: '旁观' },
        { displayName: '署名', changed: true },
      ],
    })
  })

  it('passes the draft with its channel, reply target and the message that woke the agent', async () => {
    const drafts: NxtOutboundMessage[] = []
    const watch = extension('WATCH', '记录', { cancel: true }, (message) => {
      drafts.push(message)
    })
    const { processor: target } = processor([watch])
    await target.send(
      { agentId, channelId, episodeId, parts: [text('收到')], replyTo: 'msg_QUOTED', clientRequestId: 'call-r' },
      deliver,
    )
    expect(drafts).toEqual([
      {
        stage: 'draft',
        channel: { id: channelId, kind: 'group', displayName: '示例频道' },
        parts: [text('收到')],
        text: '收到',
        replyTo: 'msg_QUOTED',
        triggeredBy: 'msg_TRIGGER',
      },
    ])
  })

  it('follows the order the user set rather than the enable order', async () => {
    const calls: string[] = []
    const first = extension('FIRST', '甲', { transform: true }, () => void calls.push('甲'))
    const second = extension('SECOND', '乙', { transform: true }, () => void calls.push('乙'))
    const { processor: target } = processor([first, second], {
      order: (_agent, ids) => resolveOutboundOrder([second.id], [first.id, second.id], ids),
    })
    await send(target, [text('顺序')])
    expect(calls).toEqual(['乙', '甲'])
  })

  it('skips read-only extensions before sending', async () => {
    const reader = vi.fn()
    const { processor: target, store } = processor([extension('READ', '统计', { read: true }, reader)])
    const result = await send(target, [text('只读')])
    expect(reader).not.toHaveBeenCalled()
    expect(result).toEqual({ logicalMessageId: 'msg_SENT1', status: 'sent', receipts: [] })
    // The record still exists so the message can be reported once after delivery.
    expect(store.records).toHaveLength(1)
  })

  it('stops at a cancel; later extensions do not run and nothing is sent', async () => {
    const later = vi.fn()
    const guard = extension('GUARD', '防泄密', { cancel: true }, () => ({ cancel: { reason: '含有示例密钥' } }))
    const { processor: target, store } = processor([guard, extension('LATER', '署名', { transform: true }, later)])
    const result = await send(target, [text('密钥是 fictional-key')])
    expect(later).not.toHaveBeenCalled()
    expect(sent).toHaveLength(0)
    expect(result).toEqual({
      status: 'cancelled',
      receipts: [],
      cancel: { extension: '防泄密', reason: '含有示例密钥' },
      processing: { processedBy: ['防泄密'], rewritten: false, followUps: [] },
    })
    expect(store.records[0]).toMatchObject({ cancelled: { extensionId: guard.id, reason: '含有示例密钥' } })
    expect(store.records[0]?.finalParts).toBeUndefined()

    // Repeating the same request answers from the record without running anyone again.
    const again = await send(target, [text('密钥是 fictional-key')])
    expect(again.status).toBe('cancelled')
    expect(store.records).toHaveLength(1)
  })

  it('ignores effects the extension did not declare and records why', async () => {
    const sneaky = extension('SNEAKY', '只能加工', { transform: true }, () => ({
      cancel: { reason: '想取消' },
      parts: [text('改写后')],
    }))
    const reader = extension('READER', '只读', { cancel: true }, () => ({ parts: [text('不该生效')] }))
    const { processor: target, store } = processor([sneaky, reader])
    const result = await send(target, [text('原文')])
    expect(result.status).toBe('sent')
    expect(sent[0]?.parts).toEqual([text('改写后')])
    expect(store.records[0]?.diagnostics.map(({ message }) => message)).toEqual([
      '未声明 cancel，忽略取消。',
      '未声明 transform，忽略替换的内容。',
    ])
  })

  it('appends follow-ups after the message, unprocessed, and reports them', async () => {
    const later = vi.fn()
    const tts = extension('TTS', '配音', { transform: true }, (message) =>
      message.stage === 'draft'
        ? { followUps: [{ parts: [{ type: 'image', assetId: AssetIdSchema.parse('ast_USABLE') }] }] }
        : undefined,
    )
    const { processor: target, store } = processor([tts, extension('AFTER', '署名', { transform: true }, later)])
    const result = await send(target, [text('讲个笑话')])
    expect(later).toHaveBeenCalledTimes(1)
    expect(sent.map(({ parts, clientRequestId }) => ({ parts, clientRequestId }))).toEqual([
      { parts: [text('讲个笑话')], clientRequestId: 'call-1' },
      { parts: [{ type: 'image', assetId: 'ast_USABLE' }], clientRequestId: 'call-1#follow-1' },
    ])
    expect(result).toMatchObject({
      status: 'sent',
      processing: {
        processedBy: ['配音'],
        rewritten: false,
        followUps: [{ extension: '配音', logicalMessageId: 'msg_SENT2', status: 'sent' }],
      },
    })
    expect(store.records[1]).toMatchObject({ followUpOf: store.records[0]?.id, clientRequestId: 'call-1#follow-1' })
  })

  it('rejects content the channel cannot send: empty, unsupported parts, or assets from elsewhere', async () => {
    const answers: unknown[] = [
      { parts: [] },
      { parts: [{ type: 'audio', assetId: 'ast_USABLE' }] },
      { parts: [{ type: 'image', assetId: 'ast_ELSEWHERE' }] },
      { parts: [{ type: 'text' }] },
      { followUps: [{ parts: [{ type: 'file', assetId: 'ast_ELSEWHERE' }] }] },
    ]
    for (const [index, answer] of answers.entries()) {
      const { processor: target, store } = processor([
        extension('BAD', '坏扩展', { transform: true }, () => answer as never),
      ])
      await send(target, [text('原样')], `bad-${index}`)
      expect(sent.at(-1)?.parts).toEqual([text('原样')])
      expect(store.records[0]?.diagnostics[0]?.message).toMatch(/无效/u)
    }
    expect(sent).toHaveLength(answers.length)
  })

  it('sends as it is when a handler times out or throws, unless it declared cancel on timeout', async () => {
    const slow = extension('SLOW', '慢扩展', { transform: true, timeoutMs: 100 }, () => new Promise(() => undefined))
    const broken = extension('BROKEN', '坏扩展', { transform: true }, () => {
      throw new Error('示例错误')
    })
    const passing = processor([slow, broken])
    expect((await send(passing.processor, [text('照常')])).status).toBe('sent')
    expect(sent[0]?.parts).toEqual([text('照常')])
    expect(passing.logs).toEqual([
      expect.stringContaining('慢扩展：处理超时，照常发出'),
      expect.stringContaining('坏扩展：处理出错，照常发出：示例错误'),
    ])

    const strict = extension(
      'STRICT',
      '审核',
      { cancel: true, timeoutMs: 100, onTimeout: 'cancel' },
      () => new Promise(() => undefined),
    )
    const blocking = processor([strict])
    expect(await send(blocking.processor, [text('等审核')], 'call-2')).toMatchObject({
      status: 'cancelled',
      cancel: { extension: '审核', reason: '「审核」没有及时处理完这条消息' },
    })
    expect(sent).toHaveLength(1)
  })

  it('sends directly and records nothing when the agent has no outbound extensions', async () => {
    const { processor: target, store } = processor([])
    expect(await send(target, [text('普通')])).toEqual({ logicalMessageId: 'msg_SENT1', status: 'sent', receipts: [] })
    expect(store.records).toHaveLength(0)
  })
})

describe('verification of outbound handlers', () => {
  it('calls the handler with a draft and a delivered message as declared', async () => {
    const stages: string[] = []
    await verifyOutboundHandler(
      (message) => {
        stages.push(message.stage)
        return message.stage === 'draft' ? { parts: [text('ok')] } : undefined
      },
      { read: true, transform: true, timeoutMs: 1000 },
    )
    expect(stages).toEqual(['draft', 'delivered'])
  })

  it('rejects undeclared effects and malformed answers', () => {
    expect(() =>
      checkOutboundVerificationAnswer({ cancel: { reason: 'x' } }, { transform: true, timeoutMs: 100 }),
    ).toThrow('没有声明 outbound.cancel')
    expect(() => checkOutboundVerificationAnswer({ parts: [text('x')] }, { cancel: true, timeoutMs: 100 })).toThrow(
      '没有声明 outbound.transform',
    )
    expect(() => checkOutboundVerificationAnswer({ parts: [] }, { transform: true, timeoutMs: 100 })).toThrow(
      '至少一个内容块',
    )
    expect(() => checkOutboundVerificationAnswer('ok', { transform: true, timeoutMs: 100 })).toThrow('或不返回')
    expect(() => checkOutboundVerificationAnswer({}, { cancel: true, timeoutMs: 100 })).not.toThrow()
  })
})

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('outbound processing with the channel runtime', () => {
  const createFixture = async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-outbound-'))
    directories.push(directory)
    const database = await openMigratedCoreDatabase(path.join(directory, 'core.sqlite'))
    const repository = new SqliteCoreRepository(database)
    let sequence = 0
    const core = new CoreService(repository, { now: () => 100, nextUlid: () => `A${++sequence}` })
    const connection = core.createConnection({ adapterKey: 'fixture-alpha', config: {} })
    const channel = core.createChannel({ connectionId: connection.id, platformChannelId: 'outbound', kind: 'internal' })
    const agent = core.createAgent({
      displayName: '出站智能体',
      persona: '',
      model: { provider: 'test', model: 'test' },
    })
    const opened = core.appendInbound({
      connectionId: connection.id,
      channelId: channel.id,
      adapterKey: 'fixture-alpha',
      kind: 'control',
      parts: [],
      platformTimestamp: 400,
      receivedAt: 400,
      dedupeKey: 'outbound-open',
    }).event
    const episode = EpisodeIdSchema.parse('eps_OUTBOUNDRUN')
    repository.createEpisode({
      id: episode,
      channelId: channel.id,
      agentId: agent.definition.id,
      agentRevisionId: agent.revision.id,
      status: 'opening',
      openedAtEventId: opened.id,
      createdAt: 401,
    })
    repository.activateEpisode(episode, 'dsh-outbound-test')
    const web = createFakeLocalChannelConnection(
      connection.id,
      () => Promise.reject(new Error('Inbound is not used by this test.')),
      () => 500,
    )
    const delivered: MessagePart[][] = []
    web.subscribe(({ request }) => {
      delivered.push([...request.parts])
    })
    const sessionDriver: AgentSessionDriver = {
      createSession: () => Promise.reject(new Error('not used')),
      applyCompatibleRevision: () => Promise.reject(new Error('not used')),
      sessionStatus: () => 'idle',
      findAdmissionMessage: () => undefined,
      createHandoffSummary: () => Promise.reject(new Error('not used')),
      cancelSession: () => Promise.reject(new Error('not used')),
      interruptTurn: () => Promise.reject(new Error('not used')),
      listPendingAdmissions: () => [],
      admit: () => Promise.reject(new Error('not used')),
      notifyConsoleOutbound: () => Promise.reject(new Error('not used')),
    }
    const reads: NxtOutboundMessage[] = []
    const extensions = [
      extension('STAMP', '署名', { transform: true }, (message) =>
        message.stage === 'draft'
          ? { parts: [...message.parts, text('（示例署名）')], followUps: [{ parts: [text('补充一句')] }] }
          : undefined,
      ),
      extension('LEDGER', '记账', { read: true }, (message) => {
        reads.push(message)
      }),
    ]
    const processorRef: { current?: ExtensionOutboundProcessor } = {}
    let deliverySequence = 0
    const runtime = new ChannelRuntime(core, repository, repository, sessionDriver, {
      now: () => 500,
      nextUlid: () => `DELIVERY${++deliverySequence}`,
      resolveAdapter: (connectionId) => (connectionId === connection.id ? web : undefined),
      onOutboundSettled: (snapshot) => processorRef.current?.settled(snapshot),
    })
    const { processor: target } = processor(extensions, {
      handlers: () => extensions.map((fake) => asHandler(fake, agent.definition.id)),
      store: repository.outboundProcessing,
    })
    processorRef.current = target
    await web.start()
    return { database, repository, runtime, web, delivered, reads, target, episode, agent, channel }
  }

  it('saves the processing with the message, sends follow-ups, and tells readers once even after redispatch', async () => {
    const fixture = await createFixture()
    try {
      const result = await fixture.target.send(
        {
          agentId: fixture.agent.definition.id,
          channelId: fixture.channel.id,
          episodeId: fixture.episode,
          parts: [text('今天天气不错')],
          clientRequestId: 'call-runtime',
        },
        (input) => fixture.runtime.sendMessage(input),
      )
      expect(result).toMatchObject({ status: 'sent', processing: { processedBy: ['署名'], rewritten: true } })
      expect(fixture.delivered).toEqual([[text('今天天气不错'), text('（示例署名）')], [text('补充一句')]])

      const primary = fixture.repository.findOutboundByClientRequest(
        fixture.agent.definition.id,
        fixture.channel.id,
        'call-runtime',
      )!
      const record = fixture.repository.outboundProcessing.getOutboundProcessingByIntent(primary.intent.id)
      expect(record).toMatchObject({
        rewritten: true,
        draftParts: [text('今天天气不错')],
        finalParts: [text('今天天气不错'), text('（示例署名）')],
        followUps: [{ parts: [text('补充一句')] }],
      })
      expect(record?.notifiedAt).toBe(1000)

      await vi.waitFor(() => expect(fixture.reads).toHaveLength(2))
      expect(fixture.reads[0]).toMatchObject({
        stage: 'delivered',
        logicalMessageId: primary.intent.logicalMessageId,
        parts: [text('今天天气不错'), text('（示例署名）')],
        deliveryState: 'sent',
      })
      expect(fixture.reads[1]).toMatchObject({ stage: 'delivered', parts: [text('补充一句')], followUp: true })

      // A recovered or redispatched message settles again; readers are not told twice.
      await fixture.runtime.redispatchOutbound(primary.intent.id)
      fixture.target.settled(fixture.repository.getOutbound(primary.intent.id))
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(fixture.reads).toHaveLength(2)
    } finally {
      await fixture.web.stop()
      fixture.database.close()
    }
  })

  it('keeps the order the user saved for each agent', async () => {
    const fixture = await createFixture()
    try {
      const outbound = fixture.repository.outboundProcessing
      expect(outbound.getAgentOutboundOrder(fixture.agent.definition.id)).toBeUndefined()
      const ids = [ExtensionIdSchema.parse('ext_B'), ExtensionIdSchema.parse('ext_A')]
      outbound.putAgentOutboundOrder(fixture.agent.definition.id, ids, 10)
      outbound.putAgentOutboundOrder(fixture.agent.definition.id, [...ids].reverse(), 20)
      expect(outbound.getAgentOutboundOrder(fixture.agent.definition.id)).toEqual(['ext_A', 'ext_B'])
      expect(resolveOutboundOrder(['ext_C' as ExtensionId], ['ext_A', 'ext_B'] as ExtensionId[], ids)).toEqual([
        'ext_A',
        'ext_B',
      ])
    } finally {
      await fixture.web.stop()
      fixture.database.close()
    }
  })
})
