import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { materializeImportedRevision } from '@nekro-nxt/extension-format'
import { ExtensionDataDowngradeError, hostPermissionRequirement } from '@nekro-nxt/extension-runtime'
import {
  CommunityReleaseSchema,
  EpisodeIdSchema,
  LinkedAccountIdSchema,
  type AgentId,
  type ChannelId,
  type ExtensionId,
  type ExtensionLayeredConfig,
  type ExtensionPermissions,
} from '@nekro-nxt/contracts'
import { NekroRuntime } from '../src/bootstrap.js'
import { ExtensionCommandPort } from '../src/extension-governance/commands.js'
import { ExtensionGovernanceTools } from '../src/extension-governance/tool-port.js'
import { extensionAgentTools } from '../src/extension-governance/agent-tools.js'
import { CommunitySyncService, type SyncCommunity } from '../src/extension-governance/community-sync.js'
import { ExtensionRequestService, EXTENSION_REQUEST_TTL_MS } from '../src/extension-governance/requests.js'
import { extensionVersions, lineageGraph } from '../src/extension-governance/versions.js'
import { HostLogService } from '../src/logs/service.js'
import { extensionVerification } from './fixtures/extension-verification.js'

const directories: string[] = []

const NOTICE_POLL = { timeout: 20_000, interval: 100 }

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

