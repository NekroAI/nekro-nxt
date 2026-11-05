import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  LlmAdapter,
  LlmError,
  ToolCallId,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NekroRuntime } from '../src/bootstrap.js'
import {
  AgentIdSchema,
  ChannelIdSchema,
  EpisodeIdSchema,
  SubConversationIdSchema,
  type SubConversationId,
} from '@nekro-nxt/contracts'
import type { SubConversationRecord } from '@nekro-nxt/storage-sqlite'
import { resolveSubConversationModel, subConversationTools } from '../src/sub-conversation-tools.js'
import type { SubConversationManager } from '../src/sub-conversations.js'

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
  /** Extra arguments of the `conversation_open` call, such as the model it names. */
  openWith: Record<string, unknown> = {}
  /** The model of every request, and whether the sub-conversation made it. */
  readonly requests: { readonly model: string; readonly child: boolean }[] = []
  /** `conversation_open` as the channel conversation saw it. */
  openSchema: unknown
  #opened = false
  #closed = false

  override providerInfo(provider: string) {
    return { id: provider, name: 'delegating model' }
  }
  override listModels(provider: string) {
    return Promise.resolve([
      { provider, id: 'chat-model', name: 'chat', inputModalities: ['text'] as const },
      { provider, id: 'fast-model', name: 'fast', inputModalities: ['text'] as const },
    ])
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
    this.requests.push({ model: options.model, child: !tools.has('conversation_open') })
    if (!tools.has('conversation_open')) {
      yield* text('三个要点：日程、预算、分工。')
      this.childReplied.resolve()
      return
    }
    const transcript = JSON.stringify(options.messages)
    if (!this.#opened) {
      this.#opened = true
      this.openSchema = options.tools?.find((tool) => tool.name === 'conversation_open')
      yield* toolCall('conversation_open', 'open-1', {
        title: '整理活动要点',
        task: '列出这次活动的三个要点。',
        ...this.openWith,
      })
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

/**
 * The channel conversation opens a sub-conversation and leaves it running; the sub-conversation then replies, fails
 * on the model, overflows its context after a first reply, or waits until it is interrupted.
 */
class UnattendedModel extends LlmAdapter {
  readonly childStarted = deferred()
  childRequests = 0

  constructor(readonly child: 'reply' | 'error' | 'overflow' | 'wait') {
    super()
  }

  override providerInfo(provider: string) {
    return { id: provider, name: 'unattended model' }
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
    if (tools.has('conversation_open')) {
      if (!JSON.stringify(options.messages).includes('cnv_')) {
        yield* toolCall('conversation_open', 'open-1', { title: '核对报名名单', task: '核对报名名单里重复的人。' })
        return
      }
      yield* toolCall('finish_channel_turn', `finish-${options.messages.length}`, {
        outcome: 'no-response-needed',
        reason: '等子对话。',
      })
      return
    }
    this.childRequests += 1
    this.childStarted.resolve()
    switch (this.child) {
      case 'reply':
        yield* text('名单里没有重复的人。')
        return
      case 'error':
        throw new LlmError('模型服务暂时不可用。', 'UNKNOWN_MODEL')
      case 'overflow': {
        if (this.childRequests > 1) throw new LlmError('上下文太长。', CONTEXT_WINDOW_EXCEEDED_CODE)
        const callId = ToolCallId('send-1')
        const argumentsText = JSON.stringify({ text: '先核对了前五十人。' })
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: '前五十人里没有重复。' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '前五十人里没有重复。' } }
        yield { type: 'block-start', index: 1, blockType: 'tool-call' }
        yield {
          type: 'tool-call-delta',
          index: 1,
          id: callId,
          name: 'conversation_send',
          argumentsDelta: argumentsText,
        }
        yield {
          type: 'block-end',
          index: 1,
          block: { type: 'tool-call', id: callId, name: 'conversation_send', arguments: argumentsText },
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      case 'wait':
        await new Promise<void>((resolve) => {
          if (options.signal?.aborted) resolve()
          options.signal?.addEventListener('abort', () => resolve(), { once: true })
        })
        throw options.signal?.reason ?? new Error('aborted')
    }
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

  it('opens one on the candidate the agent names, and keeps the channel conversation on its own model', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-sub-conversations-'))
    temporaryDirectories.push(directory)
    const model = new DelegatingModel()
    model.openWith = { model: '快速' }
    const runtime = await createRuntime(directory, model)
    try {
      await runtime.start()
      const entity = await runtime.createAgentWithInternalChannel({
        displayName: '委派智能体',
        persona: '',
        model: { provider: 'test-provider', model: 'chat-model' },
        capabilities: { subagents: true },
        subConversationModels: {
          candidates: [
            { name: '快速', model: { provider: 'test-provider', model: 'fast-model' }, guidance: '适合整理和归纳。' },
          ],
        },
      })
      await runtime.internalChannel.postMessage({
        channelId: entity.channelId,
        clientEventId: 'delegate',
        parts: [{ type: 'text', text: '帮我整理一下活动要点。' }],
      })
      await model.childReplied.promise
      await model.closed.promise

      expect(JSON.stringify(model.openSchema)).toContain('适合整理和归纳。')
      expect(JSON.stringify(model.openSchema)).toContain('不填时用「主模型」')
      expect(model.requests.filter((request) => request.child).map((request) => request.model)).toEqual(['fast-model'])
      expect(new Set(model.requests.filter((request) => !request.child).map((request) => request.model))).toEqual(
        new Set(['chat-model']),
      )
      const [record] = runtime.repository.listSubConversations({ channelId: entity.channelId })
      expect(record?.model).toEqual({ provider: 'test-provider', model: 'fast-model' })
    } finally {
      await runtime.dispose()
    }
  }, 60_000)

  it('offers no model choice without candidates and records the main model it inherits', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-sub-conversations-'))
    temporaryDirectories.push(directory)
    const model = new DelegatingModel()
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
      await model.closed.promise

      expect(JSON.stringify(model.openSchema)).not.toContain('"model"')
      expect(model.requests.every((request) => request.model === 'chat-model')).toBe(true)
      const [record] = runtime.repository.listSubConversations({ channelId: entity.channelId })
      expect(record?.model).toEqual({ provider: 'test-provider', model: 'chat-model' })
    } finally {
      await runtime.dispose()
    }
  }, 60_000)
})

