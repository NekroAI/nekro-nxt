import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NekroRuntime } from '../src/bootstrap.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const toolCall = function* (name: string, id: string, value: unknown): Generator<StreamChunk> {
  const callId = ToolCallId(id)
  const argumentsText = JSON.stringify(value)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: argumentsText }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: argumentsText } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

const text = function* (value: string): Generator<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: value }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: value } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/**
 * The channel conversation opens a sub-conversation, waits for its reply and ends it with a conclusion; the
 * sub-conversation answers once.
 */
class DelegatingModel extends LlmAdapter {
  readonly childReplied = deferred()
  readonly closed = deferred()
  conversationId: string | undefined
  /** Whether the channel conversation ends the sub-conversation once it heard back. */
  closes = true
  #opened = false
  #closed = false

  override providerInfo(provider: string) {
    return { id: provider, name: 'delegating model' }
  }
  override listModels(provider: string) {
    return Promise.resolve([{ provider, id: 'chat-model', name: 'chat', inputModalities: ['text'] as const }])
  }
  override resolveModel(provider: string, model: string) {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      inputModalities: ['text'] as const,
      context: { contextWindow: 128_000 },
    })
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    await Promise.resolve()
    const tools = new Set(options.tools?.map((tool) => tool.name) ?? [])
    if (!tools.has('conversation_open')) {
      yield* text('三个要点：日程、预算、分工。')
      this.childReplied.resolve()
      return
    }
    const transcript = JSON.stringify(options.messages)
    if (!this.#opened) {
      this.#opened = true
      yield* toolCall('conversation_open', 'open-1', { title: '整理活动要点', task: '列出这次活动的三个要点。' })
      return
    }
    const opened = /(cnv_[0-9A-Za-z]+)/u.exec(transcript)?.[1]
    if (opened !== undefined) this.conversationId = opened
    if (this.closes && !this.#closed && transcript.includes('三个要点：日程') && opened !== undefined) {
      this.#closed = true
      yield* toolCall('conversation_close', 'close-1', { conversation: opened, summary: '要点是日程、预算和分工。' })
      return
    }
    if (this.#closed) this.closed.resolve()
    yield* toolCall('finish_channel_turn', `finish-${options.messages.length}`, {
      outcome: 'no-response-needed',
      reason: '内部整理。',
    })
  }
}

const createRuntime = (directory: string, model: LlmAdapter) =>
  NekroRuntime.create({
    coreDatabasePath: path.join(directory, 'core.sqlite'),
    sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
    assetRoot: path.join(directory, 'assets'),
    extensionDataRoot: path.join(directory, 'extension-data'),
    extensionCacheRoot: path.join(directory, 'extension-cache'),
    developmentWorkspaceRoot: path.join(directory, 'workspaces'),
    configureLlm: (context) => {
      context.llm.registerAdapter(['test-provider'], model)
    },
  })

const sessionDirectories = async (directory: string): Promise<string[]> => {
  const root = path.join(directory, 'dsh', 'sessions')
  const projects = await readdir(root)
  return (await Promise.all(projects.map((project) => readdir(path.join(root, project))))).flat()
}

describe('sub-conversations', () => {
  it('lets the agent open one, hear back from it, end it with a conclusion and remove it', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-sub-conversations-'))
    temporaryDirectories.push(directory)
    const model = new DelegatingModel()
    let runtime = await createRuntime(directory, model)
    let rootSessionId: string | undefined
    try {
      await runtime.start()
      const entity = await runtime.createAgentWithInternalChannel({
        displayName: '委派智能体',
        persona: '',
        model: { provider: 'test-provider', model: 'chat-model' },
        capabilities: { subagents: true },
      })
      await runtime.internalChannel.postMessage({
        channelId: entity.channelId,
        clientEventId: 'delegate',
        parts: [{ type: 'text', text: '帮我整理一下活动要点。' }],
      })
      await model.childReplied.promise
      await model.closed.promise
      const episode = runtime.repository.listActiveEpisodesForAgent(entity.agentId)[0]!
      rootSessionId = episode.dshSessionId!
      await runtime.host.whenIdle(rootSessionId)

      const [record] = runtime.repository.listSubConversations({ channelId: entity.channelId })
      expect(record).toMatchObject({
        title: '整理活动要点',
        openedBy: 'agent',
        driver: 'model',
        status: 'closed',
        closeReason: 'closed-by-agent',
        summary: '要点是日程、预算和分工。',
      })
      expect(record?.id).toBe(model.conversationId)
      const read = await runtime.host.subConversationEvents(record!.dshSessionId)
      expect(JSON.stringify(read?.events)).toContain('三个要点：日程、预算、分工。')

      await runtime.host.subConversations.delete(record!.id, 'admin')
      expect(runtime.repository.getSubConversation(record!.id)).toBeUndefined()
      expect(await sessionDirectories(directory)).not.toContain(record!.dshSessionId)
    } finally {
      await runtime.dispose()
    }
    // The channel conversation still resumes and lists its children after one was removed.
    runtime = await createRuntime(directory, model)
    try {
      await runtime.start()
      await runtime.recover()
      await expect(runtime.host.listSubagents(rootSessionId)).resolves.toBeDefined()
    } finally {
      await runtime.dispose()
    }
  }, 60_000)

  it('ends the open ones when the channel conversation ends, and removes ended ones after the retention time', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-sub-conversations-'))
    temporaryDirectories.push(directory)
    const model = new DelegatingModel()
    model.closes = false
    const runtime = await createRuntime(directory, model)
    try {
      await runtime.start()
      const entity = await runtime.createAgentWithInternalChannel({
        displayName: '委派智能体',
        persona: '',
        model: { provider: 'test-provider', model: 'chat-model' },
        capabilities: { subagents: true },
      })
      await runtime.internalChannel.postMessage({
        channelId: entity.channelId,
        clientEventId: 'delegate',
        parts: [{ type: 'text', text: '帮我整理一下活动要点。' }],
      })
      await model.childReplied.promise
      const episode = runtime.repository.listActiveEpisodesForAgent(entity.agentId)[0]!
      await vi.waitFor(() => expect(runtime.repository.listSubConversations({ episodeId: episode.id }).length).toBe(1))
      await runtime.host.whenIdle(episode.dshSessionId!)
      const [open] = runtime.repository.listSubConversations({ episodeId: episode.id })
      expect(open?.status).toBe('open')
      await runtime.channels.stopEpisode(episode.id)
      expect(runtime.repository.getSubConversation(open!.id)).toMatchObject({
        status: 'closed',
        closeReason: 'conversation-ended',
      })

      runtime.repository.putSystemSetting('conversation.subConversations', { retention: '1d' }, undefined, Date.now())
      expect(await runtime.host.subConversations.sweep()).toBe(0)
      const later = Date.now() + 2 * 86_400_000
      vi.spyOn(Date, 'now').mockReturnValue(later)
      expect(await runtime.host.subConversations.sweep()).toBe(1)
      expect(runtime.repository.listSubConversations({ channelId: entity.channelId })).toEqual([])
    } finally {
      vi.restoreAllMocks()
      await runtime.dispose()
    }
  }, 60_000)
})
