import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { HostApiContracts } from '@nekro-nxt/contracts'
import { NEKRO_NXT_EXTENSION_AUTHORING_REFERENCE } from '@nekro-nxt/extension-sdk'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NekroRuntime } from '../src/bootstrap.js'
import { createNekroHostApi } from '../src/host-api.js'
import { preflightNekroNxtAuthoringDefinition } from '../src/dynamic-authoring-runtime.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

class QuietModel extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override providerInfo(provider: string) {
    return { id: provider, name: 'quiet model' }
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
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    await Promise.resolve()
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: '内部结束。' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '内部结束。' } }
    yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const toolHost = (name: string, execute: string) => `return {
  inject: ['tools'],
  apply(ctx) {
    harness.registerTool(ctx, harness.defineTool({
      name: '${name}',
      description: 'synthetic authoring probe',
      parameters: {},
      output: { schema: { type: 'string' }, render(_a, v) { return [{ type: 'text', text: v }] } },
      execute() { ${execute} }
    }))
  }
}`

const createRuntime = async (model = new QuietModel()) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-authoring-loop-'))
  temporaryDirectories.push(directory)
  return NekroRuntime.create({
    coreDatabasePath: path.join(directory, 'core.sqlite'),
    sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
    assetRoot: path.join(directory, 'assets'),
    extensionDataRoot: path.join(directory, 'extension-data'),
    extensionCacheRoot: path.join(directory, 'extension-cache'),
    configureLlm: (context) => {
      context.llm.registerAdapter(['test-provider'], model)
    },
  })
}

const startAuthoringSession = async (model = new QuietModel()) => {
  const runtime = await createRuntime(model)
  await runtime.start()
  const entity = await runtime.createAgentWithInternalChannel({
    displayName: '创造智能体',
    persona: '',
    model: { provider: 'test-provider', model: 'chat-model' },
    capabilities: { dynamicCreation: true },
  })
  await runtime.internalChannel.postMessage({
    channelId: entity.channelId,
    clientEventId: 'seed-session',
    parts: [{ type: 'text', text: '建立活动会话。' }],
  })
  const episode = runtime.repository
    .listActiveEpisodesForAgent(entity.agentId)
    .find((candidate) => candidate.dshSessionId !== undefined)!
  return { runtime, entity, dshSessionId: episode.dshSessionId! }
}

