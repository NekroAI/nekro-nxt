import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { HostApiContracts, type ExtensionCapabilities } from '@nekro-nxt/contracts'
import { NEKRO_NXT_EXTENSION_AUTHORING_REFERENCE } from '@nekro-nxt/extension-sdk'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NekroRuntime } from '../src/bootstrap.js'
import { NekroJsonlSessionPersistence } from '../src/dsh-session-persistence.js'
import { projectHistoryEntry } from '../src/host-route-support.js'
import { createNekroHostApi } from '../src/host-api.js'
import { DynamicAuthoringRuntime, preflightNekroNxtAuthoringDefinition } from '../src/dynamic-authoring-runtime.js'

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

const createRuntime = async (model = new QuietModel(), existingDirectory?: string) => {
  const directory = existingDirectory ?? (await mkdtemp(path.join(tmpdir(), 'nekro-nxt-authoring-loop-')))
  if (existingDirectory === undefined) temporaryDirectories.push(directory)
  return NekroRuntime.create({
    coreDatabasePath: path.join(directory, 'core.sqlite'),
    sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
    assetRoot: path.join(directory, 'assets'),
    extensionDataRoot: path.join(directory, 'extension-data'),
    extensionCacheRoot: path.join(directory, 'extension-cache'),
    developmentWorkspaceRoot: path.join(directory, 'workspaces'),
    configureLlm: (context) => {
      context.llm.registerAdapter(['test-provider'], model)
    },
  })
}

