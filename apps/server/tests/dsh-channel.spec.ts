import { LlmAdapter, CallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import { createWebAdapterConnection } from '@nekro-nxt/adapter-web'
import { ChannelRuntime } from '@nekro-nxt/channel-runtime'
import { AssetService, CoreService } from '@nekro-nxt/core'
import type { AdmissionId, EpisodeId } from '@nekro-nxt/contracts'
import {
  ExtensionActivationCoordinator,
  ExtensionBuilder,
  ExtensionService,
  ExtensionSourceStore,
} from '@nekro-nxt/extension-runtime'
import { openMigratedCoreDatabase, SqliteCoreRepository } from '@nekro-nxt/storage-sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertHostDshPackageVersions, ChannelExtensionActivationHost, DshHostRuntime } from '../src/index.ts'

const temporaryDirectories: string[] = []

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
      const callId = CallId('scripted-send-message')
      const toolCall = {
        type: 'tool-call' as const,
        id: callId,
        name: 'send_message',
        arguments: JSON.stringify({
          target: { type: 'current' },
          parts: [{ type: 'text', text: '这是通信工具确认发送的回复。' }],
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
        id: callId,
        name: 'send_message',
        argumentsDelta: toolCall.arguments,
      }
      yield { type: 'block-end', index: 1, block: toolCall }
      yield { type: 'usage', usage: { inputTokens: 32, outputTokens: 16 } }
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

describe('DSH Host and Web Channel vertical slice', () => {
  it('switches a persisted Activation through Episode handoff before mounting its Tool', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-dsh-activation-'))
    temporaryDirectories.push(directory)
    const database = await openMigratedCoreDatabase(path.join(directory, 'core.sqlite'))
    const repository = new SqliteCoreRepository(database)
    const assetService = new AssetService(repository, path.join(directory, 'assets'))
    let coreId = 0
    let runtimeId = 0
    let extensionId = 0
    let activationId = 0
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
      const before = database.prepare("SELECT id, dsh_session_id FROM episodes WHERE status = 'active'").get() as {
        id: string
        dsh_session_id: string
      }
      await host.whenIdle(before.dsh_session_id)

      const draft = service.captureDynamicPackage(agent.definition.id, {
        dshSessionId: before.dsh_session_id,
        dynamicPluginId: 'persisted-1',
        dynamicPackageId: 'pkg-1',
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
      })
      const saved = await service.saveDraftPackage({
        draftPackageId: draft.package.id,
        slug: 'activation-probe',
        displayName: '安全启用探针',
        description: '安全启用验证。',
      })
      coordinator = new ExtensionActivationCoordinator(
        repository,
        service,
        new ExtensionBuilder(path.join(directory, 'extension-cache')),
        new ChannelExtensionActivationHost(runtime, host),
        { now: () => 600 + activationId, nextUlid: () => `SA${++activationId}` },
      )
      await coordinator.activate({
        agentId: agent.definition.id,
        extensionId: saved.extension.id,
        revisionId: saved.revision.id,
      })
      expect(database.prepare('SELECT status, close_reason FROM episodes WHERE id = ?').get(before.id)).toEqual({
        status: 'closed',
        close_reason: 'incompatible-activation',
      })
      const after = database.prepare("SELECT dsh_session_id FROM episodes WHERE status = 'active'").get() as {
        dsh_session_id: string
      }
      expect(after.dsh_session_id).not.toBe(before.dsh_session_id)
      expect(host.toolNames(after.dsh_session_id)).toContain('activation_probe')
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
      capabilities: { dynamicCreation: true, developmentShell: false, fullFileAccess: false },
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
    const host = await DshHostRuntime.create({
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      communication: { sendMessage: () => Promise.reject(new Error('not used')) },
      history: repository,
      assets: repository,
      assetService,
      resolveAgentRevision: (revisionId) => repository.getAgentRevision(revisionId),
      configureLlm: (context) => {
        context.llm.registerAdapter(['test-provider'], new ScriptedCommunicationModel())
      },
    })
    const enabledEpisode = 'dynamic-enabled' as EpisodeId
    const deniedEpisode = 'dynamic-denied' as EpisodeId
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

      expect(host.dynamicToolNames(enabledSession)).toEqual(
        expect.arrayContaining([
          'cordis_inspect_list',
          'cordis_inspect_query',
          'cordis_inspect_self',
          'cordis_define',
          'cordis_run',
          'cordis_stop',
          'cordis_undefine',
        ]),
      )
      expect(() => host.dynamicToolNames(deniedSession)).toThrow('not granted')
      expect(await host.queryNekroNxtInspect(enabledSession, 'currentContext')).toMatchObject({
        agent: {
          agentId: enabled.definition.id,
          capabilities: { dynamicCreation: true, developmentShell: false, fullFileAccess: false },
        },
        channel: { channelId: enabledChannel.id, episodeId: enabledEpisode },
      })

      const privateServiceProbe = host.defineDynamicPackage(enabledSession, {
        plugin: { kind: 'new', idPrefix: 'priv' },
        name: '私有服务探针',
        purpose: '证明动态扩展不能触达跨会话 Agent Registry。',
        code: {
          host: `return {
            inject: ['agents'],
            apply(ctx) { if (ctx.agents) throw new Error('private Agent Registry leaked') }
          }`,
        },
      })
      const blockedPrivateRun = await host.runDynamicPackage(
        enabledSession,
        privateServiceProbe.pluginId,
        privateServiceProbe.packageId,
        'run',
      )
      expect(blockedPrivateRun).toMatchObject({ ok: false, reason: 'host-half-failed' })
      if (blockedPrivateRun.ok) throw new Error('Private Service probe unexpectedly ran.')
      expect(blockedPrivateRun.message).toContain('agents')
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
      expect(host.dynamicInventory(enabledSession)[0]).not.toHaveProperty('activeRun')
      expect(host.dynamicInventory(enabledSession)[0]?.latestRun).toMatchObject({ status: 'stopped' })

      let localId = 0
      let activationId = 0
      const sourceStore = new ExtensionSourceStore(path.join(directory, 'extension-data'))
      const extensionService = new ExtensionService(repository, sourceStore, {
        now: () => 600 + localId,
        nextUlid: () => `L${++localId}`,
      })
      const captured = extensionService.captureDynamicPackage(enabled.definition.id, {
        dshSessionId: enabledSession,
        dynamicPluginId: first.pluginId,
        dynamicPackageId: second.packageId,
        name: '持久探针',
        purpose: '验证动态运行、保存和启用彼此独立。',
        hostCode: host.inspectDynamicPackage(enabledSession, first.pluginId, second.packageId).code.host,
      })
      const saved = await extensionService.saveDraftPackage({
        draftPackageId: captured.package.id,
        slug: 'persistent-probe',
        displayName: '持久探针',
        description: '真实 DSH Scope 持久化验证。',
      })
      expect(host.toolNames(enabledSession)).not.toContain('dynamic_probe')
      const cacheRoot = path.join(directory, 'extension-cache')
      const coordinator = new ExtensionActivationCoordinator(
        repository,
        extensionService,
        new ExtensionBuilder(cacheRoot),
        host,
        { now: () => 700 + activationId, nextUlid: () => `P${++activationId}` },
      )
      const activation = await coordinator.activate({
        agentId: enabled.definition.id,
        extensionId: saved.extension.id,
        revisionId: saved.revision.id,
      })
      expect(activation.state).toBe('active')
      expect(host.toolNames(enabledSession)).toContain('dynamic_probe')
      expect(host.toolNames(deniedSession)).not.toContain('dynamic_probe')

      await coordinator.dispose()
      expect(host.toolNames(enabledSession)).not.toContain('dynamic_probe')
      await rm(cacheRoot, { recursive: true, force: true })
      const restored = new ExtensionActivationCoordinator(
        repository,
        extensionService,
        new ExtensionBuilder(cacheRoot),
        host,
        { now: () => 800 + activationId, nextUlid: () => `Q${++activationId}` },
      )
      expect(await restored.restore()).toEqual({ restored: 1, failed: 0 })
      expect(host.toolNames(enabledSession)).toContain('dynamic_probe')
      await restored.disable(activation.id)
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

  it('mounts creation, development Shell and complete file access as independent Agent grants', async () => {
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
        capabilities: { dynamicCreation: true, developmentShell: false, fullFileAccess: false },
      }),
      core.createAgent({
        displayName: '开发智能体',
        persona: '',
        model: { provider: 'test-provider', model: 'chat-model' },
        capabilities: { dynamicCreation: false, developmentShell: true, fullFileAccess: false },
      }),
      core.createAgent({
        displayName: '文件智能体',
        persona: '',
        model: { provider: 'test-provider', model: 'chat-model' },
        capabilities: { dynamicCreation: false, developmentShell: false, fullFileAccess: true },
      }),
      core.createAgent({
        displayName: '完整开发智能体',
        persona: '',
        model: { provider: 'test-provider', model: 'chat-model' },
        capabilities: { dynamicCreation: false, developmentShell: true, fullFileAccess: true },
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
    const host = await DshHostRuntime.create({
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      developmentWorkspaceRoot: directory,
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
            episodeId: `capability-${index}` as EpisodeId,
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

      expect(shellTools).toEqual(expect.arrayContaining(['bash', 'read', 'write', 'edit']))
      expect(shellTools).not.toContain('cordis_define')

      expect(fileTools).toEqual(expect.arrayContaining(['read', 'write', 'edit']))
      expect(fileTools).not.toContain('bash')
      expect(fileTools).not.toContain('cordis_define')

      expect(completeTools).toEqual(expect.arrayContaining(['bash', 'read', 'write', 'edit']))
      expect(completeTools).not.toContain('cordis_define')
    } finally {
      await host.dispose()
      database.close()
    }
  })

  it('keeps raw model text internal and publishes only send_message Outbox delivery', async () => {
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
    })
    core.createBinding({ channelId: channel.id, agentId: agent.definition.id, triggerPolicy: 'always' })

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
      await web.postMessage({
        channelId: channel.id,
        clientEventId: 'browser-event-1',
        parts: [{ type: 'text', text: '你好，请回复我。' }],
      })
      const episode = database.prepare("SELECT dsh_session_id FROM episodes WHERE status = 'active'").get() as {
        dsh_session_id: string
      }
      await host.whenIdle(episode.dsh_session_id)

      expect(observed).toEqual(['这是通信工具确认发送的回复。'])
      expect(database.prepare('SELECT COUNT(*) AS count FROM outbound_intents').get()).toEqual({ count: 1 })
      expect(database.prepare('SELECT state, parts_json FROM outbound_intents').get()).toEqual({
        state: 'sent',
        parts_json: '[{"type":"text","text":"这是通信工具确认发送的回复。"}]',
      })
      expect(model.calls).toHaveLength(2)
      expect(model.calls[0]?.tools?.map(({ name }) => name)).toEqual([
        'asset_inspect',
        'conversation_history_read',
        'conversation_history_search',
        'send_message',
      ])
      const eventText = JSON.stringify(host.sessionEvents(episode.dsh_session_id))
      expect(eventText).toContain('这段模型原始文字只能留在运行轨迹。')
      expect(eventText).toContain('工具完成后的原始结束文字也不会发送。')
      expect(eventText).toContain('nekro-nxt-channel')
      expect(eventText).toContain('这是通信工具确认发送的回复。')

      core.reviseAgent(agent.definition.id, agent.revision.id, {
        displayName: '小奈',
        persona: '你现在应当在保持简洁的同时说明依据。',
        model: { provider: 'test-provider', model: 'chat-model' },
      })
      await web.postMessage({
        channelId: channel.id,
        clientEventId: 'browser-event-2',
        parts: [{ type: 'text', text: '请继续刚才的任务。' }],
      })
      const resumedEpisode = database
        .prepare("SELECT id, dsh_session_id FROM episodes WHERE status = 'active'")
        .get() as { id: string; dsh_session_id: string }
      await host.whenIdle(resumedEpisode.dsh_session_id)
      expect(resumedEpisode.dsh_session_id).not.toBe(episode.dsh_session_id)
      expect(
        database
          .prepare('SELECT status, close_reason FROM episodes WHERE dsh_session_id = ?')
          .get(episode.dsh_session_id),
      ).toEqual({ status: 'closed', close_reason: 'incompatible-revision' })
      expect(database.prepare('SELECT COUNT(*) AS count FROM episode_handoffs').get()).toEqual({ count: 1 })
      expect(JSON.stringify(host.sessionEvents(resumedEpisode.dsh_session_id))).toContain('nekro-nxt-handoff')
      expect(model.calls.some(({ system }) => system?.startsWith('你是对话交接摘要器'))).toBe(true)
      expect(observed).toEqual(['这是通信工具确认发送的回复。', '这是通信工具确认发送的回复。'])

      const eventCount = host.sessionEvents(resumedEpisode.dsh_session_id).length
      const admission = database.prepare('SELECT id FROM admissions ORDER BY rowid DESC LIMIT 1').get() as {
        id: string
      }
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
      expect(resumedHost.sessionEvents(resumedEpisode.dsh_session_id).length).toBeGreaterThanOrEqual(eventCount)
      expect(resumedHost.findAdmissionMessage(resumedEpisode.dsh_session_id, admission.id as AdmissionId)).toBeTruthy()
    } finally {
      await web.stop()
      await Promise.allSettled(hosts.map((ownedHost) => ownedHost.dispose()))
      database.close()
    }
  })

  it('projects an authorized image natively and exposes asset_view_image only to an image-capable model', async () => {
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
    })
    const connection = core.createConnection({ adapterKey: 'web', config: {} })
    const channel = core.createChannel({ connectionId: connection.id, platformChannelId: 'images', kind: 'web' })
    const seedEvent = core.appendInbound({
      connectionId: connection.id,
      channelId: channel.id,
      adapterKey: 'web',
      platformEventId: 'asset-source',
      kind: 'message-created',
      parts: [{ type: 'text', text: '图片资源来源' }],
      platformTimestamp: 2000,
      receivedAt: 2000,
      dedupeKey: 'event:asset-source',
    }).event
    const assetService = new AssetService(repository, path.join(directory, 'assets'))
    const imageAsset = await assetService.import({
      bytes: new Uint8Array(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZQAAAABJRU5ErkJggg==',
          'base64',
        ),
      ),
      occurrence: {
        channelEventId: seedEvent.id,
        channelId: channel.id,
        connectionId: connection.id,
        receivedAt: 2000,
        filename: 'pixel.png',
        declaredMediaType: 'image/png',
      },
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
        parts: [{ type: 'image', assetId: imageAsset.asset.id, alt: '一个像素' }],
      })
      const episode = database.prepare("SELECT dsh_session_id FROM episodes WHERE status = 'active'").get() as {
        dsh_session_id: string
      }
      await host.whenIdle(episode.dsh_session_id)
      expect(model.calls[0]?.messages.some((message) => message.content.some((block) => block.type === 'image'))).toBe(
        true,
      )
      expect(model.calls[0]?.tools?.map(({ name }) => name)).toContain('asset_view_image')
    } finally {
      await web.stop()
      await host.dispose()
      database.close()
    }
  })
})
