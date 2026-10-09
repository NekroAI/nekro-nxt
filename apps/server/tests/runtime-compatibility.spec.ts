import { extensionVerification } from './fixtures/extension-verification.js'
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmError, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { AgentIdSchema, type ExtensionId } from '@nekro-nxt/contracts'
import { DSH_RUNTIME_FINGERPRINT } from '@nekro-nxt/dsh-compat/release'
import type * as RuntimeRelease from '@nekro-nxt/dsh-compat/release'
import { openMigratedCoreDatabase, SqliteCoreRepository } from '@nekro-nxt/storage-sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NekroRuntime } from '../src/bootstrap.js'
import { configureDshLlmProviders } from '../src/dsh-host-profile.js'
import { RuntimeCompatibilityRegistry } from '../src/runtime-compatibility.js'

// Simulate the next engine release while retaining the same synthetic durable data.
const environment = vi.hoisted(() => ({ fingerprint: '' }))
vi.mock('@nekro-nxt/dsh-compat/release', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeRelease>()
  return {
    ...actual,
    get DSH_RUNTIME_FINGERPRINT() {
      return environment.fingerprint || actual.DSH_RUNTIME_FINGERPRINT
    },
  }
})
const disposers: Array<() => void | Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const dispose of disposers.splice(0).reverse()) await dispose()
  environment.fingerprint = ''
})
const directory = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'nxt-runtime-compatibility-'))
  disposers.push(() => rm(root, { recursive: true, force: true }))
  return root
}
const databaseFixture = async () => {
  const root = await directory()
  const database = await openMigratedCoreDatabase(path.join(root, 'core.sqlite'))
  disposers.push(() => database.close())
  const repository = new SqliteCoreRepository(database)
  return { repository, registry: new RuntimeCompatibilityRegistry(repository) }
}
const runtimeFixture = async (
  configureLlm?: (context: Context) => void | Promise<void>,
  settings = false,
  existingRoot?: string,
) => {
  const root = existingRoot ?? (await directory())
  const runtime = await NekroRuntime.create({
    coreDatabasePath: path.join(root, 'core.sqlite'),
    sessionDatabasePath: path.join(root, 'sessions.sqlite'),
    assetRoot: path.join(root, 'assets'),
    extensionDataRoot: path.join(root, 'extensions'),
    extensionCacheRoot: path.join(root, 'cache'),
    ...(settings
      ? {
          llmSettingsPath: path.join(root, 'dsh', 'settings.yaml'),
          llmCredentialPath: path.join(root, 'dsh', 'credentials.yaml'),
        }
      : {}),
    ...(configureLlm ? { configureLlm } : {}),
  })
  disposers.push(() => runtime.dispose())
  return runtime
}

class CompatibilityModel extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly unavailable = new Set(['legacy-model'])
  override providerInfo(provider: string) {
    return { id: provider, name: 'Synthetic compatibility provider' }
  }
  override listModels(provider: string) {
    return Promise.resolve(
      ['healthy-model', 'legacy-model'].map((id) => ({ provider, id, name: id, inputModalities: ['text'] as const })),
    )
  }
  override resolveModel(provider: string, model: string) {
    if (this.unavailable.has(model))
      return Promise.reject(new LlmError('Synthetic unsupported model configuration', 'UNKNOWN_MODEL'))
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text'] as const })
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    await Promise.resolve()
    this.requests.push(options)
    const id = ToolCallId(`finish-${this.requests.length}`)
    const argumentsText = JSON.stringify({ outcome: 'no-response-needed', reason: '兼容性测试明确无需频道发言。' })
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id, name: 'finish_channel_turn', argumentsDelta: argumentsText }
    yield {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id, name: 'finish_channel_turn', arguments: argumentsText },
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}
const isolated = {
  status: 'isolated',
  phase: 'load',
  reason: 'synthetic incompatible interface',
  retryable: true,
} as const
const extensionIdentity = {
  objectKind: 'extension',
  objectId: 'ext_SYNTHETIC',
  objectVersion: 'xrv_ONE',
  configurationRevision: '{"option":1}',
} as const