/** Calls the scripted tools one per model request, then ends the turn. */
class ScriptedModel extends LlmAdapter {
  #step = 0
  constructor(readonly script: readonly { readonly name: string; readonly args: unknown }[]) {
    super()
  }
  override providerInfo(provider: string) {
    return { id: provider, name: 'scripted model' }
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
  override async *stream(): AsyncIterable<StreamChunk> {
    await Promise.resolve()
    const call = this.script[this.#step++]
    if (call) {
      const id = ToolCallId(`scripted-${this.#step}`)
      const text = JSON.stringify(call.args)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: call.name, argumentsDelta: text }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: call.name, arguments: text } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '好了。' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/**
 * Calls the tool named by the trigger word of the newest request once, then ends the turn; keeps what each tool
 * returned. Reminders and notices carry no trigger word, so they never use up a step.
 */
class TriggeredModel extends ScriptedModel {
  readonly results: string[] = []
  #calls = 0
  readonly #answered = new Set<string>()
  constructor(readonly triggers: Record<string, { readonly name: string; readonly args: unknown }>) {
    super([])
  }
  override async *stream(options?: GenerateOptions): AsyncIterable<StreamChunk> {
    await Promise.resolve()
    const messages = options?.messages ?? []
    const last = messages.at(-1)
    if (last?.role === 'tool') this.results.push(JSON.stringify(last))
    // Each request is `#trigger … [mN]`; a handoff may repeat earlier ones, so each N is answered once.
    const pending = messages
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

const createRuntime = async (model?: LlmAdapter, logs?: HostLogService) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nxt-governance-'))
  directories.push(directory)
  const runtime = await NekroRuntime.create({
    ...(logs === undefined ? {} : { logs }),
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

const PROBE_TOOL = `harness.registerTool(ctx, harness.defineTool({
  name: 'gov_probe',
  description: '治理探针',
  parameters: {},
  output: { schema: { type: 'string' }, render(_args, value) { return [{ type: 'text', text: value }] } },
  execute() { return 'ok' },
}))`

/** v1 keeps `{ name }` records; v2 renames the field to `title` and migrates what v1 stored. */
const SOURCE_V1 = `export default ({ harness }) => {
  harness.handle('ping', () => 'v1')
  return { inject: ['tools'], apply(ctx) { ${PROBE_TOOL} } }
}`

const SOURCE_V2 = `export default ({ harness }) => {
  harness.handle('ping', () => 'v2')
  harness.migrateData(async ({ storage }) => {
    let after
    do {
      const page = await storage.list({ after })
      for (const entry of page.entries) {
        if (entry.value && typeof entry.value === 'object' && 'name' in entry.value) {
          await storage.set(entry, { title: entry.value.name })
        }
      }
      after = page.next
    } while (after !== undefined)
  })
  return { inject: ['tools'], apply(ctx) { ${PROBE_TOOL} } }
}`

const importRevision = async (
  runtime: NekroRuntime,
  input: {
    readonly extensionId: string
    readonly revisionId: string
    readonly source: string
    readonly dataVersion?: number
  },
) => {
  const content = materializeImportedRevision({
    manifest: {
      schemaVersion: 7,
      requires: { sdk: 10 },
      extensionId: input.extensionId,
      revisionId: input.revisionId,
      entrypoints: { host: 'source/host.ts' },
      permissions: { permissions: [], networkOrigins: [] },
      contributions: [
        { kind: 'tool', name: 'gov_probe', description: '治理探针' },
        { kind: 'rpc', method: 'ping' },
      ],
      ...(input.dataVersion === undefined ? {} : { dataVersion: input.dataVersion }),
    },
    sources: { host: input.source },
  })
  return runtime.extensionService.importRevision({
    extension: { id: content.manifest.extensionId, slug: 'governance-probe', displayName: '治理探针', description: '' },
    revision: {
      id: content.manifest.revisionId,
      contentDigest: content.contentDigest,
      payloadDigest: content.payloadDigest,
    },
    manifest: content.manifest,
    sources: content.sources,
  })
}

const importBoth = async (runtime: NekroRuntime) => {
  const first = await importRevision(runtime, {
    extensionId: 'ext_GOVERNED',
    revisionId: 'xrv_GOVERNEDONE',
    source: SOURCE_V1,
  })
  const second = await importRevision(runtime, {
    extensionId: 'ext_GOVERNED',
    revisionId: 'xrv_GOVERNEDTWO',
    source: SOURCE_V2,
    dataVersion: 2,
  })
  return { extensionId: first.extension.id, v1: first.revision, v2: second.revision }
}

const storeRecord = (runtime: NekroRuntime, extensionId: ExtensionId, key: string, value: Record<string, string>) =>
  runtime.repository.setExtensionStorageEntry({
    extensionId,
    owner: 'shared',
    partition: 'host',
    key,
    value,
    updatedAt: 1,
    quotaBytes: 1024 * 1024,
  })

const storedValues = (runtime: NekroRuntime, extensionId: ExtensionId) =>
  Object.fromEntries(
    runtime.repository
      .readExtensionDataset(extensionId, { owners: 'all', index: false, library: false })
      .storage.map((entry) => [entry.key, entry.value]),
  )

let channelSequence = 0

const agentWithChannel = async (runtime: NekroRuntime, autonomy: 'manual' | 'confirm' | 'autonomous') => {
  const agent = runtime.core.createAgent({
    displayName: '治理智能体',
    persona: '',
    model: { provider: 'deepseek', model: 'deepseek-v4-flash' },
    capabilities: { extensionAutonomy: autonomy },
  })
  const channel = runtime.core.createChannel({
    connectionId: runtime.internalConnectionId,
    platformChannelId: `governance-${++channelSequence}`,
    kind: 'internal',
  })
  runtime.core.createBinding({ channelId: channel.id, agentId: agent.definition.id, triggerPolicy: 'observe-only' })
  return Promise.resolve({ agentId: agent.definition.id, channelId: channel.id })
}

const saveSharedExtension = (
  runtime: NekroRuntime,
  creator: AgentId,
  config?: ExtensionLayeredConfig,
  capabilities: Pick<ExtensionPermissions, 'host' | 'agent'> = {},
) =>
  runtime.extensionService.saveDynamicPackage({
    slug: 'shared-probe',
    displayName: '共享探针',
    description: '虚构的共享扩展',
    createdByAgentId: creator,
    verification: extensionVerification(['gov_probe'], ['ping']),
    snapshot: {
      name: '共享探针',
      purpose: '验证扩展共享',
      hostCode: SOURCE_V1,
      codeFormat: 'module',
      permissions: { permissions: [], networkOrigins: [], ...capabilities },
      contributions: [
        { kind: 'tool', name: 'gov_probe', description: '治理探针' },
        { kind: 'rpc', method: 'ping' },
      ],
      ...(config === undefined ? {} : { config }),
    },
  })

describe('extension lines', () => {
  it('chains imported versions, labels them by generation and branches into a new line', async () => {
    const runtime = await createRuntime()
    try {
      const { extensionId, v1, v2 } = await importBoth(runtime)
      // A package without lineage becomes the next version of what this machine already has.
      expect(v2).toMatchObject({ parentRevisionId: v1.id, ancestry: [v1.id], origin: 'file', dataVersion: 2 })
      const labels = extensionVersions(runtime.repository, runtime.extensionService, extensionId)
      expect([...labels.values()].map((version) => version.label)).toEqual(['v1', 'v2'])

      const branched = await runtime.extensionActions.perform(
        { kind: 'branch', revisionId: v1.id, name: '治理探针分支', slug: 'governance-branch', copyData: false },
        { kind: 'console' },
      )
      const branch = runtime.repository.getExtension(branched.extensionId!)
      expect(branch?.branchOf).toEqual({ extensionId, revisionId: v1.id })
      const branchRevision = runtime.repository.getExtensionRevision(branched.revisionId!)
      // A branch starts a line of its own; where it came from is recorded on the extension.
      expect(branchRevision).toMatchObject({ origin: 'branch', ancestry: [] })
      expect(branchRevision?.parentRevisionId).toBeUndefined()
      const lines = lineageGraph(runtime.repository, runtime.extensionService, branch!.id)
      expect(lines.map((line) => line.extensionId)).toEqual([extensionId, branch!.id])
      expect(lines[1]?.branchOf).toEqual({ extensionId, revisionId: v1.id })
      // A branch of a branch stays in the same family.
      const nested = await runtime.extensionActions.perform(
        {
          kind: 'branch',
          revisionId: branchRevision!.id,
          name: '分支的分支',
          slug: 'governance-nested',
          copyData: false,
        },
        { kind: 'console' },
      )
      expect(
        lineageGraph(runtime.repository, runtime.extensionService, extensionId).map((line) => line.extensionId),
      ).toEqual([extensionId, branch!.id, nested.extensionId])
    } finally {
      await runtime.dispose()
    }
  })
})

describe('revise tasks', () => {
  it('records a revise from the agent tool and runs its candidate beside the enabled version', async () => {
    const model = new ScriptedModel([{ name: 'nekro_nxt_extension_revise', args: { extension: '治理探针' } }])
    const runtime = await createRuntime(model)
    try {
      const { extensionId, v1 } = await importBoth(runtime)
      const entity = await runtime.createAgentWithInternalChannel({
        displayName: '修改智能体',
        persona: '',
        model: { provider: 'test-provider', model: 'chat-model' },
        capabilities: { dynamicCreation: true, extensionAutonomy: 'autonomous' },
      })
      await runtime.extensions.install({ extensionId, revisionId: v1.id })
      await runtime.extensionActions.perform(
        { kind: 'enable', extensionId, agentId: entity.agentId },
        { kind: 'console' },
      )
      await runtime.internalChannel.postMessage({
        channelId: entity.channelId,
        clientEventId: 'revise-request',
        parts: [{ type: 'text', text: '把治理探针改一下。' }],
      })
      await expect
        .poll(() => runtime.repository.listAuthoringTasks(entity.agentId)[0]?.kind, NOTICE_POLL)
        .toBe('revise')
      const task = runtime.repository.listAuthoringTasks(entity.agentId)[0]!
      expect(task).toMatchObject({ targetExtensionId: extensionId, baseRevisionId: v1.id })
      const consumer = await agentWithChannel(runtime, 'autonomous')
      const tools = new ExtensionGovernanceTools(runtime)
      expect(tools.list(consumer.agentId)).toMatchObject({ tasks: [], pendingRequests: [] })
      expect(JSON.stringify(tools.list(consumer.agentId))).not.toContain(task.id)
      await expect(tools.prepareRevise(consumer.agentId, { extension: extensionId })).rejects.toThrow(
        '其他智能体的修改任务',
      )
      expect(() => tools.resolveTask(consumer.agentId, task.id)).toThrow('找不到任务')
      const attempt = runtime.repository.listAuthoringAttempts(task.id).at(-1)!
      const episode = runtime.repository.getEpisode(task.episodeId)!
      // The candidate registers gov_probe like the enabled version; it takes over that tool in this conversation.
      await expect(
        runtime.host.runDynamicPackage(episode.dshSessionId!, task.pluginKey, attempt.runnerPackageId!, 'run'),
      ).resolves.toMatchObject({ ok: true, status: 'running' })
    } finally {
      await runtime.dispose()
    }
  })
})

/** Answers with the agent configuration it runs with, so a candidate and the enabled version can be told apart. */
const CITY_TOOL = `harness.registerTool(ctx, harness.defineTool({
  name: 'city_probe',
  description: '城市探针',
  parameters: {},
  output: { schema: { type: 'string' }, render(_args, value) { return [{ type: 'text', text: value }] } },
  execute() { return 'city=' + ctx.config().city },
}))`

const CITY_CONFIG = {
  agent: {
    schema: {
      type: 'object' as const,
      dict: { city: { type: 'string' as const, meta: { description: '城市', default: '默认市' } } },
    },
  },
}

const ASK_CITY = { name: 'city_probe', args: {} }

let cityMessage = 0

/** Posts a message and waits until the agent's turn has ended. */
const say = async (runtime: NekroRuntime, channelId: ChannelId, text: string) => {
  await runtime.internalChannel.postMessage({
    channelId,
    clientEventId: `city-${++cityMessage}`,
    parts: [{ type: 'text', text: `${text} [m${cityMessage}]` }],
  })
}

/** Waits for the next city_probe answer and returns it. */
const nextCity = async (model: TriggeredModel, runtime: NekroRuntime, channelId: ChannelId) => {
  const before = model.results.length
  await say(runtime, channelId, '#ask-city 现在是哪个城市？')
  await expect.poll(() => model.results.length, NOTICE_POLL).toBeGreaterThan(before)
  return /city=([^"\\]+)/u.exec(model.results.at(-1)!)?.[1]
}

/** Runs the task's latest candidate in its conversation and waits until it can be saved. */
const runCandidate = async (runtime: NekroRuntime, agentId: AgentId) => {
  const task = runtime.repository.listAuthoringTasks(agentId)[0]!
  const attempt = runtime.repository.listAuthoringAttempts(task.id).at(-1)!
  const sessionId = runtime.repository.getEpisode(task.episodeId)!.dshSessionId!
  await expect.poll(() => runtime.host.sessionStatus(sessionId), NOTICE_POLL).toBe('idle')
  await expect(
    runtime.host.runDynamicPackage(sessionId, task.pluginKey, attempt.runnerPackageId!, 'run'),
  ).resolves.toMatchObject({ ok: true, status: 'running' })
  await expect.poll(() => runtime.repository.getAuthoringTask(task.id)?.status, NOTICE_POLL).toBe('ready')
  return { task, sessionId }
}

const runningCandidates = (runtime: NekroRuntime, sessionId: string) =>
  runtime.host.dynamicInventory(sessionId).filter((row) => row.activeRun !== undefined)

const importCityLine = async (runtime: NekroRuntime) => {
  const content = materializeImportedRevision({
    manifest: {
      schemaVersion: 7,
      requires: { sdk: 10 },
      extensionId: 'ext_CITYLINE',
      revisionId: 'xrv_CITYLINEONE',
      entrypoints: { host: 'source/host.ts' },
      permissions: { permissions: [], networkOrigins: [] },
      contributions: [{ kind: 'tool', name: 'city_probe', description: '城市探针' }],
      config: CITY_CONFIG,
    },
    sources: { host: `export default ({ harness }) => ({ inject: ['tools'], apply(ctx) { ${CITY_TOOL} } })` },
  })
  return runtime.extensionService.importRevision({
    extension: { id: content.manifest.extensionId, slug: 'city-line', displayName: '城市线', description: '' },
    revision: {
      id: content.manifest.revisionId,
      contentDigest: content.contentDigest,
      payloadDigest: content.payloadDigest,
    },
    manifest: content.manifest,
    sources: content.sources,
  })
}

const DEFINE_CITY = {
  name: 'nekro_nxt_extension_define',
  args: {
    plugin: { kind: 'new', idPrefix: 'city' },
    name: '城市探针',
    purpose: '回答当前配置的城市。',
    code: { host: `return { inject: ['tools'], apply(ctx) { ${CITY_TOOL} } }` },
    config: CITY_CONFIG,
    testConfig: { city: '试运行市' },
  },
}

describe('candidates after saving', () => {
  it('gives the enabled version its tools once the saved candidate is enabled in the same conversation', async () => {
    const model = new TriggeredModel({ '#define-city': DEFINE_CITY, '#ask-city': ASK_CITY })
    const runtime = await createRuntime(model)
    try {
      const entity = await runtime.createAgentWithInternalChannel({
        displayName: '城市智能体',
        persona: '',
        model: { provider: 'test-provider', model: 'chat-model' },
        capabilities: { dynamicCreation: true, extensionAutonomy: 'autonomous' },
      })
      await say(runtime, entity.channelId, '#define-city 做一个城市探针。')
      await expect.poll(() => runtime.repository.listAuthoringTasks(entity.agentId).length, NOTICE_POLL).toBe(1)
      const { task, sessionId } = await runCandidate(runtime, entity.agentId)
      await expect(nextCity(model, runtime, entity.channelId)).resolves.toBe('试运行市')

      const saved = await runtime.extensionActions.perform(
        { kind: 'save', taskId: task.id, name: '城市探针', slug: 'city-probe' },
        { kind: 'console' },
      )
      // Saving alone leaves the candidate running: it is still what the agent tries out.
      expect(runningCandidates(runtime, sessionId)).toHaveLength(1)
      await runtime.extensionActions.perform(
        { kind: 'enable', extensionId: saved.extensionId!, agentId: entity.agentId, values: { city: '正式市' } },
        { kind: 'console' },
      )
      expect(runningCandidates(runtime, sessionId)).toEqual([])
      await expect(nextCity(model, runtime, entity.channelId)).resolves.toBe('正式市')

      await runtime.extensionActions.perform(
        {
          kind: 'configure',
          extensionId: saved.extensionId!,
          layer: 'agent',
          agentId: entity.agentId,
          values: { city: '新市' },
          credentials: {},
        },
        { kind: 'console' },
      )
      await expect(nextCity(model, runtime, entity.channelId)).resolves.toBe('新市')
    } finally {
      await runtime.dispose()
    }
  }, 60_000)

  it('brings the enabled version back after a revise is saved and switched to', async () => {
    const model = new TriggeredModel({
      '#revise-city': { name: 'nekro_nxt_extension_revise', args: { extension: '城市线' } },
      '#ask-city': ASK_CITY,
    })
    const runtime = await createRuntime(model)
    try {
      const { extension, revision } = await importCityLine(runtime)
      const entity = await runtime.createAgentWithInternalChannel({
        displayName: '修改城市智能体',
        persona: '',
        model: { provider: 'test-provider', model: 'chat-model' },
        capabilities: { dynamicCreation: true, extensionAutonomy: 'autonomous' },
      })
      await runtime.extensions.install({ extensionId: extension.id, revisionId: revision.id })
      await runtime.extensionActions.perform(
        { kind: 'enable', extensionId: extension.id, agentId: entity.agentId, values: { city: '正式市' } },
        { kind: 'console' },
      )
      await expect(nextCity(model, runtime, entity.channelId)).resolves.toBe('正式市')

      await say(runtime, entity.channelId, '#revise-city 改一下城市线。')
      await expect
        .poll(() => runtime.repository.listAuthoringTasks(entity.agentId)[0]?.kind, NOTICE_POLL)
        .toBe('revise')
      const revise = runtime.repository.listAuthoringTasks(entity.agentId)[0]!
      model.triggers['#change-city'] = {
        name: 'nekro_nxt_extension_define',
        args: {
          plugin: { kind: 'existing', pluginId: revise.pluginKey },
          name: '城市线',
          purpose: '回答当前配置的城市，并说明来自第二版。',
          code: { host: `export default ({ harness }) => ({ inject: ['tools'], apply(ctx) { ${CITY_TOOL} } }) // v2` },
          codeFormat: 'module',
          config: CITY_CONFIG,
        },
      }
      await say(runtime, entity.channelId, '#change-city 按说明改。')
      await expect.poll(() => runtime.repository.listAuthoringAttempts(revise.id).length, NOTICE_POLL).toBe(2)
      const { task, sessionId } = await runCandidate(runtime, entity.agentId)
      // While the revise is open its candidate stands in for the enabled version, with the candidate's defaults.
      await expect(nextCity(model, runtime, entity.channelId)).resolves.toBe('默认市')

      const saved = await runtime.extensionActions.perform({ kind: 'save', taskId: task.id }, { kind: 'console' })
      await runtime.extensionActions.perform(
        { kind: 'switch', extensionId: extension.id, revisionId: saved.revisionId! },
        { kind: 'console' },
      )
      expect(runningCandidates(runtime, sessionId)).toEqual([])
      await expect(nextCity(model, runtime, entity.channelId)).resolves.toBe('正式市')
    } finally {
      await runtime.dispose()
    }
  }, 60_000)

  it('still mounts an extension whose tool names an open task’s candidate already uses', async () => {
    const model = new TriggeredModel({ '#define-city': DEFINE_CITY, '#ask-city': ASK_CITY })
    const runtime = await createRuntime(model)
    try {
      const { extension } = await importCityLine(runtime)
      const entity = await runtime.createAgentWithInternalChannel({
        displayName: '同名智能体',
        persona: '',
        model: { provider: 'test-provider', model: 'chat-model' },
        capabilities: { dynamicCreation: true, extensionAutonomy: 'autonomous' },
      })
      await say(runtime, entity.channelId, '#define-city 做一个城市探针。')
      await expect.poll(() => runtime.repository.listAuthoringTasks(entity.agentId).length, NOTICE_POLL).toBe(1)
      const { task } = await runCandidate(runtime, entity.agentId)
      // The task is still open, so its candidate keeps the conversation; the conversation is handed off instead.
      await runtime.extensionActions.perform(
        { kind: 'enable', extensionId: extension.id, agentId: entity.agentId, values: { city: '正式市' } },
        { kind: 'console' },
      )
      expect(runtime.repository.getEpisode(task.episodeId)?.closeReason).toBe('incompatible-activation')
      await expect(nextCity(model, runtime, entity.channelId)).resolves.toBe('正式市')
    } finally {
      await runtime.dispose()
    }
  }, 60_000)
})

describe('trial configuration', () => {
  it('gives the host factory harness.config() with defaults and the task’s test values', async () => {
    const host = `const region = harness.config().region + '/' + harness.config().unit
return { inject: ['tools'], apply(ctx) { harness.registerTool(ctx, harness.defineTool({
  name: 'region_probe',
  description: '地区探针',
  parameters: {},
  output: { schema: { type: 'string' }, render(_args, value) { return [{ type: 'text', text: value }] } },
  execute() { return 'city=' + region },
})) } }`
    const model = new TriggeredModel({
      '#define-region': {
        name: 'nekro_nxt_extension_define',
        args: {
          plugin: { kind: 'new', idPrefix: 'region' },
          name: '地区探针',
          purpose: '回答本机配置的地区。',
          code: { host },
          config: {
            host: {
              schema: {
                type: 'object',
                dict: {
                  region: { type: 'string', meta: { description: '地区', default: '示例区' } },
                  unit: { type: 'string', meta: { description: '单位', default: '摄氏' } },
                },
              },
            },
          },
          testConfig: { region: '试运行区' },
        },
      },
      '#ask-region': { name: 'region_probe', args: {} },
    })
    const runtime = await createRuntime(model)
    try {
      const entity = await runtime.createAgentWithInternalChannel({
        displayName: '地区智能体',
        persona: '',
        model: { provider: 'test-provider', model: 'chat-model' },
        capabilities: { dynamicCreation: true, extensionAutonomy: 'autonomous' },
      })
      await say(runtime, entity.channelId, '#define-region 做一个地区探针。')
      await expect.poll(() => runtime.repository.listAuthoringTasks(entity.agentId).length, NOTICE_POLL).toBe(1)
      await runCandidate(runtime, entity.agentId)
      await say(runtime, entity.channelId, '#ask-region 现在是哪个地区？')
      await expect.poll(() => model.results.at(-1), NOTICE_POLL).toContain('city=试运行区/摄氏')
    } finally {
      await runtime.dispose()
    }
  }, 60_000)
})

describe('extension data across versions', () => {
  it('migrates stored data on switch, refuses to downgrade it and rolls back with the snapshot', async () => {
    const runtime = await createRuntime()
    try {
      const { extensionId, v1, v2 } = await importBoth(runtime)
      await runtime.extensions.install({ extensionId, revisionId: v1.id })
      storeRecord(runtime, extensionId, 'first', { name: '甲' })

      await runtime.extensionActions.perform({ kind: 'switch', extensionId, revisionId: v2.id }, { kind: 'console' })
      expect(storedValues(runtime, extensionId)).toEqual({ first: { title: '甲' } })
      expect(runtime.extensionData.dataVersion(extensionId)).toBe(2)
      expect(runtime.extensionData.listSnapshots(extensionId).map((snapshot) => snapshot.reason)).toEqual(['switch'])

      await expect(runtime.extensions.install({ extensionId, revisionId: v1.id })).rejects.toBeInstanceOf(
        ExtensionDataDowngradeError,
      )
      expect(runtime.repository.getHostInstallation(extensionId)?.extensionRevisionId).toBe(v2.id)

      const rolledBack = await runtime.extensionActions.perform({ kind: 'revert', extensionId }, { kind: 'console' })
      expect(rolledBack.revisionId).toBe(v1.id)
      expect(storedValues(runtime, extensionId)).toEqual({ first: { name: '甲' } })
      expect(runtime.extensionData.dataVersion(extensionId)).toBe(1)
    } finally {
      await runtime.dispose()
    }
  })

  it('previews and performs overwrite and replace migrations between lines, keeping a snapshot to undo', async () => {
    const runtime = await createRuntime()
    try {
      const { extensionId, v1 } = await importBoth(runtime)
      const branched = await runtime.extensionActions.perform(
        { kind: 'branch', revisionId: v1.id, name: '数据目标', slug: 'governance-target', copyData: false },
        { kind: 'console' },
      )
      const target = branched.extensionId!
      storeRecord(runtime, extensionId, 'shared-key', { name: '来源' })
      storeRecord(runtime, extensionId, 'only-source', { name: '只在来源' })
      storeRecord(runtime, target, 'shared-key', { name: '目标' })
      storeRecord(runtime, target, 'only-target', { name: '只在目标' })
      const plan = (mode: 'overwrite' | 'replace') => ({
        source: { kind: 'extension' as const, extensionId },
        targetExtensionId: target,
        mode,
        scope: { owners: 'all' as const, index: true, library: true },
      })

      const overwrite = runtime.extensionData.preview(plan('overwrite'))
      expect(overwrite.diff.storage).toEqual({ added: 1, overwritten: 1, removed: 0, unchanged: 0 })
      expect(overwrite.destructive).toBe(true)
      const replace = runtime.extensionData.preview(plan('replace'))
      expect(replace.diff.storage).toMatchObject({ added: 1, overwritten: 1, removed: 1 })
      expect(storedValues(runtime, target)).toEqual({
        'shared-key': { name: '目标' },
        'only-target': { name: '只在目标' },
      })

      const done = await runtime.extensionActions.perform(
        {
          kind: 'migrate-data',
          targetExtensionId: target,
          source: { kind: 'extension', extensionId },
          mode: 'replace',
        },
        { kind: 'console' },
      )
      expect(done.message).toContain('删除 1')
      expect(storedValues(runtime, target)).toEqual({
        'shared-key': { name: '来源' },
        'only-source': { name: '只在来源' },
      })
      const snapshot = runtime.extensionData.listSnapshots(target).find((entry) => entry.reason === 'migration')
      expect(snapshot).toBeDefined()
      runtime.extensionData.migrate({ ...plan('replace'), source: { kind: 'snapshot', snapshotId: snapshot!.id } })
      expect(storedValues(runtime, target)).toEqual({
        'shared-key': { name: '目标' },
        'only-target': { name: '只在目标' },
      })
    } finally {
      await runtime.dispose()
    }
  })
})

describe('extension autonomy', () => {
  it('checks the requester before exposing the local catalog through the agent tool', async () => {
    const runtime = await createRuntime()
    const context = new Context()
    try {
      const creator = await agentWithChannel(runtime, 'autonomous')
      const consumer = await agentWithChannel(runtime, 'autonomous')
      await saveSharedExtension(runtime, creator.agentId)
      const port = new ExtensionGovernanceTools(runtime)
      const requester = vi
        .spyOn(port, 'requesterAllowed')
        .mockReturnValue({ allowed: false, reason: '请管理员发起扩展管理请求。' })
      const episodeId = EpisodeIdSchema.parse('eps_CATALOGREQUEST')
      const unusedDefinition = () => {
        throw new Error('No definition expected in a catalog request.')
      }
      const list = extensionAgentTools({
        port: () => port,
        authoring: undefined,
        agentId: consumer.agentId,
        channelId: consumer.channelId,
        episodeId,
        sessionId: 'synthetic-catalog-session',
        define: unusedDefinition,
        restore: unusedDefinition,
        setReviseIntent: vi.fn(),
      }).find((tool) => tool.name === 'nekro_nxt_extension_list')!
      await context.plugin(SystemPrompt, { personaPrefix: '', includeHarnessIdentity: false })
      await context.plugin(ToolRuntime)
      context.tools.register(list)
      const execute = () =>
        context.tools.execute({
          callId: ToolCallId('catalog-request'),
          name: list.name,
          arguments: {},
          signal: new AbortController().signal,
        })
      const denied = await execute()
      expect(denied.isError).toBe(true)
      expect(JSON.stringify(denied.content)).toContain('请管理员')
      expect(JSON.stringify(denied.content)).not.toContain('shared-probe')
      expect(requester).toHaveBeenCalledWith(consumer.agentId, episodeId)
      requester.mockReturnValue({ allowed: true })
      const allowed = await execute()
      expect(allowed.isError).toBe(false)
      expect(JSON.stringify(allowed.content)).toContain('shared-probe')
    } finally {
      await context.fiber.dispose()
      await runtime.dispose()
    }
  })

  it('decides by autonomy, reach and risk, never by how often the agent asks', async () => {
    const runtime = await createRuntime()
    try {
      const { extensionId, v2 } = await importBoth(runtime)
      const manual = await agentWithChannel(runtime, 'manual')
      const confirm = await agentWithChannel(runtime, 'confirm')
      const autonomous = await agentWithChannel(runtime, 'autonomous')
      const agent = (entity: { readonly agentId: (typeof manual)['agentId']; readonly channelId: ChannelId }) =>
        ({ kind: 'agent', agentId: entity.agentId, channelId: entity.channelId }) as const
      const enable = (entity: typeof manual) => ({ kind: 'enable', extensionId, agentId: entity.agentId }) as const
      const assess = runtime.extensionActions.assess.bind(runtime.extensionActions)

      expect(assess(enable(manual), agent(manual)).decision).toBe('console')
      expect(assess(enable(confirm), agent(confirm)).decision).toBe('request')
      expect(assess(enable(autonomous), agent(autonomous)).decision).toBe('run')
      // Delegated management includes extensions made by others; publishing still needs approval.
      expect(assess({ kind: 'community-publish', extensionId, notes: '' }, agent(autonomous)).decision).toBe('request')
      await runtime.extensionActions.perform(enable(autonomous), { kind: 'console' })
      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect(assess(enable(autonomous), agent(autonomous)).decision).toBe('run')
      }
      // Publishing and data migration always go through an administrator.
      expect(assess({ kind: 'community-publish', extensionId, notes: '' }, agent(autonomous)).decision).toBe('request')
      expect(
        assess(
          {
            kind: 'migrate-data',
            targetExtensionId: extensionId,
            source: { kind: 'extension', extensionId },
            mode: 'overwrite',
          },
          agent(autonomous),
        ).decision,
      ).toBe('request')
      // Switching moves every agent that uses the extension, so it needs confirmation once another agent uses it.
      await runtime.extensionActions.perform(enable(confirm), { kind: 'console' })
      expect(assess({ kind: 'switch', extensionId, revisionId: v2.id }, agent(autonomous)).decision).toBe('request')
      expect(assess(enable(autonomous), { kind: 'administrator', label: '管理员' }).decision).toBe('run')
      expect(assess(enable(autonomous), { kind: 'console' }).decision).toBe('run')
    } finally {
      await runtime.dispose()
    }
  })

  it('discovers another agent’s saved extension and enables or disables only itself with an audit trail', async () => {
    const runtime = await createRuntime()
    try {
      const creator = await agentWithChannel(runtime, 'autonomous')
      const consumer = await agentWithChannel(runtime, 'autonomous')
      const manual = await agentWithChannel(runtime, 'manual')
      const confirm = await agentWithChannel(runtime, 'confirm')
      const { extension, revision } = await saveSharedExtension(runtime, creator.agentId)
      const tools = new ExtensionGovernanceTools(runtime)
      expect(tools.list(manual.agentId)).toMatchObject({
        autonomy: 'manual',
        scope: 'related',
        extensions: [],
      })
      expect(JSON.stringify(tools.list(manual.agentId))).toContain('管理员')
      expect(() => tools.resolveExtension(manual.agentId, extension.id)).toThrow('可访问')
      for (const entity of [consumer, confirm]) {
        expect(tools.list(entity.agentId)).toMatchObject({
          scope: 'local',
          extensions: [
            {
              id: extension.id,
              slug: 'shared-probe',
              createdByYou: false,
              enabledForYou: false,
              installed: false,
              currentVersion: null,
              availableVersion: 'v1',
              enablement: {
                decision: entity === consumer ? 'run' : 'request',
              },
            },
          ],
        })
        expect(tools.resolveExtension(entity.agentId, extension.id).id).toBe(extension.id)
        expect(tools.resolveExtension(entity.agentId, extension.displayName).id).toBe(extension.id)
      }
      const enable = (agentId: AgentId) => ({ kind: 'enable', extensionId: extension.id, agentId }) as const
      expect(await tools.act(manual.agentId, manual.channelId, enable(manual.agentId))).toMatchObject({
        outcome: 'console',
      })
      await runtime.extensionActions.perform(enable(creator.agentId), { kind: 'console' })
      // A shared version switch affects the sole other consumer, even before this agent enables it.
      expect(
        await tools.act(consumer.agentId, consumer.channelId, {
          kind: 'switch',
          extensionId: extension.id,
          revisionId: revision.id,
        }),
      ).toMatchObject({ outcome: 'requested' })
      const denied = await tools.act(consumer.agentId, consumer.channelId, enable(creator.agentId))
      expect(denied.outcome).toBe('console')
      expect(denied.message).toContain('只能给自己')
      expect(await tools.act(consumer.agentId, consumer.channelId, enable(consumer.agentId))).toMatchObject({
        outcome: 'scheduled',
      })
      await expect
        .poll(
          () =>
            runtime.extensionRequests
              .list()
              .find((request) => request.agentId === consumer.agentId && request.kind === 'enable')?.status,
        )
        .toBe('completed')
      expect(runtime.repository.getActivation(consumer.agentId, extension.id)).toBeDefined()
      expect(tools.list(consumer.agentId)).toMatchObject({
        extensions: [{ enabledForYou: true, installed: true, currentVersion: 'v1' }],
      })
      expect(
        await tools.act(consumer.agentId, consumer.channelId, {
          kind: 'disable',
          extensionId: extension.id,
          agentId: creator.agentId,
        }),
      ).toMatchObject({ outcome: 'console' })
      expect(
        await tools.act(consumer.agentId, consumer.channelId, {
          kind: 'disable',
          extensionId: extension.id,
          agentId: consumer.agentId,
        }),
      ).toMatchObject({ outcome: 'scheduled' })
      await expect
        .poll(
          () =>
            runtime.extensionRequests
              .list()
              .find((request) => request.agentId === consumer.agentId && request.kind === 'disable')?.status,
        )
        .toBe('completed')
      expect(runtime.repository.getActivation(consumer.agentId, extension.id)).toBeUndefined()
      expect(runtime.repository.getActivation(creator.agentId, extension.id)).toBeDefined()
      const requested = await tools.act(confirm.agentId, confirm.channelId, enable(confirm.agentId))
      expect(requested.outcome).toBe('requested')
      expect(runtime.repository.getActivation(confirm.agentId, extension.id)).toBeUndefined()
      await runtime.extensionRequests.approve(requested.requestNumber!, { kind: 'console' })
      expect(runtime.extensionRequests.get(requested.requestNumber!)).toMatchObject({
        status: 'completed',
        decidedBy: '控制台管理员',
      })
      expect(runtime.repository.getActivation(confirm.agentId, extension.id)).toBeDefined()
    } finally {
      await runtime.dispose()
    }
  })

  it('reports missing shared or private configuration without exposing another agent’s settings or credentials', async () => {
    const runtime = await createRuntime()
    try {
      const creator = await agentWithChannel(runtime, 'autonomous')
      const consumer = await agentWithChannel(runtime, 'autonomous')
      const { extension, revision } = await saveSharedExtension(runtime, creator.agentId, {
        host: {
          schema: {
            type: 'object',
            dict: {
              endpoint: { type: 'string', meta: { required: true } },
              hostKey: { type: 'string', meta: { required: true, role: 'secret' } },
            },
          },
        },
        agent: {
          schema: {
            type: 'object',
            dict: {
              nickname: { type: 'string', meta: { required: true } },
              agentKey: { type: 'string', meta: { required: true, role: 'secret' } },
            },
          },
        },
      })
      const tools = new ExtensionGovernanceTools(runtime)
      const action = { kind: 'enable', extensionId: extension.id, agentId: consumer.agentId } as const
      expect(tools.list(consumer.agentId)).toMatchObject({
        extensions: [{ enablement: { decision: 'console' } }],
      })
      expect(JSON.stringify(tools.list(consumer.agentId))).toContain('本机配置')
      const missingConfig = await tools.act(consumer.agentId, consumer.channelId, action)
      expect(missingConfig.outcome).toBe('console')
      expect(missingConfig.message).toContain('本机配置')
      const hostKey = await runtime.credentials.save('fictional-shared-secret')
      const creatorKey = await runtime.credentials.save('fictional-creator-secret')
      await runtime.extensions.install({
        extensionId: extension.id,
        revisionId: revision.id,
        config: { endpoint: 'https://example.invalid', hostKey },
      })
      await runtime.extensions.activate({
        agentId: creator.agentId,
        extensionId: extension.id,
        revisionId: revision.id,
        config: { nickname: '虚构私有设置', agentKey: creatorKey },
      })
      runtime.repository.setExtensionStorageEntry({
        extensionId: extension.id,
        owner: creator.agentId,
        partition: 'agent',
        key: 'private',
        value: '虚构私有数据',
        updatedAt: 1,
        quotaBytes: 1024,
      })
      // With the shared configuration complete, what is missing is the agent's own: a required value it passes when
      // enabling, and its credential afterwards.
      const listed = tools.list(consumer.agentId)
      expect(listed).toMatchObject({
        extensions: [{ enablement: { decision: 'run', note: expect.stringContaining('nickname') as unknown } }],
      })
      await expect(runtime.extensionActions.perform(action, { kind: 'console' })).rejects.toThrow('启用前还要填写')
      await expect(tools.act(consumer.agentId, consumer.channelId, action)).rejects.toThrow('values')
      const serialized = JSON.stringify(listed)
      for (const privateValue of [
        hostKey,
        creatorKey,
        'fictional-shared-secret',
        'fictional-creator-secret',
        '虚构私有设置',
        '虚构私有数据',
      ])
        expect(serialized).not.toContain(privateValue)
      // The agent's own credential can only be filled once it is enabled, so it never blocks enabling.
      await runtime.extensions.activate({
        agentId: consumer.agentId,
        extensionId: extension.id,
        revisionId: revision.id,
        config: { nickname: '虚构使用者' },
      })
      expect(runtime.extensionActions.enablementProblem(consumer.agentId, extension.id)).toBeUndefined()
      expect(tools.list(consumer.agentId)).toMatchObject({
        extensions: [{ enablement: { note: expect.stringContaining('你自己的凭据') as unknown } }],
      })
      const consumerKey = await runtime.credentials.save('fictional-consumer-secret')
      await runtime.extensions.updateAgentConfig(consumer.agentId, extension.id, {
        nickname: '虚构使用者',
        agentKey: consumerKey,
      })
      expect(await tools.act(consumer.agentId, consumer.channelId, action)).toMatchObject({ outcome: 'scheduled' })
      await expect
        .poll(() => runtime.extensionRequests.list().find((request) => request.agentId === consumer.agentId)?.status)
        .toBe('completed')
      expect(runtime.repository.getActivation(creator.agentId, extension.id)?.config).toEqual({
        nickname: '虚构私有设置',
        agentKey: creatorKey,
      })
      expect(runtime.repository.getActivation(consumer.agentId, extension.id)?.config).toEqual({
        nickname: '虚构使用者',
        agentKey: consumerKey,
      })
      expect(
        runtime.repository.readExtensionDataset(extension.id, {
          owners: [consumer.agentId],
          index: false,
          library: false,
        }).storage,
      ).toEqual([])
      expect(JSON.stringify(tools.list(consumer.agentId))).not.toContain(consumerKey)
    } finally {
      await runtime.dispose()
    }
  })

  it('inspects configuration and state without exposing credentials or another agent’s settings', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nxt-governance-logs-'))
    directories.push(root)
    const logs = await HostLogService.open({ dataRoot: root })
    const runtime = await createRuntime(undefined, logs)
    try {
      const creator = await agentWithChannel(runtime, 'autonomous')
      const consumer = await agentWithChannel(runtime, 'confirm')
      const { extension, revision } = await saveSharedExtension(
        runtime,
        creator.agentId,
        {
          host: {
            schema: {
              type: 'object',
              dict: {
                endpoint: { type: 'string', meta: { description: '服务地址', required: true } },
                hostKey: { type: 'string', meta: { description: '服务密钥', required: true, role: 'secret' } },
              },
            },
          },
          agent: {
            schema: {
              type: 'object',
              dict: {
                nickname: { type: 'string', meta: { description: '称呼', required: true, default: '虚构默认称呼' } },
                agentKey: { type: 'string', meta: { description: '个人密钥', role: 'secret' } },
              },
            },
          },
        },
        { host: { network: { mode: 'config', fields: ['endpoint'] } } },
      )
      const hostKey = await runtime.credentials.save('fictional-shared-secret')
      const creatorKey = await runtime.credentials.save('fictional-creator-secret')
      await runtime.extensions.install({
        extensionId: extension.id,
        revisionId: revision.id,
        config: { endpoint: 'https://service.example.test', hostKey },
        permissionApproval: {
          permissionDigest: hostPermissionRequirement(runtime.extensionService.revisionManifest(revision), undefined)
            .permissionDigest,
        },
      })
      await runtime.extensions.activate({
        agentId: creator.agentId,
        extensionId: extension.id,
        revisionId: revision.id,
        config: { nickname: '虚构私有设置', agentKey: creatorKey },
      })
      logs.write({
        level: 'error',
        message: '请求失败 token=fictional-log-token',
        source: { kind: 'extension', id: extension.id, name: '共享探针' },
        scope: { extensionId: extension.id },
      })
      logs.write({
        level: 'error',
        message: '虚构的创建者私有错误',
        source: { kind: 'extension', id: extension.id, name: '共享探针' },
        scope: { extensionId: extension.id, agentId: creator.agentId },
      })
      await logs.flush()

      const tools = new ExtensionGovernanceTools(runtime)
      const inspected = await tools.inspect(consumer.agentId, { kind: 'extension', reference: '共享探针' })
      expect(inspected).toMatchObject({
        extension: { id: extension.id, createdByYou: false },
        config: [
          { layer: 'host', key: 'endpoint', level: 'network', value: 'https://service.example.test' },
          { layer: 'host', key: 'hostKey', level: 'secret', set: true },
          { layer: 'agent', key: 'nickname', level: 'normal', default: '虚构默认称呼' },
          { layer: 'agent', key: 'agentKey', level: 'secret' },
        ],
        agentConfigNote: expect.any(String) as unknown,
        runtime: { installedVersion: 'v1', enabledFor: ['治理智能体'] },
        authority: {
          autonomy: 'confirm',
          requesters: 'everyone',
          actions: { enable: 'request', 'community-publish': 'request' },
        },
      })
      const shape = z
        .object({
          config: z.array(z.record(z.string(), z.unknown())),
          runtime: z.object({ recentLogs: z.array(z.object({ message: z.string() }).loose()) }).loose(),
        })
        .loose()
        .parse(inspected)
      expect(shape.config.find((field) => field['key'] === 'nickname')).not.toHaveProperty('value')
      expect(shape.config.find((field) => field['key'] === 'agentKey')).not.toHaveProperty('set')
      expect(shape.runtime.recentLogs.map((entry) => entry.message)).toEqual(['请求失败 token=[已隐藏]'])
      const serialized = JSON.stringify(inspected)
      for (const privateValue of [
        hostKey,
        creatorKey,
        'fictional-shared-secret',
        'fictional-creator-secret',
        'fictional-log-token',
        '虚构私有设置',
        '虚构的创建者私有错误',
      ])
        expect(serialized).not.toContain(privateValue)

      // Once enabled, the agent sees its own values and its own missing credential, still not the creator's.
      await runtime.extensions.activate({
        agentId: consumer.agentId,
        extensionId: extension.id,
        revisionId: revision.id,
        config: { nickname: '虚构使用者' },
      })
      const own = await tools.inspect(consumer.agentId, { kind: 'extension', reference: extension.id })
      expect(own).toMatchObject({
        config: [{}, {}, { key: 'nickname', value: '虚构使用者' }, { key: 'agentKey', set: false }],
        runtime: { enabledFor: expect.arrayContaining(['治理智能体', '你']) as unknown },
      })
      expect(JSON.stringify(own)).not.toContain('虚构私有设置')
      expect(JSON.stringify(own)).not.toContain(creatorKey)
    } finally {
      await runtime.dispose()
      await logs.close()
    }
  })

  it('takes test values for the candidate from the define tool and refuses credentials there', async () => {
    const host = `return { inject: ['tools'], apply(ctx) { ${PROBE_TOOL} } }`
    const config = {
      agent: {
        schema: {
          type: 'object',
          dict: {
            city: { type: 'string', meta: { description: '城市' } },
            apiKey: { type: 'string', meta: { description: 'API Key', role: 'secret' } },
          },
        },
      },
    }
    const define = (testConfig: Record<string, unknown>) => ({
      name: 'nekro_nxt_extension_define',
      args: {
        plugin: { kind: 'new', idPrefix: 'tcfg' },
        name: '测试配置探针',
        purpose: '验证测试配置。',
        code: { host },
        config,
        testConfig,
      },
    })
    const model = new ScriptedModel([define({ apiKey: 'fictional-agent-secret' }), define({ city: '虚构市' })])
    const runtime = await createRuntime(model)
    try {
      const entity = await runtime.createAgentWithInternalChannel({
        displayName: '配置智能体',
        persona: '',
        model: { provider: 'test-provider', model: 'chat-model' },
        capabilities: { dynamicCreation: true, extensionAutonomy: 'autonomous' },
      })
      await runtime.internalChannel.postMessage({
        channelId: entity.channelId,
        clientEventId: 'test-config-request',
        parts: [{ type: 'text', text: '做一个查天气的扩展。' }],
      })
      await expect
        .poll(() => {
          const task = runtime.repository.listAuthoringTasks(entity.agentId)[0]
          return task === undefined ? undefined : runtime.authoringTestConfig.values(task.id).agentProvided
        }, NOTICE_POLL)
        .toEqual({ city: '虚构市' })
      const task = runtime.repository.listAuthoringTasks(entity.agentId)[0]!
      // The definition that carried a credential was refused before anything was defined.
      expect(runtime.repository.listAuthoringAttempts(task.id)).toHaveLength(1)
      expect(JSON.stringify(runtime.authoringTestConfig.values(task.id))).not.toContain('fictional-agent-secret')
      await expect(runtime.authoringTestConfig.setAgentValues(task.id, { apiKey: 'x' })).rejects.toThrow('是凭据')
      await expect(runtime.authoringTestConfig.setAgentValues(task.id, { unknown: 'x' })).rejects.toThrow(
        '没有这些字段',
      )
    } finally {
      await runtime.dispose()
    }
  })

  it('binds named credentials in test values, asking an administrator first when automatic use is off', async () => {
    const host = `return { inject: ['tools'], apply(ctx) { ${PROBE_TOOL} } }`
    const config = {
      agent: {
        schema: {
          type: 'object',
          dict: {
            apiKey: { type: 'string', meta: { description: 'API Key', role: 'secret' } },
            backupKey: { type: 'string', meta: { description: '备用 Key', role: 'secret' } },
          },
        },
      },
    }
    const model = new ScriptedModel([
      {
        name: 'nekro_nxt_extension_define',
        args: {
          plugin: { kind: 'new', idPrefix: 'cred' },
          name: '凭据探针',
          purpose: '验证凭据绑定。',
          code: { host },
          config,
          testConfig: { apiKey: { credential: '天气服务' }, backupKey: { credential: '备用天气' } },
        },
      },
    ])
    const runtime = await createRuntime(model)
    try {
      const entity = await runtime.createAgentWithInternalChannel({
        displayName: '凭据智能体',
        persona: '',
        model: { provider: 'test-provider', model: 'chat-model' },
        // Manual autonomy still develops and test-runs; only the credential needs a yes.
        capabilities: { dynamicCreation: true, extensionAutonomy: 'manual' },
      })
      const guarded = await runtime.credentialLibrary.create({
        name: '天气服务',
        value: 'fictional-weather-key',
        domains: ['api.weather.test'],
        autoUse: false,
      })
      const open = await runtime.credentialLibrary.create({
        name: '备用天气',
        value: 'fictional-backup-key',
        domains: ['api.weather.test'],
        agentScope: { agentIds: [entity.agentId] },
      })
      await runtime.internalChannel.postMessage({
        channelId: entity.channelId,
        clientEventId: 'credential-binding-request',
        parts: [{ type: 'text', text: '做一个查天气的扩展。' }],
      })
      await expect
        .poll(() => runtime.extensionRequests.list('pending').find((request) => request.kind === 'use-credential'))
        .toBeDefined()
      const task = runtime.repository.listAuthoringTasks(entity.agentId)[0]!
      // The open credential is bound at once; the guarded one waits.
      expect(runtime.authoringTestConfig.values(task.id).agentProvided).toEqual({
        backupKey: `credential:named:${open.id}`,
      })
      const request = runtime.extensionRequests.list('pending').find((entry) => entry.kind === 'use-credential')!
      expect(request).toMatchObject({
        agentId: entity.agentId,
        summary: expect.stringContaining('天气服务') as unknown,
      })
      await runtime.extensionRequests.approve(request.number, { kind: 'console' })
      // The approval stays on the credential, for this agent only.
      expect(runtime.credentialLibrary.get(guarded.id)?.approvedAgentIds).toEqual([entity.agentId])
      expect(runtime.authoringTestConfig.values(task.id).agentProvided).toEqual({
        backupKey: `credential:named:${open.id}`,
        apiKey: `credential:named:${guarded.id}`,
      })
      const inspected = JSON.stringify(
        await new ExtensionGovernanceTools(runtime).inspect(entity.agentId, { kind: 'task', reference: task.id }),
      )
      expect(inspected).toContain('"credential":"天气服务"')
      expect(inspected).not.toContain('fictional-weather-key')

      // A credential that is not open to the agent, or does not exist, is refused with what to do.
      await runtime.credentialLibrary.update(open.id, { agentScope: { agentIds: [] } })
      const tools = new ExtensionGovernanceTools(runtime)
      await expect(tools.setTestConfig(task.id, { backupKey: { credential: '备用天气' } })).rejects.toThrow(
        '不对你开放',
      )
      await expect(tools.setTestConfig(task.id, { backupKey: { credential: '不存在' } })).rejects.toThrow(
        'nekro_nxt_credential_request',
      )
      await expect(tools.setTestConfig(task.id, { backupKey: 'fictional-typed-key' })).rejects.toThrow('是凭据')
    } finally {
      await runtime.dispose()
    }
  })

  it('lists credentials to the agent without values and wakes it once a requested one is added', async () => {
    const runtime = await createRuntime()
    try {
      const entity = await agentWithChannel(runtime, 'manual')
      const other = await agentWithChannel(runtime, 'manual')
      await runtime.credentialLibrary.create({
        name: '示例搜索',
        description: '搜索接口',
        value: 'fictional-search-key',
        domains: ['api.search.test'],
      })
      await runtime.credentialLibrary.create({
        name: '他人专用',
        value: 'fictional-private-key',
        usage: 'program',
        agentScope: { agentIds: [other.agentId] },
        autoUse: false,
      })
      // Linked accounts are listed by platform and login, with whether this agent's commands act as them.
      for (const [suffix, login] of [
        ['LISTED1', 'octo-fixture'],
        ['LISTED2', 'second-fixture'],
      ] as const) {
        runtime.repository.linkedAccounts.insertAccount({
          id: LinkedAccountIdSchema.parse(`acc_${suffix}`),
          platform: 'github',
          login,
          source: 'token',
          credentialRef: await runtime.credentials.save(`fictional-account-token-${suffix}`),
          createdAt: 1,
          updatedAt: 1,
        })
      }
      await runtime.linkedAccounts.prepare()
      const revision = runtime.repository.getAgent(entity.agentId)!.revision
      runtime.core.reviseAgent(entity.agentId, revision.id, {
        displayName: revision.displayName,
        persona: revision.persona,
        personaDocument: revision.personaDocument,
        model: revision.model,
        capabilities: {
          ...revision.capabilities,
          commandAccounts: [{ service: 'github', accountId: 'acc_LISTED1', usage: [] }],
        },
        imagePolicy: revision.imagePolicy,
        dynamicClientApprovalPolicy: revision.dynamicClientApprovalPolicy,
      })
      const tools = new ExtensionGovernanceTools(runtime)
      const listed = await tools.listCredentials(entity.agentId)
      expect(listed).toMatchObject({
        credentials: [
          {
            name: '示例搜索',
            description: '搜索接口',
            usage: 'request',
            domains: ['api.search.test'],
            availableToYou: true,
          },
          { name: '他人专用', usage: 'program', autoUse: false, availableToYou: false },
        ],
        accounts: [
          { platform: 'GitHub', login: 'octo-fixture', grantedToYou: true },
          { platform: 'GitHub', login: 'second-fixture', grantedToYou: false },
        ],
        modelProviders: [],
      })
      expect(await tools.listCredentials(other.agentId)).toMatchObject({
        accounts: [{ grantedToYou: false }, { grantedToYou: false }],
      })
      const serialized = JSON.stringify(listed)
      for (const hidden of [
        'fictional-search-key',
        'fictional-private-key',
        'fictional-account-token',
        'credential:local',
        'crd_',
        'acc_',
      ])
        expect(serialized).not.toContain(hidden)

      // An existing credential whose automatic use is off: asking files an approval request instead.
      const guarded = await runtime.credentialLibrary.create({
        name: '受控搜索',
        value: 'fictional-guarded-key',
        usage: 'program',
        envName: 'SEARCH_KEY',
        autoUse: false,
      })
      expect(await tools.listCredentials(entity.agentId)).toMatchObject({
        credentials: expect.arrayContaining([
          expect.objectContaining({ name: '受控搜索', needsApproval: true, envName: 'SEARCH_KEY' }),
        ]) as unknown,
      })
      const asked = z
        .object({ requested: z.boolean(), requestNumber: z.number() })
        .loose()
        .parse(
          tools.requestCredential(entity.agentId, entity.channelId, {
            name: '受控搜索',
            purpose: '命令里查资料',
            domains: [],
            usage: 'program',
          }),
        )
      expect(asked.requested).toBe(true)
      expect(runtime.extensionRequests.get(asked.requestNumber)).toMatchObject({
        kind: 'use-credential',
        status: 'pending',
      })
      await runtime.extensionRequests.approve(asked.requestNumber, { kind: 'console' })
      expect(runtime.credentialLibrary.commandCredentials(entity.agentId).map(({ record }) => record.id)).toEqual([
        guarded.id,
      ])
      expect(runtime.credentialLibrary.commandCredentials(other.agentId)).toEqual([])

      const notify = vi.spyOn(runtime.host, 'notifyAgent')
      expect(
        tools.requestCredential(entity.agentId, entity.channelId, {
          name: '示例搜索',
          purpose: '查资料',
          domains: [],
          usage: 'request',
        }),
      ).toMatchObject({ requested: false })
      expect(
        tools.requestCredential(entity.agentId, entity.channelId, {
          name: '天气服务',
          purpose: '查天气',
          domains: ['api.weather.test'],
          usage: 'request',
        }),
      ).toMatchObject({ requested: true })
      const [pending] = runtime.credentialRequests.list()
      expect(pending).toMatchObject({ name: '天气服务', agentId: entity.agentId, channelId: entity.channelId })
      expect(pending?.route).toBe(
        `/settings/credentials?add=1&name=${encodeURIComponent('天气服务')}&request=${pending?.id}&usage=request&purpose=${encodeURIComponent('查天气')}&domains=api.weather.test`,
      )
      const added = await runtime.credentialLibrary.create({
        name: '天气服务',
        value: 'fictional-weather-key',
        domains: ['api.weather.test'],
      })
      runtime.credentialRequests.fulfil(added.name)
      expect(runtime.credentialRequests.list()).toEqual([])
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: entity.agentId, channelId: entity.channelId }),
      )
    } finally {
      await runtime.dispose()
    }
  })

  it('allows shared code management while requesting approval before copying private data', async () => {
    const runtime = await createRuntime()
    try {
      const creator = await agentWithChannel(runtime, 'autonomous')
      const consumer = await agentWithChannel(runtime, 'autonomous')
      const { extension, revision } = await saveSharedExtension(runtime, creator.agentId)
      const tools = new ExtensionGovernanceTools(runtime)
      const prepared = await tools.prepareRevise(consumer.agentId, { extension: extension.id })
      expect(prepared).toMatchObject({ extensionId: extension.id, baseRevisionId: revision.id })
      const actor = { kind: 'agent', agentId: consumer.agentId } as const
      const branch = {
        kind: 'branch',
        revisionId: revision.id,
        name: '共享分支',
        slug: 'shared-branch',
        copyData: false,
      } as const
      expect(runtime.extensionActions.assess(branch, actor).decision).toBe('run')
      runtime.repository.setExtensionStorageEntry({
        extensionId: extension.id,
        owner: creator.agentId,
        partition: 'agent',
        key: 'private',
        value: '虚构私有数据',
        updatedAt: 1,
        quotaBytes: 1024,
      })
      const branched = await tools.act(consumer.agentId, consumer.channelId, branch)
      expect(branched.outcome).toBe('done')
      const branchId = runtime.repository.getExtensionBySlug('shared-branch')!.id
      expect(
        runtime.repository.readExtensionDataset(branchId, { owners: 'all', index: false, library: false }).storage,
      ).toEqual([])
      const request = await tools.act(consumer.agentId, consumer.channelId, {
        ...branch,
        name: '数据分支',
        slug: 'shared-data-branch',
        copyData: true,
      })
      expect(request.outcome).toBe('requested')
      expect(runtime.repository.getExtensionBySlug('shared-data-branch')).toBeUndefined()
      expect(runtime.extensionRequests.get(request.requestNumber!)?.status).toBe('pending')
    } finally {
      await runtime.dispose()
    }
  })

  it('posts a request, carries it out on approval and tells the channel how it ended', async () => {
    const runtime = await createRuntime()
    try {
      const { extensionId } = await importBoth(runtime)
      const entity = await agentWithChannel(runtime, 'confirm')
      const actor = { kind: 'agent', agentId: entity.agentId, channelId: entity.channelId } as const
      const action = { kind: 'enable', extensionId, agentId: entity.agentId } as const
      const requests = runtime.extensionRequests
      const asked = requests.create({ action, actor, assessment: runtime.extensionActions.assess(action, actor) })
      expect(asked.status).toBe('pending')
      // Asking again for the same thing keeps the one request.
      expect(
        requests.create({ action, actor, assessment: runtime.extensionActions.assess(action, actor) }).number,
      ).toBe(asked.number)
      // Notices keep the channel's pacing between messages, so they may take a few seconds to go out.
      await expect
        .poll(() => runtime.repository.findOutboundByNoticeKey(`ext-request:${asked.number}:asked`), NOTICE_POLL)
        .toBeDefined()

      const port = new ExtensionCommandPort(runtime)
      const platform = {
        source: 'platform' as const,
        connectionId: runtime.internalConnectionId,
        platformUserId: 'member-1',
        displayName: '群友',
      }
      await expect(
        port.ext(
          { subcommand: 'approve', target: String(asked.number) },
          { channelId: entity.channelId, agentId: entity.agentId, identity: platform, administrator: false },
        ),
      ).rejects.toThrow('只有 NekroNXT 管理员')
      const message = await port.ext(
        { subcommand: 'approve', target: `#${asked.number}` },
        { channelId: entity.channelId, agentId: entity.agentId, identity: platform, administrator: true },
      )
      expect(message).toBe(`已同意请求 #${asked.number}：已给治理智能体启用「治理探针」。`)
      expect(runtime.repository.getActivation(entity.agentId, extensionId)).toBeDefined()
      expect(requests.get(asked.number)).toMatchObject({ status: 'completed', decidedBy: '群友' })
      // The command's reply already told the channel; no second notice is posted there.
      expect(runtime.repository.findOutboundByNoticeKey(`ext-request:${asked.number}:done`)).toBeUndefined()

      // Approved from the console, the channel hears the outcome as a notice.
      const disable = { kind: 'disable', extensionId, agentId: entity.agentId } as const
      const second = requests.create({
        action: disable,
        actor,
        assessment: runtime.extensionActions.assess(disable, actor),
      })
      await requests.approve(second.number, { kind: 'console' })
      await expect
        .poll(() => runtime.repository.findOutboundByNoticeKey(`ext-request:${second.number}:done`), NOTICE_POLL)
        .toBeDefined()
      await expect(requests.approve(asked.number, { kind: 'console' })).rejects.toThrow('已经被处理')
    } finally {
      await runtime.dispose()
    }
  })

  it('lets an autonomous agent enable for itself after its turn and reports how it ended', async () => {
    const runtime = await createRuntime()
    try {
      const { extensionId } = await importBoth(runtime)
      const entity = await agentWithChannel(runtime, 'autonomous')
      const tools = new ExtensionGovernanceTools(runtime)
      const outcome = await tools.act(entity.agentId, entity.channelId, {
        kind: 'enable',
        extensionId,
        agentId: entity.agentId,
      })
      // Enabling changes what is mounted for the agent, so it lands at the agent's safe gap instead of blocking it.
      expect(outcome.outcome).toBe('scheduled')
      await expect.poll(() => runtime.repository.getActivation(entity.agentId, extensionId)).toBeDefined()
      await expect
        .poll(() => runtime.extensionRequests.list().find((request) => request.agentId === entity.agentId)?.status)
        .toBe('completed')
    } finally {
      await runtime.dispose()
    }
  })

  it('settles a waiting request once the agent carries out the same action on its own', async () => {
    const runtime = await createRuntime()
    try {
      const { extensionId } = await importBoth(runtime)
      const entity = await agentWithChannel(runtime, 'confirm')
      const actor = { kind: 'agent', agentId: entity.agentId, channelId: entity.channelId } as const
      const action = { kind: 'enable', extensionId, agentId: entity.agentId } as const
      const requests = runtime.extensionRequests
      const asked = requests.create({ action, actor, assessment: runtime.extensionActions.assess(action, actor) })
      const done = requests.recordAutonomous({
        action: { ...action, reason: '群友想试试' },
        actor,
        assessment: runtime.extensionActions.assess(action, actor),
        result: { message: '已启用。' },
      })
      expect(requests.get(asked.number)).toMatchObject({
        status: 'completed',
        result: { message: `智能体已自主完成（#${done.number}）` },
      })
      await expect(requests.approve(asked.number, { kind: 'console' })).rejects.toThrow('已经被处理')
    } finally {
      await runtime.dispose()
    }
  })

  it('expires requests after a day and rejects with a reason', async () => {
    const runtime = await createRuntime()
    try {
      const { extensionId } = await importBoth(runtime)
      const entity = await agentWithChannel(runtime, 'confirm')
      let now = 1_000
      const requests = new ExtensionRequestService(runtime, () => now)
      const actor = { kind: 'agent', agentId: entity.agentId, channelId: entity.channelId } as const
      const action = { kind: 'enable', extensionId, agentId: entity.agentId } as const
      const assessment = runtime.extensionActions.assess(action, actor)
      const stale = requests.create({ action, actor, assessment })
      const disable = { kind: 'disable', extensionId, agentId: entity.agentId } as const
      const rejected = requests.create({
        action: disable,
        actor,
        assessment: runtime.extensionActions.assess(disable, actor),
      })
      requests.reject(rejected.number, { kind: 'console' }, '先别启用')
      expect(requests.get(rejected.number)).toMatchObject({ status: 'rejected', decidedBy: '控制台管理员' })
      now += EXTENSION_REQUEST_TTL_MS + 1
      expect(requests.get(stale.number)?.status).toBe('expired')
      await expect(requests.approve(stale.number, { kind: 'console' })).rejects.toThrow('已过期')
    } finally {
      await runtime.dispose()
    }
  })
})

describe('administrators', () => {
  it('claims with a one-time code from chat and gives up the code after five wrong tries', async () => {
    const runtime = await createRuntime()
    try {
      const port = new ExtensionCommandPort(runtime)
      const entity = await agentWithChannel(runtime, 'manual')
      const identity = (platformUserId: string) => ({
        source: 'platform' as const,
        connectionId: runtime.internalConnectionId,
        platformUserId,
        displayName: `成员 ${platformUserId}`,
      })
      const context = (platformUserId: string) => ({
        channelId: entity.channelId,
        agentId: entity.agentId,
        identity: identity(platformUserId),
        administrator: runtime.administrators.isAdministrator(runtime.internalConnectionId, platformUserId),
      })
      await expect(port.admin({ action: 'list' }, context('member-1'))).rejects.toThrow('只有 NekroNXT 管理员')
      await expect(port.admin({ action: 'claim', value: '000000' }, context('member-1'))).rejects.toThrow('已失效')

      const { code } = runtime.administrators.createClaimCode()
      const wrong = code === '000000' ? '111111' : '000000'
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await expect(port.admin({ action: 'claim', value: wrong }, context('member-2'))).rejects.toThrow('不正确')
      }
      await expect(port.admin({ action: 'claim', value: code }, context('member-2'))).rejects.toThrow('已失效')

      const fresh = runtime.administrators.createClaimCode()
      expect(await port.admin({ action: 'claim', value: fresh.code }, context('member-1'))).toContain(
        '已成为 NekroNXT 管理员',
      )
      expect(runtime.administrators.isAdministrator(runtime.internalConnectionId, 'member-1')).toBe(true)
      expect(await port.admin({ action: 'list' }, context('member-1'))).toContain('成员 member-1')
      runtime.administrators.remove(runtime.internalConnectionId, 'member-1')
      expect(runtime.administrators.isAdministrator(runtime.internalConnectionId, 'member-1')).toBe(false)
    } finally {
      await runtime.dispose()
    }
  })
})

describe('community sync', () => {
  it('tells same, ahead, behind and diverged lines apart by lineage and owns lines published from here', async () => {
    const runtime = await createRuntime()
    try {
      const { extensionId, v1, v2 } = await importBoth(runtime)
      await runtime.extensions.install({ extensionId, revisionId: v2.id })
      const communityUrl = 'https://community.example.test'
      let latest: { id: string; revisionId: string; parentRevisionId: string | null; ancestry: string[] } = {
        id: 'rel_01one',
        revisionId: v1.id,
        parentRevisionId: null,
        ancestry: [],
      }
      let attention = -1
      const community: SyncCommunity = {
        communityUrl,
        status: () => Promise.resolve({ account: { handle: 'demo-author' } }),
        mine: () => Promise.resolve([]),
        setAttention: (count: number) => {
          attention = count
        },
        checkUpdates: (items) =>
          Promise.resolve(
            new Map(
              items.map((item) => [
                item.extensionId,
                {
                  found: true,
                  delisted: false,
                  delistedReason: null,
                  releaseWithdrawn: false,
                  latest: CommunityReleaseSchema.parse({
                    ...latest,
                    reviewStatus: 'passed',
                    rating: null,
                    permissions: [],
                    packageSize: 1,
                    requiresSdk: 10,
                    notes: '',
                    createdAt: 1,
                    number: 1,
                  }),
                  addedPermissions: [],
                },
              ]),
            ),
          ),
      }
      const sync = new CommunitySyncService({
        repository: runtime.repository,
        community,
        lineage: runtime.extensionService,
      })
      sync.recordInstall(v1, { releaseId: 'rel_01one', number: 1, publisherHandle: 'demo-author' })
      const status = async () => (await sync.check()).items[0]?.status

      expect(await status()).toBe('local-ahead')
      expect(attention).toBe(0)
      latest = { id: 'rel_01two', revisionId: v2.id, parentRevisionId: v1.id, ancestry: [v1.id] }
      expect(await status()).toBe('same')
      latest = { id: 'rel_01three', revisionId: 'xrv_REMOTETHREE', parentRevisionId: v2.id, ancestry: [v2.id, v1.id] }
      expect(await status()).toBe('remote-ahead')
      expect(attention).toBe(1)
      latest = { id: 'rel_01other', revisionId: 'xrv_REMOTEOTHER', parentRevisionId: v1.id, ancestry: [v1.id] }
      expect(await status()).toBe('diverged')
      sync.dismiss(extensionId, 'rel_01other')
      expect((await sync.check()).items[0]?.dismissed).toBe(true)
      expect(attention).toBe(0)

      expect(runtime.repository.getExtensionCommunityLink(extensionId, communityUrl)?.role).toBe('subscriber')
      sync.recordPublish(v2, { releaseId: 'rel_01mine', number: 4, publisherHandle: 'demo-author' })
      expect(runtime.repository.getExtensionCommunityLink(extensionId, communityUrl)?.role).toBe('owner')
      // A later install of the same line does not take ownership away.
      sync.recordInstall(v2, { releaseId: 'rel_01mine', number: 4, publisherHandle: 'demo-author' })
      expect(runtime.repository.getExtensionCommunityLink(extensionId, communityUrl)?.role).toBe('owner')
    } finally {
      await runtime.dispose()
    }
  })
})
