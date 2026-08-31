import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { HostApiContracts } from '@nekro-nxt/contracts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NekroRuntime } from '../src/bootstrap.js'
import { createNekroHostApi } from '../src/host-api.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

class QuietModel extends LlmAdapter {
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
    void options
    await Promise.resolve()
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const HOST_CODE = `
const descriptor = {
  key: 'synthetic-chat',
  displayName: '合成聊天平台',
  description: '只用于离线适配器闭环测试。',
  userCreatable: true,
  aliasEditable: true,
  channelDiscovery: 'adapter-observed',
  diagnostics: { receive: true, send: true },
  configSchema: {
    schemaVersion: 1,
    type: 'object',
    required: [],
    properties: { failFirstStop: { type: 'boolean', title: '首次停止失败', default: false } }
  }
}
harness.registerAdapter({
  apiVersion: 1,
  descriptor,
  async create(context, stored) {
    let running = false
    let stopAttempts = 0
    const failFirstStop = stored.configuration.failFirstStop === true
    return {
      capabilities: {
        text: true, mentions: false, images: false, files: false, audio: false,
        replies: false, mixedContent: false, proactiveSend: true
      },
      async start() {
        running = true
        const channelId = await context.channels.ensure({
          platformChannelId: 'synthetic-room', kind: 'group', displayName: '合成频道', observedAt: context.now()
        })
        await context.acceptInbound({
          connectionId: context.connectionId,
          channelId,
          adapterKey: descriptor.key,
          platformEventId: 'synthetic-event',
          platformMessageId: 'synthetic-message',
          kind: 'message-created',
          parts: [{ type: 'text', text: 'synthetic inbound' }],
          platformTimestamp: context.now(),
          receivedAt: context.now(),
          dedupeKey: 'synthetic-event'
        })
        context.diagnostics.publish({ status: 'connected' })
      },
      async stop() {
        stopAttempts += 1
        if (failFirstStop && stopAttempts === 1) throw new Error('synthetic stop failure')
        running = false
      },
      async deliver() {
        if (!running) return { status: 'failed', failure: { kind: 'transient', message: 'not running' } }
        return { status: 'sent', platformMessageId: 'synthetic-outbound' }
      }
    }
  }
})
return { apply() {} }
`

const CLIENT_CODE = `return {
  inject: ['slots'],
  apply(ctx) {
    ctx.slots.register(
      { name: 'conversation.message.rich', id: 'synthetic-chat:card' },
      ({ part }) => React.createElement('article', { 'data-synthetic-card': '' }, part.summary)
    )
  }
}`

describe('Host Adapter Extension end-to-end', () => {
  it('runs with the offline harness, saves V3, installs, creates a Connection, and uninstalls without data loss', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-adapter-extension-'))
    temporaryDirectories.push(directory)
    const runtime = await NekroRuntime.create({
      coreDatabasePath: path.join(directory, 'core.sqlite'),
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      assetRoot: path.join(directory, 'assets'),
      extensionDataRoot: path.join(directory, 'extension-data'),
      extensionCacheRoot: path.join(directory, 'extension-cache'),
      configureLlm: (context) => {
        context.llm.registerAdapter(['test-provider'], new QuietModel())
      },
    })
    await runtime.start()
    const entity = await runtime.createAgentWithWebChannel({
      displayName: '适配器创造智能体',
      persona: '',
      model: { provider: 'test-provider', model: 'chat-model' },
      capabilities: { dynamicCreation: true },
    })
    await runtime.web.postMessage({
      channelId: entity.channelId,
      clientEventId: 'adapter-seed',
      parts: [{ type: 'text', text: '创建合成适配器。' }],
    })
    const episode = runtime.repository.listActiveEpisodesForAgent(entity.agentId)[0]
    if (!episode?.dshSessionId) throw new Error('Expected a live DSH Session.')
    const dshSessionId = episode.dshSessionId
    const defined = runtime.host.defineDynamicPackage(dshSessionId, {
      plugin: { kind: 'new', idPrefix: 'adapt' },
      name: '合成适配器',
      purpose: '验证 Host Adapter 安装闭环。',
      code: { host: HOST_CODE, client: CLIENT_CODE },
    })
    const pendingRun = runtime.host.runDynamicPackage(dshSessionId, defined.pluginId, defined.packageId, 'run')
    await expect
      .poll(
        () =>
          runtime.host.dynamicInventory(dshSessionId).find((row) => row.pluginId === defined.pluginId)?.latestRun
            ?.approvalRequestId,
      )
      .toBeDefined()
    const approval = runtime.host.dynamicInventory(dshSessionId).find((row) => row.pluginId === defined.pluginId)
      ?.latestRun?.approvalRequestId
    expect(approval).toBeDefined()
    const hostHalf = await runtime.host.runDynamicHostHalf(
      dshSessionId,
      defined.pluginId,
      defined.packageId,
      'run',
      approval!,
      false,
    )
    expect(hostHalf.ok).toBe(true)
    if (!hostHalf.ok) throw new Error(hostHalf.message)
    await runtime.host.resolveDynamicRunRequest(episode.dshSessionId, approval!, {
      ok: true,
      pluginRunId: hostHalf.pluginRunId,
    })
    await runtime.host.recordDynamicClientVerification(
      episode.dshSessionId,
      defined.pluginId,
      defined.packageId,
      hostHalf.pluginRunId,
      [],
      [{ name: 'conversation.message.rich', key: 'synthetic-chat:card' }],
    )
    await expect(pendingRun).resolves.toMatchObject({ ok: true })

    const webContext = new Context()
    await webContext.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const api = createNekroHostApi(webContext.webServer, runtime)
    const origin = `http://127.0.0.1:${api.port}`
    try {
      const save = await fetch(`${origin}/api/extensions/save-from-dynamic`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          agentId: entity.agentId,
          episodeId: episode.id,
          pluginId: defined.pluginId,
          packageId: defined.packageId,
          displayName: '合成适配器',
          slug: 'synthetic-adapter',
          description: '合成适配器测试 Revision。',
        }),
      })
      expect(save.ok, await save.clone().text()).toBe(true)
      const saved = HostApiContracts.saveExtensionFromDynamic.parseResponse(await save.json())
      expect(runtime.repository.getExtensionRevisionVerification(saved.revisionId)).toMatchObject({
        contractVersion: 'nekro-nxt-extension-v2',
        scope: 'host-adapter',
        renderedHostSlots: [{ name: 'conversation.message.rich', key: 'synthetic-chat:card' }],
        adapter: { key: 'synthetic-chat', registered: true, started: true, stopped: true },
      })

      const exported = await fetch(`${origin}/api/extensions/${saved.extensionId}/revisions/${saved.revisionId}/export`)
      expect(exported.ok).toBe(true)
      const archive = Buffer.from(await exported.arrayBuffer())
      const importDirectory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-adapter-import-'))
      temporaryDirectories.push(importDirectory)
      const importedRuntime = await NekroRuntime.create({
        coreDatabasePath: path.join(importDirectory, 'core.sqlite'),
        sessionDatabasePath: path.join(importDirectory, 'sessions.sqlite'),
        assetRoot: path.join(importDirectory, 'assets'),
        extensionDataRoot: path.join(importDirectory, 'extension-data'),
        extensionCacheRoot: path.join(importDirectory, 'extension-cache'),
      })
      await importedRuntime.start()
      const importContext = new Context()
      await importContext.plugin(WebServer, { host: '127.0.0.1', port: 0 })
      const importApi = createNekroHostApi(importContext.webServer, importedRuntime)
      const importOrigin = `http://127.0.0.1:${importApi.port}`
      try {
        const inspectResponse = await fetch(`${importOrigin}/api/extensions/imports/inspect`, {
          method: 'POST',
          body: archive,
        })
        expect(inspectResponse.ok, await inspectResponse.clone().text()).toBe(true)
        const inspection = HostApiContracts.inspectExtensionImport.parseResponse(await inspectResponse.json())
        const commitResponse = await fetch(
          `${importOrigin}/api/extensions/imports/${encodeURIComponent(inspection.token)}/commit`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          },
        )
        expect(commitResponse.ok, await commitResponse.clone().text()).toBe(true)
        expect(importedRuntime.repository.getExtensionRevisionVerification(saved.revisionId)).toMatchObject({
          scope: 'host-adapter',
          origin: { pluginRunId: 'local-runtime-verification' },
          adapter: {
            key: 'synthetic-chat',
            registered: true,
            started: true,
            stopped: true,
            inboundCommitted: true,
            outboundReceipt: 'sent',
          },
          renderedHostSlots: [{ name: 'conversation.message.rich', key: 'synthetic-chat:card' }],
        })
        expect(importedRuntime.repository.getHostInstallation(saved.extensionId)).toBeUndefined()
        const importedInstall = await fetch(`${importOrigin}/api/extensions/${saved.extensionId}/installation`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ revisionId: saved.revisionId }),
        })
        expect(importedInstall.ok, await importedInstall.clone().text()).toBe(true)
        const importedConnection = await importedRuntime.createConnection({ adapterKey: 'synthetic-chat' })
        expect(importedRuntime.core.listChannelsByConnection(importedConnection.id)).toEqual([
          expect.objectContaining({ platformChannelId: 'synthetic-room' }),
        ])
      } finally {
        importApi.dispose()
        await importContext.fiber.dispose()
        await importedRuntime.dispose()
      }

      const install = await fetch(`${origin}/api/extensions/${saved.extensionId}/installation`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revisionId: saved.revisionId }),
      })
      expect(install.ok).toBe(true)
      expect(runtime.listConnectionAdapters()).toEqual(
        expect.arrayContaining([expect.objectContaining({ key: 'synthetic-chat', displayName: '合成聊天平台' })]),
      )
      const connection = await runtime.createConnection({ adapterKey: 'synthetic-chat' })
      const failingConnection = await runtime.createConnection({
        adapterKey: 'synthetic-chat',
        configuration: { failFirstStop: true },
      })
      expect(runtime.core.listChannelsByConnection(connection.id)).toEqual([
        expect.objectContaining({ platformChannelId: 'synthetic-room' }),
      ])

      const failedUninstall = await fetch(`${origin}/api/extensions/${saved.extensionId}/installation`, {
        method: 'DELETE',
      })
      expect(failedUninstall.ok).toBe(false)
      expect(await failedUninstall.text()).toContain('安装状态保持不变')
      expect(runtime.repository.getHostInstallation(saved.extensionId)).toBeDefined()
      expect(runtime.adapters.get('synthetic-chat')).toBeDefined()
      expect(runtime.adapterConnectionDiagnostic(connection.id)).toMatchObject({ status: 'connected' })
      expect(runtime.adapterConnectionDiagnostic(failingConnection.id)).toMatchObject({
        status: 'failed',
        message: 'synthetic stop failure',
      })

      const uninstall = await fetch(`${origin}/api/extensions/${saved.extensionId}/installation`, {
        method: 'DELETE',
      })
      expect(uninstall.ok).toBe(true)
      expect(runtime.adapters.get('synthetic-chat')).toBeUndefined()
      expect(runtime.core.getConnection(connection.id)).toBeDefined()
      expect(runtime.core.listChannelsByConnection(connection.id)).toHaveLength(1)
      expect(runtime.adapterConnectionDiagnostic(connection.id)).toMatchObject({
        status: 'stopped',
        message: '这个连接的适配器未安装。',
      })

      const conflicting = runtime.host.defineDynamicPackage(episode.dshSessionId, {
        plugin: { kind: 'existing', pluginId: defined.pluginId },
        name: '内置 key 冲突适配器',
        purpose: '验证安装前拒绝占用内置适配器 key。',
        code: { host: HOST_CODE.replace("key: 'synthetic-chat'", "key: 'web'") },
      })
      await expect(
        runtime.host.runDynamicPackage(episode.dshSessionId, conflicting.pluginId, conflicting.packageId, 'update'),
      ).resolves.toMatchObject({ ok: true, status: 'running' })
      const conflictingSave = await fetch(`${origin}/api/extensions/save-from-dynamic`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          agentId: entity.agentId,
          episodeId: episode.id,
          pluginId: conflicting.pluginId,
          packageId: conflicting.packageId,
          displayName: '内置 key 冲突适配器',
          slug: 'builtin-key-conflict',
          description: '只用于验证 Registry 冲突预检。',
        }),
      })
      expect(conflictingSave.ok).toBe(true)
      const conflictingSaved = HostApiContracts.saveExtensionFromDynamic.parseResponse(await conflictingSave.json())
      const builtinWeb = runtime.adapters.get('web')
      const webConnections = runtime.core.listConnectionsByAdapter('web')
      const conflictingInstall = await fetch(`${origin}/api/extensions/${conflictingSaved.extensionId}/installation`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revisionId: conflictingSaved.revisionId }),
      })
      expect(conflictingInstall.ok).toBe(false)
      expect(runtime.adapters.get('web')).toBe(builtinWeb)
      expect(runtime.core.listConnectionsByAdapter('web')).toEqual(webConnections)
      expect(runtime.repository.getHostInstallation(conflictingSaved.extensionId)).toBeUndefined()
    } finally {
      api.dispose()
      await webContext.fiber.dispose()
      await runtime.dispose()
    }
  })
})
