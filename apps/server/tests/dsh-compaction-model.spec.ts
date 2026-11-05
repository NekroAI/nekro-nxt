import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { LlmAdapter, ReasoningEffortId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { AssetService, CoreService, type AgentCompactionPolicy, type AgentRevisionRecord } from '@nekro-nxt/core'
import {
  AdmissionIdSchema,
  DEFAULT_COMPACTION_SETTINGS,
  EpisodeIdSchema,
  LogicalMessageIdSchema,
  type CompactionSettings,
} from '@nekro-nxt/contracts'
import { openMigratedCoreDatabase, SqliteCoreRepository } from '@nekro-nxt/storage-sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DshHostRuntime } from '../src/index.js'

/** Records what each request asked for; `hang` keeps compaction summaries from ever finishing. */
class RecordingModel extends LlmAdapter {
  readonly calls: GenerateOptions[] = []
  hang = false
  /** Input tokens each conversation reply reports, which is what the token meter measures pressure from. */
  inputTokens: number | undefined
  override resolveModel(provider: string, model: string) {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 1_000_000 },
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
    this.calls.push(options)
    if (this.hang && options.system?.startsWith('你在给一个群聊智能体写压缩记录')) {
      // Ignores the abort on purpose: the host must stop waiting on its own.
      await new Promise(() => undefined)
    }
    await Promise.resolve()
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: '整理好的记录。' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '整理好的记录。' } }
    if (this.inputTokens !== undefined && options.purpose !== 'compaction')
      yield { type: 'usage', usage: { inputTokens: this.inputTokens, outputTokens: 10 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const disposers: Array<() => void | Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const dispose of disposers.splice(0).reverse()) await dispose()
})

async function fixture(input: {
  readonly compaction?: AgentCompactionPolicy
  readonly settings?: CompactionSettings
  readonly reasoningEffort?: string
}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'nxt-compaction-model-'))
  disposers.push(() => rm(directory, { recursive: true, force: true }))
  const database = await openMigratedCoreDatabase(path.join(directory, 'core.sqlite'))
  disposers.push(() => database.close())
  const repository = new SqliteCoreRepository(database)
  let sequence = 0
  const core = new CoreService(repository, { nextUlid: () => `C${++sequence}` })
  const agent = core.createAgent({
    displayName: '压缩测试智能体',
    persona: '回复频道消息。',
    model: {
      provider: 'test-provider',
      model: 'chat-model',
      ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
    },
    ...(input.compaction === undefined ? {} : { compaction: input.compaction }),
  })
  const connection = core.createConnection({ adapterKey: 'fixture-alpha', config: {} })
  const channel = core.createChannel({
    connectionId: connection.id,
    platformChannelId: 'compaction.test',
    kind: 'internal',
  })
  const model = new RecordingModel()
  const host = await DshHostRuntime.create({
    sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
    communication: {
      sendMessage: () =>
        Promise.resolve({
          logicalMessageId: LogicalMessageIdSchema.parse(`msg_COMPACT${++sequence}`),
          status: 'sent',
          receipts: [],
        }),
    },
    history: repository,
    assets: repository,
    assetService: new AssetService(repository, path.join(directory, 'assets')),
    resolveAgentRevision: (revisionId) => repository.getAgentRevision(revisionId),
    compaction: {
      settings: () => input.settings ?? DEFAULT_COMPACTION_SETTINGS,
      currentRevision: (agentId) => repository.getAgent(agentId)?.revision,
    },
    configureLlm: (context) => {
      context.llm.registerAdapter(['test-provider'], model)
    },
  })
  disposers.push(() => host.dispose())
  const episode = {
    id: EpisodeIdSchema.parse('eps_COMPACTION'),
    channelId: channel.id,
    agentId: agent.definition.id,
    agentRevisionId: agent.revision.id,
    status: 'active' as const,
    openedAtEventId: core.appendInbound({
      connectionId: connection.id,
      channelId: channel.id,
      adapterKey: 'fixture-alpha',
      platformEventId: 'compaction-1',
      kind: 'message-created',
      parts: [{ type: 'text', text: '你好' }],
      platformTimestamp: Date.now(),
      receivedAt: Date.now(),
      dedupeKey: 'compaction-1',
    }).event.id,
    createdAt: Date.now(),
  }
  const summarize = (revision: AgentRevisionRecord = agent.revision) =>
    host.createHandoffSummary({
      dshSessionId: 'nxt-eps_COMPACTION',
      episode,
      revision,
      sourceEvents: [],
      generatedAt: Date.now(),
    })
  const summaryCalls = () => model.calls.filter((call) => call.system?.startsWith('你在给一个群聊智能体写压缩记录'))
  return { core, repository, agent, host, model, channel, connection, episode, summarize, summaryCalls }
}

