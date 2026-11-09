/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Governance and the authoring ledger are stubbed with only the calls these conversations make. */
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { AssetService, CoreService } from '@nekro-nxt/core'
import { AdmissionIdSchema, EpisodeHandoffIdSchema, EpisodeIdSchema, ExtensionIdSchema } from '@nekro-nxt/contracts'
import type { DynamicAuthoringService } from '@nekro-nxt/extension-runtime'
import { openMigratedCoreDatabase, SqliteCoreRepository } from '@nekro-nxt/storage-sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ExtensionGovernanceToolPort } from '../src/extension-governance/tool-port.ts'
import { DshHostRuntime, type ScheduledTaskPort } from '../src/index.ts'
import { communityBrowser } from '../src/community-agent-tools.ts'

type Step = { readonly name: string; readonly args: Record<string, unknown> } | undefined

const textOf = (options: GenerateOptions | undefined, role: string): string =>
  options?.messages
    .filter((message) => message.role === role)
    .flatMap((message) => message.content)
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n') ?? ''

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

/** Plays the given tool calls one per request, then ends the turn with text. */
class ScriptModel extends LlmAdapter {
  readonly calls: GenerateOptions[] = []

  constructor(
    private readonly steps: readonly Step[],
    private readonly toolUpdate?: 'addition-only',
  ) {
    super()
  }

  override providerInfo(provider: string) {
    return { id: provider, name: 'Script model' }
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
      ...(this.toolUpdate === undefined ? {} : { toolUpdate: this.toolUpdate }),
    })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    await Promise.resolve()
    const step = this.steps[this.calls.length]
    this.calls.push(options)
    if (step !== undefined) {
      const id = ToolCallId(`script-call-${this.calls.length}`)
      const argumentsText = JSON.stringify(step.args)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: step.name, argumentsDelta: argumentsText }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: step.name, arguments: argumentsText } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: '好了。' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '好了。' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** A community catalog of one fictional extension, already installed here. */
const fixtureCommunity = {
  cachedRead: async (_kind: string, _query: unknown, _refresh: boolean, load: () => Promise<object>) => ({
    ...(await load()),
    fetchedAt: 1,
    stale: false,
  }),
  listExtensions: () =>
    Promise.resolve({
      items: [
        {
          id: ExtensionIdSchema.parse('ext_01SESSIONWEATHER'),
          provides: ['agent'],
          displayName: '虚构社区天气',
          summary: '查询虚构城市的天气。',
          tags: [],
          iconUrl: null,
          official: false,
          publisher: { handle: 'fixture-author', displayName: '示例作者', avatarUrl: null },
          latest: null,
          downloads: 0,
          updatedAt: 1,
          pageUrl: 'https://community.example/extensions/ext_01SESSIONWEATHER',
        },
      ],
      nextCursor: null,
    }),
  getExtension: () => Promise.reject(new Error('not used')),
}

/** Governance as far as listing goes; a fictional extension stands in for the local catalog. */
const governance = {
  requesterAllowed: () => ({ allowed: true }),
  requester: () => ({ kind: 'admin' }),
  list: () => ({ autonomy: 'autonomous', extensions: [{ name: '虚构天气查询' }] }),
  community: () => communityBrowser(fixtureCommunity, { installed: () => true, updatable: () => false }),
} as unknown as ExtensionGovernanceToolPort