describe('persisted runtime compatibility evidence', () => {
  it('retains isolation across registry instances and replaces it only after a recorded successful check', async () => {
    const { repository, registry } = await databaseFixture()
    const recorded = registry.record(extensionIdentity, isolated)
    expect(new RuntimeCompatibilityRegistry(repository).read(extensionIdentity)).toEqual(recorded)
    expect(registry.list()).toEqual([recorded])
    expect(registry.listCurrent()).toEqual([])
    registry.record(extensionIdentity, { status: 'compatible', phase: 'restore', retryable: true })
    const restored = new RuntimeCompatibilityRegistry(repository).read(extensionIdentity)
    expect(restored).toMatchObject({
      ...extensionIdentity,
      status: 'compatible',
      runtimeFingerprint: DSH_RUNTIME_FINGERPRINT,
    })
    expect(restored).not.toHaveProperty('reason')
    expect(registry.list()).toHaveLength(1)
  })

  it('does not reuse an isolation verdict after object version, configuration or engine identity changes', async () => {
    const { repository, registry } = await databaseFixture()
    const old = registry.record(extensionIdentity, isolated)
    expect(registry.read({ ...extensionIdentity, objectVersion: 'xrv_TWO' })).toBeUndefined()
    expect(registry.read({ ...extensionIdentity, configurationRevision: '{"option":2}' })).toBeUndefined()
    environment.fingerprint = 'synthetic-next-engine'
    const next = new RuntimeCompatibilityRegistry(repository)
    expect(next.read(extensionIdentity)).toBeUndefined()
    next.record(extensionIdentity, { status: 'compatible', phase: 'restore', retryable: true })
    environment.fingerprint = ''
    expect(new RuntimeCompatibilityRegistry(repository).read(extensionIdentity)).toEqual(old)
  })
})

