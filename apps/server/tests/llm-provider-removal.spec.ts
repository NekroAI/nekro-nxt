import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { EpisodeHandoffIdSchema, EpisodeIdSchema, HostApiContracts } from '@nekro-nxt/contracts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HostModelSettings } from '../src/host-model-settings.js'
import type { AgentRevisionContent, AgentRevisionRecord } from '@nekro-nxt/core'
import { NekroRuntime } from '../src/bootstrap.js'
import { createNekroHostApi } from '../src/host-api.js'
import { configureDshLlmProviders } from '../src/main.js'

const revisionContent = (revision: AgentRevisionRecord): AgentRevisionContent => ({
  displayName: revision.displayName,
  persona: revision.persona,
  personaDocument: revision.personaDocument,
  model: revision.model,
  capabilities: revision.capabilities,
  imagePolicy: revision.imagePolicy,
  dynamicClientApprovalPolicy: revision.dynamicClientApprovalPolicy,
})

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

describe('LLM provider removal', () => {
  let directory: string
  let runtime: NekroRuntime
  let context: Context
  let api: ReturnType<typeof createNekroHostApi>
  let origin: string
  let settingsService: Context['settings']
  let startupRoutes: string[] = []
  const options = () => ({
    coreDatabasePath: path.join(directory, 'core.sqlite'),
    sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
    assetRoot: path.join(directory, 'assets'),
    extensionDataRoot: path.join(directory, 'extension-data'),
    extensionCacheRoot: path.join(directory, 'extension-cache'),
    llmSettingsPath: path.join(directory, 'dsh/settings.yaml'),
    llmCredentialPath: path.join(directory, 'dsh/credentials.yaml'),
    configureLlm: async (ctx: Context) => {
      settingsService = ctx.settings
      await configureDshLlmProviders(startupRoutes)(ctx)
    },
  })
  beforeEach(async () => {
    startupRoutes = []
    directory = await mkdtemp(path.join(tmpdir(), 'nxt-provider-removal-'))
    runtime = await NekroRuntime.create(options())
    context = new Context()
    await context.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    api = createNekroHostApi(context.webServer, runtime)
    origin = `http://127.0.0.1:${api.port}`
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    api?.dispose()
    await context?.fiber.dispose()
    await runtime?.dispose()
    await rm(directory, { recursive: true, force: true })
  })
  const save = async (provider: string, custom = false) => {
    const settings = await runtime.host.getLlmProviderSettings()
    const revision = settings.providers.find((entry) => entry.settingsNs === 'llm-pi-ai')!.settingsRevision
    return runtime.host.saveLlmProvider({
      provider,
      expectedRevision: revision,
      apiKey: 'synthetic-kept-key',
      ...(custom
        ? {
            displayName: '测试网关',
            baseURL: 'https://gateway.example.test/v1',
            api: 'openai-completions',
            models: [{ id: 'synthetic-model' }],
          }
        : {}),
    })
  }
  const preview = async (provider: string) => {
    const response = await fetch(`${origin}/api/llm/providers/${provider}/removal-impact`)
    expect(response.status, await response.clone().text()).toBe(200)
    return HostApiContracts.llmProviderRemovalImpact.parseResponse(await response.json())
  }
  const remove = (provider: string, expectedRevision: number) =>
    fetch(`${origin}/api/llm/providers/${provider}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision }),
    })

  it('removes a custom route durably while retaining credentials and other providers', async () => {
    await save('synthetic-gateway', true)
    await save('deepseek')
    const before = await preview('synthetic-gateway')
    expect(before).toMatchObject({ declared: true, references: [], blockedReason: '' })
    const credentialsBefore = await runtime.host.describeDshCredentials([
      'SYNTHETIC_GATEWAY_API_KEY',
      'DEEPSEEK_API_KEY',
    ])
    expect(credentialsBefore['SYNTHETIC_GATEWAY_API_KEY']?.configured).toBe(true)
    expect(credentialsBefore['DEEPSEEK_API_KEY']?.configured).toBe(true)
    const response = await remove(before.provider, before.expectedRevision)
    expect(response.status, await response.clone().text()).toBe(200)
    const after = HostApiContracts.llmRemoveProvider.parseResponse(await response.json())
    expect(after.providers.some((entry) => entry.provider === before.provider)).toBe(false)
    expect(after.providers.find((entry) => entry.provider === 'deepseek')).toMatchObject({
      active: true,
      configured: true,
    })
    expect((await runtime.host.listAvailableLlmModels()).some((model) => model.provider === before.provider)).toBe(
      false,
    )
    expect(await runtime.host.describeDshCredentials(['SYNTHETIC_GATEWAY_API_KEY', 'DEEPSEEK_API_KEY'])).toEqual(
      credentialsBefore,
    )
    api.dispose()
    await context.fiber.dispose()
    await runtime.dispose()
    runtime = await NekroRuntime.create(options())
    expect(
      (await runtime.host.getLlmProviderSettings()).providers.some((entry) => entry.provider === before.provider),
    ).toBe(false)
    expect(await runtime.host.describeDshCredentials(['SYNTHETIC_GATEWAY_API_KEY', 'DEEPSEEK_API_KEY'])).toEqual(
      credentialsBefore,
    )
  })

  it('keeps built-in catalog entries, rejects stale confirmations and fixed adapters', async () => {
    await save('deepseek')
    const before = await preview('deepseek')
    await runtime.host.saveLlmProvider({
      provider: 'deepseek',
      expectedRevision: before.expectedRevision,
      baseURL: 'https://changed.example.test/v1',
    })
    expect((await remove('deepseek', before.expectedRevision)).status).toBe(409)
    const latest = await preview('deepseek')
    const response = await remove('deepseek', latest.expectedRevision)
    expect(response.status, await response.clone().text()).toBe(200)
    const after = HostApiContracts.llmRemoveProvider.parseResponse(await response.json())
    expect(after.providers.find((entry) => entry.provider === 'deepseek')).toMatchObject({
      configured: false,
      active: false,
      declared: false,
    })
    const fixed = await preview('deepseek-official')
    expect(fixed.blockedReason).toContain('固定装载')
    expect((await remove(fixed.provider, fixed.expectedRevision)).status).toBe(409)
  })

  it('rechecks new primary and auxiliary references after the preview', async () => {
    await save('deepseek')
    const before = await preview('deepseek')
    runtime.core.createAgent({
      displayName: '主模型引用',
      persona: '',
      model: { provider: 'deepseek', model: 'synthetic-primary' },
    })
    runtime.core.createAgent({
      displayName: '视觉引用',
      persona: '',
      model: { provider: 'elsewhere', model: 'text' },
      imagePolicy: {
        history: {
          mode: 'persistent-distinct',
          detail: 'high',
          restoreAfterCompaction: { recentMessages: 12, maxImages: 4 },
        },
        textModel: { mode: 'auxiliary', model: { provider: 'deepseek', model: 'synthetic-vision' }, maxTokens: 4096 },
      },
    })
    expect((await remove('deepseek', before.expectedRevision)).status).toBe(409)
    await expect(runtime.host.removeLlmProvider('deepseek', before.expectedRevision)).rejects.toThrow('仍有智能体')
    const impact = await preview('deepseek')
    expect(impact.references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ displayName: '主模型引用', role: 'primary', scope: 'configuration' }),
        expect.objectContaining({ displayName: '视觉引用', role: 'vision', scope: 'configuration' }),
      ]),
    )
    expect(
      (await runtime.host.getLlmProviderSettings()).providers.find((entry) => entry.provider === 'deepseek')?.active,
    ).toBe(true)
  })

  it('blocks an old pinned context even after the current agent switches provider', async () => {
    await save('deepseek')
    const seeded = runtime.core.createAgentWithChannel(
      { displayName: '旧上下文引用', persona: '', model: { provider: 'deepseek', model: 'synthetic-model' } },
      {
        connectionId: runtime.internalConnectionId,
        kind: 'internal',
        triggerPolicy: 'always',
      },
    )
    const opened = runtime.core.appendInbound({
      connectionId: runtime.internalConnectionId,
      channelId: seeded.channel.id,
      adapterKey: runtime.core.listConnections().find((connection) => connection.id === runtime.internalConnectionId)!
        .adapterKey,
      kind: 'control',
      parts: [],
      platformTimestamp: 400,
      receivedAt: 400,
      dedupeKey: 'synthetic-open',
    }).event
    runtime.repository.createEpisode({
      id: EpisodeIdSchema.parse('eps_REMOVALTEST'),
      channelId: seeded.channel.id,
      agentId: seeded.definition.id,
      agentRevisionId: seeded.revision.id,
      status: 'opening',
      openedAtEventId: opened.id,
      createdAt: 401,
    })
    runtime.core.reviseAgent(seeded.definition.id, seeded.revision.id, {
      displayName: '旧上下文引用',
      persona: '',
      model: { provider: 'elsewhere', model: 'text' },
    })
    const impact = await preview('deepseek')
    expect(impact.references).toHaveLength(1)
    expect(impact.references[0]).toMatchObject({
      scope: 'context',
      episodeStatus: 'opening',
      channelId: seeded.channel.id,
    })
    expect((await remove('deepseek', impact.expectedRevision)).status).toBe(409)
  })

  it('rejects fixed removal without poisoning subsequent primary or auxiliary reference commits', async () => {
    const fixed = await preview('deepseek-official')
    expect((await remove(fixed.provider, fixed.expectedRevision)).status).toBe(409)
    await expect(runtime.host.removeLlmProvider(fixed.provider, fixed.expectedRevision)).rejects.toThrow('固定装载')
    const created = runtime.core.createAgent({
      displayName: '固定接入仍可引用',
      persona: '',
      model: { provider: fixed.provider, model: 'synthetic-model' },
    })
    expect(() =>
      runtime.core.reviseAgent(created.definition.id, created.revision.id, {
        ...revisionContent(created.revision),
        displayName: '固定接入仍可修订',
        imagePolicy: {
          ...created.revision.imagePolicy,
          textModel: {
            mode: 'auxiliary',
            model: { provider: fixed.provider, model: 'synthetic-vision' },
            maxTokens: 4096,
          },
        },
      }),
    ).not.toThrow()
  })

  it('rejects startup base providers through preview and the direct host removal entry', async () => {
    api.dispose()
    await context.fiber.dispose()
    await runtime.dispose()
    startupRoutes = ['deepseek']
    runtime = await NekroRuntime.create(options())
    await save('deepseek')
    const before = await runtime.host.getLlmProviderRemovalImpact('deepseek')
    expect(before.blockedReason).toContain('启动配置')
    const settings = await runtime.host.getLlmProviderSettings()
    await expect(runtime.host.removeLlmProvider('deepseek', before.expectedRevision)).rejects.toThrow('启动配置')
    expect(await runtime.host.getLlmProviderSettings()).toEqual(settings)
    expect(() =>
      runtime.core.createAgent({
        displayName: '基础接入仍可引用',
        persona: '',
        model: { provider: 'deepseek', model: 'synthetic-model' },
      }),
    ).not.toThrow()
  })

  it('guards every repository reference commit while deletion awaits settings and after commit', async () => {
    await save('deepseek')
    const old = runtime.core.createAgentWithChannel(
      { displayName: '并发引用', persona: '', model: { provider: 'deepseek', model: 'synthetic-model' } },
      { connectionId: runtime.internalConnectionId, kind: 'internal', triggerPolicy: 'always' },
    )
    const current = runtime.core.reviseAgent(old.definition.id, old.revision.id, {
      ...revisionContent(old.revision),
      model: { provider: 'elsewhere', model: 'text' },
    })
    const opened = runtime.core.appendInbound({
      connectionId: runtime.internalConnectionId,
      channelId: old.channel.id,
      adapterKey: runtime.core.listConnections().find((connection) => connection.id === runtime.internalConnectionId)!
        .adapterKey,
      kind: 'control',
      parts: [],
      platformTimestamp: 400,
      receivedAt: 400,
      dedupeKey: 'synthetic-gate-open',
    }).event
    const currentEpisode = {
      id: EpisodeIdSchema.parse('eps_REMOVALCURRENT'),
      channelId: old.channel.id,
      agentId: old.definition.id,
      agentRevisionId: current.revision.id,
      status: 'opening' as const,
      openedAtEventId: opened.id,
      createdAt: 401,
    }
    runtime.repository.createEpisode(currentEpisode)
    runtime.repository.activateEpisode(currentEpisode.id, 'synthetic-current-session')
    const before = await preview('deepseek')
    const started = deferred()
    const release = deferred()
    const original = settingsService.mutate.bind(settingsService)
    vi.spyOn(settingsService, 'mutate').mockImplementationOnce(async (...args) => {
      started.resolve()
      await release.promise
      return original(...args)
    })
    const removal = runtime.host.removeLlmProvider('deepseek', before.expectedRevision)
    const episode = {
      id: EpisodeIdSchema.parse('eps_REMOVALGATE'),
      channelId: old.channel.id,
      agentId: old.definition.id,
      agentRevisionId: old.revision.id,
      status: 'opening' as const,
      openedAtEventId: opened.id,
      createdAt: 401,
    }
    const checkReferences = () => {
      const attempts = [
        () => runtime.core.createAgent(revisionContent(old.revision)),
        () =>
          runtime.core.createAgentWithChannel(revisionContent(old.revision), {
            connectionId: runtime.internalConnectionId,
            kind: 'internal',
            triggerPolicy: 'always',
          }),
        () => runtime.core.reviseAgent(old.definition.id, current.revision.id, revisionContent(old.revision)),
        () => runtime.repository.appendAgentRevision(old.definition, old.revision, current.revision.id),
        () => runtime.repository.activateAgentRevision(old.definition, old.revision, current.revision.id),
        () => runtime.repository.createEpisode(episode),
        () => runtime.repository.updateEpisodeRevision(currentEpisode.id, current.revision.id, old.revision.id),
        () =>
          runtime.repository.commitEpisodeRollover({
            fromEpisodeId: currentEpisode.id,
            nextEpisode: episode,
            reason: 'manual',
            closedAtEventId: episode.openedAtEventId,
            closedAt: 402,
            handoff: {
              id: EpisodeHandoffIdSchema.parse('hof_REMOVAL'),
              fromEpisodeId: currentEpisode.id,
              toEpisodeId: episode.id,
              sourceEventIds: [],
              recentEventIds: [],
              summary: '合成上下文',
              provider: 'elsewhere',
              model: 'text',
              createdAt: 402,
            },
          }),
        () =>
          runtime.core.createAgent({
            ...revisionContent(current.revision),
            imagePolicy: {
              ...current.revision.imagePolicy,
              textModel: { mode: 'auxiliary', model: old.revision.model, maxTokens: 4096 },
            },
          }),
      ]
      for (const attempt of attempts) expect(attempt).toThrow('正在移除或已移除')
    }
    try {
      await started.promise
      checkReferences()
      await expect(runtime.host.removeLlmProvider('deepseek', before.expectedRevision)).rejects.toThrow('正在移除')
      expect(() =>
        runtime.core.createAgent({ ...revisionContent(current.revision), displayName: '其他供应商不受阻' }),
      ).not.toThrow()
    } finally {
      release.resolve()
      await removal
    }
    checkReferences()
    await save('deepseek')
    expect(() => runtime.core.createAgent(revisionContent(old.revision))).not.toThrow()
  })

  it('releases the reference gate after a failed settings write and allows a later removal', async () => {
    await save('deepseek')
    const before = await preview('deepseek')
    vi.spyOn(settingsService, 'mutate').mockRejectedValueOnce(new Error('synthetic storage failure'))
    await expect(runtime.host.removeLlmProvider('deepseek', before.expectedRevision)).rejects.toThrow('storage failure')
    expect(
      (await runtime.host.getLlmProviderSettings()).providers.find((entry) => entry.provider === 'deepseek'),
    ).toMatchObject({ active: true, configured: true })
    const created = runtime.core.createAgent({
      displayName: '写入失败后仍可引用',
      persona: '',
      model: { provider: 'deepseek', model: 'synthetic-model' },
    })
    runtime.core.reviseAgent(created.definition.id, created.revision.id, {
      ...revisionContent(created.revision),
      model: { provider: 'elsewhere', model: 'text' },
    })
    await expect(runtime.host.removeLlmProvider('deepseek', before.expectedRevision)).resolves.toBeDefined()
  })

  it('reports a committed deletion with a failed result read as unknown, not rejected', async () => {
    await save('deepseek')
    const before = await preview('deepseek')
    const settingsBeforeRemoval = await runtime.host.getLlmProviderSettings()
    vi.spyOn(HostModelSettings.prototype, 'getLlmProviderSettings')
      .mockResolvedValueOnce(settingsBeforeRemoval)
      .mockRejectedValueOnce(new Error('synthetic result read failure'))
    const response = await remove('deepseek', before.expectedRevision)
    expect(response.status).toBe(503)
    expect(await response.text()).toContain('已提交')
    expect(
      (await runtime.host.getLlmProviderSettings()).providers.find((entry) => entry.provider === 'deepseek'),
    ).toMatchObject({ configured: false })
    expect(() =>
      runtime.core.createAgent({
        displayName: '提交后旧请求',
        persona: '',
        model: { provider: 'deepseek', model: 'synthetic-model' },
      }),
    ).toThrow('已移除')
  })
})
