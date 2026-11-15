import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, type GenerateOptions, type Message, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { AssetService, CoreService, DEFAULT_IMAGE_UNDERSTANDING_POLICY } from '@nekro-nxt/core'
import { AdmissionIdSchema, EpisodeIdSchema, LogicalMessageIdSchema, type MessagePart } from '@nekro-nxt/contracts'
import { openMigratedCoreDatabase, SqliteCoreRepository } from '@nekro-nxt/storage-sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { DshHostRuntime } from '../src/index.js'

const imageFlags = (messages: readonly Pick<Message, 'content'>[]): boolean[] =>
  messages.flatMap((message) =>
    message.content.flatMap((block) => (block.type === 'image' ? [block.offloaded === true] : [])),
  )

const systemText = (options: GenerateOptions): string =>
  options.messages
    .filter((message) => message.role === 'system')
    .flatMap((message) => message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])))
    .join('\n')

/** A vision route with no image budget of its own: every omission in these tests is NekroNXT's limit. */
class OpenVisionModel extends LlmAdapter {
  readonly calls: GenerateOptions[] = []
  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text', 'image'] as const })
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    await Promise.resolve()
    this.calls.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '看到了。' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const disposers: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
})

const fixture = async (maxRequestImages: number | undefined, imageCount: number) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nxt-request-image-limit-'))
  disposers.push(() => rm(directory, { recursive: true, force: true }))
  const database = await openMigratedCoreDatabase(path.join(directory, 'core.sqlite'))
  disposers.push(() => database.close())
  const repository = new SqliteCoreRepository(database)
  let sequence = 0
  const core = new CoreService(repository, { nextUlid: () => `L${++sequence}` })
  const agent = core.createAgent({
    displayName: '看图智能体',
    persona: '回复频道消息。',
    model: { provider: 'vision-provider', model: 'vision-model' },
    imagePolicy: {
      ...DEFAULT_IMAGE_UNDERSTANDING_POLICY,
      history: {
        ...DEFAULT_IMAGE_UNDERSTANDING_POLICY.history,
        ...(maxRequestImages === undefined ? {} : { maxRequestImages }),
      },
    },
  })
  const connection = core.createConnection({ adapterKey: 'fixture-alpha', config: {} })
  const channel = core.createChannel({ connectionId: connection.id, platformChannelId: 'gallery', kind: 'internal' })
  const assetService = new AssetService(repository, path.join(directory, 'assets'))
  const images: MessagePart[] = []
  for (let index = 1; index <= imageCount; index += 1) {
    const bytes = await sharp({
      create: { width: index, height: 1, channels: 4, background: { r: index * 10, g: 40, b: 90, alpha: 1 } },
    })
      .png()
      .toBuffer()
    const { asset } = await assetService.prepare({ bytes: new Uint8Array(bytes), declaredMediaType: 'image/png' })
    repository.grantAssetAccess({ assetId: asset.id, channelId: channel.id, source: 'agent-tool', grantedAt: 1000 })
    images.push({ type: 'image', assetId: asset.id, alt: `第 ${index} 张` })
  }
  const model = new OpenVisionModel()
  let context: Context | undefined
  const host = await DshHostRuntime.create({
    sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
    communication: {
      sendMessage: () =>
        Promise.resolve({
          logicalMessageId: LogicalMessageIdSchema.parse(`msg_LIMIT${++sequence}`),
          status: 'sent',
          receipts: [],
        }),
    },
    history: repository,
    assets: repository,
    assetService,
    resolveAgentRevision: (revisionId) => repository.getAgentRevision(revisionId),
    configureLlm: (ctx) => {
      context = ctx
      ctx.llm.registerAdapter(['vision-provider'], model)
    },
  })
  disposers.push(() => host.dispose())
  const sessionId = await host.createSession({
    episodeId: EpisodeIdSchema.parse('eps_REQUESTIMAGES'),
    channelId: channel.id,
    agentId: agent.definition.id,
    agentRevisionId: agent.revision.id,
  })
  if (!context?.agents.get(SessionId(sessionId))) throw new Error('Missing live agent')
  const send = async (key: string, parts: readonly MessagePart[]): Promise<void> => {
    const event = core.appendInbound({
      connectionId: connection.id,
      channelId: channel.id,
      adapterKey: 'fixture-alpha',
      platformEventId: key,
      kind: 'message-created',
      parts: [...parts],
      platformTimestamp: Date.now(),
      receivedAt: Date.now(),
      dedupeKey: key,
    }).event
    await host.admit({
      dshSessionId: sessionId,
      admissionId: AdmissionIdSchema.parse(`adm_${key.toUpperCase()}`),
      events: [event],
      mode: 'followup',
      replyRequired: false,
    })
    await host.whenIdle(sessionId)
  }
  const offloadCount = () => host.sessionEvents(sessionId).filter((event) => event.type === 'image/offload').length
  return { model, images, send, offloadCount }
}

describe('request image limit in a live conversation', () => {
  it('omits the oldest images only in the round that crosses the limit, keeping earlier requests a stable prefix', async () => {
    const f = await fixture(6, 14)
    const offloadsAfterRound: number[] = []
    for (const [index, image] of f.images.entries()) {
      await f.send(`round${index + 1}`, [{ type: 'text', text: `第 ${index + 1} 张图` }, image])
      offloadsAfterRound.push(f.offloadCount())
    }
    // Limit 6, step 2: the 7th image trims to 4, and the next trim waits until there are 7 again (the 10th, 13th).
    const trimmedRounds = offloadsAfterRound.flatMap((count, index) =>
      count > (offloadsAfterRound[index - 1] ?? 0) ? [index + 1] : [],
    )
    expect(trimmedRounds).toEqual([7, 10, 13])

    const requests = f.model.calls.map((call) => imageFlags(call.messages))
    expect(requests).toHaveLength(14)
    for (const [index, flags] of requests.entries()) {
      // Every request carries the round's new image and never more than the limit.
      expect(flags.at(-1)).toBe(false)
      expect(flags.filter((offloaded) => !offloaded).length).toBeLessThanOrEqual(6)
      // What is omitted is always the oldest images.
      const firstKept = flags.indexOf(false)
      expect(flags.slice(0, firstKept).every(Boolean)).toBe(true)
      expect(flags.slice(firstKept).some(Boolean)).toBe(false)
      if (index === 0) continue
      // Outside a trimming round the request only grows: the previous one is its unchanged prefix, so the cache holds.
      const previous = requests[index - 1]!
      const unchanged = flags.slice(0, previous.length).every((flag, position) => flag === previous[position])
      expect(unchanged).toBe(!trimmedRounds.includes(index + 1))
    }
    expect(requests.at(-1)).toEqual([...Array<boolean>(9).fill(true), ...Array<boolean>(5).fill(false)])
    // The agent learns how to open an omitted image again.
    expect(systemText(f.model.calls[0]!)).toContain('`nxt-asset:` 和最后一个 `:` 之间是图片编号')
  })

  it('leaves images and the prompt alone without a limit', async () => {
    const f = await fixture(undefined, 8)
    for (const [index, image] of f.images.entries()) await f.send(`free${index + 1}`, [image])
    expect(f.offloadCount()).toBe(0)
    expect(imageFlags(f.model.calls.at(-1)!.messages)).toEqual(Array<boolean>(8).fill(false))
    expect(systemText(f.model.calls[0]!)).not.toContain('nxt-asset:')
  })
})