describe('NekroRuntime compatibility recovery', () => {
  it('isolates only the invalid model agent, preserves its exact revision and messages, and resumes after retry', async () => {
    const model = new CompatibilityModel()
    const runtime = await runtimeFixture((context) => {
      context.llm.registerAdapter(['synthetic'], model)
    })
    await runtime.start()
    const healthy = await runtime.createAgentWithInternalChannel({
      displayName: '可用智能体',
      persona: '',
      model: { provider: 'synthetic', model: 'healthy-model' },
    })
    const broken = await runtime.createAgentWithInternalChannel({
      displayName: '等待修复智能体',
      persona: '',
      model: { provider: 'synthetic', model: 'legacy-model' },
    })
    const original = runtime.repository.getAgent(broken.agentId)!
    await runtime.checkAgentCompatibility()
    expect(runtime.host.canRunAgent(healthy.agentId)).toBe(true)
    expect(runtime.host.canRunAgent(broken.agentId)).toBe(false)
    expect(runtime.compatibility.list()).toContainEqual(
      expect.objectContaining({ objectId: broken.agentId, objectVersion: original.revision.id, status: 'isolated' }),
    )
    await runtime.internalChannel.postMessage({
      channelId: broken.channelId,
      clientEventId: 'pending-invalid-model',
      parts: [{ type: 'text', text: '修复后继续处理此请求' }],
    })
    await runtime.internalChannel.postMessage({
      channelId: healthy.channelId,
      clientEventId: 'healthy-model',
      parts: [{ type: 'text', text: '正常处理' }],
    })
    const healthyEpisode = runtime.repository.getActiveEpisode(healthy.channelId, healthy.agentId)
    expect(healthyEpisode?.dshSessionId).toBeDefined()
    await runtime.host.whenIdle(healthyEpisode!.dshSessionId!)
    expect(model.requests.map(({ model: id }) => id)).toEqual(['healthy-model'])
    expect(runtime.repository.listChannelHistory(broken.channelId)).toEqual([
      expect.objectContaining({ source: 'channel-event', parts: [{ type: 'text', text: '修复后继续处理此请求' }] }),
    ])
    expect(runtime.repository.getAgent(broken.agentId)).toEqual(original)
    const failedRetry = await runtime.retryCompatibility({ objectKind: 'agent', objectId: broken.agentId })
    expect(failedRetry.diagnostics).toContainEqual(
      expect.objectContaining({ objectId: broken.agentId, status: 'isolated' }),
    )
    expect(model.requests).toHaveLength(1)
    // This fake provider models a repaired configuration; the following test exercises real Settings writes.
    model.unavailable.delete('legacy-model')
    const retried = await runtime.retryCompatibility({ objectKind: 'agent', objectId: broken.agentId })
    expect(retried.diagnostics).toContainEqual(
      expect.objectContaining({ objectId: broken.agentId, status: 'compatible' }),
    )
    expect(runtime.host.canRunAgent(broken.agentId)).toBe(true)
    const resumed = runtime.repository.getActiveEpisode(broken.channelId, broken.agentId)
    expect(resumed?.dshSessionId).toBeDefined()
    await runtime.host.whenIdle(resumed!.dshSessionId!)
    expect(model.requests.map(({ model: id }) => id)).toEqual(['healthy-model', 'legacy-model'])
    expect(runtime.repository.getAgent(broken.agentId)).toEqual(original)
    expect(
      runtime.repository.listBindings(broken.channelId).find(({ channelId }) => channelId === broken.channelId)
        ?.agentId,
    ).toBe(broken.agentId)
  })

  it('rechecks the same agent model after a real provider-settings repair without changing its Revision', async () => {
    const runtime = await runtimeFixture(configureDshLlmProviders([]), true)
    const created = runtime.core.createAgent({
      displayName: '配置修复探针',
      persona: '',
      model: { provider: 'fixture-gateway', model: 'original-model' },
    })
    await runtime.checkAgentCompatibility()
    expect(runtime.host.canRunAgent(created.definition.id)).toBe(false)
    const settings = await runtime.host.getLlmProviderSettings()
    await runtime.host.saveLlmProvider({
      provider: 'fixture-gateway',
      expectedRevision: settings.providers[0]!.settingsRevision,
      displayName: '合成配置网关',
      baseURL: 'https://synthetic.example.test/v1',
      api: 'openai-completions',
      apiKey: 'synthetic-credential',
      models: [{ id: 'original-model', name: '原模型', contextWindow: 32000, maxTokens: 4000 }],
    })
    expect(runtime.host.canRunAgent(created.definition.id)).toBe(false)
    const result = await runtime.retryCompatibility({ objectKind: 'agent', objectId: created.definition.id })
    expect(runtime.host.canRunAgent(created.definition.id)).toBe(true)
    expect(runtime.repository.getAgent(created.definition.id)).toEqual(created)
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        objectId: created.definition.id,
        status: 'compatible',
        objectVersion: created.revision.id,
      }),
    )
    expect(JSON.stringify(result)).not.toContain('synthetic-credential')
    await expect(
      runtime.retryCompatibility({ objectKind: 'agent', objectId: AgentIdSchema.parse('agt_MISSING') }),
    ).rejects.toThrow('智能体不存在')
  })

  it('isolates an unregistered provider without switching the agent to an available provider', async () => {
    const runtime = await runtimeFixture((context) => {
      context.llm.registerAdapter(['synthetic'], new CompatibilityModel())
    })
    const unknown = runtime.core.createAgent({
      displayName: '未知供应商探针',
      persona: '',
      model: { provider: 'missing-provider', model: 'healthy-model' },
    })
    const healthy = runtime.core.createAgent({
      displayName: '已注册供应商探针',
      persona: '',
      model: { provider: 'synthetic', model: 'healthy-model' },
    })
    await runtime.checkAgentCompatibility()
    expect(runtime.host.canRunAgent(unknown.definition.id)).toBe(false)
    expect(runtime.host.canRunAgent(healthy.definition.id)).toBe(true)
    expect(runtime.compatibility.list()).toContainEqual(
      expect.objectContaining({ objectId: unknown.definition.id, status: 'isolated' }),
    )
    expect(runtime.repository.getAgent(unknown.definition.id)).toEqual(unknown)
  })

  it.each([
    ['TRANSPORT', undefined],
    ['AUTH', 401],
    ['RATE_LIMIT', 429],
    ['SERVER', 503],
  ] as const)(
    'does not persist engine incompatibility for a temporary %s model lookup failure',
    async (code, status) => {
      const model = new CompatibilityModel()
      const runtime = await runtimeFixture((context) => {
        context.llm.registerAdapter(['synthetic'], model)
      })
      const created = runtime.core.createAgent({
        displayName: '临时故障探针',
        persona: '',
        model: { provider: 'synthetic', model: 'healthy-model' },
      })
      await runtime.checkAgentCompatibility()
      expect(runtime.host.canRunAgent(created.definition.id)).toBe(true)
      const error = new LlmError(`synthetic ${code}`, code, status === undefined ? {} : { status })
      const resolution = vi.spyOn(model, 'resolveModel').mockRejectedValueOnce(error)
      await expect(runtime.checkAgentCompatibility()).resolves.toBeUndefined()
      expect(resolution).toHaveBeenCalledWith('synthetic', 'healthy-model', undefined)
      expect(runtime.host.canRunAgent(created.definition.id)).toBe(true)
      const identity = {
        objectKind: 'agent' as const,
        objectId: created.definition.id,
        objectVersion: created.revision.id,
        configurationRevision: JSON.stringify(created.revision.model),
      }
      expect(new RuntimeCompatibilityRegistry(runtime.repository).read(identity)?.status).not.toBe('isolated')
      expect(runtime.repository.getAgent(created.definition.id)).toEqual(created)
      await runtime.checkAgentCompatibility()
      expect(runtime.host.canRunAgent(created.definition.id)).toBe(true)
    },
  )

  it('clears attachment isolation after manual activation and restores the instance before attachments on restart', async () => {
    const root = await directory()
    const runtime = await runtimeFixture(undefined, false, root)
    const agent = runtime.core.createAgent({
      displayName: '手动启用修复探针',
      persona: '',
      model: { provider: 'synthetic', model: 'healthy-model' },
    })
    const saved = await runtime.extensionService.saveDynamicPackage({
      slug: 'manual-reactivation',
      displayName: '手动修复扩展',
      description: '',
      snapshot: {
        name: '手动修复扩展',
        purpose: '验证本机实例与智能体挂载分别恢复',
        hostCode: "harness.handle('probe', () => 'recovered'); return { apply() {} }",
        contributions: [
          { kind: 'rpc', method: 'probe' },
          { kind: 'panel', id: 'probe', anchor: 'agent', title: '探针', densities: ['full'] },
        ],
        clientCode:
          "return { apply(ctx) { ctx.panels.register({ id: 'probe', anchor: 'agent', title: '探针', densities: ['full'] }, () => React.createElement('section', null, 'probe')) } }",
        config: {
          agent: { schema: { type: 'object', dict: { option: { type: 'string', meta: { description: '选项' } } } } },
        },
      },
      verification: { ...extensionVerification([], ['probe']), renderedPanels: ['probe'] },
    })
    const config = { option: 'unchanged' }
    await runtime.extensions.install({ extensionId: saved.extension.id, revisionId: saved.revision.id })
    runtime.repository.upsertActivation({
      agentId: agent.definition.id,
      extensionId: saved.extension.id,
      extensionRevisionId: saved.revision.id,
      config,
      activatedAt: 1,
    })
    const identity = {
      objectKind: 'extension' as const,
      objectId: saved.extension.id,
      objectVersion: saved.revision.id,
      configurationRevision: JSON.stringify([agent.definition.id, config]),
    }
    runtime.compatibility.record(identity, {
      status: 'isolated',
      phase: 'restore',
      retryable: true,
      reason: 'synthetic attachment failure',
    })
    expect(await runtime.extensions.restoreAttachments()).toEqual({ restored: 0, failed: 1 })
    const committed = await runtime.extensions.activate({
      agentId: agent.definition.id,
      extensionId: saved.extension.id,
      revisionId: saved.revision.id,
      config,
    })
    expect(runtime.repository.getActivation(agent.definition.id, saved.extension.id)).toEqual(committed)
    expect(runtime.compatibility.read(identity)).toMatchObject({ status: 'compatible' })
    expect(runtime.compatibility.read(identity)).not.toHaveProperty('reason')
    await expect(runtime.extensions.call(saved.extension.id, 'probe', null, { surface: 'verification' })).resolves.toBe(
      'recovered',
    )
    await runtime.dispose()
    const restarted = await runtimeFixture(undefined, false, root)
    expect(await restarted.extensions.restoreInstances()).toEqual({ restored: 1, failed: 0 })
    expect(await restarted.extensions.restoreAttachments()).toEqual({ restored: 1, failed: 0 })
    expect(restarted.repository.getActivation(agent.definition.id, saved.extension.id)).toEqual(committed)
    await expect(
      restarted.extensions.call(saved.extension.id, 'probe', null, { surface: 'verification' }),
    ).resolves.toBe('recovered')
  })

  it('keeps failed installations and attachments, skips unchanged failures and rechecks runtime and revision', async () => {
    const runtime = await runtimeFixture()
    const agent = runtime.core.createAgent({
      displayName: '扩展恢复探针',
      persona: '',
      model: { provider: 'synthetic', model: 'healthy-model' },
    })
    const save = (slug: string, extensionId?: ExtensionId) =>
      runtime.extensionService.saveDynamicPackage({
        slug,
        displayName: slug,
        description: '',
        snapshot: {
          name: slug,
          purpose: '合成兼容性回归',
          hostCode: `harness.handle('probe', () => '${extensionId ? 'fixed' : 'good'}'); return { apply() {} }`,
          contributions: [{ kind: 'rpc', method: 'probe' }],
          permissions: { permissions: [], networkOrigins: [], agent: { history: { read: true } } },
          config: {
            host: {
              schema: {
                type: 'object',
                dict: { option: { type: 'natural', meta: { description: '选项', default: 1 } } },
              },
            },
          },
        },
        verification: extensionVerification([], ['probe']),
        ...(extensionId ? { extensionId } : {}),
      })
    const good = await save('good-probe')
    const bad = await save('bad-probe')
    for (const saved of [good, bad]) {
      runtime.repository.upsertHostInstallation({
        extensionId: saved.extension.id,
        extensionRevisionId: saved.revision.id,
        config: { option: 1 },
        installedAt: 1,
      })
      runtime.repository.upsertActivation({
        agentId: agent.definition.id,
        extensionId: saved.extension.id,
        extensionRevisionId: saved.revision.id,
        config: {},
        activatedAt: 1,
      })
    }
    const originalLoad = runtime.host.loadExtension.bind(runtime.host)
    const load = vi.spyOn(runtime.host, 'loadExtension').mockImplementation((input) => {
      if (input.revision.id === bad.revision.id) return Promise.reject(new Error('synthetic runtime ABI mismatch'))
      return originalLoad(input)
    })
    expect(await runtime.extensions.restoreInstances()).toEqual({ restored: 1, failed: 1 })
    expect(load).toHaveBeenCalledTimes(2)
    expect(await runtime.extensions.restoreInstances()).toEqual({ restored: 0, failed: 1 })
    expect(load).toHaveBeenCalledTimes(2)
    const attachment = runtime.repository.getActivation(agent.definition.id, bad.extension.id)
    const failed = await runtime.retryCompatibility({ objectKind: 'extension', objectId: bad.extension.id })
    expect(failed.diagnostics).toContainEqual(
      expect.objectContaining({
        objectId: bad.extension.id,
        status: 'isolated',
        reason: 'synthetic runtime ABI mismatch',
      }),
    )
    expect(load).toHaveBeenCalledTimes(3)
    expect(runtime.repository.getActivation(agent.definition.id, bad.extension.id)).toEqual(attachment)
    environment.fingerprint = 'synthetic-runtime-upgrade'
    expect(await runtime.extensions.restoreInstances()).toEqual({ restored: 0, failed: 1 })
    expect(load).toHaveBeenCalledTimes(4)
    const fixed = await save('bad-probe', bad.extension.id)
    const requirement = runtime.extensions.agentRequirement(agent.definition.id, fixed.extension.id, fixed.revision.id)
    await runtime.extensions.install({
      extensionId: fixed.extension.id,
      revisionId: fixed.revision.id,
      agentPermissionApproval: { permissionDigest: requirement.permissionDigest },
    })
    expect(runtime.repository.getActivation(agent.definition.id, fixed.extension.id)?.extensionRevisionId).toBe(
      fixed.revision.id,
    )
    await expect(runtime.extensions.call(fixed.extension.id, 'probe', null, { surface: 'verification' })).resolves.toBe(
      'fixed',
    )
    const success = await runtime.retryCompatibility({ objectKind: 'extension', objectId: fixed.extension.id })
    expect(success.diagnostics).toContainEqual(
      expect.objectContaining({
        objectId: fixed.extension.id,
        objectVersion: fixed.revision.id,
        status: 'compatible',
        runtimeFingerprint: 'synthetic-runtime-upgrade',
      }),
    )
    expect(runtime.repository.getExtensionRevision(bad.revision.id)).toEqual(bad.revision)
    await expect(runtime.extensions.call(good.extension.id, 'probe', null, { surface: 'verification' })).resolves.toBe(
      'good',
    )
  })
  it('rechecks an isolated host instance when its persisted host config changes', async () => {
    const runtime = await runtimeFixture()
    const saved = await runtime.extensionService.saveDynamicPackage({
      slug: 'config-retry',
      displayName: '配置重试探针',
      description: '',
      snapshot: {
        name: '配置重试探针',
        purpose: '配置变化使旧兼容性判断失效',
        hostCode: "harness.handle('probe', () => 'ok'); return { apply() {} }",
        contributions: [{ kind: 'rpc', method: 'probe' }],
        config: {
          host: {
            schema: {
              type: 'object',
              dict: { option: { type: 'natural', meta: { description: '选项', default: 1 } } },
            },
          },
        },
      },
      verification: extensionVerification([], ['probe']),
    })
    const installation = {
      extensionId: saved.extension.id,
      extensionRevisionId: saved.revision.id,
      config: { option: 1 },
      installedAt: 1,
    }
    runtime.repository.upsertHostInstallation(installation)
    const originalLoad = runtime.host.loadExtension.bind(runtime.host)
    const load = vi.spyOn(runtime.host, 'loadExtension').mockRejectedValueOnce(new Error('synthetic config failure'))
    expect(await runtime.extensions.restoreInstances()).toEqual({ restored: 0, failed: 1 })
    expect(await runtime.extensions.restoreInstances()).toEqual({ restored: 0, failed: 1 })
    expect(load).toHaveBeenCalledTimes(1)
    load.mockImplementation(originalLoad)
    runtime.repository.upsertHostInstallation({ ...installation, config: { option: 2 } })
    expect(await runtime.extensions.restoreInstances()).toEqual({ restored: 1, failed: 0 })
    expect(load).toHaveBeenCalledTimes(2)
  })
})
