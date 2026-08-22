import { LlmAdapter, CallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import { createWebAdapterConnection } from '@nekro-nxt/adapter-web'
import { ChannelRuntime } from '@nekro-nxt/channel-runtime'
import { AssetService, CoreService } from '@nekro-nxt/core'
import { AdmissionIdSchema, EpisodeHandoffIdSchema, EpisodeIdSchema } from '@nekro-nxt/contracts'
import {
  ExtensionActivationCoordinator,
  ExtensionBuilder,
  ExtensionService,
  ExtensionSourceStore,
} from '@nekro-nxt/extension-runtime'
import { admissions, openMigratedCoreDatabase, SqliteCoreRepository } from '@nekro-nxt/storage-sqlite'
import { access, mkdtemp, rm, stat } from 'node:fs/promises'
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

describe('DSH Host and Web Channel vertical slice', () => {
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
        contractVersion: 'nekro-nxt-extension-v1',
        dshVersion: '0.1.1-rc.1',
        hostTool: true,
        hostRpc: true,
        clientSlots: ['agent.workbench.sections', 'extension.details.panels'],
        dshNativeWebUi: false,
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
      expect(extensionSkill.content).toContain('宿主是 NekroNxt')
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
    core.createBinding({ channelId: channel.id, agentId: agent.definition.id, triggerPolicy: 'always' })
    core.appendInbound({
      connectionId: connection.id,
      channelId: channel.id,
      adapterKey: 'web',
      platformEventId: 'stale-channel-event',
      kind: 'message-created',
      parts: [{ type: 'text', text: '同频道但未准入旧 Episode 的内容' }],
      platformTimestamp: 999,
      receivedAt: 999,
      dedupeKey: 'web:stale-channel-event',
    })
    const otherChannel = core.createChannel({
      connectionId: connection.id,
      platformChannelId: 'other',
      kind: 'web',
      displayName: '另一个测试频道',
    })
    core.appendInbound({
      connectionId: connection.id,
      channelId: otherChannel.id,
      adapterKey: 'web',
      platformEventId: 'other-channel-event',
      kind: 'message-created',
      parts: [{ type: 'text', text: '另一个频道的秘密内容' }],
      platformTimestamp: 999,
      receivedAt: 999,
      dedupeKey: 'web:other-channel-event',
    })

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
      await runtime.acceptInbound({
        connectionId: connection.id,
        channelId: channel.id,
        adapterKey: 'web',
        platformEventId: 'browser-event-1',
        kind: 'message-created',
        senderMemberId: sender.id,
        parts: [
          { type: 'text', text: '你好，请回复我。' },
          { type: 'mention', memberId: mentionedMember.id },
        ],
        platformTimestamp: 1000,
        receivedAt: 1000,
        dedupeKey: 'web:browser-event-1',
        facts: { mentionedBot: true },
      })
      const episode = repository.getActiveEpisode(channel.id, agent.definition.id)!
      await host.whenIdle(episode.dshSessionId!)

      expect(observed).toEqual(['这是通信工具确认发送的回复。'])
      expect(repository.listChannelHistory(channel.id).find((entry) => entry.source === 'channel-event')).toMatchObject(
        {
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
      expect(recentEventIds).toHaveLength(2)
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
    core.appendInbound({
      connectionId: connection.id,
      channelId: channel.id,
      adapterKey: 'web',
      platformEventId: 'asset-source',
      kind: 'message-created',
      parts: [{ type: 'image', assetId: imageAsset.asset.id, alt: '图片资源来源' }],
      platformTimestamp: 2000,
      receivedAt: 2000,
      dedupeKey: 'event:asset-source',
      assetOccurrences: [{ partIndex: 0, assetId: imageAsset.asset.id }],
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
      const episode = repository.getActiveEpisode(channel.id, agent.definition.id)!
      await host.whenIdle(episode.dshSessionId!)
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