const runScenario = async (input: {
  readonly steps: readonly Step[]
  readonly capabilities: Record<string, unknown>
  readonly toolUpdate?: 'addition-only'
  /** Without the authoring ledger and governance, as a host without extension management runs. */
  readonly withoutGovernance?: boolean
  /** Scheduled tasks the agent's schedule tools manage; absent hosts offer no schedule tools. */
  readonly scheduledTasks?: ScheduledTaskPort
}) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-capability-packs-'))
  temporaryDirectories.push(directory)
  const database = await openMigratedCoreDatabase(path.join(directory, 'core.sqlite'))
  const repository = new SqliteCoreRepository(database)
  const assetService = new AssetService(repository, path.join(directory, 'assets'))
  let sequence = 0
  const core = new CoreService(repository, { now: () => 900, nextUlid: () => `P${++sequence}` })
  const definition = core.createAgent({
    displayName: '能力包智能体',
    persona: '回复频道消息。',
    model: { provider: 'test-provider', model: 'chat-model' },
    capabilities: input.capabilities,
  })
  const connection = core.createConnection({ adapterKey: 'fixture-alpha', config: {} })
  const channel = core.createChannel({ connectionId: connection.id, platformChannelId: 'packs', kind: 'internal' })
  const inbound = core.appendInbound({
    connectionId: connection.id,
    channelId: channel.id,
    adapterKey: 'fixture-alpha',
    platformEventId: 'packs-inbound',
    kind: 'message-created',
    parts: [{ type: 'text', text: '看看有哪些扩展。' }],
    platformTimestamp: 900,
    receivedAt: 900,
    dedupeKey: 'packs-inbound',
  }).event
  const model = new ScriptModel(input.steps, input.toolUpdate)
  const host = await DshHostRuntime.create({
    sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
    developmentWorkspaceRoot: path.join(directory, 'workspaces'),
    codeRunNode: () => ({}),
    communication: { sendMessage: () => Promise.reject(new Error('not used')) },
    history: repository,
    assets: repository,
    assetService,
    resolveAgentRevision: (revisionId) => repository.getAgentRevision(revisionId),
    ...(input.withoutGovernance === true
      ? {}
      : {
          authoring: {
            service: { pauseTasksOfEpisode: () => undefined } as unknown as DynamicAuthoringService,
            resolveInitiatingEvent: () => undefined,
            governance: () => governance,
          },
        }),
    ...(input.scheduledTasks === undefined
      ? {}
      : {
          extensionHost: {
            activationBackends: {},
            dynamicBackends: {},
            describeRevision: () => ({
              displayName: '虚构扩展',
              capabilities: undefined,
              hostCapabilities: undefined,
              secretKeys: { agent: [], host: [] },
            }),
            scheduledTasks: input.scheduledTasks,
          } as unknown as NonNullable<Parameters<typeof DshHostRuntime.create>[0]['extensionHost']>,
        }),
    configureLlm: (context) => {
      context.llm.registerAdapter(['test-provider'], model)
    },
  })
  const sessionId = await host.createSession({
    episodeId: EpisodeIdSchema.parse('eps_PACKS'),
    channelId: channel.id,
    agentId: definition.definition.id,
    agentRevisionId: definition.revision.id,
  })
  return {
    host,
    model,
    sessionId,
    /** The session after this one, as a compaction into a new session opens it. */
    openNextSession: () =>
      host.createSession({
        episodeId: EpisodeIdSchema.parse('eps_PACKSNEXT'),
        channelId: channel.id,
        agentId: definition.definition.id,
        agentRevisionId: definition.revision.id,
        handoff: {
          id: EpisodeHandoffIdSchema.parse('hof_PACKSNEXT'),
          fromEpisodeId: EpisodeIdSchema.parse('eps_PACKS'),
          sourceEventIds: [],
          createdAt: 950,
          provider: 'test-provider',
          model: 'chat-model',
          summary: '虚构的压缩摘要。',
          recentEvents: [],
        },
      }),
    run: async (target = sessionId, admission = 'adm_PACKS') => {
      await host.admit({
        dshSessionId: target,
        admissionId: AdmissionIdSchema.parse(admission),
        events: [inbound],
        mode: 'followup',
        replyRequired: false,
      })
      await host.whenIdle(target)
    },
    dispose: async () => {
      await host.dispose()
      database.close()
    },
  }
}

const program = (code: string): Step => ({ name: 'run_code', args: { description: '扩展', code } })

