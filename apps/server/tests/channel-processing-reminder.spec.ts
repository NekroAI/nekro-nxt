import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { AssetService, CoreService } from '@nekro-nxt/core'
import { AdmissionIdSchema, EpisodeIdSchema, LogicalMessageIdSchema } from '@nekro-nxt/contracts'
import { openMigratedCoreDatabase, SqliteCoreRepository } from '@nekro-nxt/storage-sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DshHostRuntime } from '../src/index.js'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

class ProcessingModel extends LlmAdapter {
  readonly calls: GenerateOptions[] = []
  #step = 0
  constructor(public script: readonly { name: string; args: unknown }[]) {
    super()
  }
  reset(script: typeof this.script): void {
    this.script = script
    this.#step = 0
  }
  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text'] as const })
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    await Promise.resolve()
    this.calls.push(options)
    const call = this.script[this.#step++]
    if (call) {
      const id = ToolCallId(`processing-${this.calls.length}`)
      const argumentsText = JSON.stringify(call.args)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: call.name, argumentsDelta: argumentsText }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: call.name, arguments: argumentsText } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '工具返回后继续处理。' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

const disposers: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
  vi.restoreAllMocks()
})

const send = { name: 'send_channel_message', args: { target: { type: 'current' }, parts: [{ text: '测试进展。' }] } }
const lookup = { name: 'nekro_nxt_channel_context', args: {} }
const program = (code: string) => ({ name: 'run_code', args: { description: '验证提醒时机', code } })
const deliveryStateOf = (meta: unknown): unknown =>
  typeof meta === 'object' && meta !== null && 'deliveryState' in meta ? meta.deliveryState : undefined
const reminderEvents = (events: readonly SessionEvent[]) =>
  events.filter(
    (event) => event.type === 'user/message' && event.data.source.kind === 'nekro-nxt-channel-processing-reminder',
  )
const reminderCount = (request: GenerateOptions | undefined) =>
  request?.messages.filter((message) => message.source?.kind === 'nekro-nxt-channel-processing-reminder').length

const fixture = async (input: {
  script: ProcessingModel['script']
  ptc?: boolean
  sendStatus?: 'sent' | 'partially-sent' | 'failed' | 'unknown'
  configure?: (context: Context) => void
}) => {
  let now = 1_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const directory = await mkdtemp(path.join(tmpdir(), 'nxt-processing-reminder-'))
  disposers.push(() => rm(directory, { recursive: true, force: true }))
  const database = await openMigratedCoreDatabase(path.join(directory, 'core.sqlite'))
  disposers.push(() => database.close())
  const repository = new SqliteCoreRepository(database)
  const assetService = new AssetService(repository, path.join(directory, 'assets'))
  let sequence = 0
  const core = new CoreService(repository, { now: () => now, nextUlid: () => `P${++sequence}` })
  const definition = core.createAgent({
    displayName: '处理提醒测试智能体',
    persona: '回复频道消息。',
    model: { provider: 'test-provider', model: 'chat-model' },
    capabilities: { codeRun: input.ptc === true, developmentShell: input.ptc === true, fileTools: input.ptc === true },
  })
  const connection = core.createConnection({ adapterKey: 'fixture-alpha', config: {} })
  const channel = core.createChannel({
    connectionId: connection.id,
    platformChannelId: 'processing.test',
    kind: 'internal',
  })
  const model = new ProcessingModel(input.script)
  const createHost = () =>
    DshHostRuntime.create({
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      developmentWorkspaceRoot: path.join(directory, 'workspaces'),
      codeRunNode: () => ({}),
      communication: {
        sendMessage: () =>
          Promise.resolve({
            logicalMessageId: LogicalMessageIdSchema.parse(`msg_PROCESSING${++sequence}`),
            status: input.sendStatus ?? 'failed',
            receipts: [],
          }),
      },
      history: repository,
      assets: repository,
      assetService,
      resolveAgentRevision: (revisionId) => repository.getAgentRevision(revisionId),
      configureLlm: (context) => {
        context.llm.registerAdapter(['test-provider'], model)
        input.configure?.(context)
      },
    })
  let host = await createHost()
  disposers.push(() => host.dispose())
  const sessionInput = {
    episodeId: EpisodeIdSchema.parse('eps_PROCESSING'),
    channelId: channel.id,
    agentId: definition.definition.id,
    agentRevisionId: definition.revision.id,
  }
  const sessionId = await host.createSession(sessionInput)
  const admit = async (mode: 'followup' | 'inject' = 'followup') => {
    const key = `input-${++sequence}`
    const event = core.appendInbound({
      connectionId: connection.id,
      channelId: channel.id,
      adapterKey: 'fixture-alpha',
      platformEventId: key,
      kind: 'message-created',
      parts: [{ type: 'text', text: '请处理这条测试消息。' }],
      platformTimestamp: now,
      receivedAt: now,
      dedupeKey: key,
    }).event
    await host.admit({
      dshSessionId: sessionId,
      admissionId: AdmissionIdSchema.parse(`adm_P${sequence}`),
      events: [event],
      mode,
      replyRequired: false,
    })
  }
  return {
    model,
    sessionId,
    admit,
    advance: (ms: number) => {
      now += ms
    },
    events: () => host.sessionEvents(sessionId),
    idle: () => host.whenIdle(sessionId),
    restart: async () => {
      await host.dispose()
      host = await createHost()
      expect(await host.createSession(sessionInput)).toBe(sessionId)
    },
  }
}

