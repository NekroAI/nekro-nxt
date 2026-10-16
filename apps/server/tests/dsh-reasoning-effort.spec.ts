import { LlmAdapter, ReasoningEffortId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { AssetService, CoreService } from '@nekro-nxt/core'
import { AdmissionIdSchema, EpisodeIdSchema, LogicalMessageIdSchema } from '@nekro-nxt/contracts'
import { openMigratedCoreDatabase, SqliteCoreRepository } from '@nekro-nxt/storage-sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DshHostRuntime } from '../src/index.js'

/** A model offering two thinking levels that records what each request asked for. */
class LevelledModel extends LlmAdapter {
  readonly calls: GenerateOptions[] = []
  override resolveModel(provider: string, model: string) {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      inputModalities: ['text'] as const,
      reasoning: {
        efforts: [
          { id: ReasoningEffortId('low'), name: 'Low' },
          { id: ReasoningEffortId('high'), name: 'High' },
        ],
      },
    })
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    await Promise.resolve()
    this.calls.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '收到。' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const disposers: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
})

/** One turn of an agent saved with `reasoningEffort`; returns the level the model was asked for. */
async function requestedEffort(reasoningEffort: string): Promise<string | undefined> {
  const directory = await mkdtemp(path.join(tmpdir(), 'nxt-reasoning-effort-'))
  disposers.push(() => rm(directory, { recursive: true, force: true }))
  const database = await openMigratedCoreDatabase(path.join(directory, 'core.sqlite'))
  disposers.push(() => database.close())
  const repository = new SqliteCoreRepository(database)
  let sequence = 0
  const core = new CoreService(repository, { nextUlid: () => `E${++sequence}` })
  const agent = core.createAgent({
    displayName: '思考强度测试智能体',
    persona: '回复频道消息。',
    model: { provider: 'test-provider', model: 'chat-model', reasoningEffort },
  })
  const connection = core.createConnection({ adapterKey: 'fixture-alpha', config: {} })
  const channel = core.createChannel({
    connectionId: connection.id,
    platformChannelId: 'effort.test',
    kind: 'internal',
  })
  const model = new LevelledModel()
  const host = await DshHostRuntime.create({
    sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
    communication: {
      sendMessage: () =>
        Promise.resolve({
          logicalMessageId: LogicalMessageIdSchema.parse(`msg_EFFORT${++sequence}`),
          status: 'sent',
          receipts: [],
        }),
    },
    history: repository,
    assets: repository,
    assetService: new AssetService(repository, path.join(directory, 'assets')),
    resolveAgentRevision: (revisionId) => repository.getAgentRevision(revisionId),
    configureLlm: (context) => {
      context.llm.registerAdapter(['test-provider'], model)
    },
  })
  disposers.push(() => host.dispose())
  const sessionId = await host.createSession({
    episodeId: EpisodeIdSchema.parse('eps_EFFORT'),
    channelId: channel.id,
    agentId: agent.definition.id,
    agentRevisionId: agent.revision.id,
  })
  const event = core.appendInbound({
    connectionId: connection.id,
    channelId: channel.id,
    adapterKey: 'fixture-alpha',
    platformEventId: 'effort-1',
    kind: 'message-created',
    parts: [{ type: 'text', text: '你好' }],
    platformTimestamp: Date.now(),
    receivedAt: Date.now(),
    dedupeKey: 'effort-1',
  }).event
  await host.admit({
    dshSessionId: sessionId,
    admissionId: AdmissionIdSchema.parse('adm_EFFORT1'),
    events: [event],
    mode: 'followup',
    replyRequired: false,
  })
  await host.whenIdle(sessionId)
  expect(model.calls.length).toBeGreaterThan(0)
  return model.calls[0]?.reasoningEffort === undefined ? undefined : String(model.calls[0].reasoningEffort)
}

describe('agent thinking level', () => {
  it('asks the model for the level saved with the agent', async () => {
    expect(await requestedEffort('high')).toBe('high')
  })

  it('falls back to the model default when the model no longer offers the saved level', async () => {
    expect(await requestedEffort('max')).toBeUndefined()
  })
})