const asked = (call: GenerateOptions | undefined) => ({
  provider: call?.provider,
  model: call?.model,
  effort: call?.reasoningEffort === undefined ? undefined : String(call.reasoningEffort),
})

describe('compaction into a new session', () => {
  it('requires measured occupancy at the configured threshold and reads setting changes without a new session', async () => {
    const settings = { ...DEFAULT_COMPACTION_SETTINGS }
    const f = await fixture({ settings })
    expect(f.host.shouldCompactIdleSession('unknown-session')).toBe(false)
    const metrics = vi.spyOn(f.host, 'sessionRuntimeMetrics')
    metrics.mockReturnValue({ occupancy: { projectedTokens: 66_800, contextWindow: 1_000_000 } })
    expect(f.host.shouldCompactIdleSession('fixture-session')).toBe(false)
    metrics.mockReturnValue({ occupancy: { projectedTokens: 499_999, contextWindow: 1_000_000 } })
    expect(f.host.shouldCompactIdleSession('fixture-session')).toBe(false)
    metrics.mockReturnValue({ occupancy: { projectedTokens: 500_000, contextWindow: 1_000_000 } })
    expect(f.host.shouldCompactIdleSession('fixture-session')).toBe(true)
    settings.idleThresholdPercent = 60
    expect(f.host.shouldCompactIdleSession('fixture-session')).toBe(false)
    settings.idleThresholdPercent = 30
    expect(f.host.shouldCompactIdleSession('fixture-session')).toBe(true)
    metrics.mockReturnValue({})
    expect(f.host.shouldCompactIdleSession('fixture-session')).toBe(false)
    expect(f.summaryCalls()).toHaveLength(0)
  })

  it('uses the main model by default, then the host default, then the agent’s own choice', async () => {
    const plain = await fixture({ reasoningEffort: 'high' })
    await plain.summarize()
    expect(asked(plain.summaryCalls()[0])).toEqual({ provider: 'test-provider', model: 'chat-model', effort: 'high' })

    const hosted = await fixture({
      settings: {
        ...DEFAULT_COMPACTION_SETTINGS,
        newSessionModel: {
          mode: 'custom',
          model: { provider: 'test-provider', model: 'fast-model', reasoningEffort: 'low' },
        },
        timeoutSeconds: 180,
      },
    })
    const result = await hosted.summarize()
    expect(asked(hosted.summaryCalls()[0])).toEqual({ provider: 'test-provider', model: 'fast-model', effort: 'low' })
    expect(result).toMatchObject({ summary: '整理好的记录。', model: 'fast-model' })

    const own = await fixture({
      settings: {
        ...DEFAULT_COMPACTION_SETTINGS,
        newSessionModel: { mode: 'custom', model: { provider: 'test-provider', model: 'fast-model' } },
        timeoutSeconds: 180,
      },
      compaction: {
        inSession: { mode: 'follow' },
        newSession: { mode: 'custom', model: { provider: 'test-provider', model: 'agent-model' } },
      },
    })
    await own.summarize()
    expect(asked(own.summaryCalls()[0])).toEqual({ provider: 'test-provider', model: 'agent-model', effort: undefined })
  })

  it('reads the agent’s current choice, so a change applies to the next compaction', async () => {
    const f = await fixture({})
    f.core.reviseAgent(f.agent.definition.id, f.agent.revision.id, {
      displayName: '压缩测试智能体',
      persona: '回复频道消息。',
      model: { provider: 'test-provider', model: 'chat-model' },
      compaction: {
        inSession: { mode: 'follow' },
        newSession: { mode: 'custom', model: { provider: 'test-provider', model: 'later-model' } },
      },
    })
    // The episode still runs the revision it opened with.
    await f.summarize(f.agent.revision)
    expect(f.summaryCalls()[0]?.model).toBe('later-model')
  })

  it('stops waiting at the configured limit and shows the channel as compacting meanwhile', async () => {
    const f = await fixture({ settings: { ...DEFAULT_COMPACTION_SETTINGS, timeoutSeconds: 0.2 } })
    f.model.hang = true
    const started = Date.now()
    const pending = f.summarize()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(f.host.newSessionCompactionStartedAt(f.channel.id)).toBeGreaterThanOrEqual(started)
    const result = await pending
    expect(Date.now() - started).toBeLessThan(2000)
    expect(result.summary).toContain('没能整理出压缩记录')
    expect(f.host.newSessionCompactionStartedAt(f.channel.id)).toBeUndefined()
  })
})