describe('sub-conversations that stop on their own', () => {
  const openUnattended = async (child: UnattendedModel['child']) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-sub-conversations-'))
    temporaryDirectories.push(directory)
    const model = new UnattendedModel(child)
    const runtime = await createRuntime(directory, model)
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
      parts: [{ type: 'text', text: '帮我核对一下报名名单。' }],
    })
    await model.childStarted.promise
    await vi.waitFor(() =>
      expect(runtime.repository.listSubConversations({ channelId: entity.channelId })).toHaveLength(1),
    )
    const [record] = runtime.repository.listSubConversations({ channelId: entity.channelId })
    return { directory, runtime, model, record: record! }
  }

  const settled = async (runtime: NekroRuntime, id: SubConversationId) => {
    let record = runtime.repository.getSubConversation(id)
    await vi.waitFor(
      () => {
        record = runtime.repository.getSubConversation(id)
        expect(record?.status).toBe('closed')
      },
      { timeout: 20_000 },
    )
    return record!
  }

  it('ends one whose model fails, with the reason', async () => {
    const { runtime, record } = await openUnattended('error')
    try {
      expect(await settled(runtime, record.id)).toMatchObject({
        status: 'closed',
        closeReason: 'failed',
        summary: '子对话出错停止了：模型服务暂时不可用。\n它还没有回复过。',
      })
    } finally {
      await runtime.dispose()
    }
  }, 60_000)

  it('ends one that overflows its context, with how far it got', async () => {
    const { runtime, record } = await openUnattended('overflow')
    try {
      const closed = await settled(runtime, record.id)
      expect(closed.closeReason).toBe('failed')
      expect(closed.summary).toBe('子对话的上下文超出了模型上限，没能继续。\n停止前最后的回复：前五十人里没有重复。')
    } finally {
      await runtime.dispose()
    }
  }, 60_000)

  it('ends one that is interrupted', async () => {
    const { runtime, record } = await openUnattended('wait')
    try {
      await vi.waitFor(() => expect(runtime.host.tryLiveSession(record.dshSessionId)?.status).toBe('running'))
      await runtime.host.interruptTurn(record.dshSessionId, '管理员停止')
      expect(await settled(runtime, record.id)).toMatchObject({
        closeReason: 'failed',
        summary: '子对话被中断，没有做完。\n它还没有回复过。',
      })
    } finally {
      await runtime.dispose()
    }
  }, 60_000)

  it('keeps one that finished its turn open for a follow-up, and records its activity', async () => {
    const { runtime, record } = await openUnattended('reply')
    try {
      await vi.waitFor(() => expect(runtime.host.tryLiveSession(record.dshSessionId)).toBeUndefined(), {
        timeout: 20_000,
      })
      const current = runtime.repository.getSubConversation(record.id)
      expect(current?.status).toBe('open')
      expect(current?.lastActivityAt).toBeGreaterThanOrEqual(record.createdAt)
    } finally {
      await runtime.dispose()
    }
  }, 60_000)

  it('ends one that is running with its channel conversation, not as its own failure', async () => {
    const { runtime, record } = await openUnattended('wait')
    try {
      await vi.waitFor(() => expect(runtime.host.tryLiveSession(record.dshSessionId)?.status).toBe('running'))
      await runtime.channels.stopEpisode(record.episodeId)
      expect(runtime.repository.getSubConversation(record.id)).toMatchObject({
        status: 'closed',
        closeReason: 'conversation-ended',
      })
    } finally {
      await runtime.dispose()
    }
  }, 60_000)

  it('keeps one that is running when NekroNXT shuts down open, to resume after the restart', async () => {
    const { directory, model, runtime, record } = await openUnattended('wait')
    await vi.waitFor(() => expect(runtime.host.tryLiveSession(record.dshSessionId)?.status).toBe('running'))
    await runtime.dispose()
    const restarted = await createRuntime(directory, model)
    try {
      await restarted.start()
      expect(restarted.repository.getSubConversation(record.id)?.status).toBe('open')
    } finally {
      await restarted.dispose()
    }
  }, 60_000)
})