describe('capability packs in a conversation', () => {
  it('keeps pack tools out of the system prompt and lets a loaded pack run without changing it', async () => {
    const scenario = await runScenario({
      capabilities: { codeRun: true, developmentShell: true, extensionAutonomy: 'autonomous' },
      steps: [
        program(`
let refused = ''
try { await tools.nekro_nxt_extension_list({}) } catch (error) { refused = error.message }
const loaded = await tools.capability_load({ names: ['扩展管理'] })
return { refused, loaded }
`),
        program(`return await tools.nekro_nxt_extension_list({})`),
        program(`return await tools.capability_load({ names: ['扩展管理'] })`),
      ],
    })
    try {
      await scenario.run()
      const [first, second, third, fourth] = scenario.model.calls
      expect(first?.tools?.map(({ name }) => name)).toEqual(['run_code'])
      const system = textOf(first, 'system')
      expect(system).toContain('capability_load')
      expect(system).not.toContain('nekro_nxt_extension_list')
      expect(system).not.toContain('nekro_nxt_extension_action')
      expect(textOf(first, 'user')).toContain('- 扩展管理：查看和管理已有扩展')
      expect(textOf(first, 'user')).not.toContain('扩展开发')

      // The refusal names the pack; the delivery follows the program's result.
      expect(textOf(second, 'tool')).toContain('这个工具在「扩展管理」能力包里，先调用 capability_load 加载。')
      expect(textOf(second, 'tool')).toContain('已加载「扩展管理」')
      const delivery = textOf(second, 'user')
      expect(delivery).toContain('〔能力包「扩展管理」〕')
      expect(delivery).toContain('interface ToolArgsMap {')
      expect(delivery).toContain('nekro_nxt_extension_list:')
      expect(delivery).toContain('nekro_nxt_extension_action:')

      expect(textOf(third, 'tool')).toContain('虚构天气查询')
      expect(textOf(fourth, 'tool')).toContain('「扩展管理」已经加载过了。')

      for (const call of [second, third, fourth]) expect(textOf(call, 'system')).toBe(system)
      const events = scenario.host.sessionEvents(scenario.sessionId)
      expect(events.filter((event) => event.type === 'system/message')).toHaveLength(1)
      expect(
        events.filter(
          (event) => event.type === 'user/message' && event.data.source.kind === 'nekro-nxt-capability-catalog',
        ),
      ).toHaveLength(1)

      const context = scenario.host.sessionContext(scenario.sessionId)
      expect(context?.capabilityPacks).toEqual({ available: ['扩展管理', '社区'], loaded: ['扩展管理'] })
      expect(context?.promptSections?.map((section) => section.label)).toContain('工具声明')

      // The next session starts with nothing loaded; its handoff names what this one used.
      const next = await scenario.openNextSession()
      await scenario.run(next, 'adm_PACKSNEXT')
      const opening = scenario.model.calls.at(-1)
      expect(textOf(opening, 'user')).toContain('〔能力包〕上一段会话加载过「扩展管理」')
      expect(textOf(opening, 'user')).toContain('- 扩展管理：')
      expect(textOf(opening, 'system')).not.toContain('nekro_nxt_extension_list')
      expect(scenario.host.sessionContext(next)?.capabilityPacks?.loaded).toEqual([])
    } finally {
      await scenario.dispose()
    }
  }, 60_000)

  it('keeps the development tools out of the system prompt of a dynamic creation agent', async () => {
    const scenario = await runScenario({
      capabilities: { codeRun: true, developmentShell: true, dynamicCreation: true },
      withoutGovernance: true,
      steps: [],
    })
    try {
      expect(scenario.host.toolNames(scenario.sessionId)).toEqual(
        expect.arrayContaining(['cordis_define', 'cordis_run', 'nekro_nxt_extension_define']),
      )
      await scenario.run()
      const system = textOf(scenario.model.calls[0], 'system')
      for (const name of ['cordis_define', 'cordis_run', 'cordis_inspect_list', 'nekro_nxt_extension_define'])
        expect(system).not.toContain(name)
      expect(textOf(scenario.model.calls[0], 'user')).toContain('- 扩展开发：制作新扩展或修改扩展代码，试运行并保存。')
    } finally {
      await scenario.dispose()
    }
  }, 60_000)

  it('gives an agent with manual autonomy only the read-only tools, without dynamic creation', async () => {
    const scenario = await runScenario({
      capabilities: { codeRun: true, developmentShell: true },
      steps: [],
    })
    try {
      const tools = scenario.host.toolNames(scenario.sessionId)
      expect(tools).toEqual(
        expect.arrayContaining(['capability_load', 'nekro_nxt_extension_list', 'nekro_nxt_extension_inspect']),
      )
      expect(tools).not.toContain('nekro_nxt_extension_action')
      expect(tools).not.toContain('nekro_nxt_credential_list')
      expect(tools).not.toContain('nekro_nxt_extension_define')
      await scenario.run()
      expect(textOf(scenario.model.calls[0], 'user')).toContain('- 扩展管理：查看与你相关的扩展')
    } finally {
      await scenario.dispose()
    }
  }, 60_000)

  it('adds a loaded pack to the tools of a route that accepts additions', async () => {
    const scenario = await runScenario({
      capabilities: { extensionAutonomy: 'confirm' },
      toolUpdate: 'addition-only',
      steps: [
        { name: 'capability_load', args: { names: ['扩展管理'] } },
        { name: 'nekro_nxt_extension_list', args: {} },
      ],
    })
    try {
      await scenario.run()
      const [first, , third] = scenario.model.calls
      const names = (call: GenerateOptions | undefined) => call?.tools?.map(({ name }) => name) ?? []
      expect(names(first)).toContain('capability_load')
      expect(names(first)).not.toContain('nekro_nxt_extension_list')
      expect(names(third)).toEqual(expect.arrayContaining(['nekro_nxt_extension_list', 'nekro_nxt_extension_action']))
      expect(textOf(third, 'tool')).toContain('虚构天气查询')
    } finally {
      await scenario.dispose()
    }
  }, 60_000)

  it('keeps every tool resident on a route that cannot add tools later', async () => {
    const scenario = await runScenario({ capabilities: { extensionAutonomy: 'confirm' }, steps: [] })
    try {
      await scenario.run()
      const names = scenario.model.calls[0]?.tools?.map(({ name }) => name) ?? []
      expect(names).toContain('nekro_nxt_extension_list')
      expect(names).not.toContain('capability_load')
      expect(scenario.host.sessionContext(scenario.sessionId)?.capabilityPacks).toBeUndefined()
    } finally {
      await scenario.dispose()
    }
  }, 60_000)
  it('lets any agent browse the community once it loads the pack', async () => {
    const scenario = await runScenario({
      capabilities: { codeRun: true, developmentShell: true },
      steps: [
        program(`await tools.capability_load({ names: ['社区'] })
return 'loaded'`),
        program(`return await tools.nekro_nxt_community_search({ query: '天气' })`),
      ],
    })
    try {
      await scenario.run()
      const [first, second, third] = scenario.model.calls
      const system = textOf(first, 'system')
      expect(system).not.toContain('nekro_nxt_community_search')
      expect(system).not.toContain('nekro_nxt_community_extension')
      expect(textOf(first, 'user')).toContain('- 社区：浏览和搜索社区扩展，查看版本、权限和审查结论。')
      const delivery = textOf(second, 'user')
      expect(delivery).toContain('〔能力包「社区」〕')
      // A manual agent is pointed to the administrator for installs.
      expect(delivery).toContain('请管理员在「社区」页面安装')
      expect(delivery).toContain('nekro_nxt_community_extension:')
      expect(textOf(third, 'tool')).toContain('虚构社区天气')
      expect(textOf(third, 'tool')).toContain('"installed": true')
      expect(textOf(third, 'system')).toBe(system)
    } finally {
      await scenario.dispose()
    }
  }, 60_000)

  it('loads the scheduled task tools as a pack', async () => {
    const scenario = await runScenario({
      capabilities: { codeRun: true, developmentShell: true },
      withoutGovernance: true,
      scheduledTasks: { list: () => [] } as unknown as ScheduledTaskPort,
      steps: [
        program(`
let refused = ''
try { await tools.schedule_list({}) } catch (error) { refused = error.message }
return { refused, loaded: await tools.capability_load({ names: ['定时任务'] }) }
`),
        program(`return await tools.schedule_list({})`),
      ],
    })
    try {
      expect(scenario.host.toolNames(scenario.sessionId)).toEqual(expect.arrayContaining(['schedule_create']))
      await scenario.run()
      const [first, second, third] = scenario.model.calls
      const system = textOf(first, 'system')
      for (const name of ['schedule_create', 'schedule_list', 'schedule_run_now']) expect(system).not.toContain(name)
      expect(textOf(first, 'user')).toContain(
        '- 定时任务：建提醒和定时任务，也能让自己过一会儿回来接着做；查看、暂停、修改已有任务。',
      )
      expect(textOf(second, 'tool')).toContain('这个工具在「定时任务」能力包里')
      const delivery = textOf(second, 'user')
      expect(delivery).toContain('〔能力包「定时任务」〕')
      expect(delivery).toContain('〔定时任务到时间了〕')
      expect(delivery).toContain('schedule_create:')
      expect(textOf(third, 'tool')).toContain('"tasks": []')
      expect(textOf(third, 'system')).toBe(system)
    } finally {
      await scenario.dispose()
    }
  }, 60_000)

  it('keeps reading and writing resident and loads the other file tools as a pack', async () => {
    const scenario = await runScenario({
      capabilities: { fileTools: true },
      withoutGovernance: true,
      toolUpdate: 'addition-only',
      steps: [
        { name: 'capability_load', args: { names: ['文件管理'] } },
        { name: 'make_dir', args: { path: 'notes' } },
      ],
    })
    try {
      await scenario.run()
      const [first, , third] = scenario.model.calls
      const names = (call: GenerateOptions | undefined) => call?.tools?.map(({ name }) => name) ?? []
      expect(names(first)).toEqual(expect.arrayContaining(['capability_load', 'read', 'write']))
      for (const name of ['move', 'delete', 'glob', 'grep', 'unzip']) expect(names(first)).not.toContain(name)
      expect(textOf(first, 'user')).toContain('- 文件管理：')
      expect(names(third)).toEqual(expect.arrayContaining(['move', 'make_dir', 'glob', 'grep']))
      expect(textOf(third, 'tool')).toContain('已新建目录 notes')
    } finally {
      await scenario.dispose()
    }
  }, 60_000)
})
