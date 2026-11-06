import { afterEach, describe, expect, it } from 'vitest'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { materializeImportedRevision } from '@nekro-nxt/extension-format'
import type { AgentId, ChannelId, ExtensionId } from '@nekro-nxt/contracts'
import { NekroRuntime } from '../src/bootstrap.js'
import { namedCredentialReference } from '../src/credentials-library.js'
import type { ExtensionActor } from '../src/extension-governance/actions.js'
import { ExtensionGovernanceTools } from '../src/extension-governance/tool-port.js'

/** #139: a host-layer credential is bound together with enabling, and a save can enable in the same approval. */

const directories: string[] = []
const POLL = { timeout: 20_000, interval: 100 }

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

/** Calls the tool named by the trigger word of the newest message once, then ends the turn. */
class TriggeredModel extends LlmAdapter {
  readonly #answered = new Set<string>()
  #calls = 0
  constructor(readonly triggers: Record<string, { readonly name: string; readonly args: unknown }>) {
    super()
  }
  override providerInfo(provider: string) {
    return { id: provider, name: 'triggered model' }
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
  override async *stream(options?: GenerateOptions): AsyncIterable<StreamChunk> {
    await Promise.resolve()
    const pending = (options?.messages ?? [])
      .filter((message) => message.role === 'user')
      .flatMap((message) => [...JSON.stringify(message.content).matchAll(/(#[a-z-]+)[^[]*\[m(\d+)\]/gu)])
      .filter((match) => this.triggers[match[1]!] !== undefined && !this.#answered.has(match[2]!))
      .sort((left, right) => Number(right[2]) - Number(left[2]))[0]
    if (pending !== undefined) this.#answered.add(pending[2]!)
    const call = pending === undefined ? undefined : this.triggers[pending[1]!]
    if (call) {
      const id = ToolCallId(`triggered-${++this.#calls}`)
      const args = JSON.stringify(call.args)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: call.name, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: call.name, arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '好了。' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const createRuntime = async (model?: LlmAdapter) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nxt-save-enable-'))
  directories.push(directory)
  const runtime = await NekroRuntime.create({
    coreDatabasePath: path.join(directory, 'core.sqlite'),
    sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
    assetRoot: path.join(directory, 'assets'),
    extensionDataRoot: path.join(directory, 'extensions'),
    extensionCacheRoot: path.join(directory, 'cache'),
    ...(model === undefined
      ? {}
      : {
          configureLlm: (
            context: Parameters<NonNullable<Parameters<typeof NekroRuntime.create>[0]['configureLlm']>>[0],
          ) => {
            context.llm.registerAdapter(['test-provider'], model)
          },
        }),
  })
  await runtime.start()
  return runtime
}

const WEATHER_TOOL = `harness.registerTool(ctx, harness.defineTool({
  name: 'weather_probe',
  description: '天气探针',
  parameters: {},
  output: { schema: { type: 'string' }, render(_args, value) { return [{ type: 'text', text: value }] } },
  execute() { return 'city=' + ctx.config().city },
}))`

/** The service key is shared by every agent; the city is each agent's own. */
const WEATHER_CONFIG = {
  host: {
    schema: {
      type: 'object' as const,
      dict: {
        apiKey: { type: 'string' as const, meta: { description: 'API Key', role: 'secret' as const } },
        region: { type: 'string' as const, meta: { description: '地区', default: '示例区' } },
      },
    },
  },
  agent: {
    schema: {
      type: 'object' as const,
      dict: { city: { type: 'string' as const, meta: { description: '城市', default: '默认市' } } },
    },
  },
}

const importWeather = async (runtime: NekroRuntime): Promise<ExtensionId> => {
  const content = materializeImportedRevision({
    manifest: {
      schemaVersion: 7,
      requires: { sdk: 12 },
      extensionId: 'ext_WEATHERLINE',
      revisionId: 'xrv_WEATHERLINEONE',
      entrypoints: { host: 'source/host.ts' },
      permissions: { permissions: [], networkOrigins: [] },
      contributions: [{ kind: 'tool', name: 'weather_probe', description: '天气探针' }],
      config: WEATHER_CONFIG,
    },
    sources: { host: `export default ({ harness }) => ({ inject: ['tools'], apply(ctx) { ${WEATHER_TOOL} } })` },
  })
  const { extension } = await runtime.extensionService.importRevision({
    extension: { id: content.manifest.extensionId, slug: 'weather-line', displayName: '天气线', description: '' },
    revision: {
      id: content.manifest.revisionId,
      contentDigest: content.contentDigest,
      payloadDigest: content.payloadDigest,
    },
    manifest: content.manifest,
    sources: content.sources,
  })
  return extension.id
}

let sequence = 0

const agentWithChannel = (runtime: NekroRuntime, autonomy: 'confirm' | 'autonomous' = 'autonomous') => {
  const agent = runtime.core.createAgent({
    displayName: `天气智能体${++sequence}`,
    persona: '',
    model: { provider: 'deepseek', model: 'deepseek-v4-flash' },
    capabilities: { extensionAutonomy: autonomy },
  })
  const channel = runtime.core.createChannel({
    connectionId: runtime.internalConnectionId,
    platformChannelId: `save-enable-${sequence}`,
    kind: 'internal',
  })
  runtime.core.createBinding({ channelId: channel.id, agentId: agent.definition.id, triggerPolicy: 'observe-only' })
  return { agentId: agent.definition.id, channelId: channel.id, name: agent.revision.displayName }
}

const addCredential = (
  runtime: NekroRuntime,
  name: string,
  options: { readonly autoUse?: boolean; readonly onlyFor?: AgentId } = {},
) =>
  runtime.credentialLibrary.create({
    name,
    domains: ['api.weather.test'],
    value: 'fictional-weather-value',
    autoUse: options.autoUse ?? true,
    ...(options.onlyFor === undefined ? {} : { agentScope: { agentIds: [options.onlyFor] } }),
  })

const asAdmin = (agentId: AgentId, channelId: ChannelId): ExtensionActor => ({
  kind: 'agent',
  agentId,
  channelId,
  requester: 'admin',
})

describe('enable with host configuration', () => {
  it('binds a host-layer credential together with enabling, in one request', async () => {
    const runtime = await createRuntime()
    try {
      const extensionId = await importWeather(runtime)
      const credential = await addCredential(runtime, '虚构天气')
      const entity = agentWithChannel(runtime)
      const tools = new ExtensionGovernanceTools(runtime)
      const enable = {
        kind: 'enable' as const,
        extensionId,
        agentId: entity.agentId,
        values: { city: '虚构城' },
        credentials: { apiKey: '虚构天气' },
      }
      const outcome = await tools.act(entity.agentId, entity.channelId, enable, { kind: 'admin' })
      expect(outcome.outcome).toBe('requested')
      expect(outcome.message).toContain('本机配置由所有智能体共用')
      const request = runtime.extensionRequests.get(outcome.requestNumber!)!
      expect(request.summary).toBe(
        `给${entity.name}启用「天气线」，本机配置「API Key」绑定凭据「虚构天气」，智能体配置填写「城市」`,
      )
      // Asking again keeps the one request.
      const again = await tools.act(entity.agentId, entity.channelId, enable, { kind: 'admin' })
      expect(again.requestNumber).toBe(outcome.requestNumber)

      const result = await runtime.extensionRequests.approve(outcome.requestNumber!, { kind: 'console' })
      expect(result.message).toContain(`已给${entity.name}启用「天气线」`)
      expect(result.message).toContain('本机配置已设置：API Key')
      expect(result.message).not.toContain('还没有绑定')
      expect(runtime.repository.getHostInstallation(extensionId)?.config).toMatchObject({
        apiKey: namedCredentialReference(credential.id),
        region: '示例区',
      })
      expect(runtime.repository.getActivation(entity.agentId, extensionId)?.config).toMatchObject({ city: '虚构城' })
      expect(runtime.extensionConfig.versions({ extensionId, layer: 'host' })[0]).toMatchObject({
        source: 'agent',
        actorAgentId: entity.agentId,
      })
    } finally {
      await runtime.dispose()
    }
  })

  it('still asks for a credential that needs consent and refuses one that is not open to the agent', async () => {
    const runtime = await createRuntime()
    try {
      const extensionId = await importWeather(runtime)
      const entity = agentWithChannel(runtime)
      const other = agentWithChannel(runtime)
      await addCredential(runtime, '待同意的天气', { autoUse: false })
      await addCredential(runtime, '别人的天气', { onlyFor: other.agentId })
      const assess = (credentials: Record<string, string>, actor = asAdmin(entity.agentId, entity.channelId)) =>
        runtime.extensionActions.assess({ kind: 'enable', extensionId, agentId: entity.agentId, credentials }, actor)
      expect(assess({ apiKey: '待同意的天气' })).toMatchObject({
        decision: 'request',
        reason: expect.stringContaining('凭据「待同意的天气」需要管理员同意后才能使用') as unknown,
      })
      expect(assess({ apiKey: '别人的天气' })).toMatchObject({
        decision: 'console',
        reason: '凭据「别人的天气」不对你开放。',
      })
      // A member cannot have the host configuration changed, through enabling either.
      expect(
        assess({ apiKey: '待同意的天气' }, { kind: 'agent', agentId: entity.agentId, requester: 'member' }),
      ).toMatchObject({ decision: 'console' })
      expect(assess({ unknownKey: '待同意的天气' })).toMatchObject({
        decision: 'console',
        reason: expect.stringContaining('扩展的配置里没有这些字段：unknownKey') as unknown,
      })
    } finally {
      await runtime.dispose()
    }
  })

  it('names the layer of a field given to the wrong one, and how to set host configuration before installing', async () => {
    const runtime = await createRuntime()
    try {
      const extensionId = await importWeather(runtime)
      await addCredential(runtime, '虚构天气')
      const entity = agentWithChannel(runtime)
      const tools = new ExtensionGovernanceTools(runtime)
      await expect(
        tools.act(
          entity.agentId,
          entity.channelId,
          {
            kind: 'configure',
            extensionId,
            layer: 'agent',
            agentId: entity.agentId,
            values: {},
            credentials: { apiKey: '虚构天气' },
          },
          { kind: 'admin' },
        ),
      ).rejects.toThrow('智能体配置里没有这些字段：apiKey。apiKey 在本机配置里，修改时 layer 写 host。')
      await expect(
        tools.act(
          entity.agentId,
          entity.channelId,
          { kind: 'configure', extensionId, layer: 'host', values: {}, credentials: { apiKey: '虚构天气' } },
          { kind: 'admin' },
        ),
      ).rejects.toThrow(/还没有安装到本机。本机配置可以在启用时一起设置.*save 加 enable: true/u)
    } finally {
      await runtime.dispose()
    }
  })

  it('tells right after enabling which host credentials are still unbound', async () => {
    const runtime = await createRuntime()
    try {
      const extensionId = await importWeather(runtime)
      const entity = agentWithChannel(runtime)
      const result = await runtime.extensionActions.perform(
        { kind: 'enable', extensionId, agentId: entity.agentId },
        { kind: 'console' },
      )
      expect(result.message).toContain('本机配置的凭据「API Key」（apiKey）还没有绑定')
      expect(result.message).toContain('configure（layer: host）')
      expect(result.message).toContain('nekro_nxt_credential_request')
    } finally {
      await runtime.dispose()
    }
  })
})

let message = 0

const say = async (runtime: NekroRuntime, channelId: ChannelId, text: string) => {
  await runtime.internalChannel.postMessage({
    channelId,
    clientEventId: `save-enable-${++message}`,
    parts: [{ type: 'text', text: `${text} [m${message}]` }],
  })
}

/** Defines the weather candidate with its trial run bound to a named credential, runs it, and waits until it can be saved. */
const readyCandidate = async (credentialName: string) => {
  const model = new TriggeredModel({
    '#define-weather': {
      name: 'nekro_nxt_extension_define',
      args: {
        plugin: { kind: 'new', idPrefix: 'wthr' },
        name: '天气探针',
        purpose: '回答当前配置的城市。',
        code: { host: `return { inject: ['tools'], apply(ctx) { ${WEATHER_TOOL} } }` },
        config: WEATHER_CONFIG,
        testConfig: { apiKey: { credential: credentialName }, city: '试运行市' },
      },
    },
  })
  const runtime = await createRuntime(model)
  const credential = await addCredential(runtime, credentialName)
  const entity = await runtime.createAgentWithInternalChannel({
    displayName: '天气智能体',
    persona: '',
    model: { provider: 'test-provider', model: 'chat-model' },
    capabilities: { dynamicCreation: true, extensionAutonomy: 'autonomous' },
  })
  await say(runtime, entity.channelId, '#define-weather 做一个天气探针。')
  await expect.poll(() => runtime.repository.listAuthoringTasks(entity.agentId).length, POLL).toBe(1)
  const task = runtime.repository.listAuthoringTasks(entity.agentId)[0]!
  const attempt = runtime.repository.listAuthoringAttempts(task.id).at(-1)!
  const sessionId = runtime.repository.getEpisode(task.episodeId)!.dshSessionId!
  await expect.poll(() => runtime.host.sessionStatus(sessionId), POLL).toBe('idle')
  await expect(
    runtime.host.runDynamicPackage(sessionId, task.pluginKey, attempt.runnerPackageId!, 'run'),
  ).resolves.toMatchObject({ ok: true, status: 'running' })
  await expect.poll(() => runtime.repository.getAuthoringTask(task.id)?.status, POLL).toBe('ready')
  return { runtime, credential, entity, task }
}

describe('save with enable', () => {
  it('saves, enables and binds the trial run’s host credential on one approval', async () => {
    const { runtime, credential, entity, task } = await readyCandidate('虚构天气')
    try {
      const tools = new ExtensionGovernanceTools(runtime)
      const save = {
        kind: 'save' as const,
        taskId: task.id,
        name: '天气探针',
        slug: 'weather-probe',
        enable: { agentId: entity.agentId, values: { city: '正式市' } },
      }
      const outcome = await tools.act(entity.agentId, entity.channelId, save, { kind: 'admin' })
      expect(outcome.outcome).toBe('requested')
      const request = runtime.extensionRequests.get(outcome.requestNumber!)!
      expect(request.summary).toBe(
        '保存新扩展「天气探针」并给天气智能体启用，本机配置「API Key」绑定凭据「虚构天气」，智能体配置填写「城市」',
      )
      const again = await tools.act(entity.agentId, entity.channelId, save, { kind: 'admin' })
      expect(again.requestNumber).toBe(outcome.requestNumber)

      const result = await runtime.extensionRequests.approve(outcome.requestNumber!, { kind: 'console' })
      expect(result.message).toMatch(/^已保存「天气探针」v1。已给天气智能体启用「天气探针」。/u)
      const extensionId = result.extensionId!
      expect(runtime.repository.getActivation(entity.agentId, extensionId)?.config).toMatchObject({ city: '正式市' })
      expect(runtime.repository.getHostInstallation(extensionId)?.config).toMatchObject({
        apiKey: namedCredentialReference(credential.id),
      })
      expect(runtime.extensionActions.enablementNote(entity.agentId, extensionId)).toBeUndefined()
    } finally {
      await runtime.dispose()
    }
  }, 60_000)

  it('keeps the save and says why when enabling then fails', async () => {
    const { runtime, credential, entity, task } = await readyCandidate('会删掉的天气')
    try {
      const outcome = await new ExtensionGovernanceTools(runtime).act(
        entity.agentId,
        entity.channelId,
        { kind: 'save', taskId: task.id, name: '天气探针', enable: { agentId: entity.agentId } },
        { kind: 'admin' },
      )
      expect(outcome.outcome).toBe('requested')
      await runtime.credentialLibrary.remove(credential.id)
      const result = await runtime.extensionRequests.approve(outcome.requestNumber!, { kind: 'console' })
      expect(result.message).toMatch(/^已保存「天气探针」v1，启用没有完成：没有名为「会删掉的天气」的凭据/u)
      expect(runtime.repository.getExtension(result.extensionId!)).toBeDefined()
      expect(runtime.repository.getActivation(entity.agentId, result.extensionId!)).toBeUndefined()
    } finally {
      await runtime.dispose()
    }
  }, 60_000)
})
