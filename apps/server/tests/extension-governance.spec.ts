import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { LlmAdapter, ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { materializeImportedRevision } from '@nekro-nxt/extension-format'
import { ExtensionDataDowngradeError } from '@nekro-nxt/extension-runtime'
import {
  CommunityReleaseSchema,
  EpisodeIdSchema,
  type AgentId,
  type ChannelId,
  type ExtensionId,
  type ExtensionLayeredConfig,
} from '@nekro-nxt/contracts'
import { NekroRuntime } from '../src/bootstrap.js'
import { ExtensionCommandPort } from '../src/extension-governance/commands.js'
import { ExtensionGovernanceTools } from '../src/extension-governance/tool-port.js'
import { extensionAgentTools } from '../src/extension-governance/agent-tools.js'
import { CommunitySyncService, type SyncCommunity } from '../src/extension-governance/community-sync.js'
import { ExtensionRequestService, EXTENSION_REQUEST_TTL_MS } from '../src/extension-governance/requests.js'
import { extensionVersions, lineageGraph } from '../src/extension-governance/versions.js'
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

const createRuntime = async (model?: LlmAdapter) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nxt-governance-'))
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

const saveSharedExtension = (runtime: NekroRuntime, creator: AgentId, config?: ExtensionLayeredConfig) =>
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
      permissions: { permissions: [], networkOrigins: [] },
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
              nickname: { type: 'string', meta: { required: true, default: '虚构默认称呼' } },
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
      // With the shared configuration complete, only the agent's own credential is missing: it may enable and is told
      // to have it filled afterwards.
      const listed = tools.list(consumer.agentId)
      expect(listed).toMatchObject({
        extensions: [{ enablement: { decision: 'run', note: expect.stringContaining('填写你的凭据') as unknown } }],
      })
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
        extensions: [{ enablement: { note: expect.stringContaining('填写你的凭据') as unknown } }],
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