describe('dynamic authoring closed loop', () => {
  it('accepts Client CSS beside an agent-scope Client and rejects it without one', () => {
    const css = '.panel { color: var(--nxt-text); }'
    const candidate = (code: { readonly client?: string }) =>
      preflightNekroNxtAuthoringDefinition({
        plugin: { kind: 'new', idPrefix: 'css' },
        name: '带样式的面板',
        purpose: 'V6 面板通过自带 CSS 设定样式。',
        scope: 'agent',
        code,
        resources: { 'assets/panel.module.css': css },
        clientCss: { path: 'assets/panel.module.css', sha256: createHash('sha256').update(css).digest('hex') },
        permissions: { permissions: [], networkOrigins: [] },
        contributions: [],
      })
    expect(() => candidate({ client: 'return { apply() {} }' })).not.toThrow()
    expect(() => candidate({})).toThrow('必须配套 Client 源码')
  })

  it('stops a run that fails verification and records the failure on its attempt', async () => {
    const { runtime, entity, dshSessionId } = await startAuthoringSession()
    try {
      const defined = runtime.host.defineDynamicPackage(dshSessionId, {
        plugin: { kind: 'new', idPrefix: 'fail' },
        name: '验证失败探针',
        purpose: '工具在验证调用时抛错。',
        code: { host: toolHost('failing_probe', "throw new Error('synthetic tool failure')") },
      })
      await expect(
        runtime.host.runDynamicPackage(dshSessionId, defined.pluginId, defined.packageId, 'run'),
      ).rejects.toThrow('synthetic tool failure')

      expect(runtime.host.dynamicToolNames(dshSessionId)).not.toContain('failing_probe')
      const task = runtime.repository.listAuthoringTasks(entity.agentId)[0]!
      expect(task.status).toBe('failed')
      expect(runtime.repository.listAuthoringAttempts(task.id).at(-1)).toMatchObject({
        state: 'failed',
        error: { phase: 'verification', repairable: true },
      })
      expect(runtime.host.dynamicAuthoringPolicy(dshSessionId)).toMatchObject({ consecutiveFailures: 1 })
    } finally {
      await runtime.dispose()
    }
  })

  it('returns the Runner usage diagnostic without verifying a stale run or spending the repair budget', async () => {
    const { runtime, dshSessionId } = await startAuthoringSession()
    try {
      const first = runtime.host.defineDynamicPackage(dshSessionId, {
        plugin: { kind: 'new', idPrefix: 'mode' },
        name: '模式探针',
        purpose: '第一个版本。',
        code: { host: toolHost('mode_probe', "return 'v1'") },
      })
      await expect(
        runtime.host.runDynamicPackage(dshSessionId, first.pluginId, first.packageId, 'run'),
      ).resolves.toMatchObject({ ok: true, status: 'running' })
      const second = runtime.host.defineDynamicPackage(dshSessionId, {
        plugin: { kind: 'existing', pluginId: first.pluginId },
        name: '模式探针 v2',
        purpose: '第二个版本。',
        code: { host: toolHost('mode_probe', "return 'v2'") },
      })
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const rejected = await runtime.host.runDynamicPackage(dshSessionId, first.pluginId, second.packageId, 'run')
        expect(rejected).toMatchObject({ ok: false, reason: 'invalid-mode' })
        expect(rejected.ok ? '' : rejected.message).toContain('use mode "update"')
      }
      const policy = runtime.host.dynamicAuthoringPolicy(dshSessionId)
      expect(policy.consecutiveFailures).toBe(0)
      expect(policy.blockedReason).toBeUndefined()
      await expect(
        runtime.host.runDynamicPackage(dshSessionId, first.pluginId, second.packageId, 'update'),
      ).resolves.toMatchObject({ ok: true, status: 'running', packageId: second.packageId })
    } finally {
      await runtime.dispose()
    }
  })

  it('keeps the breaker closed across undefine until a new ordinary user turn', async () => {
    const { runtime, dshSessionId } = await startAuthoringSession()
    try {
      const failing = toolHost('breaker_probe', "throw new Error('same synthetic failure')")
      const first = runtime.host.defineDynamicPackage(dshSessionId, {
        plugin: { kind: 'new', idPrefix: 'brk' },
        name: '熔断探针',
        purpose: '重复失败。',
        code: { host: failing },
      })
      await expect(
        runtime.host.runDynamicPackage(dshSessionId, first.pluginId, first.packageId, 'run'),
      ).rejects.toThrow()
      const second = runtime.host.defineDynamicPackage(dshSessionId, {
        plugin: { kind: 'existing', pluginId: first.pluginId },
        name: '熔断探针 v2',
        purpose: '再次相同失败。',
        code: { host: failing },
      })
      await expect(
        runtime.host.runDynamicPackage(dshSessionId, first.pluginId, second.packageId, 'update'),
      ).rejects.toThrow()
      expect(runtime.host.dynamicAuthoringPolicy(dshSessionId).blockedReason).toContain('相同动态扩展错误')

      await expect(runtime.host.undefineDynamicPlugin(dshSessionId, first.pluginId)).resolves.toMatchObject({
        ok: true,
      })
      expect(runtime.host.dynamicAuthoringPolicy(dshSessionId).blockedReason).toContain('相同动态扩展错误')
      expect(() =>
        runtime.host.defineDynamicPackage(dshSessionId, {
          plugin: { kind: 'new', idPrefix: 'esc' },
          name: '绕过熔断',
          purpose: '不应被允许。',
          code: { host: toolHost('escape_probe', "return 'ok'") },
        }),
      ).toThrow('动态创造已熔断')
    } finally {
      await runtime.dispose()
    }
  })

  it('verifies a Tool with required arguments through its declared sample across run, save and import', async () => {
    const { runtime, entity, dshSessionId } = await startAuthoringSession()
    const hostTool = NEKRO_NXT_EXTENSION_AUTHORING_REFERENCE.examples.hostTool
    const definition = {
      name: '项目状态',
      purpose: '按项目名返回状态。',
      scope: 'agent' as const,
      code: { host: hostTool },
      resources: {},
      permissions: { permissions: [], networkOrigins: [] },
      contributions: [],
    }
    const webContext = new Context()
    const importContext = new Context()
    const imported = await createRuntime()
    try {
      const withoutSample = runtime.host.defineDynamicAuthoringPackage(dshSessionId, {
        ...definition,
        plugin: { kind: 'new', idPrefix: 'proj' },
      })
      await expect(
        runtime.host.runDynamicPackage(dshSessionId, withoutSample.pluginId, withoutSample.packageId, 'run'),
      ).rejects.toThrow('no verification input was declared')

      const sample = { project: '示例项目' }
      const withSample = runtime.host.defineDynamicAuthoringPackage(dshSessionId, {
        ...definition,
        plugin: { kind: 'existing', pluginId: withoutSample.pluginId },
        verificationInputs: { tools: { project_status: sample }, rpc: {} },
      })
      await expect(
        runtime.host.runDynamicPackage(dshSessionId, withSample.pluginId, withSample.packageId, 'update'),
      ).resolves.toMatchObject({ ok: true, status: 'running' })
      const task = runtime.repository.listAuthoringTasks(entity.agentId)[0]!
      const attempt = runtime.repository.listAuthoringAttempts(task.id).at(-1)!
      expect(runtime.repository.getAuthoringTask(task.id)?.status).toBe('ready')
      expect(attempt.verification?.toolInvocations).toEqual([{ name: 'project_status', succeeded: true }])

      const saved = await runtime.authoring.save({
        taskId: task.id,
        attemptId: attempt.id,
        displayName: '项目状态',
        slug: 'project-status',
        description: '带必填参数的工具。',
      })
      await webContext.plugin(WebServer, { host: '127.0.0.1', port: 0 })
      const api = createNekroHostApi(webContext.webServer, runtime)
      const archive = new Uint8Array(
        await (
          await fetch(
            `http://127.0.0.1:${api.port}/api/extensions/${saved.extension.id}/revisions/${saved.revision.id}/export`,
          )
        ).arrayBuffer(),
      )

      await importContext.plugin(WebServer, { host: '127.0.0.1', port: 0 })
      const importApi = createNekroHostApi(importContext.webServer, imported)
      const importOrigin = `http://127.0.0.1:${importApi.port}`
      const inspection = HostApiContracts.inspectExtensionImport.parseResponse(
        await (
          await fetch(`${importOrigin}/api/extensions/imports/inspect`, {
            method: 'POST',
            headers: { 'content-type': 'application/vnd.nekro-nxt.extension+zip' },
            body: Buffer.from(archive),
          })
        ).json(),
      )
      const commit = await fetch(`${importOrigin}/api/extensions/imports/${inspection.token}/commit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      expect(commit.ok, await commit.clone().text()).toBe(true)
      expect(imported.repository.getExtensionRevisionVerification(saved.revision.id)).toMatchObject({
        toolInvocations: [{ name: 'project_status', succeeded: true }],
      })
    } finally {
      await webContext.fiber.dispose()
      await importContext.fiber.dispose()
      await imported.dispose()
      await runtime.dispose()
    }
  })

  it('refuses to save a Revision whose materialized artifact fails at runtime', async () => {
    const runtime = await createRuntime()
    try {
      await expect(
        runtime.extensionService.saveDynamicPackage({
          slug: 'broken-after-save',
          displayName: '保存后失效',
          description: '',
          snapshot: {
            name: '保存后失效',
            purpose: '物化后的产物在运行时抛错。',
            hostCode: "throw new Error('materialized factory failure')",
            contributions: [],
          },
          verification: {
            dshVersion: 'synthetic',
            contractVersion: 'nekro-nxt-extension-v4',
            origin: { episodeId: 'eps_synthetic', pluginId: 'p', packageId: 'pkg', pluginRunId: 'run' },
            toolInvocations: [],
            rpcMethods: [],
            renderedPanels: [],
            renderedToolViews: [],
            renderedMessageRenderers: [],
          },
        }),
      ).rejects.toThrow('materialized factory failure')
      expect(runtime.repository.getExtensionBySlug('broken-after-save')).toBeUndefined()
    } finally {
      await runtime.dispose()
    }
  })

  it('restores an earlier verified candidate after a newer unverified one replaced it, then saves it', async () => {
    const { runtime, entity, dshSessionId } = await startAuthoringSession()
    try {
      const verified = runtime.host.defineDynamicAuthoringPackage(dshSessionId, {
        plugin: { kind: 'new', idPrefix: 'back' },
        name: '可回退工具',
        purpose: '先通过验证。',
        scope: 'agent',
        code: { host: toolHost('restorable_probe', "return 'ok'") },
        resources: {},
        permissions: { permissions: [], networkOrigins: [] },
        contributions: [],
      })
      await expect(
        runtime.host.runDynamicPackage(dshSessionId, verified.pluginId, verified.packageId, 'run'),
      ).resolves.toMatchObject({ ok: true, status: 'running' })
      // The Agent appends a probe it never runs; the verified attempt is no longer the latest candidate.
      runtime.host.defineDynamicPackage(dshSessionId, {
        plugin: { kind: 'existing', pluginId: verified.pluginId },
        name: '探针',
        purpose: '不应成为保存目标。',
        code: { host: 'return { apply() {} }' },
      })
      const task = runtime.repository.listAuthoringTasks(entity.agentId)[0]!
      // The probe's attempt is recorded asynchronously; assert only once it has replaced the candidate.
      await vi.waitFor(() => expect(runtime.repository.listAuthoringAttempts(task.id)).toHaveLength(2))
      const [first] = runtime.repository.listAuthoringAttempts(task.id)
      await expect(
        runtime.authoring.save({
          taskId: task.id,
          attemptId: first!.id,
          displayName: '可回退工具',
          slug: 'restorable-probe',
          description: '',
        }),
      ).rejects.toThrow('只能保存该创造任务当前的精确候选')

      await runtime.authoring.restore({
        taskId: task.id,
        attemptId: first!.id,
        expectedRevision: runtime.repository.getAuthoringTask(task.id)!.revision,
      })
      const restored = runtime.repository.listAuthoringAttempts(task.id).at(-1)!
      expect(restored.ordinal).toBe(3)
      expect(restored.snapshotDigest).toBe(first!.snapshotDigest)
      expect(runtime.repository.getAuthoringTask(task.id)?.status).toBe('ready')
      await expect(
        runtime.authoring.save({
          taskId: task.id,
          attemptId: restored.id,
          displayName: '可回退工具',
          slug: 'restorable-probe',
          description: '',
        }),
      ).resolves.toMatchObject({ revision: { revisionNumber: 1 } })
    } finally {
      await runtime.dispose()
    }
  })

  it('wakes the Agent with the reason when the interface preview calls a failing Host RPC', async () => {
    const model = new QuietModel()
    const { runtime, dshSessionId } = await startAuthoringSession(model)
    try {
      const defined = runtime.host.defineDynamicAuthoringPackage(dshSessionId, {
        plugin: { kind: 'new', idPrefix: 'rpc' },
        name: '失败接口面板',
        purpose: '界面调用会失败的 Host RPC。',
        scope: 'agent',
        code: {
          host: "harness.handle('broken_summary', () => { throw new Error('synthetic rpc failure') }); return { apply() {} }",
          client: `return {
            inject: ['slots'],
            apply(ctx) { ctx.slots.register({ name: 'agent.workbench.sections', id: 'main' }, () => React.createElement('div')) }
          }`,
        },
        resources: {},
        permissions: { permissions: [], networkOrigins: [] },
        contributions: [],
      })
      void runtime.host
        .runDynamicPackage(dshSessionId, defined.pluginId, defined.packageId, 'run')
        .catch(() => undefined)
      await expect
        .poll(
          () =>
            runtime.host.dynamicInventory(dshSessionId).find((row) => row.pluginId === defined.pluginId)?.latestRun
              ?.approvalRequestId,
        )
        .toBeDefined()
      const approval = runtime.host.dynamicInventory(dshSessionId).find((row) => row.pluginId === defined.pluginId)!
        .latestRun!.approvalRequestId!
      const hostHalf = await runtime.host.runDynamicHostHalf(
        dshSessionId,
        defined.pluginId,
        defined.packageId,
        'run',
        approval,
        false,
      )
      if (!hostHalf.ok) throw new Error(hostHalf.message)
      await runtime.host.resolveDynamicRunRequest(dshSessionId, approval, {
        ok: true,
        pluginRunId: hostHalf.pluginRunId,
      })
      await runtime.host.waitUntilSafe(runtime.repository.listAuthoringTasks()[0]!.agentId)
      const requestsBefore = model.requests.length

      const invoked = await runtime.host.invokeDynamicHost(
        dshSessionId,
        defined.pluginId,
        hostHalf.pluginRunId,
        'broken_summary',
      )
      expect(invoked.ok).toBe(false)
      await expect
        .poll(() =>
          model.requests
            .slice(requestsBefore)
            .some((request) =>
              request.messages.some(
                (message) =>
                  message.role === 'user' &&
                  message.content.some(
                    (block) =>
                      block.type === 'text' &&
                      block.text.includes('Host RPC broken_summary 失败') &&
                      block.text.includes('synthetic rpc failure'),
                  ),
              ),
            ),
        )
        .toBe(true)
    } finally {
      await runtime.dispose()
    }
  })
})