describe('compaction inside a session', () => {
  const runTurnAndCompact = async (f: Awaited<ReturnType<typeof fixture>>) => {
    const sessionId = await f.host.createSession({
      episodeId: f.episode.id,
      channelId: f.channel.id,
      agentId: f.agent.definition.id,
      agentRevisionId: f.agent.revision.id,
    })
    const event = f.core.appendInbound({
      connectionId: f.connection.id,
      channelId: f.channel.id,
      adapterKey: 'fixture-alpha',
      platformEventId: 'compaction-2',
      kind: 'message-created',
      // Long enough that the summary is smaller than what it replaces.
      parts: [{ type: 'text', text: '请记住这件事。'.repeat(200) }],
      platformTimestamp: Date.now(),
      receivedAt: Date.now(),
      dedupeKey: 'compaction-2',
    }).event
    await f.host.admit({
      dshSessionId: sessionId,
      admissionId: AdmissionIdSchema.parse('adm_COMPACTION1'),
      events: [event],
      mode: 'followup',
      replyRequired: false,
    })
    await f.host.whenIdle(sessionId)
    await f.host.compactSessionNow(sessionId)
    return f.model.calls.filter((call) => call.purpose === 'compaction')
  }

  it('follows the main model and its thinking level, which is what keeps the provider cache', async () => {
    const calls = await runTurnAndCompact(await fixture({ reasoningEffort: 'high' }))
    expect(calls.length).toBeGreaterThan(0)
    expect(asked(calls[0])).toEqual({ provider: 'test-provider', model: 'chat-model', effort: 'high' })
  })

  it('uses the model the agent chose for it', async () => {
    const calls = await runTurnAndCompact(
      await fixture({
        reasoningEffort: 'high',
        compaction: {
          inSession: {
            mode: 'custom',
            model: { provider: 'test-provider', model: 'chat-model', reasoningEffort: 'low' },
          },
          newSession: { mode: 'follow' },
        },
      }),
    )
    expect(asked(calls[0])).toEqual({ provider: 'test-provider', model: 'chat-model', effort: 'low' })
  })
})

