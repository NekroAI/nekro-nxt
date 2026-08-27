import { LlmAdapter, CallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import {
  DeepSeekAdapter,
  DeepSeekFileStore,
  DeepSeekUploadIndex,
  resolveAdapterOptions,
} from '@deepseek-ai/dsh-llm-deepseek'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { createWebAdapterConnection } from '@nekro-nxt/adapter-web'
import { ChannelRuntime } from '@nekro-nxt/channel-runtime'
import { AssetService, CoreService, type AssetRecord } from '@nekro-nxt/core'
import {
  AdmissionIdSchema,
  AssetIdSchema,
  EpisodeHandoffIdSchema,
  EpisodeIdSchema,
  LogicalMessageIdSchema,
} from '@nekro-nxt/contracts'
import {
  ExtensionActivationCoordinator,
  ExtensionBuilder,
  ExtensionService,
  ExtensionSourceStore,
} from '@nekro-nxt/extension-runtime'
import { NEKRO_NXT_EXTENSION_AUTHORING_REFERENCE } from '@nekro-nxt/extension-sdk'
import { admissions, openMigratedCoreDatabase, SqliteCoreRepository } from '@nekro-nxt/storage-sqlite'
import { access, mkdtemp, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { assertHostDshPackageVersions, ChannelExtensionActivationHost, DshHostRuntime } from '../src/index.ts'
import { normalizeSessionEvents } from '../src/channel-runtime-events.ts'
import { projectChannelRuntime } from '../src/channel-runtime-projection.ts'

const temporaryDirectories: string[] = []

const DeepSeekWireRequestSchema = z.object({
  messages: z.array(z.object({ role: z.string(), content: z.unknown().optional() })),
})

const isDeepSeekWireImagePart = (part: unknown): boolean => {
  if (typeof part !== 'object' || part === null || !('type' in part)) return false
  return part.type === 'file' || part.type === 'image_url'
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

class ScriptedCommunicationModel extends LlmAdapter {
  calls: GenerateOptions[] = []

  constructor(readonly supportsImage = false) {
    super()
  }

  override providerInfo(provider: string) {
    return { id: provider, name: 'Deterministic communication model' }
  }

  override listModels(provider: string) {
    return Promise.resolve([
      {
        provider,
        id: 'chat-model',
        name: 'Chat model',
        inputModalities: this.supportsImage ? (['text', 'image'] as const) : (['text'] as const),
      },
    ])
  }

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      inputModalities: this.supportsImage ? (['text', 'image'] as const) : (['text'] as const),
      context: { contextWindow: 128_000 },
    })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    await Promise.resolve()
    this.calls.push(options)
    if (options.purpose === 'compaction') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '保留频道任务、图片引用和最近结论。' }
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'text', text: '保留频道任务、图片引用和最近结论。' },
      }
      yield { type: 'usage', usage: { inputTokens: 64, outputTokens: 12 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (options.system?.startsWith('你是对话交接摘要器')) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '用户希望继续当前频道任务，并保持简洁准确。' }
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'text', text: '用户希望继续当前频道任务，并保持简洁准确。' },
      }
      yield { type: 'usage', usage: { inputTokens: 64, outputTokens: 12 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const hasToolResult = options.messages.some((message) =>
      message.content.some((block) => block.type === 'tool-result'),
    )
    if (!hasToolResult) {
      const contextCallId = CallId('scripted-channel-context')
      const contextToolCall = {
        type: 'tool-call' as const,
        id: contextCallId,
        name: 'nekro_nxt_channel_context',
        arguments: '{}',
      }
      const sendCallId = CallId('scripted-send-message')
      const sendToolCall = {
        type: 'tool-call' as const,
        id: sendCallId,
        name: 'send_channel_message',
        arguments: JSON.stringify({
          target: { type: 'current' },
          parts: [{ text: '这是通信工具确认发送的回复。' }],
        }),
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '这段模型原始文字只能留在运行轨迹。' }
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'text', text: '这段模型原始文字只能留在运行轨迹。' },
      }
      yield { type: 'block-start', index: 1, blockType: 'tool-call' }
      yield {
        type: 'tool-call-delta',
        index: 1,
        id: contextCallId,
        name: 'nekro_nxt_channel_context',
        argumentsDelta: contextToolCall.arguments,
      }
      yield { type: 'block-end', index: 1, block: contextToolCall }
      yield { type: 'block-start', index: 2, blockType: 'tool-call' }
      yield {
        type: 'tool-call-delta',
        index: 2,
        id: sendCallId,
        name: 'send_channel_message',
        argumentsDelta: sendToolCall.arguments,
      }
      yield { type: 'block-end', index: 2, block: sendToolCall }
      yield { type: 'usage', usage: { inputTokens: 32, outputTokens: 24 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }

    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: '工具完成后的原始结束文字也不会发送。' }
    yield {
      type: 'block-end',
      index: 0,
      block: { type: 'text', text: '工具完成后的原始结束文字也不会发送。' },
    }
    yield { type: 'usage', usage: { inputTokens: 48, outputTokens: 8 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class ToolSchemaProbeModel extends ScriptedCommunicationModel {
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    await Promise.resolve()
    this.calls.push(options)
    const text = '工具 schema 回归探针。'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 4 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class ReplyGuardThenSendModel extends ScriptedCommunicationModel {
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    await Promise.resolve()
    this.calls.push(options)
    const hasGuardReminder = options.messages.some((message) => message.source.kind === 'nekro-nxt-channel-reply-guard')
    const hasSendResult = options.messages.some((message) =>
      message.content.some(
        (block) => block.type === 'tool-result' && block.toolCallId === CallId('guard-recovery-send'),
      ),
    )
    if (hasGuardReminder && !hasSendResult) {
      const callId = CallId('guard-recovery-send')
      const toolCall = {
        type: 'tool-call' as const,
        id: callId,
        name: 'send_channel_message',
        arguments: JSON.stringify({ target: { type: 'current' }, parts: [{ text: '守卫提醒后的真实回复。' }] }),
      }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield {
        type: 'tool-call-delta',
        index: 0,
        id: callId,
        name: toolCall.name,
        argumentsDelta: toolCall.arguments,
      }
      yield { type: 'block-end', index: 0, block: toolCall }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const text = hasSendResult ? '发送后的内部结束文字。' : '第一次只输出普通模型文字。'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class ReplyGuardNeverSendModel extends ScriptedCommunicationModel {
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    await Promise.resolve()
    this.calls.push(options)
    const text = `第 ${this.calls.length} 次仍只输出普通模型文字。`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class MultiStageCommunicationModel extends ScriptedCommunicationModel {
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    await Promise.resolve()
    this.calls.push(options)
    const hasResult = (callId: string): boolean =>
      options.messages.some((message) =>
        message.content.some((block) => block.type === 'tool-result' && String(block.toolCallId) === callId),
      )
    let callId: ReturnType<typeof CallId> | undefined
    let name = ''
    let argumentsText = ''
    if (!hasResult('multi-stage-opening')) {
      callId = CallId('multi-stage-opening')
      name = 'send_channel_message'
      argumentsText = JSON.stringify({ target: { type: 'current' }, parts: [{ text: '我已经开始处理。' }] })
    } else if (!hasResult('multi-stage-context')) {
      callId = CallId('multi-stage-context')
      name = 'nekro_nxt_channel_context'
      argumentsText = '{}'
    } else if (!hasResult('multi-stage-progress')) {
      callId = CallId('multi-stage-progress')
      name = 'send_channel_message'
      argumentsText = JSON.stringify({ target: { type: 'current' }, parts: [{ text: '已经确认当前频道。' }] })
    } else if (!hasResult('multi-stage-final')) {
      callId = CallId('multi-stage-final')
      name = 'send_channel_message'
      argumentsText = JSON.stringify({ target: { type: 'current' }, parts: [{ text: '处理完成。' }] })
    }
    if (callId !== undefined) {
      const toolCall = { type: 'tool-call' as const, id: callId, name, arguments: argumentsText }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: argumentsText }
      yield { type: 'block-end', index: 0, block: toolCall }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const text = '多阶段发送后的内部结束文字。'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class FinalOnlyCommunicationModel extends ScriptedCommunicationModel {
  constructor(
    private readonly callId: string,
    private readonly visibleText: string,
    private readonly expectedPersonaText: string,
  ) {
    super()
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    await Promise.resolve()
    this.calls.push(options)
    if (!options.system?.includes(this.expectedPersonaText)) {
      throw new Error(`Expected persona text was not present: ${this.expectedPersonaText}`)
    }
    const hasResult = options.messages.some((message) =>
      message.content.some((block) => block.type === 'tool-result' && String(block.toolCallId) === this.callId),
    )
    if (!hasResult) {
      const callId = CallId(this.callId)
      const argumentsText = JSON.stringify({
        target: { type: 'current' },
        parts: [{ text: this.visibleText }],
      })
      const toolCall = {
        type: 'tool-call' as const,
        id: callId,
        name: 'send_channel_message',
        arguments: argumentsText,
      }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield {
        type: 'tool-call-delta',
        index: 0,
        id: callId,
        name: toolCall.name,
        argumentsDelta: argumentsText,
      }
      yield { type: 'block-end', index: 0, block: toolCall }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const text = '最终结果发送后的内部结束文字。'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class ImageInspectionProbeModel extends ScriptedCommunicationModel {
  constructor(private readonly assetIds: readonly string[]) {
    super(true)
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    await Promise.resolve()
    this.calls.push(options)
    const hasInspectionResult = options.messages.some((message) =>
      message.content.some(
        (block) =>
          block.type === 'tool-result' &&
          block.content.some((child) => child.type === 'text' && child.text.includes('批量图片问题')),
      ),
    )
    if (!hasInspectionResult) {
      const callId = CallId('scripted-image-inspection')
      const toolCall = {
        type: 'tool-call' as const,
        id: callId,
        name: 'asset_inspect_images',
        arguments: JSON.stringify({
          images: [
            { assetId: this.assetIds[0], focus: '确认是否已驻留' },
            { assetId: this.assetIds[1], focus: '读取新图片' },
          ],
          question: '比较两张图片',
          detail: 'high',
        }),
      }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield {
        type: 'tool-call-delta',
        index: 0,
        id: callId,
        name: toolCall.name,
        argumentsDelta: toolCall.arguments,
      }
      yield { type: 'block-end', index: 0, block: toolCall }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: '图片检查完成。' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '图片检查完成。' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class TextInspectionProbeModel extends ScriptedCommunicationModel {
  constructor(private readonly assetId: string) {
    super(false)
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    await Promise.resolve()
    this.calls.push(options)
    if (this.calls.length % 2 === 1) {
      const callId = CallId('scripted-delegated-image-inspection')
      const toolCall = {
        type: 'tool-call' as const,
        id: callId,
        name: 'asset_inspect_images',
        arguments: JSON.stringify({
          images: [{ assetId: this.assetId, focus: '读取文字' }],
          question: '图片写了什么？',
        }),
      }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield {
        type: 'tool-call-delta',
        index: 0,
        id: callId,
        name: toolCall.name,
        argumentsDelta: toolCall.arguments,
      }
      yield { type: 'block-end', index: 0, block: toolCall }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: '已收到结构化图片证据。' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '已收到结构化图片证据。' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class AuxiliaryVisionEvidenceModel extends ScriptedCommunicationModel {
  constructor(private readonly assetId: string) {
    super(true)
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    await Promise.resolve()
    this.calls.push(options)
    const evidence = JSON.stringify({
      answer: '图片中可见一个测试像素。',
      images: [
        {
          index: 0,
          assetId: this.assetId,
          focus: '读取文字',
          answer: '没有可辨认文字。',
          observations: ['可见单个像素图像'],
          uncertainty: ['分辨率过低'],
        },
      ],
      comparisons: [],
      uncertainty: ['无法从单像素判断更多内容'],
    })
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: evidence }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: evidence } }
    yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 20 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class InvalidImageInspectionProbeModel extends ScriptedCommunicationModel {
  constructor(private readonly argumentSets: readonly unknown[]) {
    super(true)
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    await Promise.resolve()
    this.calls.push(options)
    if (this.calls.length % 2 === 1) {
      const invocation = Math.floor((this.calls.length - 1) / 2)
      const callId = CallId(`invalid-image-inspection-${invocation}`)
      const toolCall = {
        type: 'tool-call' as const,
        id: callId,
        name: 'asset_inspect_images',
        arguments: JSON.stringify(this.argumentSets[invocation]),
      }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield {
        type: 'tool-call-delta',
        index: 0,
        id: callId,
        name: toolCall.name,
        argumentsDelta: toolCall.arguments,
      }
      yield { type: 'block-end', index: 0, block: toolCall }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: '已收到确定性图片检查错误。' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '已收到确定性图片检查错误。' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

describe('DSH Host and Web Channel vertical slice', () => {
  it('supports multi-stage sends, steers one reply reminder, and persists an unreplied outcome after a second miss', async () => {
    const runScenario = async (model: ScriptedCommunicationModel, suffix: string, persona = '回复频道消息。') => {
      const directory = await mkdtemp(path.join(tmpdir(), `nekro-nxt-reply-guard-${suffix}-`))
      temporaryDirectories.push(directory)
      const database = await openMigratedCoreDatabase(path.join(directory, 'core.sqlite'))
      const repository = new SqliteCoreRepository(database)
      const assetService = new AssetService(repository, path.join(directory, 'assets'))
      let sequence = 0
      const core = new CoreService(repository, { now: () => 700, nextUlid: () => `G${++sequence}` })
      const definition = core.createAgent({
        displayName: '回复守卫测试智能体',
        persona,
        model: { provider: 'test-provider', model: 'chat-model' },
      })
      const connection = core.createConnection({ adapterKey: 'web', config: {} })
      const channel = core.createChannel({
        connectionId: connection.id,
        platformChannelId: `reply-guard-${suffix}`,
        kind: 'web',
      })
      const inbound = core.appendInbound({
        connectionId: connection.id,
        channelId: channel.id,
        adapterKey: 'web',
        platformEventId: `reply-guard-${suffix}`,
        kind: 'message-created',
        parts: [{ type: 'text', text: '请回复这条测试消息。' }],
        platformTimestamp: 700,
        receivedAt: 700,
        dedupeKey: `reply-guard:${suffix}`,
      }).event
      const sentParts: unknown[] = []
      const host = await DshHostRuntime.create({
        sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
        communication: {
          sendMessage: (input) => {
            sentParts.push(input.parts)
            return Promise.resolve({
              logicalMessageId: LogicalMessageIdSchema.parse(`msg_GUARD${suffix.toUpperCase()}`),
              status: 'sent',
              receipts: [],
            })
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
      const episodeId = EpisodeIdSchema.parse(`eps_GUARD${suffix.toUpperCase()}`)
      const sessionId = await host.createSession({
        episodeId,
        channelId: channel.id,
        agentId: definition.definition.id,
        agentRevisionId: definition.revision.id,
      })
      await host.admit({
        dshSessionId: sessionId,
        admissionId: AdmissionIdSchema.parse(`adm_GUARD${suffix.toUpperCase()}`),
        events: [inbound],
        mode: 'followup',
      })
      await host.whenIdle(sessionId)
      const events = host.sessionEvents(sessionId)
      const projection = projectChannelRuntime({
        channelId: channel.id,
        agentId: definition.definition.id,
        episodeId,
        sessionStatus: host.sessionStatus(sessionId),
        pendingInjectCount: 0,
        events: normalizeSessionEvents(events),
      })
      return {
        assetService,
        channel,
        database,
        definition,
        directory,
        episodeId,
        events,
        host,
        projection,
        repository,
        sentParts,
        sessionId,
      }
    }

    const recovered = await runScenario(new ReplyGuardThenSendModel(), 'RECOVERED')
    try {
      expect(recovered.sentParts).toEqual([[{ type: 'text', text: '守卫提醒后的真实回复。' }]])
      expect(
        recovered.events.filter(
          (event) => event.type === 'user/message' && event.data.source.kind === 'nekro-nxt-channel-reply-guard',
        ),
      ).toHaveLength(1)
      expect(recovered.projection.turns[0]).toMatchObject({ state: 'completed', producedReply: true })
      expect(JSON.stringify(recovered.events)).toContain('发送后的内部结束文字。')
      expect(JSON.stringify(recovered.events)).toContain('普通 text 或 reasoning 仍只保存在内部运行轨迹中')
    } finally {
      await recovered.host.dispose()
      recovered.database.close()
    }

    const multiStage = await runScenario(new MultiStageCommunicationModel(), 'MULTISTAGE')
    try {
      expect(multiStage.sentParts).toEqual([
        [{ type: 'text', text: '我已经开始处理。' }],
        [{ type: 'text', text: '已经确认当前频道。' }],
        [{ type: 'text', text: '处理完成。' }],
      ])
      expect(
        multiStage.events.filter(
          (event) => event.type === 'user/message' && event.data.source.kind === 'nekro-nxt-channel-reply-guard',
        ),
      ).toHaveLength(0)
      expect(multiStage.projection.turns[0]).toMatchObject({ state: 'completed', producedReply: true })
      expect(JSON.stringify(multiStage.events)).toContain('多阶段发送后的内部结束文字。')
    } finally {
      await multiStage.host.dispose()
      multiStage.database.close()
    }

    const quiet = await runScenario(
      new FinalOnlyCommunicationModel('quiet-final', '安静执行后的最终结果。', '只发送最终结果'),
      'QUIET',
      '只发送最终结果，不发送开场确认或过程消息。',
    )
    try {
      expect(quiet.sentParts).toEqual([[{ type: 'text', text: '安静执行后的最终结果。' }]])
      expect(
        quiet.events.filter(
          (event) => event.type === 'user/message' && event.data.source.kind === 'nekro-nxt-channel-reply-guard',
        ),
      ).toHaveLength(0)
      expect(quiet.projection.turns).toHaveLength(1)
      expect(quiet.projection.turns[0]).toMatchObject({ state: 'completed', producedReply: true })
    } finally {
      await quiet.host.dispose()
      quiet.database.close()
    }

    const quick = await runScenario(
      new FinalOnlyCommunicationModel('quick-final', '快速任务的直接结果。', '直接给出结果'),
      'QUICK',
      '这是快速任务，直接给出结果，不添加寒暄。',
    )
    try {
      expect(quick.sentParts).toEqual([[{ type: 'text', text: '快速任务的直接结果。' }]])
      expect(
        quick.events.filter(
          (event) => event.type === 'user/message' && event.data.source.kind === 'nekro-nxt-channel-reply-guard',
        ),
      ).toHaveLength(0)
      expect(quick.projection.turns).toHaveLength(1)
      expect(quick.projection.turns[0]).toMatchObject({ state: 'completed', producedReply: true })
    } finally {
      await quick.host.dispose()
      quick.database.close()
    }

    const missed = await runScenario(new ReplyGuardNeverSendModel(), 'MISSED')
    let missedHostDisposed = false
    try {
      expect(missed.sentParts).toEqual([])
      expect(
        missed.events.filter(
          (event) => event.type === 'user/message' && event.data.source.kind === 'nekro-nxt-channel-reply-guard',
        ),
      ).toHaveLength(1)
      expect(missed.projection.turns[0]).toMatchObject({ state: 'unreplied', producedReply: false })
      expect(missed.projection.summary).toBe('智能体本轮未产生频道回复。')
      await missed.host.dispose()
      missedHostDisposed = true
      const resumed = await DshHostRuntime.create({
        sessionDatabasePath: path.join(missed.directory, 'sessions.sqlite'),
        communication: { sendMessage: () => Promise.reject(new Error('Unexpected resumed communication call.')) },
        history: missed.repository,
        assets: missed.repository,
        assetService: missed.assetService,
        resolveAgentRevision: (revisionId) => missed.repository.getAgentRevision(revisionId),
        configureLlm: (context) => {
          context.llm.registerAdapter(['test-provider'], new ReplyGuardNeverSendModel())
        },
      })
      try {
        await expect(
          resumed.createSession({
            episodeId: missed.episodeId,
            channelId: missed.channel.id,
            agentId: missed.definition.definition.id,
            agentRevisionId: missed.definition.revision.id,
          }),
        ).resolves.toBe(missed.sessionId)
        const resumedProjection = projectChannelRuntime({
          channelId: missed.channel.id,
          agentId: missed.definition.definition.id,
          episodeId: missed.episodeId,
          sessionStatus: resumed.sessionStatus(missed.sessionId),
          pendingInjectCount: 0,
          events: normalizeSessionEvents(resumed.sessionEvents(missed.sessionId)),
        })
        expect(resumedProjection.turns[0]).toMatchObject({ state: 'unreplied', producedReply: false })
      } finally {
        await resumed.dispose()
      }
    } finally {
      if (!missedHostDisposed) await missed.host.dispose()
      missed.database.close()
    }
  })

  it('keeps ImageBlock entries when the rc.2 tool-result pruner trims long text', async () => {
    const context = new Context()
    try {
      await context.plugin(TokenMeter)
      await context.plugin(ToolResultPruner, { thresholdChars: 120, headChars: 30, tailChars: 30 })
      const image = {
        type: 'image' as const,
        attachment: {
          attachmentId: AttachmentId('ast_synthetic_pruner_image'),
          mediaType: 'image/png' as const,
          bytes: 68,
          width: 1,
          height: 1,
        },
      }
      const pruned = context.toolResultPruner.pruneContent([
        { type: 'text', text: '头'.repeat(300) },
        image,
        { type: 'text', text: '尾'.repeat(300) },
      ])
      expect(pruned).not.toBeNull()
      expect(pruned?.filter((block) => block.type === 'image')).toEqual([image])
    } finally {
      await context.fiber.dispose()
    }
  })

  it('resumes persisted pending handoff and Admission messages without inserting duplicate identities', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-dsh-pending-resume-'))
    temporaryDirectories.push(directory)
    const database = await openMigratedCoreDatabase(path.join(directory, 'core.sqlite'))
    const repository = new SqliteCoreRepository(database)
    const assetService = new AssetService(repository, path.join(directory, 'assets'))
    let coreId = 0
    const core = new CoreService(repository, { now: () => 100, nextUlid: () => `P${++coreId}` })
    const agent = core.createAgent({
      displayName: '恢复测试智能体',
      persona: '',
      model: { provider: 'test-provider', model: 'chat-model' },
    })
    const connection = core.createConnection({ adapterKey: 'web', config: {} })
    const channel = core.createChannel({ connectionId: connection.id, platformChannelId: 'pending', kind: 'web' })
    const event = core.appendInbound({
      connectionId: connection.id,
      channelId: channel.id,
      adapterKey: 'web',
      platformEventId: 'pending-event',
      kind: 'message-created',
      parts: [{ type: 'text', text: '待恢复消息' }],
      platformTimestamp: 100,
      receivedAt: 100,
      dedupeKey: 'web:pending-event',
    }).event
    const createHost = () =>
      DshHostRuntime.create({
        sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
        communication: { sendMessage: () => Promise.reject(new Error('Unexpected communication call.')) },
        history: repository,
        assets: repository,
        assetService,
        resolveAgentRevision: (revisionId) => repository.getAgentRevision(revisionId),
        configureLlm: (context: Context) => {
          context.llm.registerAdapter(['test-provider'], new ScriptedCommunicationModel())
        },
      })
    const hosts: DshHostRuntime[] = []
    const sessionInput = {
      episodeId: EpisodeIdSchema.parse('eps_PENDINGRESUME'),
      channelId: channel.id,
      agentId: agent.definition.id,
      agentRevisionId: agent.revision.id,
      handoff: {
        id: EpisodeHandoffIdSchema.parse('hof_PENDINGRESUME'),
        fromEpisodeId: EpisodeIdSchema.parse('eps_PENDINGPREVIOUS'),
        sourceEventIds: [],
        createdAt: 100,
        provider: 'test-provider',
        model: 'chat-model',
        summary: '待恢复的交接摘要。',
        recentEvents: [],
      },
    } as const

    try {
      const firstHost = await createHost()
      hosts.push(firstHost)
      const sessionId = await firstHost.createSession(sessionInput)

      const resumedHost = await createHost()
      hosts.push(resumedHost)
      await expect(resumedHost.createSession(sessionInput)).resolves.toBe(sessionId)
      const admissionId = AdmissionIdSchema.parse('adm_PENDINGRESUME')
      await resumedHost.admit({ dshSessionId: sessionId, admissionId, events: [event], mode: 'inject' })
      expect(resumedHost.findAdmissionMessage(sessionId, admissionId)).toBe(`nxt-${admissionId}`)

      const secondResume = await createHost()
      hosts.push(secondResume)
      await expect(secondResume.createSession(sessionInput)).resolves.toBe(sessionId)
      expect(secondResume.findAdmissionMessage(sessionId, admissionId)).toBe(`nxt-${admissionId}`)
    } finally {
      await Promise.allSettled(hosts.map((host) => host.dispose()))
      database.close()
    }
  })

  it('switches a persisted Activation through Episode handoff before mounting its Tool', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-dsh-activation-'))
    temporaryDirectories.push(directory)
    const database = await openMigratedCoreDatabase(path.join(directory, 'core.sqlite'))
    const repository = new SqliteCoreRepository(database)
    const assetService = new AssetService(repository, path.join(directory, 'assets'))
    let coreId = 0
    let runtimeId = 0
    let extensionId = 0
    const core = new CoreService(repository, { now: () => 400, nextUlid: () => `S${++coreId}` })
    const agent = core.createAgent({
      displayName: '启用智能体',
      persona: '',
      model: { provider: 'test-provider', model: 'chat-model' },
    })
    const connection = core.createConnection({ adapterKey: 'web', config: {} })
    const channel = core.createChannel({ connectionId: connection.id, platformChannelId: 'activation', kind: 'web' })
    core.createBinding({ channelId: channel.id, agentId: agent.definition.id, triggerPolicy: 'always' })
    const runtimeRef: { current?: ChannelRuntime } = {}
    const web = createWebAdapterConnection(connection.id, (event) => runtimeRef.current!.acceptInbound(event))
    const model = new ScriptedCommunicationModel()
    const host = await DshHostRuntime.create({
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      communication: { sendMessage: (input) => runtimeRef.current!.sendMessage(input) },
      history: repository,
      assets: repository,
      assetService,
      resolveAgentRevision: (revisionId) => repository.getAgentRevision(revisionId),
      configureLlm: (context) => {
        context.llm.registerAdapter(['test-provider'], model)
      },
    })
    const runtime = new ChannelRuntime(core, repository, repository, host, {
      now: () => 401,
      nextUlid: () => `SR${++runtimeId}`,
      resolveAdapter: () => web,
    })
    runtimeRef.current = runtime
    const sourceStore = new ExtensionSourceStore(path.join(directory, 'extension-data'))
    const service = new ExtensionService(repository, sourceStore, {
      now: () => 500 + extensionId,
      nextUlid: () => `SX${++extensionId}`,
    })
    let coordinator: ExtensionActivationCoordinator | undefined
    try {
      await web.start()
      await web.postMessage({
        channelId: channel.id,
        clientEventId: 'activation-before',
        parts: [{ type: 'text', text: '建立启用前会话。' }],
      })
      const before = repository.getActiveEpisode(channel.id, agent.definition.id)!
      await host.whenIdle(before.dshSessionId!)

      const saved = await service.saveDynamicPackage({
        snapshot: {
          name: '安全启用探针',
          purpose: '验证 Activation 先交接 Session。',
          hostCode: `return {
          inject: ['tools'],
          apply(ctx) {
            const tool = harness.defineTool({
              name: 'activation_probe',
              description: 'Activation probe',
              parameters: {},
              output: { schema: { type: 'string' }, render(_args, value) { return [{ type: 'text', text: value }] } },
              execute() { return 'active' }
            })
            harness.registerTool(ctx, tool)
          }
        }`,
        },
        slug: 'activation-probe',
        displayName: '安全启用探针',
        description: '安全启用验证。',
        createdByAgentId: agent.definition.id,
      })
      coordinator = new ExtensionActivationCoordinator(
        repository,
        service,
        new ExtensionBuilder(path.join(directory, 'extension-cache')),
        new ChannelExtensionActivationHost(runtime, host),
        { now: () => 600 },
      )
      await coordinator.activate({
        agentId: agent.definition.id,
        extensionId: saved.extension.id,
        revisionId: saved.revision.id,
      })
      expect(repository.getEpisode(before.id)).toMatchObject({
        status: 'closed',
        closeReason: 'incompatible-activation',
      })
      const after = repository.getActiveEpisode(channel.id, agent.definition.id)!
      expect(after.dshSessionId).not.toBe(before.dshSessionId)
      expect(host.toolNames(after.dshSessionId!)).toContain('activation_probe')
    } finally {
      await coordinator?.dispose()
      await web.stop()
      await host.dispose()
      database.close()
    }
  })

  it('mounts dynamic creation only for the granted revision and disposes its scoped effects', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-dsh-creation-'))
    temporaryDirectories.push(directory)
    const database = await openMigratedCoreDatabase(path.join(directory, 'core.sqlite'))
    const repository = new SqliteCoreRepository(database)
    const assetService = new AssetService(repository, path.join(directory, 'assets'))
    let coreId = 0
    const core = new CoreService(repository, { now: () => 500, nextUlid: () => `D${++coreId}` })
    const enabled = core.createAgent({
      displayName: '创造智能体',
      persona: '',
      model: { provider: 'test-provider', model: 'chat-model' },
      capabilities: { dynamicCreation: true },
    })
    const denied = core.createAgent({
      displayName: '普通智能体',
      persona: '',
      model: { provider: 'test-provider', model: 'chat-model' },
    })
    const connection = core.createConnection({ adapterKey: 'web', config: {} })
    const enabledChannel = core.createChannel({
      connectionId: connection.id,
      platformChannelId: 'creation-enabled',
      kind: 'web',
    })
    const deniedChannel = core.createChannel({
      connectionId: connection.id,
      platformChannelId: 'creation-denied',
      kind: 'web',
    })
    const model = new ToolSchemaProbeModel()
    const host = await DshHostRuntime.create({
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      communication: { sendMessage: () => Promise.reject(new Error('not used')) },
      history: repository,
      assets: repository,
      assetService,
      resolveAgentRevision: (revisionId) => repository.getAgentRevision(revisionId),
      configureLlm: (context) => {
        context.llm.registerAdapter(['test-provider'], model)
      },
    })
    const enabledEpisode = EpisodeIdSchema.parse('eps_DYNAMICENABLED')
    const deniedEpisode = EpisodeIdSchema.parse('eps_DYNAMICDENIED')
    try {
      const enabledSession = await host.createSession({
        episodeId: enabledEpisode,
        channelId: enabledChannel.id,
        agentId: enabled.definition.id,
        agentRevisionId: enabled.revision.id,
      })
      const deniedSession = await host.createSession({
        episodeId: deniedEpisode,
        channelId: deniedChannel.id,
        agentId: denied.definition.id,
        agentRevisionId: denied.revision.id,
      })

      let modelEventId = 0
      const appendModelEvent = (channelId: typeof enabledChannel.id, text: string) =>
        core.appendInbound({
          connectionId: connection.id,
          channelId,
          adapterKey: 'web',
          platformEventId: `dynamic-model-${++modelEventId}`,
          kind: 'message-created',
          parts: [{ type: 'text', text }],
          platformTimestamp: 500 + modelEventId,
          receivedAt: 500 + modelEventId,
          dedupeKey: `dynamic-model:${modelEventId}:${channelId}`,
        }).event
      const modelToolNamesAfter = async (
        dshSessionId: string,
        channelId: typeof enabledChannel.id,
        admissionId: string,
        text: string,
      ): Promise<readonly string[]> => {
        const previousCallCount = model.calls.length
        await host.admit({
          dshSessionId,
          admissionId: AdmissionIdSchema.parse(admissionId),
          events: [appendModelEvent(channelId, text)],
          mode: 'followup',
        })
        await host.whenIdle(dshSessionId)
        expect(model.calls.length).toBeGreaterThan(previousCallCount)
        const request = model.calls.at(-1)
        expect(request?.tools).toBeDefined()
        return request?.tools?.map(({ name }) => name) ?? []
      }

      expect(host.dynamicToolNames(enabledSession)).toEqual(
        expect.arrayContaining([
          'cordis_inspect_list',
          'cordis_inspect_query',
          'cordis_inspect_self',
          'cordis_define',
          'cordis_run',
          'cordis_stop',
          'cordis_undefine',
          'skill',
        ]),
      )
      expect(host.toolNames(enabledSession)).toContain('asset_create')
      expect(host.toolNames(deniedSession)).toContain('asset_create')
      expect(() => host.dynamicToolNames(deniedSession)).toThrow('not granted')
      expect(await host.queryNekroNxtInspect(enabledSession, 'currentContext')).toMatchObject({
        agent: {
          agentId: enabled.definition.id,
          capabilities: {
            subagents: false,
            fileTools: false,
            webSearch: false,
            dynamicCreation: true,
            developmentShell: false,
            unrestrictedFileAccess: false,
          },
        },
        channel: { channelId: enabledChannel.id, episodeId: enabledEpisode },
      })
      await expect(host.queryNekroNxtInspect(enabledSession, 'supportedContributions')).resolves.toEqual({
        contractVersion: NEKRO_NXT_EXTENSION_AUTHORING_REFERENCE.contractVersion,
        dshVersion: NEKRO_NXT_EXTENSION_AUTHORING_REFERENCE.dshVersion,
        ...NEKRO_NXT_EXTENSION_AUTHORING_REFERENCE.supportedContributions,
      })
      const developmentExample = await host.queryNekroNxtInspect(enabledSession, 'developmentExample')
      if (typeof developmentExample !== 'object' || developmentExample === null || Array.isArray(developmentExample)) {
        throw new TypeError('developmentExample must be an object.')
      }
      expect(developmentExample['hostTool']).toContain("name: 'project_status'")
      expect(developmentExample['hostRpcAndClientSlot']).toContain("name: 'agent.workbench.sections'")
      await expect(host.queryNekroNxtInspect(enabledSession, 'extensionLifecycle')).resolves.toMatchObject({
        dynamicRun: { lifetime: 'current-dsh-session' },
        save: { createsImmutableSourceRevision: true, activatesAutomatically: false },
      })
      const extensionSkill = await host.loadNekroNxtExtensionSkill(enabledSession)
      expect(extensionSkill.provider).toBe('nekro-nxt-runtime')
      expect(extensionSkill.content).toContain('宿主是 NekroNXT')
      await expect(host.loadNekroNxtExtensionSkill(deniedSession)).rejects.toThrow('not granted')

      const privateServiceProbe = host.defineDynamicPackage(enabledSession, {
        plugin: { kind: 'new', idPrefix: 'priv' },
        name: '私有服务探针',
        purpose: '证明动态扩展不能触达 Agent、子智能体、网页和 Spill 私有服务。',
        code: {
          host: `return {
            inject: ['agents', 'subagents', 'web', 'spillStore', 'skills'],
            apply(ctx) { throw new Error('private Host Service leaked') }
          }`,
        },
      })
      expect(() =>
        host.defineDynamicPackage(enabledSession, {
          plugin: { kind: 'new', idPrefix: 'other' },
          name: '错误的新 Plugin',
          purpose: '验证一个 Episode 只能维护一个 Plugin。',
          code: { host: 'return { apply() {} }' },
        }),
      ).toThrow('修复必须使用 kind:existing')
      const blockedPrivateRun = await host.runDynamicPackage(
        enabledSession,
        privateServiceProbe.pluginId,
        privateServiceProbe.packageId,
        'run',
      )
      expect(blockedPrivateRun).toMatchObject({ ok: false, reason: 'host-half-failed' })
      if (blockedPrivateRun.ok) throw new Error('Private Service probe unexpectedly ran.')
      expect(blockedPrivateRun.message).toContain('agents')
      expect(blockedPrivateRun.message).toContain('subagents')
      expect(blockedPrivateRun.message).toContain('web')
      expect(blockedPrivateRun.message).toContain('spillStore')
      expect(blockedPrivateRun.message).toContain('skills')
      const repeatedPrivateProbe = host.defineDynamicPackage(enabledSession, {
        plugin: { kind: 'existing', pluginId: privateServiceProbe.pluginId },
        name: '私有服务探针修复失败',
        purpose: '验证相同错误两次后熔断。',
        code: {
          host: `return {
            inject: ['agents', 'subagents', 'web', 'spillStore', 'skills'],
            apply(ctx) { throw new Error('private Host Service leaked') }
          }`,
        },
      })
      await expect(
        host.runDynamicPackage(enabledSession, repeatedPrivateProbe.pluginId, repeatedPrivateProbe.packageId, 'update'),
      ).resolves.toMatchObject({ ok: false, reason: 'host-half-failed' })
      const blockedPolicy = host.dynamicAuthoringPolicy(enabledSession)
      expect(blockedPolicy).toMatchObject({
        consecutiveFailures: 2,
        repeatedFingerprintCount: 2,
      })
      expect(blockedPolicy.blockedReason).toContain('相同动态扩展错误')
      expect(() =>
        host.defineDynamicPackage(enabledSession, {
          plugin: { kind: 'existing', pluginId: privateServiceProbe.pluginId },
          name: '熔断后拒绝',
          purpose: '熔断后不再增长库存。',
          code: { host: 'return { apply() {} }' },
        }),
      ).toThrow('动态创造已熔断')
      await modelToolNamesAfter(enabledSession, enabledChannel.id, 'adm_DYNAMICPOLICYRESET', '开始新的普通用户轮次。')
      expect(host.dynamicAuthoringPolicy(enabledSession)).toMatchObject({
        turn: 1,
        consecutiveFailures: 0,
        repeatedFingerprintCount: 0,
      })
      await expect(host.undefineDynamicPlugin(enabledSession, privateServiceProbe.pluginId)).resolves.toMatchObject({
        ok: true,
      })

      const clientProbe = host.defineDynamicPackage(enabledSession, {
        plugin: { kind: 'new', idPrefix: 'clnt' },
        name: '动态 Client 探针',
        purpose: '验证浏览器审批 Host seam。',
        code: { client: 'return { apply() {} }' },
      })
      const pendingClientRun = host.runDynamicPackage(
        enabledSession,
        clientProbe.pluginId,
        clientProbe.packageId,
        'run',
      )
      await Promise.resolve()
      const approval = host.dynamicInventory(enabledSession).find(({ pluginId }) => pluginId === clientProbe.pluginId)
        ?.latestRun?.approvalRequestId
      expect(approval).toBeDefined()
      const hostHalf = await host.runDynamicHostHalf(
        enabledSession,
        clientProbe.pluginId,
        clientProbe.packageId,
        'run',
        approval!,
        false,
      )
      expect(hostHalf).toMatchObject({ ok: true })
      if (!hostHalf.ok) throw new Error(hostHalf.message)
      expect(host.getDynamicClientCode(enabledSession, clientProbe.pluginId, hostHalf.pluginRunId).code).toContain(
        'apply',
      )
      await expect(
        host.resolveDynamicRunRequest(enabledSession, approval!, {
          ok: true,
          pluginRunId: hostHalf.pluginRunId,
        }),
      ).resolves.toEqual({ accepted: true })
      await expect(pendingClientRun).resolves.toMatchObject({ ok: true, status: 'awaiting-approval' })
      expect(
        host.dynamicInventory(enabledSession).find(({ pluginId }) => pluginId === clientProbe.pluginId),
      ).toMatchObject({
        currentPackageId: clientProbe.packageId,
        activeRun: { pluginRunId: hostHalf.pluginRunId },
        latestRun: { status: 'running' },
      })
      await host.stopDynamicPlugin(enabledSession, clientProbe.pluginId)
      await host.undefineDynamicPlugin(enabledSession, clientProbe.pluginId)

      const code = {
        host: `return {
          inject: ['tools'],
          apply(ctx) {
            const tool = harness.defineTool({
              name: 'dynamic_probe',
              description: 'Scoped dynamic probe',
              parameters: {},
              output: {
                schema: { type: 'string' },
                render(_args, value) { return [{ type: 'text', text: value }] }
              },
              execute() { return 'dynamic-ok' }
            })
            harness.registerTool(ctx, tool)
          }
        }`,
      }
      const first = host.defineDynamicPackage(enabledSession, {
        plugin: { kind: 'new', idPrefix: 'probe' },
        name: '动态探针',
        purpose: '验证当前智能体作用域和停止清理。',
        code,
      })
      await expect(
        host.runDynamicPackage(enabledSession, first.pluginId, first.packageId, 'run'),
      ).resolves.toMatchObject({ ok: true, status: 'running' })
      expect(host.dynamicToolNames(enabledSession)).toContain('dynamic_probe')
      expect(
        await modelToolNamesAfter(enabledSession, enabledChannel.id, 'adm_DYNAMICMODELENABLED', '动态工具应可见。'),
      ).toContain('dynamic_probe')
      expect(
        await modelToolNamesAfter(deniedSession, deniedChannel.id, 'adm_DYNAMICMODELDENIED', '无授权会话不应看见。'),
      ).not.toContain('dynamic_probe')

      const second = host.defineDynamicPackage(enabledSession, {
        plugin: { kind: 'existing', pluginId: first.pluginId },
        name: '动态探针 v2',
        purpose: '验证不可变动态版本更新。',
        code,
      })
      await expect(
        host.runDynamicPackage(enabledSession, first.pluginId, second.packageId, 'update'),
      ).resolves.toMatchObject({ ok: true, status: 'running', packageId: second.packageId })
      expect(host.inspectDynamicPackage(enabledSession, first.pluginId, first.packageId).code.host).toContain(
        'dynamic_probe',
      )
      await expect(host.stopDynamicPlugin(enabledSession, first.pluginId)).resolves.toEqual({ ok: true })
      expect(host.dynamicToolNames(enabledSession)).not.toContain('dynamic_probe')
      expect(
        await modelToolNamesAfter(enabledSession, enabledChannel.id, 'adm_DYNAMICMODELSTOPPED', '动态工具已停止。'),
      ).not.toContain('dynamic_probe')
      expect(host.dynamicInventory(enabledSession)[0]).not.toHaveProperty('activeRun')
      expect(host.dynamicInventory(enabledSession)[0]?.latestRun).toMatchObject({ status: 'stopped' })

      let localId = 0
      const sourceStore = new ExtensionSourceStore(path.join(directory, 'extension-data'))
      const inspected = host.inspectDynamicPackage(enabledSession, first.pluginId, second.packageId)
      const extensionService = new ExtensionService(repository, sourceStore, {
        now: () => 600 + localId,
        nextUlid: () => `L${++localId}`,
      })
      const saved = await extensionService.saveDynamicPackage({
        snapshot: {
          name: '持久探针',
          purpose: '验证动态运行、保存和启用彼此独立。',
          ...(inspected.code.host === undefined ? {} : { hostCode: inspected.code.host }),
        },
        slug: 'persistent-probe',
        displayName: '持久探针',
        description: '真实 DSH Scope 持久化验证。',
        createdByAgentId: enabled.definition.id,
      })
      expect(host.toolNames(enabledSession)).not.toContain('dynamic_probe')
      const cacheRoot = path.join(directory, 'extension-cache')
      const coordinator = new ExtensionActivationCoordinator(
        repository,
        extensionService,
        new ExtensionBuilder(cacheRoot),
        host,
        { now: () => 700 },
      )
      const activation = await coordinator.activate({
        agentId: enabled.definition.id,
        extensionId: saved.extension.id,
        revisionId: saved.revision.id,
      })
      expect(activation).toMatchObject({
        agentId: enabled.definition.id,
        extensionId: saved.extension.id,
        extensionRevisionId: saved.revision.id,
      })
      expect(host.toolNames(enabledSession)).toContain('dynamic_probe')
      expect(host.toolNames(deniedSession)).not.toContain('dynamic_probe')
      expect(
        await modelToolNamesAfter(enabledSession, enabledChannel.id, 'adm_DYNAMICMODELACTIVATED', '持久扩展已启用。'),
      ).toContain('dynamic_probe')

      await coordinator.dispose()
      expect(host.toolNames(enabledSession)).not.toContain('dynamic_probe')
      expect(
        await modelToolNamesAfter(enabledSession, enabledChannel.id, 'adm_DYNAMICMODELUNLOADED', '持久扩展已卸载。'),
      ).not.toContain('dynamic_probe')
      await rm(cacheRoot, { recursive: true, force: true })
      const restored = new ExtensionActivationCoordinator(
        repository,
        extensionService,
        new ExtensionBuilder(cacheRoot),
        host,
        { now: () => 800 },
      )
      expect(await restored.restore()).toEqual({ restored: 1, failed: 0 })
      expect(host.toolNames(enabledSession)).toContain('dynamic_probe')
      await restored.disable(enabled.definition.id, saved.extension.id)
      expect(host.toolNames(enabledSession)).not.toContain('dynamic_probe')
      await expect(host.undefineDynamicPlugin(enabledSession, first.pluginId)).resolves.toEqual({
        ok: true,
        wasRunning: false,
      })
      expect(host.dynamicInventory(enabledSession)).toEqual([])
    } finally {
      await host.dispose()
      database.close()
    }
  })

  it('mounts creation, file tools, development Shell and unrestricted file access as independent grants', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-capability-grants-'))
    temporaryDirectories.push(directory)
    const database = await openMigratedCoreDatabase(path.join(directory, 'core.sqlite'))
    const repository = new SqliteCoreRepository(database)
    const assetService = new AssetService(repository, path.join(directory, 'assets'))
    let id = 0
    const core = new CoreService(repository, { now: () => 900, nextUlid: () => `G${++id}` })
    const definitions = [
      core.createAgent({
        displayName: '创造智能体',
        persona: '',
        model: { provider: 'test-provider', model: 'chat-model' },
        capabilities: { dynamicCreation: true },
      }),
      core.createAgent({
        displayName: '开发智能体',
        persona: '',
        model: { provider: 'test-provider', model: 'chat-model' },
        capabilities: { fileTools: false, developmentShell: true },
      }),
      core.createAgent({
        displayName: '文件智能体',
        persona: '',
        model: { provider: 'test-provider', model: 'chat-model' },
        capabilities: { fileTools: true, unrestrictedFileAccess: true },
      }),
      core.createAgent({
        displayName: '完整开发智能体',
        persona: '',
        model: { provider: 'test-provider', model: 'chat-model' },
        capabilities: { fileTools: true, developmentShell: true, unrestrictedFileAccess: true },
      }),
    ]
    const connection = core.createConnection({ adapterKey: 'web', config: {} })
    const channels = definitions.map((_, index) =>
      core.createChannel({
        connectionId: connection.id,
        platformChannelId: `capability-${index}`,
        kind: 'web',
      }),
    )
    const workspaceRoot = path.join(directory, 'workspaces')
    const host = await DshHostRuntime.create({
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      developmentWorkspaceRoot: workspaceRoot,
      communication: { sendMessage: () => Promise.reject(new Error('not used')) },
      history: repository,
      assets: repository,
      assetService,
      resolveAgentRevision: (revisionId) => repository.getAgentRevision(revisionId),
      configureLlm: (context) => {
        context.llm.registerAdapter(['test-provider'], new ScriptedCommunicationModel())
      },
    })
    try {
      const sessions = await Promise.all(
        definitions.map((agent, index) =>
          host.createSession({
            episodeId: EpisodeIdSchema.parse(`eps_CAPABILITY${index}`),
            channelId: channels[index]!.id,
            agentId: agent.definition.id,
            agentRevisionId: agent.revision.id,
          }),
        ),
      )
      const [creationTools, shellTools, fileTools, completeTools] = sessions.map((session) => host.toolNames(session))

      expect(creationTools).toContain('cordis_define')
      expect(creationTools).not.toContain('bash')
      expect(creationTools).not.toContain('read')

      expect(shellTools).toContain('bash')
      expect(shellTools).not.toEqual(expect.arrayContaining(['read', 'write', 'edit']))
      expect(shellTools).not.toContain('cordis_define')

      expect(fileTools).toEqual(expect.arrayContaining(['read', 'write', 'edit']))
      expect(fileTools).not.toContain('bash')
      expect(fileTools).not.toContain('cordis_define')

      expect(completeTools).toEqual(expect.arrayContaining(['bash', 'read', 'write', 'edit']))
      expect(completeTools).not.toContain('cordis_define')

      await expect(access(path.join(workspaceRoot, definitions[0]!.definition.id))).rejects.toThrow()
      for (const agent of definitions.slice(1)) {
        const workspace = path.join(workspaceRoot, agent.definition.id)
        expect((await stat(workspace)).isDirectory()).toBe(true)
        expect((await stat(workspace)).mode & 0o777).toBe(0o700)
      }
      expect(new Set(definitions.slice(1).map((agent) => path.join(workspaceRoot, agent.definition.id))).size).toBe(3)
    } finally {
      await host.dispose()
      database.close()
    }
  })

  it('keeps raw model text internal and publishes only send_channel_message Outbox delivery', async () => {
    expect(assertHostDshPackageVersions).not.toThrow()
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-dsh-channel-'))
    temporaryDirectories.push(directory)
    const database = await openMigratedCoreDatabase(path.join(directory, 'core.sqlite'))
    const repository = new SqliteCoreRepository(database)
    const assetService = new AssetService(repository, path.join(directory, 'assets'))
    let coreId = 0
    let runtimeId = 0
    const core = new CoreService(repository, { now: () => 1000, nextUlid: () => `C${++coreId}` })
    const agent = core.createAgent({
      displayName: '小奈',
      persona: '你应当简洁、准确地回应频道消息。',
      model: { provider: 'test-provider', model: 'chat-model' },
    })
    const connection = core.createConnection({ adapterKey: 'web', config: {} })
    const channel = core.createChannel({
      connectionId: connection.id,
      platformChannelId: 'main',
      kind: 'web',
      displayName: '主测试频道',
    })
    const sender = core.observeChannelMember({
      connectionId: connection.id,
      channelId: channel.id,
      platformUserId: 'member-sender',
      displayName: '成员甲',
      observedAt: 1000,
    }).member
    const mentionedMember = core.observeChannelMember({
      connectionId: connection.id,
      channelId: channel.id,
      platformUserId: 'member-target',
      displayName: '成员乙',
      observedAt: 1000,
    }).member
    const quotedImage = await assetService.prepare({
      bytes: new Uint8Array(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZQAAAABJRU5ErkJggg==',
          'base64',
        ),
      ),
      declaredMediaType: 'image/png',
    })
    repository.grantAssetAccess({
      assetId: quotedImage.asset.id,
      channelId: channel.id,
      source: 'agent-tool',
      grantedAt: 1000,
    })
    const quotedFileId = AssetIdSchema.parse('ast_QUOTEDFILE')
    const quotedAudioId = AssetIdSchema.parse('ast_QUOTEDAUDIO')
    core.createBinding({ channelId: channel.id, agentId: agent.definition.id, triggerPolicy: 'always' })
    const staleEvent = core.appendInbound({
      connectionId: connection.id,
      channelId: channel.id,
      adapterKey: 'web',
      platformEventId: 'stale-channel-event',
      kind: 'message-created',
      parts: [{ type: 'text', text: '同频道但未准入旧 Episode 的内容' }],
      platformTimestamp: 999,
      receivedAt: 999,
      dedupeKey: 'web:stale-channel-event',
    }).event
    const quotedEvent = core.appendInbound({
      connectionId: connection.id,
      channelId: channel.id,
      adapterKey: 'web',
      platformEventId: 'quoted-channel-event',
      kind: 'message-created',
      senderMemberId: sender.id,
      parts: [
        { type: 'text', text: '这是被引用的当前频道内容。' },
        { type: 'mention', memberId: mentionedMember.id },
        { type: 'image', assetId: quotedImage.asset.id, alt: '引用图片' },
        { type: 'file', assetId: quotedFileId, name: '引用资料.txt' },
        { type: 'audio', assetId: quotedAudioId },
        { type: 'rich', adapterKey: 'sample', kind: 'card', summary: '引用卡片摘要' },
        { type: 'quote', messageId: staleEvent.logicalMessageId },
      ],
      platformTimestamp: 999,
      receivedAt: 999,
      dedupeKey: 'web:quoted-channel-event',
    }).event
    const otherChannel = core.createChannel({
      connectionId: connection.id,
      platformChannelId: 'other',
      kind: 'web',
      displayName: '另一个测试频道',
    })
    const otherChannelEvent = core.appendInbound({
      connectionId: connection.id,
      channelId: otherChannel.id,
      adapterKey: 'web',
      platformEventId: 'other-channel-event',
      kind: 'message-created',
      parts: [{ type: 'text', text: '另一个频道的秘密内容' }],
      platformTimestamp: 999,
      receivedAt: 999,
      dedupeKey: 'web:other-channel-event',
    }).event

    const runtimeRef: { current?: ChannelRuntime } = {}
    const web = createWebAdapterConnection(connection.id, (event) => {
      if (!runtimeRef.current) return Promise.reject(new Error('Channel Runtime is not ready.'))
      return runtimeRef.current.acceptInbound(event)
    })
    const createHost = (hostModel: ScriptedCommunicationModel) =>
      DshHostRuntime.create({
        sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
        communication: {
          sendMessage: (input) => {
            if (!runtimeRef.current) return Promise.reject(new Error('Channel Runtime is not ready.'))
            return runtimeRef.current.sendMessage(input)
          },
        },
        history: repository,
        assets: repository,
        assetService,
        resolveAgentRevision: (revisionId) => repository.getAgentRevision(revisionId),
        configureLlm: (context: Context) => {
          context.llm.registerAdapter(['test-provider'], hostModel)
        },
      })
    const model = new ScriptedCommunicationModel()
    const host = await createHost(model)
    const hosts = [host]
    const runtime = new ChannelRuntime(core, repository, repository, host, {
      now: () => 1000,
      nextUlid: () => `R${++runtimeId}`,
      resolveAdapter: (id) => (id === connection.id ? web : undefined),
    })
    runtimeRef.current = runtime
    const observed: string[] = []
    web.subscribe(({ request }) => {
      observed.push(request.parts.map((part) => (part.type === 'text' ? part.text : part.type)).join(''))
    })

    try {
      await web.start()
      const browserCommit = await runtime.acceptInbound({
        connectionId: connection.id,
        channelId: channel.id,
        adapterKey: 'web',
        platformEventId: 'browser-event-1',
        kind: 'message-created',
        senderMemberId: sender.id,
        parts: [
          { type: 'text', text: '你好，请回复我。' },
          { type: 'mention', memberId: mentionedMember.id },
          { type: 'quote', messageId: quotedEvent.logicalMessageId },
          { type: 'quote', messageId: otherChannelEvent.logicalMessageId },
          { type: 'quote', messageId: LogicalMessageIdSchema.parse('msg_MISSINGQUOTE') },
        ],
        platformTimestamp: 1000,
        receivedAt: 1000,
        dedupeKey: 'web:browser-event-1',
        facts: { mentionedBot: true },
      })
      const browserEvent = repository.getChannelEvent(browserCommit.channelEventId)!
      const episode = repository.getActiveEpisode(channel.id, agent.definition.id)!
      await host.whenIdle(episode.dshSessionId!)

      expect(observed).toEqual(['这是通信工具确认发送的回复。'])
      expect(repository.listChannelHistory(channel.id).find((entry) => entry.source === 'channel-event')).toMatchObject(
        {
          logicalMessageId: browserEvent.logicalMessageId,
          senderMemberId: sender.id,
          facts: { mentionedBot: true },
        },
      )
      const outboundHistory = repository
        .listChannelHistory(channel.id)
        .filter((entry) => entry.source === 'outbound-intent')
      expect(outboundHistory).toHaveLength(1)
      expect(outboundHistory[0]).toMatchObject({
        source: 'outbound-intent',
        channelId: channel.id,
        state: 'sent',
        parts: [{ type: 'text', text: '这是通信工具确认发送的回复。' }],
      })
      expect(typeof outboundHistory[0]?.sourceId).toBe('string')
      expect(typeof outboundHistory[0]?.logicalMessageId).toBe('string')
      expect(typeof outboundHistory[0]?.occurredAt).toBe('number')
      expect(model.calls).toHaveLength(2)
      expect(model.calls[0]?.tools?.map(({ name }) => name)).toEqual([
        'asset_create',
        'asset_inspect',
        'conversation_history_read',
        'conversation_history_search',
        'nekro_nxt_channel_context',
        'send_channel_message',
      ])
      expect(model.calls[0]?.system).toContain(channel.id)
      expect(model.calls[0]?.system).toContain('主测试频道')
      expect(model.calls[0]?.system).toContain('普通 text 或 reasoning 只会作为内部运行轨迹保存')
      expect(model.calls[0]?.system).toContain('一次 send_channel_message 不会结束当前 Turn')
      expect(model.calls[0]?.system).toContain('通常适合先简短说明你理解的任务和马上要做的事')
      expect(model.calls[0]?.system).toContain('沟通篇幅和频率应结合当前智能体人设')
      expect(model.calls[0]?.tools?.find(({ name }) => name === 'send_channel_message')?.description).toContain(
        '可在同一 Turn 中多次调用',
      )
      const eventText = JSON.stringify(host.sessionEvents(episode.dshSessionId!))
      expect(eventText).toContain('这段模型原始文字只能留在运行轨迹。')
      expect(eventText).toContain('工具完成后的原始结束文字也不会发送。')
      expect(eventText).toContain('nekro-nxt-channel')
      expect(eventText).toContain('这是通信工具确认发送的回复。')
      expect(eventText).toContain('发送成员：成员甲')
      expect(eventText).toContain('@成员乙')
      expect(eventText).toContain('该消息提及了当前智能体关联的机器人账号')
      expect(eventText).toContain('当前频道身份（Host 权威运行时事实）')
      expect(eventText).toContain(channel.id)
      expect(eventText).toContain(`频道消息 ${browserEvent.logicalMessageId}`)
      expect(eventText).not.toContain(`频道事件 ${browserEvent.id}`)
      expect(eventText).toContain(`引用频道消息 ${quotedEvent.logicalMessageId}，发送成员：成员甲`)
      expect(eventText).toContain('这是被引用的当前频道内容。')
      expect(eventText).toContain('@成员乙')
      expect(eventText).toContain(`收到图片资源 ${quotedImage.asset.id}（引用图片）`)
      expect(eventText).toContain('当前模型不直接支持图片输入')
      expect(eventText).toContain(`收到文件资源 ${quotedFileId}（引用资料.txt）`)
      expect(eventText).toContain(`收到音频资源 ${quotedAudioId}`)
      expect(eventText).toContain('引用卡片摘要')
      expect(eventText).toContain(`引用频道消息 ${staleEvent.logicalMessageId}`)
      expect(eventText).not.toContain('同频道但未准入旧 Episode 的内容')
      expect(eventText).toContain(`引用频道消息 ${otherChannelEvent.logicalMessageId}，当前频道中无法读取该消息`)
      expect(eventText).toContain('引用频道消息 msg_MISSINGQUOTE，当前频道中无法读取该消息')
      expect(eventText).not.toContain('另一个频道的秘密内容')

      core.reviseAgent(agent.definition.id, agent.revision.id, {
        displayName: '小奈',
        persona: '你现在应当在保持简洁的同时说明依据。',
        model: { provider: 'test-provider', model: 'chat-model' },
      })
      await web.postMessage({
        channelId: channel.id,
        clientEventId: 'browser-event-2',
        parts: [
          { type: 'text', text: '请继续刚才的任务。' },
          { type: 'quote', messageId: outboundHistory[0]!.logicalMessageId },
        ],
      })
      const resumedEpisode = repository.getActiveEpisode(channel.id, agent.definition.id)!
      await host.whenIdle(resumedEpisode.dshSessionId!)
      expect(resumedEpisode.dshSessionId).not.toBe(episode.dshSessionId)
      expect(repository.getEpisode(episode.id)).toMatchObject({
        status: 'closed',
        closeReason: 'incompatible-revision',
      })
      const handoff = repository.getEpisodeHandoffTo(resumedEpisode.id)!
      expect(handoff.sourceEventIds).toHaveLength(1)
      const recentEventIds = handoff.recentEventIds
      expect(recentEventIds).toHaveLength(1)
      expect(typeof recentEventIds[0]).toBe('string')
      const summaryCall = model.calls.find(({ system }) => system?.startsWith('你是对话交接摘要器'))
      const summaryInput = JSON.stringify(summaryCall?.messages)
      expect(summaryInput).toContain('你好，请回复我。')
      expect(summaryInput).toContain('这是通信工具确认发送的回复。')
      expect(summaryInput).not.toContain('同频道但未准入旧 Episode 的内容')
      expect(summaryInput).not.toContain('另一个频道的秘密内容')
      expect(summaryInput).toContain('当前 Episode 智能体历史出站；不代表用户确认')
      const resumedEvents = JSON.stringify(host.sessionEvents(resumedEpisode.dshSessionId!))
      expect(resumedEvents).toContain('nekro-nxt-handoff')
      expect(resumedEvents).toContain('你好，请回复我。')
      expect(resumedEvents).toContain(`[原文 ${browserEvent.logicalMessageId}]`)
      expect(resumedEvents).toContain(`引用频道消息 ${outboundHistory[0]!.logicalMessageId}，本频道智能体此前发送`)
      expect(resumedEvents).toContain('派生交接摘要，不是原始消息或系统事实')
      expect(resumedEvents).not.toContain('把它视为有来源的既有背景')
      expect(model.calls.some(({ system }) => system?.startsWith('你是对话交接摘要器'))).toBe(true)
      expect(observed).toEqual(['这是通信工具确认发送的回复。', '这是通信工具确认发送的回复。'])

      const eventCount = host.sessionEvents(resumedEpisode.dshSessionId!).length
      const admission = database.db
        .select({ id: admissions.id, episodeId: admissions.episodeId, createdAt: admissions.createdAt })
        .from(admissions)
        .all()
        .filter((candidate) => candidate.episodeId === resumedEpisode.id)
        .sort((left, right) => right.createdAt - left.createdAt)[0]!
      await host.dispose()
      const resumedHost = await createHost(new ScriptedCommunicationModel())
      hosts.push(resumedHost)
      const resumedRuntime = new ChannelRuntime(core, repository, repository, resumedHost, {
        now: () => 1001,
        nextUlid: () => `R${++runtimeId}`,
        resolveAdapter: (id) => (id === connection.id ? web : undefined),
      })
      runtimeRef.current = resumedRuntime
      expect(await resumedRuntime.recover()).toEqual({
        resumedEpisodes: 1,
        recoveredAdmissions: 0,
        recoveredOutbounds: 0,
        unknownDeliveries: 0,
      })
      expect(resumedHost.sessionEvents(resumedEpisode.dshSessionId!).length).toBeGreaterThanOrEqual(eventCount)
      expect(resumedHost.findAdmissionMessage(resumedEpisode.dshSessionId!, admission.id)).toBeTruthy()
    } finally {
      await web.stop()
      await Promise.allSettled(hosts.map((ownedHost) => ownedHost.dispose()))
      database.close()
    }
  })

  it('projects authorized images in message order and exposes only the batch inspection protocol', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-dsh-image-'))
    temporaryDirectories.push(directory)
    const database = await openMigratedCoreDatabase(path.join(directory, 'core.sqlite'))
    const repository = new SqliteCoreRepository(database)
    let coreId = 0
    let runtimeId = 0
    const core = new CoreService(repository, { now: () => 2000, nextUlid: () => `I${++coreId}` })
    const agent = core.createAgent({
      displayName: '识图智能体',
      persona: '',
      model: { provider: 'vision-provider', model: 'vision-model' },
      imagePolicy: {
        history: {
          mode: 'persistent-distinct',
          detail: 'low',
          restoreAfterCompaction: { recentMessages: 32, maxImages: 20 },
        },
        textModel: { mode: 'disabled' },
      },
    })
    const connection = core.createConnection({ adapterKey: 'web', config: {} })
    const channel = core.createChannel({ connectionId: connection.id, platformChannelId: 'images', kind: 'web' })
    const assetService = new AssetService(repository, path.join(directory, 'assets'))
    const imageAsset = await assetService.prepare({
      bytes: new Uint8Array(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZQAAAABJRU5ErkJggg==',
          'base64',
        ),
      ),
      declaredMediaType: 'image/png',
    })
    const secondImageAsset = await assetService.prepare({
      bytes: new Uint8Array(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAQAAABeK7cBAAAADUlEQVR42mNk+M/wHwAFAgIACwL9WQAAAABJRU5ErkJggg==',
          'base64',
        ),
      ),
      declaredMediaType: 'image/png',
    })
    repository.grantAssetAccess({
      assetId: imageAsset.asset.id,
      channelId: channel.id,
      source: 'agent-tool',
      grantedAt: 2000,
    })
    repository.grantAssetAccess({
      assetId: secondImageAsset.asset.id,
      channelId: channel.id,
      source: 'agent-tool',
      grantedAt: 2000,
    })
    core.createBinding({ channelId: channel.id, agentId: agent.definition.id, triggerPolicy: 'always' })

    const model = new ImageInspectionProbeModel([imageAsset.asset.id, secondImageAsset.asset.id])
    const runtimeRef: { current?: ChannelRuntime } = {}
    const web = createWebAdapterConnection(connection.id, (event) => runtimeRef.current!.acceptInbound(event))
    const host = await DshHostRuntime.create({
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      communication: { sendMessage: (input) => runtimeRef.current!.sendMessage(input) },
      history: repository,
      assets: repository,
      assetService,
      resolveAgentRevision: (revisionId) => repository.getAgentRevision(revisionId),
      configureLlm: (context) => {
        context.llm.registerAdapter(['vision-provider'], model)
      },
    })
    const runtime = new ChannelRuntime(core, repository, repository, host, {
      now: () => 2001,
      nextUlid: () => `IR${++runtimeId}`,
      resolveAdapter: () => web,
    })
    runtimeRef.current = runtime
    try {
      await web.start()
      await web.postMessage({
        channelId: channel.id,
        clientEventId: 'image-message',
        parts: [
          { type: 'text', text: '图片之前' },
          { type: 'image', assetId: imageAsset.asset.id, alt: '一个像素' },
          { type: 'text', text: '图片之后' },
          { type: 'image', assetId: imageAsset.asset.id, alt: '重复图片' },
        ],
      })
      const episode = repository.getActiveEpisode(channel.id, agent.definition.id)!
      await host.whenIdle(episode.dshSessionId!)
      const imageMessage = model.calls[0]?.messages.find((message) =>
        message.content.some((block) => block.type === 'image'),
      )
      expect(imageMessage?.content.filter((block) => block.type === 'image')).toHaveLength(1)
      const before =
        imageMessage?.content.findIndex((block) => block.type === 'text' && block.text === '图片之前') ?? -1
      const image = imageMessage?.content.findIndex((block) => block.type === 'image') ?? -1
      const after = imageMessage?.content.findIndex((block) => block.type === 'text' && block.text === '图片之后') ?? -1
      expect(before).toBeGreaterThanOrEqual(0)
      expect(image).toBeGreaterThan(before)
      expect(after).toBeGreaterThan(image)
      expect(model.calls[0]?.tools?.map(({ name }) => name)).toContain('asset_inspect_images')
      expect(model.calls[0]?.tools?.map(({ name }) => name)).not.toContain('asset_view_image')
      const inspectionResult = model.calls[1]?.messages
        .flatMap((message) => message.content)
        .find((block) => block.type === 'tool-result')
      expect(inspectionResult?.type).toBe('tool-result')
      if (inspectionResult?.type === 'tool-result') {
        expect(inspectionResult.content.filter((block) => block.type === 'image')).toHaveLength(2)
        expect(inspectionResult.content.map((block) => block.type)).toEqual(['text', 'text', 'image', 'text', 'image'])
        expect(inspectionResult.content[0]).toMatchObject({ type: 'text', text: '批量图片问题：比较两张图片' })
        expect(inspectionResult.content[1]).toMatchObject({ type: 'text' })
        expect(inspectionResult.content[1]?.type === 'text' ? inspectionResult.content[1].text : '').toContain(
          'detail-upgraded',
        )
      }
      await expect(host.getAgentImageDiagnostics(agent.revision)).resolves.toMatchObject({
        route: { mode: 'direct', provider: 'vision-provider', model: 'vision-model' },
        residentImages: 2,
        duplicateImagesSkipped: 1,
        lastInspection: { mode: 'direct', imageCount: 2, cacheHit: false },
      })
    } finally {
      await web.stop()
      await host.dispose()
      database.close()
    }
  })

  it('delivers ordered multi-image user and tool-result blocks through the rc.2 DeepSeek wire adapter', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-deepseek-image-wire-'))
    temporaryDirectories.push(directory)
    const database = await openMigratedCoreDatabase(path.join(directory, 'core.sqlite'))
    const repository = new SqliteCoreRepository(database)
    let coreId = 0
    let runtimeId = 0
    const core = new CoreService(repository, { now: () => 2400, nextUlid: () => `DW${++coreId}` })
    const agent = core.createAgent({
      displayName: 'DeepSeek 多图协议智能体',
      persona: '',
      model: { provider: 'deepseek-official', model: 'vision-model' },
    })
    const connection = core.createConnection({ adapterKey: 'web', config: {} })
    const channel = core.createChannel({ connectionId: connection.id, platformChannelId: 'deepseek-wire', kind: 'web' })
    const assetService = new AssetService(repository, path.join(directory, 'assets'))
    const prepared: AssetRecord[] = []
    for (const index of [1, 2, 3, 4]) {
      const bytes = await sharp({
        create: {
          width: index,
          height: 1,
          channels: 4,
          background: { r: index * 30, g: 40, b: 90, alpha: 1 },
        },
      })
        .png()
        .toBuffer()
      const asset = await assetService.prepare({ bytes: new Uint8Array(bytes), declaredMediaType: 'image/png' })
      repository.grantAssetAccess({
        assetId: asset.asset.id,
        channelId: channel.id,
        source: 'agent-tool',
        grantedAt: 2400,
      })
      prepared.push(asset.asset)
    }
    core.createBinding({ channelId: channel.id, agentId: agent.definition.id, triggerPolicy: 'always' })

    const chatBodies: Array<{ messages: Array<{ role: string; content?: unknown }> }> = []
    const requestPaths: string[] = []
    const upstream = createServer((request, response) => {
      void (async () => {
        requestPaths.push(request.url ?? '')
        const chunks: Buffer[] = []
        await new Promise<void>((resolve, reject) => {
          request.on('data', (chunk: Buffer) => chunks.push(chunk))
          request.once('end', resolve)
          request.once('error', reject)
        })
        if (request.url === '/files') {
          response.writeHead(500, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: { message: 'synthetic Files API fallback' } }))
          return
        }
        if (request.url !== '/chat/completions') {
          response.writeHead(404)
          response.end()
          return
        }
        const body = DeepSeekWireRequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        chatBodies.push(body)
        const payloads =
          chatBodies.length === 1
            ? [
                {
                  choices: [
                    {
                      delta: {
                        tool_calls: [
                          {
                            index: 0,
                            id: 'deepseek-image-call',
                            type: 'function',
                            function: {
                              name: 'asset_inspect_images',
                              arguments: JSON.stringify({
                                images: prepared.map((asset, index) => ({
                                  assetId: asset.id,
                                  focus: `关注第 ${index + 1} 张`,
                                })),
                                question: '比较四张图片',
                              }),
                            },
                          },
                        ],
                      },
                      finish_reason: null,
                    },
                  ],
                },
                {
                  choices: [{ delta: {}, finish_reason: 'tool_calls' }],
                  usage: { prompt_tokens: 32, completion_tokens: 8 },
                },
              ]
            : [
                { choices: [{ delta: { content: '多图协议检查完成。' }, finish_reason: null }] },
                {
                  choices: [{ delta: {}, finish_reason: 'stop' }],
                  usage: { prompt_tokens: 48, completion_tokens: 8 },
                },
              ]
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(`${payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join('')}data: [DONE]\n\n`)
      })().catch((cause: unknown) => {
        response.destroy(cause instanceof Error ? cause : new Error(String(cause)))
      })
    })
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject)
      upstream.listen(0, '127.0.0.1', () => resolve())
    })
    const address = upstream.address()
    if (address === null || typeof address === 'string') throw new Error('DeepSeek test upstream did not bind TCP.')
    const upstreamOrigin = `http://127.0.0.1:${address.port}`
    const runtimeRef: { current?: ChannelRuntime } = {}
    const web = createWebAdapterConnection(connection.id, (event) => runtimeRef.current!.acceptInbound(event))
    const host = await DshHostRuntime.create({
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      communication: { sendMessage: (input) => runtimeRef.current!.sendMessage(input) },
      history: repository,
      assets: repository,
      assetService,
      resolveAgentRevision: (revisionId) => repository.getAgentRevision(revisionId),
      configureLlm: (context) => {
        const resolved = resolveAdapterOptions({
          baseURL: upstreamOrigin,
          thinking: 'disabled',
          retryPolicy: { mode: 'normal', maxRetries: 0 },
          models: [
            {
              id: 'vision-model',
              name: 'Vision Model',
              inputModalities: ['text', 'image'],
              contextWindow: 128_000,
            },
          ],
        })
        const adapter = new DeepSeekAdapter({
          options: () => resolved,
          resolveApiKey: () => Promise.resolve('sk-synthetic-api-key'),
          resolveUserId: () => getOrCreateAnonymousUserId({ env: { DSH_HOME: directory } }),
          resolveAttachments: () => context.attachments,
          resolveFiles: () =>
            new DeepSeekFileStore({
              index: new DeepSeekUploadIndex(path.join(directory, 'deepseek-files.json')),
            }),
        })
        context.llm.registerAdapter(['deepseek-official'], adapter)
      },
    })
    const runtime = new ChannelRuntime(core, repository, repository, host, {
      now: () => 2401,
      nextUlid: () => `DWR${++runtimeId}`,
      resolveAdapter: () => web,
    })
    runtimeRef.current = runtime
    try {
      await web.start()
      await web.postMessage({
        channelId: channel.id,
        clientEventId: 'deepseek-image-wire',
        parts: [
          { type: 'text', text: '前置文字' },
          { type: 'image', assetId: prepared[0]!.id, alt: '第一张' },
          { type: 'text', text: '中间文字' },
          { type: 'image', assetId: prepared[1]!.id, alt: '第二张' },
          { type: 'text', text: '后置文字' },
        ],
      })
      const episode = repository.getActiveEpisode(channel.id, agent.definition.id)!
      await host.whenIdle(episode.dshSessionId!)
      if (chatBodies.length !== 3) {
        throw new Error(JSON.stringify({ requestPaths, tail: host.sessionEvents(episode.dshSessionId!).slice(-8) }))
      }
      expect(chatBodies).toHaveLength(3)
      const firstMultimodal = chatBodies[0]!.messages.find(
        (message) => Array.isArray(message.content) && message.content.some(isDeepSeekWireImagePart),
      )
      expect(
        Array.isArray(firstMultimodal?.content) ? firstMultimodal.content.filter(isDeepSeekWireImagePart) : [],
      ).toHaveLength(2)
      const toolIndex = chatBodies[1]!.messages.findIndex((message) => message.role === 'tool')
      expect(toolIndex).toBeGreaterThanOrEqual(0)
      const toolImages = chatBodies[1]!.messages
        .slice(toolIndex + 1)
        .find((message) => Array.isArray(message.content) && message.content.some(isDeepSeekWireImagePart))
      expect(Array.isArray(toolImages?.content) ? toolImages.content.filter(isDeepSeekWireImagePart) : []).toHaveLength(
        2,
      )
      expect(JSON.stringify(chatBodies[2])).toContain('本轮尚未成功调用 send_channel_message')
      expect(
        projectChannelRuntime({
          channelId: channel.id,
          agentId: agent.definition.id,
          episodeId: episode.id,
          sessionStatus: host.sessionStatus(episode.dshSessionId!),
          pendingInjectCount: 0,
          events: normalizeSessionEvents(host.sessionEvents(episode.dshSessionId!)),
        }).turns[0]?.state,
      ).toBe('unreplied')
    } finally {
      await web.stop()
      await host.dispose()
      database.close()
      await new Promise<void>((resolve, reject) =>
        upstream.close((error) => {
          if (error) reject(error)
          else resolve()
        }),
      )
    }
  }, 20_000)

  it('rejects invalid or inaccessible image batches atomically with stable terminal audit codes', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-dsh-invalid-image-batch-'))
    temporaryDirectories.push(directory)
    const database = await openMigratedCoreDatabase(path.join(directory, 'core.sqlite'))
    const repository = new SqliteCoreRepository(database)
    let coreId = 0
    let runtimeId = 0
    const core = new CoreService(repository, { now: () => 2500, nextUlid: () => `IV${++coreId}` })
    const agent = core.createAgent({
      displayName: '图片批次校验智能体',
      persona: '',
      model: { provider: 'vision-provider', model: 'vision-model' },
    })
    const connection = core.createConnection({ adapterKey: 'web', config: {} })
    const channel = core.createChannel({
      connectionId: connection.id,
      platformChannelId: 'invalid-images',
      kind: 'web',
    })
    const assetService = new AssetService(repository, path.join(directory, 'assets'))
    const validImage = await assetService.prepare({
      bytes: new Uint8Array(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZQAAAABJRU5ErkJggg==',
          'base64',
        ),
      ),
      declaredMediaType: 'image/png',
    })
    const forbiddenImage = await assetService.prepare({
      bytes: new Uint8Array(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAQAAABeK7cBAAAADUlEQVR42mNk+M/wHwAFAgIACwL9WQAAAABJRU5ErkJggg==',
          'base64',
        ),
      ),
      declaredMediaType: 'image/png',
    })
    const textAsset = await assetService.prepare({
      bytes: new TextEncoder().encode('synthetic non-image fixture'),
      declaredMediaType: 'text/plain',
    })
    for (const assetId of [validImage.asset.id, textAsset.asset.id]) {
      repository.grantAssetAccess({
        assetId,
        channelId: channel.id,
        source: 'agent-tool',
        grantedAt: 2500,
      })
    }
    core.createBinding({ channelId: channel.id, agentId: agent.definition.id, triggerPolicy: 'always' })
    const argumentSets = [
      { images: [] },
      { images: Array.from({ length: 21 }, () => ({ assetId: validImage.asset.id })) },
      { images: [{ assetId: validImage.asset.id }], question: '问'.repeat(4001) },
      { images: [{ assetId: validImage.asset.id, focus: '点'.repeat(1001) }] },
      { images: [{ assetId: forbiddenImage.asset.id }] },
      { images: [{ assetId: AssetIdSchema.parse('ast_missing') }] },
      { images: [{ assetId: validImage.asset.id }, { assetId: textAsset.asset.id }] },
    ]
    const model = new InvalidImageInspectionProbeModel(argumentSets)
    const runtimeRef: { current?: ChannelRuntime } = {}
    const web = createWebAdapterConnection(connection.id, (event) => runtimeRef.current!.acceptInbound(event))
    const host = await DshHostRuntime.create({
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      communication: { sendMessage: (input) => runtimeRef.current!.sendMessage(input) },
      history: repository,
      assets: repository,
      assetService,
      resolveAgentRevision: (revisionId) => repository.getAgentRevision(revisionId),
      configureLlm: (context) => {
        context.llm.registerAdapter(['vision-provider'], model)
      },
    })
    const runtime = new ChannelRuntime(core, repository, repository, host, {
      now: () => 2501,
      nextUlid: () => `IVR${++runtimeId}`,
      resolveAdapter: () => web,
    })
    runtimeRef.current = runtime
    try {
      await web.start()
      let sessionId: string | undefined
      for (const index of argumentSets.keys()) {
        await web.postMessage({
          channelId: channel.id,
          clientEventId: `invalid-image-batch-${index}`,
          parts: [{ type: 'text', text: `执行第 ${index + 1} 个图片批次校验。` }],
        })
        const episode = repository.getActiveEpisode(channel.id, agent.definition.id)!
        sessionId = episode.dshSessionId
        await host.whenIdle(episode.dshSessionId!)
      }
      const events = host.sessionEvents(sessionId!)
      const audits = events.filter((event) => event.type === 'nekro-nxt/image-inspection')
      expect(audits).toHaveLength(7)
      expect(
        audits.map((event) => (event.type === 'nekro-nxt/image-inspection' ? event.data.errorCode : null)),
      ).toEqual([
        'invalid-input',
        'invalid-input',
        'invalid-input',
        'invalid-input',
        'asset-forbidden',
        'asset-forbidden',
        'asset-not-image',
      ])
      const errorResults = events.filter(
        (event) => event.type === 'tool/result' && event.data.message.content[0]?.type === 'tool-result',
      )
      expect(errorResults).toHaveLength(7)
      expect(
        errorResults.every(
          (event) =>
            event.type === 'tool/result' &&
            event.data.message.content[0]?.type === 'tool-result' &&
            event.data.message.content[0].isError === true &&
            event.data.message.content[0].content.every((block) => block.type !== 'image'),
        ),
      ).toBe(true)
    } finally {
      await web.stop()
      await host.dispose()
      database.close()
    }
  })

  it('delegates one ordered image batch for a text-only primary model and returns text evidence only', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-dsh-delegated-image-'))
    temporaryDirectories.push(directory)
    const database = await openMigratedCoreDatabase(path.join(directory, 'core.sqlite'))
    const repository = new SqliteCoreRepository(database)
    let coreId = 0
    let runtimeId = 0
    const core = new CoreService(repository, { now: () => 3000, nextUlid: () => `D${++coreId}` })
    const connection = core.createConnection({ adapterKey: 'web', config: {} })
    const channel = core.createChannel({ connectionId: connection.id, platformChannelId: 'delegated', kind: 'web' })
    const assetService = new AssetService(repository, path.join(directory, 'assets'))
    const imageAsset = await assetService.prepare({
      bytes: new Uint8Array(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZQAAAABJRU5ErkJggg==',
          'base64',
        ),
      ),
      declaredMediaType: 'image/png',
    })
    repository.grantAssetAccess({
      assetId: imageAsset.asset.id,
      channelId: channel.id,
      source: 'agent-tool',
      grantedAt: 3000,
    })
    const agent = core.createAgent({
      displayName: '文本智能体',
      persona: '',
      model: { provider: 'text-provider', model: 'text-model' },
      imagePolicy: {
        history: {
          mode: 'persistent-distinct',
          detail: 'auto',
          restoreAfterCompaction: { recentMessages: 32, maxImages: 20 },
        },
        textModel: {
          mode: 'auxiliary',
          model: { provider: 'vision-provider', model: 'vision-model' },
          maxTokens: 2048,
        },
      },
    })
    core.createBinding({ channelId: channel.id, agentId: agent.definition.id, triggerPolicy: 'always' })
    const primary = new TextInspectionProbeModel(imageAsset.asset.id)
    const auxiliary = new AuxiliaryVisionEvidenceModel(imageAsset.asset.id)
    const runtimeRef: { current?: ChannelRuntime } = {}
    const web = createWebAdapterConnection(connection.id, (event) => runtimeRef.current!.acceptInbound(event))
    const host = await DshHostRuntime.create({
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      communication: { sendMessage: (input) => runtimeRef.current!.sendMessage(input) },
      history: repository,
      assets: repository,
      assetService,
      resolveAgentRevision: (revisionId) => repository.getAgentRevision(revisionId),
      configureLlm: (context) => {
        context.llm.registerAdapter(['text-provider'], primary)
        context.llm.registerAdapter(['vision-provider'], auxiliary)
      },
    })
    const runtime = new ChannelRuntime(core, repository, repository, host, {
      now: () => 3001,
      nextUlid: () => `DR${++runtimeId}`,
      resolveAdapter: () => web,
    })
    runtimeRef.current = runtime
    try {
      await web.start()
      await web.postMessage({
        channelId: channel.id,
        clientEventId: 'delegated-image-message',
        parts: [{ type: 'image', assetId: imageAsset.asset.id, alt: '单像素' }],
      })
      const episode = repository.getActiveEpisode(channel.id, agent.definition.id)!
      await host.whenIdle(episode.dshSessionId!)
      expect(
        primary.calls[0]?.messages.some((message) => message.content.some((block) => block.type === 'image')),
      ).toBe(false)
      expect(auxiliary.calls).toHaveLength(1)
      expect(
        auxiliary.calls[0]?.messages.flatMap((message) => message.content).filter((block) => block.type === 'image'),
      ).toHaveLength(1)
      const result = primary.calls[1]?.messages
        .flatMap((message) => message.content)
        .find((block) => block.type === 'tool-result')
      expect(result?.type).toBe('tool-result')
      if (result?.type === 'tool-result') {
        expect(result.content.every((block) => block.type === 'text')).toBe(true)
        expect(result.content[0]).toMatchObject({ type: 'text' })
        expect(result.content[0]?.type === 'text' ? JSON.parse(result.content[0].text) : null).toMatchObject({
          mode: 'delegated',
          answer: '图片中可见一个测试像素。',
          cacheHit: false,
        })
      }
      await web.postMessage({
        channelId: channel.id,
        clientEventId: 'delegated-image-cache',
        parts: [{ type: 'text', text: '请按同一关注点再检查一次。' }],
      })
      await host.whenIdle(episode.dshSessionId!)
      expect(auxiliary.calls).toHaveLength(1)
      const cachedResult = primary.calls[3]?.messages
        .flatMap((message) => message.content)
        .filter((block) => block.type === 'tool-result')
        .at(-1)
      expect(cachedResult?.type).toBe('tool-result')
      if (cachedResult?.type === 'tool-result') {
        const text = cachedResult.content.find((block) => block.type === 'text')
        expect(text?.type === 'text' ? JSON.parse(text.text) : null).toMatchObject({
          mode: 'delegated',
          cacheHit: true,
        })
      }
      await expect(host.getAgentImageDiagnostics(agent.revision)).resolves.toMatchObject({
        route: { mode: 'delegated', provider: 'vision-provider', model: 'vision-model' },
        residentImages: 0,
        lastInspection: { mode: 'delegated', imageCount: 1, cacheHit: true },
      })
    } finally {
      await web.stop()
      await host.dispose()
      database.close()
    }
  })

  it('restores recent channel images after a committed DSH compaction without creating channel facts', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-dsh-image-restore-'))
    temporaryDirectories.push(directory)
    const database = await openMigratedCoreDatabase(path.join(directory, 'core.sqlite'))
    const repository = new SqliteCoreRepository(database)
    let coreId = 0
    let runtimeId = 0
    const core = new CoreService(repository, { now: () => 4000, nextUlid: () => `C${++coreId}` })
    const agent = core.createAgent({
      displayName: '压缩识图智能体',
      persona: '',
      model: { provider: 'vision-provider', model: 'vision-model' },
      imagePolicy: {
        history: {
          mode: 'persistent-distinct',
          detail: 'auto',
          restoreAfterCompaction: { recentMessages: 32, maxImages: 20 },
        },
        textModel: { mode: 'disabled' },
      },
    })
    const connection = core.createConnection({ adapterKey: 'web', config: {} })
    const channel = core.createChannel({ connectionId: connection.id, platformChannelId: 'restore', kind: 'web' })
    const assetService = new AssetService(repository, path.join(directory, 'assets'))
    const imageAsset = await assetService.prepare({
      bytes: new Uint8Array(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZQAAAABJRU5ErkJggg==',
          'base64',
        ),
      ),
      declaredMediaType: 'image/png',
    })
    repository.grantAssetAccess({
      assetId: imageAsset.asset.id,
      channelId: channel.id,
      source: 'agent-tool',
      grantedAt: 4000,
    })
    core.createBinding({ channelId: channel.id, agentId: agent.definition.id, triggerPolicy: 'always' })
    const model = new ScriptedCommunicationModel(true)
    const runtimeRef: { current?: ChannelRuntime } = {}
    const web = createWebAdapterConnection(connection.id, (event) => runtimeRef.current!.acceptInbound(event))
    const host = await DshHostRuntime.create({
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      communication: { sendMessage: (input) => runtimeRef.current!.sendMessage(input) },
      history: repository,
      assets: repository,
      assetService,
      resolveAgentRevision: (revisionId) => repository.getAgentRevision(revisionId),
      configureLlm: (context) => {
        context.llm.registerAdapter(['vision-provider'], model)
      },
    })
    const runtime = new ChannelRuntime(core, repository, repository, host, {
      now: () => 4001 + runtimeId,
      nextUlid: () => `CR${++runtimeId}`,
      resolveAdapter: () => web,
    })
    runtimeRef.current = runtime
    try {
      await web.start()
      await web.postMessage({
        channelId: channel.id,
        clientEventId: 'restore-image',
        parts: [{ type: 'image', assetId: imageAsset.asset.id, alt: '需要恢复的图片' }],
      })
      const episode = repository.getActiveEpisode(channel.id, agent.definition.id)!
      await host.whenIdle(episode.dshSessionId!)
      for (let index = 0; index < 5; index += 1) {
        await web.postMessage({
          channelId: channel.id,
          clientEventId: `restore-text-${index}`,
          parts: [{ type: 'text', text: `后续消息 ${index}` }],
        })
        await host.whenIdle(episode.dshSessionId!)
      }
      const beforeHistory = repository.listChannelHistory(channel.id, { limit: 100 }).length
      expect(await host.compactSessionNow(episode.dshSessionId!)).toBe(true)
      const events = host.sessionEvents(episode.dshSessionId!)
      const restoration = events.find(
        (event) => event.type === 'user/message' && event.data.source.kind === 'nekro-nxt-visual-restore',
      )
      expect(restoration?.type).toBe('user/message')
      if (restoration?.type === 'user/message') {
        expect(restoration.data.content.filter((block) => block.type === 'image')).toHaveLength(1)
        expect(restoration.data.source).toMatchObject({
          kind: 'nekro-nxt-visual-restore',
          policyVersion: 1,
        })
      }
      expect(repository.listChannelHistory(channel.id, { limit: 100 })).toHaveLength(beforeHistory)
      expect(events.filter((event) => event.type === 'nekro-nxt/image-restoration')).toHaveLength(1)
    } finally {
      await web.stop()
      await host.dispose()
      database.close()
    }
  })
})