describe('channel processing reminder with the assembled DSH Host', () => {
  it.each([false, true])('waits for the complete root, including forwarded context (PTC=%s)', async (ptc) => {
    const started = deferred()
    const release = deferred()
    const nestedDone = deferred()
    const releaseParent = deferred()
    disposers.push(() => {
      release.resolve()
      releaseParent.resolve()
    })
    const f = await fixture({
      ptc,
      script: [
        ptc ? program("await tools.forward_context({}); return 'done'") : { name: 'forward_context', args: {} },
        ptc ? program('return await tools.nekro_nxt_channel_context({})') : lookup,
      ],
      configure: (context) => {
        context.inject(['tools'], (ctx) => {
          ctx.tools.register(
            defineTool({
              name: 'context_leaf',
              description: '测试上下文',
              parameters: {},
              output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'leaf completed' }] },
              async execute(_args, exec) {
                started.resolve()
                await release.promise
                exec.signal.throwIfAborted()
                exec.deferContext(
                  createUserMessage({
                    content: [{ type: 'text', text: 'forwarded fixture context' }],
                    source: { kind: 'tool-registry' },
                  }),
                )
                return 'done'
              },
            }),
          )
          ctx.tools.register(
            defineTool({
              name: 'forward_context',
              description: '测试转发',
              parameters: {},
              output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'forward completed' }] },
              async execute(_args, exec) {
                const result = await ctx.tools.execute({
                  callId: ToolCallId(`${exec.callId}-leaf`),
                  rootCallId: exec.rootCallId,
                  parent: exec.token,
                  name: 'context_leaf',
                  arguments: {},
                  ...(exec.agent === undefined ? {} : { agent: exec.agent }),
                  signal: exec.signal,
                })
                if (result.isError) throw new Error('Leaf failed')
                for (const message of result.additionalContexts ?? []) exec.deferContext(message)
                return 'done'
              },
            }),
          )
        })
        if (ptc)
          context.on('tools/post-execute', async (exec, _result, next) => {
            if (exec.name === 'run_code' && String(exec.callId) === 'processing-1') {
              nestedDone.resolve()
              await releaseParent.promise
            }
            return next()
          })
      },
    })
    try {
      await f.admit()
      await started.promise
      f.advance(60_000)
      await f.admit('inject')
      expect(f.model.calls).toHaveLength(1)
      expect(reminderEvents(f.events())).toHaveLength(0)
      release.resolve()
      if (ptc) {
        await nestedDone.promise
        expect(f.events().some((event) => event.type === 'tool/ptc-dispatch')).toBe(true)
        expect(f.events().some((event) => event.type === 'tool/result')).toBe(false)
        expect(reminderEvents(f.events())).toHaveLength(0)
        expect(f.model.calls).toHaveLength(1)
        releaseParent.resolve()
      }
      await f.idle()
      expect(f.model.calls).toHaveLength(3)
      expect(reminderCount(f.model.calls[1])).toBe(1)
      expect(reminderEvents(f.events())).toHaveLength(1)
      const messages = f.model.calls[1]!.messages
      const resultIndex = messages.findIndex((message) => message.role === 'tool')
      const contextIndex = messages.findIndex((message) =>
        message.content.some((block) => block.type === 'text' && block.text === 'forwarded fixture context'),
      )
      const reminderIndex = messages.findIndex(
        (message) => message.source?.kind === 'nekro-nxt-channel-processing-reminder',
      )
      expect(contextIndex).toBeGreaterThan(resultIndex)
      expect(reminderIndex).toBeGreaterThan(contextIndex)
    } finally {
      release.resolve()
      releaseParent.resolve()
    }
  })

  it.each([
    { ptc: false, status: 'sent' },
    { ptc: false, status: 'partially-sent' },
    { ptc: true, status: 'sent' },
    { ptc: true, status: 'partially-sent' },
  ] as const)('suppresses $status in the current channel after inject (PTC=$ptc)', async ({ ptc, status }) => {
    const started = deferred()
    const release = deferred()
    const f = await fixture({
      ptc,
      sendStatus: status,
      script: [
        ptc
          ? program(`await tools.send_channel_message(${JSON.stringify(send.args)}); throw new Error('after send')`)
          : send,
        ptc ? program('return 1') : lookup,
      ],
      configure: (context) => {
        context.on('tools/execute', async (exec, next) => {
          if (exec.name === 'send_channel_message') {
            started.resolve()
            await release.promise
          }
          return next()
        })
      },
    })
    try {
      await f.admit()
      await started.promise
      f.advance(60_000)
      await f.admit('inject')
      release.resolve()
      await f.idle()
      expect(f.model.calls).toHaveLength(3)
      expect(
        f
          .events()
          .some(
            (event) =>
              (event.type === 'tool/result' || event.type === 'tool/ptc-dispatch') &&
              deliveryStateOf(event.data.meta) === status,
          ),
      ).toBe(true)
      expect(reminderEvents(f.events())).toHaveLength(0)
    } finally {
      release.resolve()
    }
  })

  it('starts a new budget after restart, without old reminders or downtime triggering a new turn', async () => {
    let elapsed = 60_000
    let advance: (ms: number) => void = () => {
      throw new Error('Fixture not ready')
    }
    const f = await fixture({
      script: [lookup, lookup],
      configure: (context) => {
        context.on('tools/execute', async (_exec, next) => {
          advance(elapsed)
          return next()
        })
      },
    })
    advance = f.advance
    await f.admit()
    await f.idle()
    expect(reminderEvents(f.events())).toHaveLength(1)
    f.advance(600_000)
    await f.restart()
    elapsed = 59_999
    f.model.reset([lookup])
    await f.admit()
    await f.idle()
    expect(reminderEvents(f.events())).toHaveLength(1)
    f.model.reset([lookup, lookup])
    await f.admit()
    await f.idle()
    expect(reminderEvents(f.events())).toHaveLength(2)
  })
})