const startAuthoringSession = async (model = new QuietModel(), codeRun = false) => {
  const runtime = await createRuntime(model)
  await runtime.start()
  const entity = await runtime.createAgentWithInternalChannel({
    displayName: '创造智能体',
    persona: '',
    model: { provider: 'test-provider', model: 'chat-model' },
    capabilities: { dynamicCreation: true, ...(codeRun ? { codeRun: true, developmentShell: true } : {}) },
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
  it('verifies dynamic tools through the PTC transport and retains tool failure handling', async () => {
    const model = new QuietModel()
    const { runtime, entity, dshSessionId } = await startAuthoringSession(model, true)
    try {
      await runtime.host.whenIdle(dshSessionId)
      expect(model.requests[0]?.tools?.map((tool) => tool.name)).toEqual(['run_code'])
      const defined = runtime.host.defineDynamicPackage(dshSessionId, {
        plugin: { kind: 'new', idPrefix: 'ptcv' },
        name: '编排验证探针',
        purpose: '在编排会话里验证候选工具。',
        code: { host: toolHost('ptc_verification_probe', "return 'verified'") },
      })
      await expect(
        runtime.host.runDynamicPackage(dshSessionId, defined.pluginId, defined.packageId, 'run'),
      ).resolves.toMatchObject({ ok: true, status: 'running' })
      await expect(
        runtime.host.verifyDynamicPackage(dshSessionId, defined.pluginId, defined.packageId),
      ).resolves.toMatchObject({ toolInvocations: [{ name: 'ptc_verification_probe', succeeded: true }] })
      const failing = runtime.host.defineDynamicPackage(dshSessionId, {
        plugin: { kind: 'existing', pluginId: defined.pluginId },
        name: '编排验证失败探针',
        purpose: '验证失败仍记录失败并停止候选。',
        code: { host: toolHost('ptc_verification_probe', "throw new Error('fixture verification failure')") },
      })
      await expect(
        runtime.host.runDynamicPackage(dshSessionId, failing.pluginId, failing.packageId, 'update'),
      ).rejects.toThrow('fixture verification failure')
      expect(runtime.host.dynamicToolNames(dshSessionId)).not.toContain('ptc_verification_probe')
      expect(runtime.repository.listAuthoringTasks(entity.agentId).some((task) => task.status === 'failed')).toBe(true)
    } finally {
      await runtime.dispose()
    }
  }, 60_000)

  it('checks candidate tools in a sub-conversation whose log, like the channel conversation, reads back', async () => {
    const { runtime, dshSessionId } = await startAuthoringSession(new QuietModel(), true)
    const directory = temporaryDirectories.at(-1)!
    let childId: string | undefined
    try {
      await runtime.host.whenIdle(dshSessionId)
      const defined = runtime.host.defineDynamicPackage(dshSessionId, {
        plugin: { kind: 'new', idPrefix: 'subv' },
        name: '子对话验证探针',
        purpose: '候选工具在独立的子对话里验证。',
        code: { host: toolHost('sub_conversation_probe', "return 'verified'") },
      })
      await runtime.host.runDynamicPackage(dshSessionId, defined.pluginId, defined.packageId, 'run')
      const children = await runtime.host.listSubagents(dshSessionId)
      expect(children).toHaveLength(1)
      childId = String(children[0]!.id)
      const [task] = runtime.repository.listAuthoringTasks()
      expect(runtime.repository.getSubConversationBySession(childId)).toMatchObject({
        title: '验证 sub_conversation_probe',
        openedBy: 'host',
        driver: 'script',
        status: 'closed',
        closeReason: 'completed',
        authoringTaskId: task?.id,
      })
    } finally {
      await runtime.dispose()
    }
    const reader = new Context()
    try {
      await reader.plugin(NekroJsonlSessionPersistence, { root: path.join(directory, 'dsh', 'sessions') })
      const read = async (id: string) => {
        const handle = await reader.sessionPersistence.open(SessionId(id), 'read')
        try {
          return (await handle.read()).events.map((event) => event.type)
        } finally {
          await handle.close()
        }
      }
      const root = await read(dshSessionId)
      const child = await read(childId)
      expect(root.filter((type) => type.startsWith('tool/ptc-dispatch'))).toEqual([])
      expect(child).toEqual(
        expect.arrayContaining(['turn/start', 'tool/ptc-dispatch-start', 'tool/ptc-dispatch', 'turn/end']),
      )
    } finally {
      await reader.fiber.dispose()
    }
  }, 60_000)

  it('keeps a verified candidate ready across a restart without calling its tools again', async () => {
    const model = new QuietModel()
    const { runtime, entity, dshSessionId } = await startAuthoringSession(model, true)
    const directory = temporaryDirectories.at(-1)!
    try {
      await runtime.host.whenIdle(dshSessionId)
      const defined = runtime.host.defineDynamicPackage(dshSessionId, {
        plugin: { kind: 'new', idPrefix: 'rstv' },
        name: '重启探针',
        purpose: '验证通过后重启仍可保存。',
        code: { host: toolHost('restart_probe', "return 'verified'") },
      })
      await runtime.host.runDynamicPackage(dshSessionId, defined.pluginId, defined.packageId, 'run')
      expect(runtime.repository.listAuthoringTasks(entity.agentId)[0]?.status).toBe('ready')
    } finally {
      await runtime.dispose()
    }
    const verify = vi.spyOn(DynamicAuthoringRuntime.prototype, 'verifyDynamicPackage')
    const restarted = await createRuntime(model, directory)
    try {
      await restarted.start()
      await restarted.recover()
      const [task] = restarted.repository.listAuthoringTasks(entity.agentId)
      expect(task?.status).toBe('ready')
      expect(restarted.repository.listAuthoringAttempts(task!.id).at(-1)?.verification).toBeDefined()
      expect(verify).not.toHaveBeenCalled()
    } finally {
      verify.mockRestore()
      await restarted.dispose()
    }
  }, 60_000)

  it('accepts Client CSS beside an Client and rejects it without one', () => {
    const css = '.panel { color: var(--nxt-text); }'
    const candidate = (code: { readonly client?: string }) =>
      preflightNekroNxtAuthoringDefinition({
        plugin: { kind: 'new', idPrefix: 'css' },
        name: '带样式的面板',
        purpose: 'V7 面板通过自带 CSS 设定样式。',

        code,
        resources: { 'assets/panel.module.css': css },
        clientCss: { path: 'assets/panel.module.css', sha256: createHash('sha256').update(css).digest('hex') },
        permissions: { permissions: [], networkOrigins: [] },
        contributions: [],
      })
    expect(() => candidate({ client: 'return { apply() {} }' })).not.toThrow()
    expect(() => candidate({})).toThrow('必须配套 Client 源码')
  })

  it('accepts tool and page contributions together during V7 authoring preflight', () => {
    const page = {
      kind: 'host-page' as const,
      entryId: 'overview',
      title: '组合概览',
      icon: { kind: 'host-icon' as const, name: 'puzzle' as const },
      objectPane: 'hidden' as const,
      startPath: '',
    }
    expect(() =>
      preflightNekroNxtAuthoringDefinition({
        plugin: { kind: 'new', idPrefix: 'mixed' },
        name: '组合扩展',
        purpose: '工具与管理页面由同一扩展提供。',
        code: {
          host: toolHost('mixed_probe', "return 'ok'"),
          client: `return { apply(ctx) { ctx.pages.register({ page: ${JSON.stringify(page)} }, () => React.createElement('section', null, '组合概览')) } }`,
        },
        resources: {},
        permissions: { permissions: [], networkOrigins: [] },
        contributions: [{ kind: 'tool', name: 'mixed_probe', description: '组合探针' }, page],
      }),
    ).not.toThrow()
  })

  it('accepts command contributions and rejects built-in command names before creating a candidate', async () => {
    const { runtime, entity, dshSessionId } = await startAuthoringSession()
    try {
      const command = (name: string) => ({ kind: 'command' as const, name, description: '回声' })
      const input = (name: string) => ({
        plugin: { kind: 'new' as const, idPrefix: 'cmd' },
        name: '动态命令',
        purpose: '验证命令贡献的预检。',
        code: { host: 'return { apply() {} }' },
        resources: {},
        permissions: { permissions: [], networkOrigins: [] },
        contributions: [command(name)],
      })
      expect(() => preflightNekroNxtAuthoringDefinition(input('echo'))).not.toThrow()
      const tasks = runtime.repository.listAuthoringTasks(entity.agentId)
      for (const reserved of ['ext', 'admin', 'help']) {
        expect(() => preflightNekroNxtAuthoringDefinition(input(reserved))).toThrow('内置命令名称保留')
        expect(() => runtime.host.defineDynamicAuthoringPackage(dshSessionId, input(reserved))).toThrow(
          '内置命令名称保留',
        )
      }
      expect(runtime.repository.listAuthoringTasks(entity.agentId)).toEqual(tasks)
    } finally {
      await runtime.dispose()
    }
  })

  it('accepts an extension icon without Client source and checks its digest and pixels', () => {
    const png = new Uint8Array(40)
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
    new DataView(png.buffer).setUint32(16, 128)
    new DataView(png.buffer).setUint32(20, 128)
    const content = Buffer.from(png).toString('base64')
    const candidate = (sha256: string, resource = content) =>
      preflightNekroNxtAuthoringDefinition({
        plugin: { kind: 'new', idPrefix: 'icon' },
        name: '带图标的工具',
        purpose: '图标随扩展保存。',
        code: { host: toolHost('icon_probe', "return 'ok'") },
        resources: { 'assets/icon.png': resource },
        icon: { path: 'assets/icon.png', sha256 },
        permissions: { permissions: [], networkOrigins: [] },
        contributions: [],
      })
    const digest = createHash('sha256').update(png).digest('hex')
    expect(() => candidate(digest)).not.toThrow()
    expect(() => candidate('0'.repeat(64))).toThrow('扩展图标摘要不匹配')
    expect(() => candidate(digest, `${content}\n`)).toThrow('base64')
    const tiny = new Uint8Array(png)
    new DataView(tiny.buffer).setUint32(16, 16)
    new DataView(tiny.buffer).setUint32(20, 16)
    expect(() =>
      candidate(createHash('sha256').update(tiny).digest('hex'), Buffer.from(tiny).toString('base64')),
    ).toThrow('64–512')
  })

  it('saves the extension icon a dynamic definition declares into the Revision', async () => {
    const { runtime, entity, dshSessionId } = await startAuthoringSession()
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>'
    try {
      const defined = runtime.host.defineDynamicAuthoringPackage(dshSessionId, {
        plugin: { kind: 'new', idPrefix: 'icon' },
        name: '图标探针',
        purpose: '验证扩展图标随保存进入 Revision。',
        code: { host: toolHost('icon_probe', "return 'ok'") },
        resources: { 'assets/icon.svg': svg },
        icon: { path: 'assets/icon.svg', sha256: createHash('sha256').update(svg).digest('hex') },
        permissions: { permissions: [], networkOrigins: [] },
        contributions: [],
      })
      await expect(
        runtime.host.runDynamicPackage(dshSessionId, defined.pluginId, defined.packageId, 'run'),
      ).resolves.toMatchObject({ ok: true, status: 'running' })
      const task = runtime.repository.listAuthoringTasks(entity.agentId)[0]!
      const attempt = runtime.repository.listAuthoringAttempts(task.id).at(-1)!
      const saved = await runtime.authoring.save({
        taskId: task.id,
        attemptId: attempt.id,
        displayName: '图标探针',
        slug: 'icon-probe',
        description: '带图标的扩展。',
      })
      const manifest = runtime.extensionService.revisionManifest(saved.revision)
      expect(manifest?.icon).toEqual({
        path: 'assets/icon.svg',
        sha256: createHash('sha256').update(svg).digest('hex'),
      })
      const directory = runtime.extensionService.revisionSourceDirectory(saved.revision)
      expect(await readFile(path.join(directory, 'assets/icon.svg'), 'utf8')).toBe(svg)
    } finally {
      await runtime.dispose()
    }
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
      expect(runtime.host.dynamicAuthoringPolicy(dshSessionId).blockedReason).toContain('同样的错误已经出现两次')

      await expect(runtime.host.undefineDynamicPlugin(dshSessionId, first.pluginId)).resolves.toMatchObject({
        ok: true,
      })
      expect(runtime.host.dynamicAuthoringPolicy(dshSessionId).blockedReason).toContain('同样的错误已经出现两次')
      expect(() =>
        runtime.host.defineDynamicPackage(dshSessionId, {
          plugin: { kind: 'new', idPrefix: 'esc' },
          name: '绕过熔断',
          purpose: '不应被允许。',
          code: { host: toolHost('escape_probe', "return 'ok'") },
        }),
      ).toThrow('扩展开发已暂停')
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

  it('lets a dynamic candidate use ctx.nxt and carries its capabilities through save and enable approval', async () => {
    const { runtime, entity, dshSessionId } = await startAuthoringSession()
    const host = `return {
  inject: ['tools', 'nxt'],
  apply(ctx) {
    ctx.nxt.prompt.dynamic('visits', async ({ storage }) => '访问次数等级：' + ((await storage.get('visits')) ? '有' : '无'))
    harness.registerTool(ctx, harness.defineTool({
      name: 'visit_counter',
      description: 'Count visits in extension storage.',
      parameters: { label: { type: 'string', required: true, description: 'Visit label.' } },
      output: { schema: { type: 'json' }, render(_args, value) { return [{ type: 'text', text: JSON.stringify(value) }] } },
      async execute({ label }) {
        const previous = (await ctx.nxt.storage.get('visits')) ?? 0
        await ctx.nxt.storage.set('visits', previous + 1)
        const context = await ctx.nxt.context.current()
        let denied = ''
        try { await ctx.nxt.http.fetch('https://api.example.com/') } catch (error) { denied = String(error.message) }
        const card = await ctx.nxt.render.svg('<svg xmlns="http://www.w3.org/2000/svg" width="12" height="8"/>', { scale: 1 })
        const feed = await ctx.nxt.parse.feed('<rss><channel><title>示例</title></channel></rss>')
        if (card.width !== 12 || feed.title !== '示例') throw new Error('render or parse failed')
        return { label, visits: previous + 1, channelKind: context.channel.kind, apiKey: (await ctx.nxt.secrets.get('apiKey')) ?? null, denied }
      }
    }))
  }
}`
    const capabilities: ExtensionCapabilities = {
      storage: { scopes: ['agent'] },
      context: [{ name: 'visits', kind: 'dynamic', maxChars: 100 }],
    }
    try {
      const defined = runtime.host.defineDynamicAuthoringPackage(dshSessionId, {
        plugin: { kind: 'new', idPrefix: 'visit' },
        name: '访问计数',
        purpose: '验证 nxt 宿主能力。',
        code: { host },
        resources: {},
        permissions: { permissions: [], networkOrigins: [], agent: capabilities },
        config: {
          agent: {
            schema: {
              type: 'object',
              dict: { apiKey: { type: 'string', meta: { description: 'API Key', role: 'secret' } } },
            },
          },
        },
        contributions: [],
        verificationInputs: { tools: { visit_counter: { label: '示例' } }, rpc: {} },
      })
      const run = await runtime.host.runDynamicPackage(dshSessionId, defined.pluginId, defined.packageId, 'run')
      expect(run, JSON.stringify(run)).toMatchObject({ ok: true, status: 'running' })
      const task = runtime.repository.listAuthoringTasks(entity.agentId)[0]!
      const attempt = runtime.repository.listAuthoringAttempts(task.id).at(-1)!
      expect(runtime.repository.getAuthoringTask(task.id)?.status).toBe('ready')
      expect(attempt.verification?.toolInvocations).toEqual([{ name: 'visit_counter', succeeded: true }])

      const saved = await runtime.authoring.save({
        taskId: task.id,
        attemptId: attempt.id,
        displayName: '访问计数',
        slug: 'visit-counter',
        description: '使用 nxt 存储与上下文的工具。',
      })
      const verification = runtime.repository.getExtensionRevisionVerification(saved.revision.id)
      expect(verification?.permissions?.agent).toEqual(capabilities)
      const requirement = runtime.extensions.agentRequirement(entity.agentId, saved.extension.id, saved.revision.id)
      expect(requirement.approvalRequired).toBe(true)
      await expect(
        runtime.extensions.activate({
          agentId: entity.agentId,
          extensionId: saved.extension.id,
          revisionId: saved.revision.id,
        }),
      ).rejects.toThrow('permission-approval-required')
      // The authoring Session still runs the candidate with the same Tool, so only that Session is handed off.
      const handoff = vi.spyOn(runtime.channels, 'rolloverEpisodesForActivation')
      await expect(
        runtime.extensions.activate({
          agentId: entity.agentId,
          extensionId: saved.extension.id,
          revisionId: saved.revision.id,
          permissionApproval: { permissionDigest: requirement.permissionDigest },
        }),
      ).resolves.toMatchObject({ extensionRevisionId: saved.revision.id })
      expect(handoff).toHaveBeenCalledTimes(1)
      const next = runtime.repository.listActiveEpisodesForAgent(entity.agentId)
      expect(next).toHaveLength(1)
      expect(next[0]?.dshSessionId).not.toBe(dshSessionId)
      expect(runtime.host.toolNames(next[0]!.dshSessionId!)).toContain('visit_counter')
    } finally {
      await runtime.dispose()
    }
  })

  it('verifies an inbound hook in the dynamic run and hides matching messages once enabled', async () => {
    const { runtime, entity, dshSessionId } = await startAuthoringSession()
    const host = `harness.onInbound(async (message, nxt) => {
  if (message.text.startsWith('广告')) return { hideFromAgent: true }
  const seen = (await nxt.storage.get('seen')) ?? 0
  await nxt.storage.set('seen', seen + 1)
  return { annotation: '已见消息 ' + (seen + 1) + '，图片 ' + JSON.stringify(message.images) }
})
return { inject: ['nxt'], apply() {} }`
    const capabilities: ExtensionCapabilities = {
      storage: { scopes: ['agent'] },
      inboundHook: { reads: 'all', mayHide: true, mayForceTrigger: false, timeoutMs: 1000 },
    }
    try {
      const defined = runtime.host.defineDynamicAuthoringPackage(dshSessionId, {
        plugin: { kind: 'new', idPrefix: 'guard' },
        name: '广告过滤',
        purpose: '对智能体隐藏广告消息。',
        code: { host },
        resources: {},
        permissions: { permissions: [], networkOrigins: [], agent: capabilities },
        contributions: [],
      })
      await expect(
        runtime.host.runDynamicPackage(dshSessionId, defined.pluginId, defined.packageId, 'run'),
      ).resolves.toMatchObject({ ok: true, status: 'running' })
      const task = runtime.repository.listAuthoringTasks(entity.agentId)[0]!
      const attempt = runtime.repository.listAuthoringAttempts(task.id).at(-1)!
      expect(runtime.repository.getAuthoringTask(task.id)?.status).toBe('ready')
      expect(JSON.stringify(attempt.verification ?? {})).not.toContain('__nekro_nxt_inbound_probe')

      const saved = await runtime.authoring.save({
        taskId: task.id,
        attemptId: attempt.id,
        displayName: '广告过滤',
        slug: 'ad-guard',
        description: '隐藏广告消息。',
      })
      const requirement = runtime.extensions.agentRequirement(entity.agentId, saved.extension.id, saved.revision.id)
      await runtime.extensions.activate({
        agentId: entity.agentId,
        extensionId: saved.extension.id,
        revisionId: saved.revision.id,
        permissionApproval: { permissionDigest: requirement.permissionDigest },
      })

      await runtime.internalChannel.postMessage({
        channelId: entity.channelId,
        clientEventId: 'ad-message',
        parts: [{ type: 'text', text: '广告：示例商品' }],
      })
      const binding = runtime.repository.getBinding(entity.channelId)!
      const pending = runtime.repository.listUnadmittedEvents(entity.channelId, entity.agentId, binding.boundAt)
      const ad = pending.find((event) => event.parts[0]?.type === 'text' && event.parts[0].text.startsWith('广告'))
      expect(ad).toBeDefined()
      expect(runtime.repository.getChannelEvent(ad!.id)).toBeDefined()
      // The timeline shows the decision on the message itself.
      await vi.waitFor(() =>
        expect(
          projectHistoryEntry(runtime, {
            source: 'channel-event',
            sourceId: ad!.id,
            logicalMessageId: ad!.logicalMessageId,
            channelId: entity.channelId,
            occurredAt: ad!.receivedAt,
            parts: ad!.parts,
          }).inboundHook,
        ).toEqual({ trigger: 'default', hidden: true, extensions: ['广告过滤'] }),
      )

      const picture = await runtime.assetService.prepare({
        bytes: new Uint8Array(
          Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZQAAAABJRU5ErkJggg==',
            'base64',
          ),
        ),
        declaredMediaType: 'image/png',
      })
      await runtime.internalChannel.postMessage({
        channelId: entity.channelId,
        clientEventId: 'picture-message',
        parts: [{ type: 'image', assetId: picture.asset.id }],
      })
      const pictureEvent = runtime.repository
        .listChannelEvents(entity.channelId)
        .find((event) => event.parts[0]?.type === 'image')
      expect(pictureEvent).toBeDefined()
      // Hooks see the pictures of the message; the internal channel has no platform sticker marking.
      await vi.waitFor(() =>
        expect(runtime.repository.getInboundHookDecision(pictureEvent!.id, entity.agentId)?.annotation).toContain(
          JSON.stringify([{ assetId: picture.asset.id, sticker: false }]),
        ),
      )
    } finally {
      await runtime.dispose()
    }
  })

  it('accepts a due-job handler in the dynamic run of a candidate that declares jobs', async () => {
    const { runtime, entity, dshSessionId } = await startAuthoringSession()
    const host = `harness.onJob(async () => ({ wake: false }))
return { inject: ['nxt'], apply() {} }`
    try {
      const defined = runtime.host.defineDynamicAuthoringPackage(dshSessionId, {
        plugin: { kind: 'new', idPrefix: 'poll' },
        name: '示例轮询',
        purpose: '只在有新内容时唤醒智能体。',
        code: { host },
        resources: {},
        permissions: {
          permissions: [],
          networkOrigins: [],
          agent: { jobs: { runtime: { maxActive: 3 } } },
        },
        contributions: [],
      })
      await expect(
        runtime.host.runDynamicPackage(dshSessionId, defined.pluginId, defined.packageId, 'run'),
      ).resolves.toMatchObject({ ok: true, status: 'running' })
      const task = runtime.repository.listAuthoringTasks(entity.agentId)[0]!
      expect(runtime.repository.getAuthoringTask(task.id)?.status).toBe('ready')
      const attempt = runtime.repository.listAuthoringAttempts(task.id).at(-1)!
      // The saved Revision keeps the original source, not the Host's dynamic wrapper.
      const saved = await runtime.authoring.save({
        taskId: task.id,
        attemptId: attempt.id,
        displayName: '示例轮询',
        slug: 'poll-probe',
        description: '只在有新内容时唤醒智能体。',
      })
      const source = await readFile(
        path.join(runtime.extensionService.revisionSourceDirectory(saved.revision), 'source', 'host.ts'),
        'utf8',
      )
      expect(source).toContain('harness.onJob')
      expect(source).not.toContain('__nxtInbound')
    } finally {
      await runtime.dispose()
    }
  })

  it('lets only the dynamic run of a task read its test credentials', async () => {
    const { runtime, entity, dshSessionId } = await startAuthoringSession()
    const host = `return {
  inject: ['tools', 'nxt'],
  apply(ctx) {
    harness.registerTool(ctx, harness.defineTool({
      name: 'needs_key',
      description: 'Fails without the test credential.',
      parameters: {},
      output: { schema: { type: 'string' }, render(_args, value) { return [{ type: 'text', text: value }] } },
      async execute() {
        const key = await ctx.nxt.secrets.get('apiKey')
        if (key !== 'fixture-test-key') throw new Error('test credential missing')
        return 'ok'
      }
    }))
  }
}`
    try {
      const defined = runtime.host.defineDynamicAuthoringPackage(dshSessionId, {
        plugin: { kind: 'new', idPrefix: 'key' },
        name: '需要凭据',
        purpose: '验证测试凭据。',
        code: { host },
        resources: {},
        permissions: { permissions: [], networkOrigins: [] },
        config: {
          agent: {
            schema: {
              type: 'object',
              dict: { apiKey: { type: 'string', meta: { description: 'API Key', role: 'secret' } } },
            },
          },
        },
        contributions: [],
      })
      const task = await vi.waitFor(() => {
        const recorded = runtime.repository.listAuthoringTasks(entity.agentId)[0]
        if (recorded === undefined || runtime.repository.listAuthoringAttempts(recorded.id).length === 0) {
          throw new Error('authoring task not recorded yet')
        }
        return recorded
      })
      expect(await runtime.authoringTestConfig.describe(task.id)).toEqual({
        fields: [{ key: 'apiKey', title: 'API Key', kind: 'secret' }],
        configured: [],
        values: {},
        agentValues: {},
      })
      await expect(runtime.authoringTestConfig.setSecrets(task.id, { other: 'x' })).rejects.toThrow(/没有这些凭据字段/u)
      await runtime.authoringTestConfig.setSecrets(task.id, { apiKey: 'fixture-test-key' })
      expect((await runtime.authoringTestConfig.describe(task.id)).configured).toEqual(['apiKey'])

      await expect(
        runtime.host.runDynamicPackage(dshSessionId, defined.pluginId, defined.packageId, 'run'),
      ).resolves.toMatchObject({ ok: true, status: 'running' })
      expect(runtime.repository.getAuthoringTask(task.id)?.status).toBe('ready')
      // Save verification runs without any credential, so the test value never leaks into the saved Revision;
      // this tool throws instead of returning a readable result and therefore cannot be saved.
      const attempt = runtime.repository.listAuthoringAttempts(task.id).at(-1)!
      await expect(
        runtime.authoring.save({
          taskId: task.id,
          attemptId: attempt.id,
          displayName: '需要凭据',
          slug: 'needs-key',
          description: '验证测试凭据。',
        }),
      ).rejects.toThrow('test credential missing')
      await runtime.authoringTestConfig.clear(task.id)
      expect((await runtime.authoringTestConfig.describe(task.id)).configured).toEqual([])

      // Deleting the agent removes its test credentials and takes its tasks out of the Workshop; the history stays.
      await runtime.authoringTestConfig.setSecrets(task.id, { apiKey: 'fixture-test-key' })
      await runtime.deleteAgent(entity.agentId, { deleteAutoCreatedBuiltInChannels: true })
      expect((await runtime.authoringTestConfig.describe(task.id)).configured).toEqual([])
      expect(runtime.repository.getAuthoringTask(task.id)).toBeDefined()
      const webContext = new Context()
      try {
        await webContext.plugin(WebServer, { host: '127.0.0.1', port: 0 })
        const api = createNekroHostApi(webContext.webServer, runtime)
        const snapshot = HostApiContracts.snapshot.parseResponse(
          await (await fetch(`http://127.0.0.1:${api.port}/api/snapshot`)).json(),
        )
        expect(snapshot.authoringTasks.map(({ id }) => id)).not.toContain(task.id)
      } finally {
        await webContext.fiber.dispose()
      }
    } finally {
      await runtime.dispose()
    }
  })

  it('layers test values as defaults, then the agent’s, then the user’s, and only the user’s reach a private network', async () => {
    const server = createServer((_request, response) =>
      response.writeHead(200, { 'content-type': 'text/plain' }).end('pong'),
    )
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Fixture server has no TCP port.')
    const endpoint = `http://127.0.0.1:${address.port}`
    const { runtime, entity, dshSessionId } = await startAuthoringSession()
    // The probe reports what it saw by failing with it, so each trial run returns the observation.
    const host = `return {
  inject: ['tools', 'nxt'],
  apply(ctx) {
    harness.registerTool(ctx, harness.defineTool({
      name: 'config_probe',
      description: 'Reports its configuration and whether its service answers.',
      parameters: {},
      output: { schema: { type: 'string' }, render(_a, v) { return [{ type: 'text', text: v }] } },
      async execute() {
        const c = ctx.config()
        const fetched = await ctx.nxt.http.fetch(c.endpoint + '/ping').then(
          (response) => response.text,
          (error) => (String(error && error.message).includes('私网') ? 'private-blocked' : 'failed'),
        )
        throw new Error('observed ' + JSON.stringify({ unit: c.unit, label: c.label, retries: c.retries, fetched }))
      }
    }))
  }
}`
    const definition = (plugin: { kind: 'new'; idPrefix: string } | { kind: 'existing'; pluginId: string }) => ({
      plugin,
      name: '配置探针',
      purpose: '验证测试配置。',
      code: { host },
      resources: {},
      permissions: {
        permissions: [],
        networkOrigins: [],
        agent: { network: { mode: 'config' as const, fields: ['endpoint'] } },
      },
      config: {
        host: {
          schema: {
            type: 'object' as const,
            dict: { region: { type: 'string' as const, meta: { description: '区域', default: '示例区' } } },
          },
        },
        agent: {
          schema: {
            type: 'object' as const,
            dict: {
              endpoint: { type: 'string' as const, meta: { description: '服务地址', default: 'https://example.test' } },
              unit: { type: 'string' as const, meta: { description: '单位', default: '摄氏' } },
              label: { type: 'string' as const, meta: { description: '标签', default: '默认标签' } },
              retries: { type: 'number' as const, meta: { description: '重试次数', default: 1 } },
              apiKey: { type: 'string' as const, meta: { description: 'API Key', role: 'secret' } },
            },
          },
        },
      },
      contributions: [],
    })
    try {
      const first = runtime.host.defineDynamicAuthoringPackage(
        dshSessionId,
        definition({ kind: 'new', idPrefix: 'cfg' }),
      )
      const task = await vi.waitFor(() => {
        const recorded = runtime.repository.listAuthoringTasks(entity.agentId)[0]
        if (recorded === undefined || runtime.repository.listAuthoringAttempts(recorded.id).length === 0) {
          throw new Error('authoring task not recorded yet')
        }
        return recorded
      })
      await expect(runtime.authoringTestConfig.setAgentValues(task.id, { apiKey: 'fictional-key' })).rejects.toThrow(
        '是凭据',
      )
      await expect(runtime.authoringTestConfig.setAgentValues(task.id, { retries: '五' })).rejects.toThrow('必须是数字')
      await runtime.authoringTestConfig.setAgentValues(task.id, { endpoint, label: '智能体标签', retries: 5 })
      await expect(
        runtime.host.runDynamicPackage(dshSessionId, first.pluginId, first.packageId, 'run'),
      ).rejects.toThrow('observed {"unit":"摄氏","label":"智能体标签","retries":5,"fetched":"private-blocked"}')

      // The user's values win, and the same private address the user entered is reachable.
      await runtime.authoringTestConfig.setUserValues(task.id, { endpoint, retries: '9' })
      const second = runtime.host.defineDynamicAuthoringPackage(
        dshSessionId,
        definition({ kind: 'existing', pluginId: first.pluginId }),
      )
      await expect(
        runtime.host.runDynamicPackage(dshSessionId, second.pluginId, second.packageId, 'update'),
      ).rejects.toThrow('observed {"unit":"摄氏","label":"智能体标签","retries":9,"fetched":"pong"}')

      await runtime.authoringTestConfig.setSecrets(task.id, { apiKey: 'fictional-test-key' })
      expect(runtime.authoringTestConfig.values(task.id).agentProvided).toEqual({
        endpoint,
        label: '智能体标签',
        retries: 5,
      })

      await runtime.authoringTestConfig.clear(task.id)
      expect(runtime.authoringTestConfig.values(task.id)).toEqual({ agentProvided: {}, userEntered: {} })
    } finally {
      await runtime.dispose()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 60_000)

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
            contributions: [{ kind: 'rpc', method: 'probe' }],
          },
          verification: {
            dshVersion: 'synthetic',
            contractVersion: 'nekro-nxt-extension-v5',
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
      ).rejects.toThrow('只能保存这个任务最新的候选')

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
        code: {
          host: "harness.handle('broken_summary', () => { throw new Error('synthetic rpc failure') }); return { apply() {} }",
          client: `return {
            inject: ['panels'],
            apply(ctx) {
              ctx.panels.register(
                { id: 'main', anchor: 'agent', title: '接口面板', densities: ['full'] },
                () => React.createElement('div'),
              )
            }
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
                      block.text.includes('界面调用 broken_summary 出错') &&
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
