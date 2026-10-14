import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { AssetService, CoreService } from '@nekro-nxt/core'
import { AdmissionIdSchema, EpisodeIdSchema, LogicalMessageIdSchema } from '@nekro-nxt/contracts'
import { openMigratedCoreDatabase, SqliteCoreRepository } from '@nekro-nxt/storage-sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DshHostRuntime } from '../src/index.js'

class DelayedFailedSendModel extends LlmAdapter {
  readonly calls: GenerateOptions[] = []
  sawReminder = false

  override providerInfo(provider: string) {
    return { id: provider, name: 'Delayed failed send test model' }
  }

  override listModels(provider: string) {
    return Promise.resolve([{ provider, id: 'chat-model', name: 'Chat model', inputModalities: ['text'] as const }])
  }

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text'] as const })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    const hasToolResult = options.messages.some(
      (message) => message.role === 'tool' && String(message.toolCallId) === 'slow-failed-send',
    )
    if (!hasToolResult) {
      const id = ToolCallId('slow-failed-send')
      const argumentsText = JSON.stringify({ target: { type: 'current' }, parts: [{ text: '这次投递会失败。' }] })
      const toolCall = { type: 'tool-call' as const, id, name: 'send_channel_message', arguments: argumentsText }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: toolCall.name, argumentsDelta: argumentsText }
      yield { type: 'block-end', index: 0, block: toolCall }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    this.sawReminder = options.messages.some(
      (message) => message.source?.kind === 'nekro-nxt-channel-processing-reminder',
    )
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '工具返回后继续处理。' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('channel processing reminder runtime', () => {
  it('injects once after a 60-second tool wait without interrupting the tool', async () => {
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-processing-reminder-'))
    temporaryDirectories.push(directory)
    const database = await openMigratedCoreDatabase(path.join(directory, 'core.sqlite'))
    const repository = new SqliteCoreRepository(database)
    const assetService = new AssetService(repository, path.join(directory, 'assets'))
    let sequence = 0
    const core = new CoreService(repository, { now: () => now, nextUlid: () => `P${++sequence}` })
    const definition = core.createAgent({
      displayName: '处理提醒测试智能体',
      persona: '回复频道消息。',
      model: { provider: 'test-provider', model: 'chat-model' },
    })
    const connection = core.createConnection({ adapterKey: 'fixture-alpha', config: {} })
    const channel = core.createChannel({
      connectionId: connection.id,
      platformChannelId: 'processing-reminder.test',
      kind: 'internal',
    })
    const inbound = core.appendInbound({
      connectionId: connection.id,
      channelId: channel.id,
      adapterKey: 'fixture-alpha',
      platformEventId: 'processing-reminder.test',
      kind: 'message-created',
      parts: [{ type: 'text', text: '请处理这条测试消息。' }],
      platformTimestamp: now,
      receivedAt: now,
      dedupeKey: 'processing-reminder.test',
    }).event
    let resolveToolStarted!: () => void
    const toolStarted = new Promise<void>((resolve) => {
      resolveToolStarted = resolve
    })
    let releaseTool!: () => void
    const releaseToolPromise = new Promise<void>((resolve) => {
      releaseTool = resolve
    })
    let toolReturned = false
    const model = new DelayedFailedSendModel()
    const host = await DshHostRuntime.create({
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      communication: {
        sendMessage: async () => {
          resolveToolStarted()
          await releaseToolPromise
          toolReturned = true
          return {
            logicalMessageId: LogicalMessageIdSchema.parse('msg_PROCESSING_FAILED'),
            status: 'failed',
            receipts: [],
          }
        },
      },
      history: repository,
      assets: repository,
      assetService,
      resolveAgentRevision: (revisionId) => repository.getAgentRevision(revisionId),
      configureLlm: (context) => {
        context.llm.registerAdapter(['test-provider'], model)
      },
    })
    const sessionId = await host.createSession({
      episodeId: EpisodeIdSchema.parse('eps_PROCESSINGREMINDER'),
      channelId: channel.id,
      agentId: definition.definition.id,
      agentRevisionId: definition.revision.id,
    })
    try {
      await host.admit({
        dshSessionId: sessionId,
        admissionId: AdmissionIdSchema.parse('adm_PROCESSINGREMINDER'),
        events: [inbound],
        mode: 'followup',
        replyRequired: false,
      })
      await toolStarted
      now += 60_000
      releaseTool()
      await host.whenIdle(sessionId)

      expect(toolReturned).toBe(true)
      expect(model.sawReminder).toBe(true)
      expect(
        host
          .sessionEvents(sessionId)
          .filter(
            (event) =>
              event.type === 'user/message' && event.data.source.kind === 'nekro-nxt-channel-processing-reminder',
          ),
      ).toHaveLength(1)
    } finally {
      await host.dispose()
      database.close()
    }
  })
})
