import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { AssetService, CoreService } from '@nekro-nxt/core'
import { AdmissionIdSchema, EpisodeIdSchema, LogicalMessageIdSchema } from '@nekro-nxt/contracts'
import { openMigratedCoreDatabase, SqliteCoreRepository } from '@nekro-nxt/storage-sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DshHostRuntime } from '../src/index.ts'
import { projectChannelRuntime } from '../src/channel-runtime-projection.ts'

const systemText = (options: GenerateOptions | undefined): string =>
  options?.messages
    .filter((message) => message.role === 'system')
    .flatMap((message) => message.content)
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n') ?? ''

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

/** Answers one channel message with a single `run_code` program that sends two messages. */
class CodeRunModel extends LlmAdapter {
  readonly calls: GenerateOptions[] = []

  constructor(private readonly program: string) {
    super()
  }

  override providerInfo(provider: string) {
    return { id: provider, name: 'Code run model' }
  }

  override listModels(provider: string) {
    return Promise.resolve([{ provider, id: 'chat-model', name: 'Chat model', inputModalities: ['text'] as const }])
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
    this.calls.push(options)
    if (!options.messages.some((message) => message.role === 'tool')) {
      const id = ToolCallId('code-run-program')
      const argumentsText = JSON.stringify({ description: '分两条回复', code: this.program })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'run_code', argumentsDelta: argumentsText }
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id, name: 'run_code', arguments: argumentsText },
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: '脚本跑完了。' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '脚本跑完了。' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const sendTwice = `
await tools.send_channel_message({ target: { type: 'current' }, parts: [{ text: '第一条' }] })
await tools.send_channel_message({ target: { type: 'current' }, parts: [{ text: '第二条' }] })
return 'done'
`

const runScenario = async (input: {
  readonly program: string
  readonly capabilities: { readonly codeRun: boolean; readonly developmentShell: boolean }
  readonly codeRunNode?: () => { readonly executable?: string } | undefined
}) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-code-run-'))
  temporaryDirectories.push(directory)
  const database = await openMigratedCoreDatabase(path.join(directory, 'core.sqlite'))
  const repository = new SqliteCoreRepository(database)
  const assetService = new AssetService(repository, path.join(directory, 'assets'))
  let sequence = 0
  const core = new CoreService(repository, { now: () => 900, nextUlid: () => `R${++sequence}` })
  const definition = core.createAgent({
    displayName: '脚本智能体',
    persona: '回复频道消息。',
    model: { provider: 'test-provider', model: 'chat-model' },
    capabilities: { fileTools: true, ...input.capabilities },
  })
  const connection = core.createConnection({ adapterKey: 'fixture-alpha', config: {} })
  const channel = core.createChannel({ connectionId: connection.id, platformChannelId: 'code-run', kind: 'internal' })
  const inbound = core.appendInbound({
    connectionId: connection.id,
    channelId: channel.id,
    adapterKey: 'fixture-alpha',
    platformEventId: 'code-run-inbound',
    kind: 'message-created',
    parts: [{ type: 'text', text: '用两条消息回我。' }],
    platformTimestamp: 900,
    receivedAt: 900,
    dedupeKey: 'code-run-inbound',
  }).event
  const sentParts: unknown[] = []
  const model = new CodeRunModel(input.program)
  const host = await DshHostRuntime.create({
    sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
    developmentWorkspaceRoot: path.join(directory, 'workspaces'),
    codeRunNode: input.codeRunNode ?? (() => ({})),
    communication: {
      sendMessage: (message) => {
        sentParts.push(message.parts)
        return Promise.resolve({
          logicalMessageId: LogicalMessageIdSchema.parse(`msg_CODERUN${sentParts.length}`),
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
  const episodeId = EpisodeIdSchema.parse('eps_CODERUN')
  const sessionId = await host.createSession({
    episodeId,
    channelId: channel.id,
    agentId: definition.definition.id,
    agentRevisionId: definition.revision.id,
  })
  await host.admit({
    dshSessionId: sessionId,
    admissionId: AdmissionIdSchema.parse('adm_CODERUN'),
    events: [inbound],
    mode: 'followup',
    replyRequired: true,
  })
  await host.whenIdle(sessionId)
  const projection = projectChannelRuntime({
    channelId: channel.id,
    agentId: definition.definition.id,
    episodeId,
    sessionStatus: host.sessionStatus(sessionId),
    pendingInjectCount: 0,
    events: host.normalizedSessionEvents(sessionId),
  })
  return {
    host,
    database,
    model,
    sentParts,
    projection,
    events: host.sessionEvents(sessionId),
    dispose: async () => {
      await host.dispose()
      database.close()
    },
  }
}

describe('run_code for agents granted codeRun', () => {
  it('sends from one program, counts as the reply and shows the calls under the program', async () => {
    const scenario = await runScenario({ program: sendTwice, capabilities: { codeRun: true, developmentShell: true } })
    try {
      expect(scenario.model.calls[0]?.tools?.map(({ name }) => name)).toEqual(['run_code'])
      expect(systemText(scenario.model.calls[0])).toContain('一起写在同一段程序的最后')
      expect(scenario.sentParts).toEqual([[{ type: 'text', text: '第一条' }], [{ type: 'text', text: '第二条' }]])
      expect(
        scenario.events.filter(
          (event) => event.type === 'user/message' && event.data.source.kind === 'nekro-nxt-channel-reply-guard',
        ),
      ).toHaveLength(0)
      const turn = scenario.projection.turns[0]
      expect(turn).toMatchObject({ state: 'completed', producedReply: true })
      const program = turn?.steps.flatMap((step) => step.tools).find((tool) => tool.name === 'run_code')
      expect(program).toMatchObject({ state: 'succeeded', inputPreview: '分两条回复' })
      expect(program?.children?.map((child) => [child.name, child.wroteToChannel, child.deliveryState])).toEqual([
        ['send_channel_message', true, 'sent'],
        ['send_channel_message', true, 'sent'],
      ])
      expect(turn?.steps.flatMap((step) => step.tools).filter((tool) => tool.name !== 'run_code')).toEqual([])
    } finally {
      await scenario.dispose()
    }
  }, 60_000)

  it('ends the turn from the same program that sent the reply', async () => {
    const scenario = await runScenario({
      program: `
await tools.send_channel_message({ target: { type: 'current' }, parts: [{ text: '好的' }] })
await tools.finish_channel_turn({ outcome: 'response-complete', reason: '已经回复' })
return 'done'
`,
      capabilities: { codeRun: true, developmentShell: true },
    })
    try {
      const program = scenario.projection.turns[0]?.steps
        .flatMap((step) => step.tools)
        .find((tool) => tool.name === 'run_code')
      expect(program?.children?.map((child) => [child.name, child.state])).toEqual([
        ['send_channel_message', 'succeeded'],
        ['finish_channel_turn', 'succeeded'],
      ])
      // The program ended the turn, so the model is not asked again.
      expect(scenario.model.calls).toHaveLength(1)
      expect(scenario.projection.turns[0]).toMatchObject({ state: 'completed', producedReply: true })
    } finally {
      await scenario.dispose()
    }
  }, 60_000)

  it('runs programs with a separate Node executable, as the desktop app does', async () => {
    const scenario = await runScenario({
      program: sendTwice,
      capabilities: { codeRun: true, developmentShell: true },
      codeRunNode: () => ({ executable: process.execPath }),
    })
    try {
      expect(scenario.sentParts).toHaveLength(2)
      expect(scenario.projection.turns[0]).toMatchObject({ state: 'completed', producedReply: true })
    } finally {
      await scenario.dispose()
    }
  }, 60_000)

  it('keeps ordinary tool calls without the shell grant or without a usable Node', async () => {
    for (const variant of [
      { capabilities: { codeRun: true, developmentShell: false } },
      { capabilities: { codeRun: true, developmentShell: true }, codeRunNode: () => undefined },
    ]) {
      const scenario = await runScenario({ program: sendTwice, ...variant })
      try {
        const names = scenario.model.calls[0]?.tools?.map(({ name }) => name) ?? []
        expect(names).toContain('send_channel_message')
        expect(names).not.toContain('run_code')
        expect(systemText(scenario.model.calls[0])).not.toContain('用 run_code 时')
      } finally {
        await scenario.dispose()
      }
    }
  }, 60_000)
})
