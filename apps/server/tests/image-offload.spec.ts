import type { Context } from '@deepseek-ai/cordis'
import {
  IMAGE_OFFLOAD_REQUIRED_CODE,
  LlmAdapter,
  LlmError,
  type GenerateOptions,
  type Message,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { AssetService, CoreService } from '@nekro-nxt/core'
import { AdmissionIdSchema, EpisodeIdSchema, LogicalMessageIdSchema, type MessagePart } from '@nekro-nxt/contracts'
import { openMigratedCoreDatabase, SqliteCoreRepository } from '@nekro-nxt/storage-sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { OFFLOADED_IMAGE_MARKER } from '../src/channel-runtime-events.js'
import { DshHostRuntime } from '../src/index.js'
import { oldestImageTargets, visibleImageCount, type PressureMeasurement } from '../src/compaction-pressure.js'

const RETAINED_IMAGE_LIMIT = 1

const imageFlags = (messages: readonly Pick<Message, 'content'>[]): boolean[] =>
  messages.flatMap((message) =>
    message.content.flatMap((block) => (block.type === 'image' ? [block.offloaded === true] : [])),
  )

/** A vision route that accepts at most one image per request and, like the real routes, names how many to drop. */
class ImageBudgetModel extends LlmAdapter {
  readonly calls: GenerateOptions[] = []
  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text', 'image'] as const })
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    await Promise.resolve()
    this.calls.push(options)
    const retained = imageFlags(options.messages).filter((offloaded) => !offloaded).length
    if (retained > RETAINED_IMAGE_LIMIT) {
      throw new LlmError('Fixture route image budget exceeded.', IMAGE_OFFLOAD_REQUIRED_CODE, {
        offloadImages: retained - RETAINED_IMAGE_LIMIT,
      })
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '看到了。' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const disposers: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
})

const fixture = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nxt-image-offload-'))
  disposers.push(() => rm(directory, { recursive: true, force: true }))
  const database = await openMigratedCoreDatabase(path.join(directory, 'core.sqlite'))
  disposers.push(() => database.close())
  const repository = new SqliteCoreRepository(database)
  let sequence = 0
  const core = new CoreService(repository, { nextUlid: () => `O${++sequence}` })
  const agent = core.createAgent({
    displayName: '看图智能体',
    persona: '回复频道消息。',
    model: { provider: 'vision-provider', model: 'vision-model' },
  })
  const connection = core.createConnection({ adapterKey: 'fixture-alpha', config: {} })
  const channel = core.createChannel({ connectionId: connection.id, platformChannelId: 'gallery', kind: 'internal' })
  const assetService = new AssetService(repository, path.join(directory, 'assets'))
  const images: MessagePart[] = []
  for (const width of [1, 2, 3]) {
    const bytes = await sharp({
      create: { width, height: 1, channels: 4, background: { r: width * 60, g: 40, b: 90, alpha: 1 } },
    })
      .png()
      .toBuffer()
    const { asset } = await assetService.prepare({ bytes: new Uint8Array(bytes), declaredMediaType: 'image/png' })
    repository.grantAssetAccess({
      assetId: asset.id,
      channelId: channel.id,
      source: 'agent-tool',
      grantedAt: 1000,
    })
    images.push({ type: 'image', assetId: asset.id, alt: `第 ${width} 张` })
  }
  const model = new ImageBudgetModel()
  const session = {
    episodeId: EpisodeIdSchema.parse('eps_IMAGEOFFLOAD'),
    channelId: channel.id,
    agentId: agent.definition.id,
    agentRevisionId: agent.revision.id,
  }
  const start = async () => {
    let context: Context | undefined
    const host = await DshHostRuntime.create({
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      communication: {
        sendMessage: () =>
          Promise.resolve({
            logicalMessageId: LogicalMessageIdSchema.parse(`msg_OFFLOAD${++sequence}`),
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
    const sessionId = await host.createSession(session)
    const live = context?.agents.get(SessionId(sessionId))
    if (!live || !context) throw new Error('Missing live agent')
    return { host, sessionId, agent: live, context }
  }
  const send = async (
    host: DshHostRuntime,
    sessionId: string,
    key: string,
    parts: readonly MessagePart[],
  ): Promise<void> => {
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
  return { model, images, start, send }
}

describe('image offload', () => {
  it('drops the oldest images when the route is over its budget, retries, and keeps the choice on resume', async () => {
    const f = await fixture()
    const first = await f.start()
    await f.send(first.host, first.sessionId, 'gallery1', [{ type: 'text', text: '看看这三张' }, ...f.images])

    expect(f.model.calls.map((call) => imageFlags(call.messages))).toEqual([
      [false, false, false],
      [true, true, false],
    ])
    const events = first.host.sessionEvents(first.sessionId)
    expect(events.filter((event) => event.type === 'image/offload')).toHaveLength(1)
    const turnEnd = events.findLast((event) => event.type === 'turn/end')
    expect(turnEnd?.type === 'turn/end' ? turnEnd.data.reason.kind : undefined).not.toBe('error')

    const input = first.host
      .normalizedSessionEvents(first.sessionId)
      .find((event) => event.type === 'turn/input' && event.text?.includes('看看这三张'))
    const text = input?.type === 'turn/input' ? (input.text ?? '') : ''
    expect(text.split(OFFLOADED_IMAGE_MARKER)).toHaveLength(3)
    expect(text.split('［图片］')).toHaveLength(2)
    const detail = first.host.sessionInput(first.sessionId, input?.type === 'turn/input' ? input.messageId : '')
    expect(detail?.text).toBe(text)

    await first.host.dispose()
    const second = await f.start()
    expect(second.sessionId).toBe(first.sessionId)
    expect(imageFlags(second.agent.session.deriveMessages())).toEqual([true, true, false])
    // The first picture is out of view, so sending it again shows it again instead of calling it a duplicate.
    await f.send(second.host, second.sessionId, 'gallery2', [{ type: 'text', text: '再看第一张' }, f.images[0]!])
    expect(f.model.calls.slice(2).map((call) => imageFlags(call.messages))).toEqual([
      [true, true, false, false],
      [true, true, true, false],
    ])
  })

  it('omits images in the same records DSH writes, counting earlier omissions in the indexes', async () => {
    const f = await fixture()
    const live = await f.start()
    await f.send(live.host, live.sessionId, 'gallery3', [{ type: 'text', text: '看看这三张' }, ...f.images])
    // The route already had DSH omit the first two.
    expect(imageFlags(live.agent.session.deriveMessages())).toEqual([true, true, false])
    expect(visibleImageCount(live.agent.session)).toBe(1)
    const targets = oldestImageTargets(live.agent.session, 5)
    expect(targets.map((target) => target.imageIndexes)).toEqual([[2]])
    live.agent.session.append('image/offload', {
      targets: targets.map((target) => ({ ...target, imageIndexes: [...target.imageIndexes] })),
    })
    expect(imageFlags(live.agent.session.deriveMessages())).toEqual([true, true, true])
    expect(visibleImageCount(live.agent.session)).toBe(0)
    // NekroNXT reads these fields of DSH's measurement.
    const measurement: PressureMeasurement = live.context.tokenMeter.measure(live.agent.session)
    // This fixture route reports no usage, so the reading is the heuristic; offloading waits for real usage.
    expect(measurement.baseline.kind).toBe('estimated')
    expect(measurement.totalTokens).toBe(measurement.baseline.tokens + measurement.surfaceDeltaTokens)
    expect(measurement.surfaceTokens).toBeGreaterThan(0)
  })
})