describe('compaction threshold', () => {
  const openSession = async (f: Awaited<ReturnType<typeof fixture>>) =>
    f.host.createSession({
      episodeId: f.episode.id,
      channelId: f.channel.id,
      agentId: f.agent.definition.id,
      agentRevisionId: f.agent.revision.id,
    })
  let message = 0
  const say = async (f: Awaited<ReturnType<typeof fixture>>, sessionId: string) => {
    message += 1
    const event = f.core.appendInbound({
      connectionId: f.connection.id,
      channelId: f.channel.id,
      adapterKey: 'fixture-alpha',
      platformEventId: `threshold-${message}`,
      kind: 'message-created',
      parts: [{ type: 'text', text: '请记住这件事。'.repeat(200) }],
      platformTimestamp: Date.now(),
      receivedAt: Date.now(),
      dedupeKey: `threshold-${message}`,
    }).event
    await f.host.admit({
      dshSessionId: sessionId,
      admissionId: AdmissionIdSchema.parse(`adm_THRESHOLD${message}`),
      events: [event],
      mode: 'followup',
      replyRequired: false,
    })
    await f.host.whenIdle(sessionId)
  }
  const revise = (f: Awaited<ReturnType<typeof fixture>>, thresholdRatio: number | undefined) =>
    f.core.reviseAgent(f.agent.definition.id, f.repository.getAgent(f.agent.definition.id)!.revision.id, {
      displayName: '压缩测试智能体',
      persona: '回复频道消息。',
      model: { provider: 'test-provider', model: 'chat-model' },
      compaction: {
        inSession: { mode: 'follow' },
        newSession: { mode: 'follow' },
        ...(thresholdRatio === undefined ? {} : { thresholdRatio }),
      },
    })

  it('reads the override, then the agent’s current setting, and leaves the default alone', async () => {
    const f = await fixture({})
    const sessionId = await openSession(f)
    expect(f.host.compactionThresholdRatio(sessionId, 1_000_000)).toBeUndefined()
    revise(f, 0.5)
    // The running conversation keeps its revision; the setting is read live.
    expect(f.host.compactionThresholdRatio(sessionId, 1_000_000)).toBe(0.5)
    expect(f.host.compactionThresholdRatio(sessionId, 200_000)).toBe(0.5)
    revise(f, 0.2)
    expect(f.host.compactionThresholdRatio(sessionId, 128_000)).toBe(0.5)
    f.host.setCompactionThresholdOverride(sessionId, 0.3)
    expect(f.host.compactionThresholdRatio(sessionId, 1_000_000)).toBe(0.3)
    expect(f.host.compactionThresholdRatio('another-session', 1_000_000)).toBeUndefined()
  })

  it('hands DSH the agent’s threshold under pressure and drops the override once the conversation compacts', async () => {
    // What DSH resolves its pressure policy from, at the moment it does.
    const seen: number[] = []
    // eslint-disable-next-line @typescript-eslint/unbound-method -- The captured original is always invoked with apply(this) below.
    const original = BasicCompactionEngine.prototype.compactIfNeeded
    vi.spyOn(BasicCompactionEngine.prototype, 'compactIfNeeded').mockImplementation(function (
      this: BasicCompactionEngine,
      ...args: Parameters<BasicCompactionEngine['compactIfNeeded']>
    ) {
      if (args[1] === 'pressure') seen.push(this.config.thresholdRatio)
      return original.apply(this, args)
    })
    const f = await fixture({})
    f.model.inputTokens = 300_000
    const sessionId = await openSession(f)
    await say(f, sessionId)
    await say(f, sessionId)
    revise(f, 0.25)
    await say(f, sessionId)
    f.host.setCompactionThresholdOverride(sessionId, 0.6)
    await say(f, sessionId)
    revise(f, undefined)
    f.host.setCompactionThresholdOverride(sessionId, undefined)
    await say(f, sessionId)
    expect(seen.at(0)).toBe(0.8)
    expect(seen.slice(-3)).toEqual([0.25, 0.6, 0.8])

    f.host.setCompactionThresholdOverride(sessionId, 0.6)
    await f.host.compactSessionNow(sessionId)
    expect(f.host.compactionThresholdOverride(sessionId)).toBeUndefined()
  })
})