describe('conversation_list', () => {
  it('says how long open ones have been quiet, and which ended ones did not finish', async () => {
    const now = Date.UTC(2026, 9, 1, 12, 0, 0)
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const base = {
      channelId: ChannelIdSchema.parse('chn_01'),
      episodeId: EpisodeIdSchema.parse('eps_01'),
      agentId: AgentIdSchema.parse('agt_01'),
      parentDshSessionId: 'parent-session',
      openedBy: 'agent',
      driver: 'model',
    } as const
    const records: SubConversationRecord[] = [
      {
        ...base,
        id: SubConversationIdSchema.parse('cnv_A'),
        dshSessionId: 'nxt-cnv_A',
        title: '查资料',
        status: 'open',
        createdAt: now - 3_600_000,
        lastActivityAt: now - 12 * 60_000,
      },
      {
        ...base,
        id: SubConversationIdSchema.parse('cnv_B'),
        dshSessionId: 'nxt-cnv_B',
        title: '刚开的',
        status: 'open',
        createdAt: now - 20_000,
      },
      {
        ...base,
        id: SubConversationIdSchema.parse('cnv_C'),
        dshSessionId: 'nxt-cnv_C',
        title: '没做完的',
        status: 'closed',
        closeReason: 'failed',
        summary: '子对话被中断，没有做完。',
        createdAt: now - 7_200_000,
        closedAt: now - 3_600_000,
      },
    ]
    const store = {
      listSubConversations: () => records,
      getSubConversationBySession: () => undefined,
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Listing never reaches the manager.
    const list = subConversationTools({} as SubConversationManager, store, {
      policy: { candidates: [] },
      main: { provider: 'p', model: 'm' },
      isAvailable: () => Promise.resolve(true),
    }).find((tool) => tool.name === 'conversation_list')!
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Listing reads only the caller's id.
    const value = await list.execute({}, { agent: { id: 'parent-session' } } as Parameters<typeof list.execute>[1])
    expect(value).toEqual({
      items: [
        { id: 'cnv_A', title: '查资料', status: 'open', idleMinutes: 12 },
        { id: 'cnv_B', title: '刚开的', status: 'open', idleMinutes: 0 },
        { id: 'cnv_C', title: '没做完的', status: 'closed', failed: true, summary: '子对话被中断，没有做完。' },
      ],
    })
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- The value the tool just returned.
    expect(list.output?.render?.({}, value as Parameters<NonNullable<typeof list.output.render>>[1])).toEqual([
      {
        type: 'text',
        text: 'cnv_A 查资料（进行中，12 分钟没有动静）\ncnv_B 刚开的（进行中）\ncnv_C 没做完的（未完成）',
      },
    ])
  })
})

describe('sub-conversation model choice', () => {
  const policy = {
    candidates: [
      { name: '快速', model: { provider: 'p', model: 'fast' }, guidance: '' },
      { name: '深度', model: { provider: 'p', model: 'deep', reasoningEffort: 'high' }, guidance: '' },
    ],
  }

  it('uses the named candidate, the default when none is named, and the main model otherwise', () => {
    expect(resolveSubConversationModel(policy, '深度')).toEqual({
      provider: 'p',
      model: 'deep',
      reasoningEffort: 'high',
    })
    expect(resolveSubConversationModel(policy, undefined)).toBeUndefined()
    expect(resolveSubConversationModel(policy, '主模型')).toBeUndefined()
    expect(resolveSubConversationModel({ ...policy, default: '快速' }, undefined)).toEqual({
      provider: 'p',
      model: 'fast',
    })
    expect(resolveSubConversationModel({ ...policy, default: '快速' }, '主模型')).toBeUndefined()
  })

  it('names the choices when the agent asks for one that does not exist', () => {
    expect(() => resolveSubConversationModel(policy, '最强')).toThrow(
      '没有叫「最强」的子对话模型，可以选：主模型、快速、深度。',
    )
  })
})
