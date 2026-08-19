import { LlmAdapter, CallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { HostApiContracts } from '@nekro-nxt/contracts'
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { NekroRuntime } from '../src/bootstrap.js'
import { createNekroHostApi } from '../src/host-api.js'
import { configureDshLlmProviders } from '../src/main.js'

const temporaryDirectories: string[] = []

const LlmProviderSnapshotSchema = z
  .object({
    providers: z.array(
      z
        .object({
          provider: z.string(),
          settingsRevision: z.number(),
          configured: z.boolean().optional(),
          active: z.boolean().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough()

const DshPluginCatalogSchema = z
  .object({
    plugins: z.array(
      z.object({ packageName: z.string(), overall: z.string(), settingsNamespaces: z.array(z.string()) }).passthrough(),
    ),
  })
  .passthrough()

const DshSettingsSnapshotSchema = z
  .object({
    namespaces: z.array(
      z
        .object({
          ns: z.string(),
          revision: z.number(),
          resolved: z.record(z.string(), z.unknown()),
          secrets: z.array(z.unknown()),
        })
        .passthrough(),
    ),
  })
  .passthrough()

const DshSettingsMutationSchema = z
  .object({ revision: z.number(), resolved: z.object({ maxUses: z.number() }).passthrough() })
  .passthrough()

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

class ScriptedCommunicationModel extends LlmAdapter {
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
    if (options.system?.startsWith('你是对话交接摘要器')) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '用户希望继续当前频道任务。' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '用户希望继续当前频道任务。' } }
      yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 4 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (!options.messages.some((message) => message.content.some((block) => block.type === 'tool-result'))) {
      const callId = CallId('scripted-send-message')
      const toolCall = {
        type: 'tool-call' as const,
        id: callId,
        name: 'send_channel_message',
        arguments: JSON.stringify({
          target: { type: 'current' },
          parts: [{ type: 'text', text: '这是通信工具确认发送的回复。' }],
        }),
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '这段模型原始文字只能留在运行轨迹。' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '这段模型原始文字只能留在运行轨迹。' } }
      yield { type: 'block-start', index: 1, blockType: 'tool-call' }
      yield {
        type: 'tool-call-delta',
        index: 1,
        id: callId,
        name: 'send_channel_message',
        argumentsDelta: toolCall.arguments,
      }
      yield { type: 'block-end', index: 1, block: toolCall }
      yield { type: 'usage', usage: { inputTokens: 16, outputTokens: 8 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: '工具完成后的原始结束文字也不会发送。' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '工具完成后的原始结束文字也不会发送。' } }
    yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 4 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

describe('NekroNxt Server domain API (WebServer seam)', () => {
  it('creates an intelligent-agent, admits a Web message, and exposes only the communication-tool reply', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-host-api-'))
    temporaryDirectories.push(directory)
    const runtime = await NekroRuntime.create({
      coreDatabasePath: path.join(directory, 'core.sqlite'),
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      assetRoot: path.join(directory, 'assets'),
      extensionDataRoot: path.join(directory, 'extension-data'),
      extensionCacheRoot: path.join(directory, 'extension-cache'),
      configureLlm: (context: Context) => {
        context.llm.registerAdapter(['test-provider'], new ScriptedCommunicationModel())
      },
    })
    await runtime.start()
    await runtime.recover()

    const webContext = new Context()
    await webContext.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const api = createNekroHostApi(webContext.webServer, runtime)
    const origin = `http://127.0.0.1:${api.port}`

    try {
      const providerTest = await fetch(`${origin}/api/llm/test-provider`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'test-provider', model: 'chat-model' }),
      })
      expect(providerTest.ok).toBe(true)
      expect(await providerTest.json()).toEqual({ provider: 'test-provider', model: 'chat-model' })

      const invalidModelResponse = await fetch(`${origin}/api/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          displayName: '不应创建的智能体',
          persona: '',
          model: { provider: 'test-provider', model: 'missing-model' },
        }),
      })
      expect(invalidModelResponse.status).toBe(400)
      expect(
        HostApiContracts.snapshot.parseResponse(await (await fetch(`${origin}/api/snapshot`)).json()).agents,
      ).toEqual([])

      const importedAgent = runtime.core.createAgent({
        displayName: '仅迁入配置的智能体',
        persona: '没有迁入频道数据。',
        model: { provider: 'test-provider', model: 'chat-model' },
      })
      const importedSnapshot = HostApiContracts.snapshot.parseResponse(
        await (await fetch(`${origin}/api/snapshot`)).json(),
      )
      expect(importedSnapshot.agents).toEqual([
        expect.objectContaining({ id: importedAgent.definition.id, channels: [] }),
      ])
      expect(importedSnapshot.channels).toEqual([])

      // Closed-loop A: create an intelligent-agent through the real HTTP surface.
      const createdResponse = await fetch(`${origin}/api/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          displayName: '网页智能体',
          persona: '简洁准确地回应。',
          model: { provider: 'test-provider', model: 'chat-model' },
        }),
      })
      expect(createdResponse.status).toBe(201)
      const created = HostApiContracts.createAgent.parseResponse(await createdResponse.json())
      expect(created.agentId.length).toBeGreaterThan(0)
      expect(created.channelId.length).toBeGreaterThan(0)
      expect(runtime.repository.getAgent(created.agentId)?.revision.capabilities).toMatchObject({
        subagents: true,
        fileTools: false,
        webSearch: false,
      })

      const sender = runtime.core.observeChannelMember({
        connectionId: created.connectionId,
        channelId: created.channelId,
        platformUserId: 'sender-openid',
        displayName: '成员甲',
        observedAt: Date.now(),
      }).member
      const mentioned = runtime.core.observeChannelMember({
        connectionId: created.connectionId,
        channelId: created.channelId,
        platformUserId: 'mentioned-openid',
        displayName: '成员乙',
        observedAt: Date.now(),
      }).member
      runtime.core.appendInbound({
        connectionId: created.connectionId,
        channelId: created.channelId,
        adapterKey: 'web',
        platformEventId: 'member-projection-1',
        kind: 'message-created',
        senderMemberId: sender.id,
        parts: [
          { type: 'text', text: '请看' },
          { type: 'mention', memberId: mentioned.id },
        ],
        platformTimestamp: Date.now(),
        receivedAt: Date.now(),
        dedupeKey: 'member-projection-1',
        facts: { mentionedBot: true },
      })

      // The authoritative snapshot exposes the new intelligent-agent + its Web Channel.
      const snapshot = HostApiContracts.snapshot.parseResponse(await (await fetch(`${origin}/api/snapshot`)).json())
      expect(snapshot.models.find((model) => model.id === 'chat-model')).toMatchObject({
        provider: 'test-provider',
        name: 'Chat model',
      })
      expect(snapshot.connectionAdapters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: 'web', userCreatable: false }),
          expect.objectContaining({ key: 'qq-openclaw', displayName: 'QQ 官方机器人', userCreatable: true }),
        ]),
      )
      expect(snapshot.agents.some((agent) => agent.id === created.agentId)).toBe(true)
      expect(snapshot.agents.find((agent) => agent.id === created.agentId)?.displayName).toBe('网页智能体')
      expect(snapshot.agents.find((agent) => agent.id === created.agentId)?.runtimeStatus).toBe('idle')
      expect(snapshot.agents.find((agent) => agent.id === created.agentId)?.runtimePhase).toBe('idle')
      expect(snapshot.channels.find((channel) => channel.id === created.channelId)?.runtimePhase).toBe('idle')
      const idleRuntime = HostApiContracts.getChannelRuntime.parseResponse(
        await (await fetch(`${origin}/api/channels/${created.channelId}/runtime`)).json(),
      )
      expect(idleRuntime).toMatchObject({
        channelId: created.channelId,
        agentId: created.agentId,
        phase: 'idle',
        pendingInjectCount: 0,
        turns: [],
      })
      expect(snapshot.channels.some((channel) => channel.id === created.channelId)).toBe(true)
      expect(snapshot.channels.find((channel) => channel.id === created.channelId)?.boundAgentId).toBe(created.agentId)
      expect(snapshot.messages).toEqual([])
      const renamed = await fetch(`${origin}/api/channels/${created.channelId}/display-name`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: '本地识别名称' }),
      })
      expect(renamed.status).toBe(200)
      const renamedSnapshot = HostApiContracts.snapshot.parseResponse(
        await (await fetch(`${origin}/api/snapshot`)).json(),
      )
      expect(renamedSnapshot.channels.find((channel) => channel.id === created.channelId)).toMatchObject({
        displayName: '本地识别名称',
        platformChannelId: `web-${created.agentId}`,
      })
      const initialHistory = HostApiContracts.listChannelMessages.parseResponse(
        await (await fetch(`${origin}/api/channels/${created.channelId}/messages?limit=40`)).json(),
      )
      expect(initialHistory.messages.find((message) => message.sender?.memberId === sender.id)).toMatchObject({
        sender: { displayName: '成员甲' },
        mentionedConnectionAccount: true,
        parts: [
          { type: 'text', text: '请看' },
          { type: 'mention', memberId: mentioned.id, displayName: '成员乙' },
        ],
      })

      const pngBytes = new Uint8Array(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
          'base64',
        ),
      )
      const preparedAsset = await runtime.assetService.prepare({
        bytes: pngBytes,
        declaredMediaType: 'image/png',
      })
      await runtime.channels.acceptInbound({
        connectionId: created.connectionId,
        channelId: created.channelId,
        adapterKey: 'web',
        platformEventId: 'asset-http-event',
        platformMessageId: 'asset-http-message',
        kind: 'message-created',
        parts: [{ type: 'image', assetId: preparedAsset.asset.id, alt: '一像素图片' }],
        platformTimestamp: Date.now(),
        receivedAt: Date.now(),
        dedupeKey: 'asset-http-event',
        assetOccurrences: [{ partIndex: 0, assetId: preparedAsset.asset.id }],
      })
      const assetResponse = await fetch(`${origin}/api/channels/${created.channelId}/assets/${preparedAsset.asset.id}`)
      expect(assetResponse.status).toBe(200)
      expect(assetResponse.headers.get('content-type')).toBe('image/png')
      expect(new Uint8Array(await assetResponse.arrayBuffer())).toEqual(pngBytes)

      // Admit a Web message through the real HTTP surface.
      const admitted = await fetch(`${origin}/api/channels/${created.channelId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ parts: [{ type: 'text', text: '你好，请回复我。' }], clientEventId: 'browser-1' }),
      })
      expect(admitted.status).toBe(200)

      // Wait for the DSH Agent Loop to settle (the scripted model replies via send_channel_message).
      const web = runtime.web
      const session = runtime.host
      const before = Date.now()
      // Poll the Channel history endpoint until the agent reply lands (bounded wait, no fake clock).
      for (;;) {
        const latest = HostApiContracts.listChannelMessages.parseResponse(
          await (await fetch(`${origin}/api/channels/${created.channelId}/messages?limit=40`)).json(),
        )
        const agentMessages = latest.messages.filter((message) => message.role === 'agent')
        if (
          agentMessages.some((message) =>
            message.parts.some((part) => part.type === 'text' && part.text === '这是通信工具确认发送的回复。'),
          )
        ) {
          break
        }
        if (Date.now() - before > 10_000) throw new Error('Timed out waiting for the communication-tool reply.')
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      void web
      void session

      // Only the communication-tool reply is a channel message; raw model text stays internal.
      const finalSnapshot = HostApiContracts.listChannelMessages.parseResponse(
        await (await fetch(`${origin}/api/channels/${created.channelId}/messages?limit=40`)).json(),
      )
      const allTexts = finalSnapshot.messages.flatMap((message) =>
        message.parts
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .filter((text) => text.length > 0),
      )
      expect(allTexts).toContain('这是通信工具确认发送的回复。')
      expect(allTexts.join(' ')).not.toContain('模型原始文字只能留在运行轨迹')
      expect(allTexts.join(' ')).not.toContain('工具完成后的原始结束文字也不会发送')

      const firstPage = HostApiContracts.listChannelMessages.parseResponse(
        await (await fetch(`${origin}/api/channels/${created.channelId}/messages?limit=1`)).json(),
      )
      expect(firstPage.messages).toHaveLength(1)
      expect(firstPage.hasMore).toBe(true)
      const cursor = firstPage.messages[0]!
      const olderPage = HostApiContracts.listChannelMessages.parseResponse(
        await (
          await fetch(
            `${origin}/api/channels/${created.channelId}/messages?limit=1&beforeOccurredAt=${cursor.occurredAt}&beforeSourceId=${cursor.id}`,
          )
        ).json(),
      )
      expect(olderPage.messages).toHaveLength(1)
      expect(olderPage.messages[0]?.id).not.toBe(cursor.id)

      const observerResponse = await fetch(`${origin}/api/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          displayName: '观察智能体',
          persona: '',
          model: { provider: 'test-provider', model: 'chat-model' },
        }),
      })
      const observer = HostApiContracts.createAgent.parseResponse(await observerResponse.json())
      const bindingResponse = await fetch(`${origin}/api/bindings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          agentId: observer.agentId,
          channelId: created.channelId,
          triggerPolicy: 'observe-only',
        }),
      })
      expect(bindingResponse.status).toBe(201)
      const reboundSnapshot = HostApiContracts.snapshot.parseResponse(
        await (await fetch(`${origin}/api/snapshot`)).json(),
      )
      expect(reboundSnapshot.agents.find((agent) => agent.id === observer.agentId)?.channels).toContain(
        created.channelId,
      )
      expect(reboundSnapshot.channels.find((channel) => channel.id === created.channelId)?.bindings).toEqual([
        expect.objectContaining({ agentId: observer.agentId, triggerPolicy: 'observe-only' }),
      ])
    } finally {
      api.dispose()
      await webContext.fiber.dispose()
      await runtime.dispose()
    }
  })

  it('creates a new AgentRevision when capabilities change through the API', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-cap-api-'))
    temporaryDirectories.push(directory)
    const runtime = await NekroRuntime.create({
      coreDatabasePath: path.join(directory, 'core.sqlite'),
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      assetRoot: path.join(directory, 'assets'),
      extensionDataRoot: path.join(directory, 'extension-data'),
      extensionCacheRoot: path.join(directory, 'extension-cache'),
    })
    const seeded = runtime.core.createAgentWithChannel(
      {
        displayName: '能力智能体',
        persona: '',
        model: { provider: 'test-provider', model: 'chat-model' },
      },
      {
        connectionId: runtime.webConnectionId,
        kind: 'web',
        triggerPolicy: 'always',
      },
    )
    const entity = { agentId: seeded.definition.id, channelId: seeded.channel.id }
    const before = runtime.repository.getAgent(entity.agentId)!
    const webContext = new Context()
    await webContext.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const api = createNekroHostApi(webContext.webServer, runtime)
    const origin = `http://127.0.0.1:${api.port}`
    try {
      const response = await fetch(`${origin}/api/agents/${entity.agentId}/capabilities`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dynamicCreation: true }),
      })
      expect(response.ok).toBe(true)
      const result = HostApiContracts.updateAgentCapabilities.parseResponse(await response.json())
      expect(result.capabilities).toMatchObject({
        dynamicCreation: true,
        developmentShell: false,
        unrestrictedFileAccess: false,
      })
      // 不可变 Revision：新 Revision id 与原不同。
      expect(result.currentRevisionId).not.toBe(before.revision.id)

      const restoredResponse = await fetch(`${origin}/api/agents/${entity.agentId}/capabilities`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dynamicCreation: false }),
      })
      expect(restoredResponse.ok).toBe(true)
      const restored = HostApiContracts.updateAgentCapabilities.parseResponse(await restoredResponse.json())
      expect(restored.currentRevisionId).toBe(before.revision.id)
      expect(restored.capabilities.dynamicCreation).toBe(false)
    } finally {
      api.dispose()
      await webContext.fiber.dispose()
      await runtime.dispose()
    }
  })

  it('defaults Web Search on only when the DSH Provider credential is ready', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-cap-default-api-'))
    temporaryDirectories.push(directory)
    const dshRoot = path.join(directory, 'dsh')
    await mkdir(dshRoot, { recursive: true })
    const runtime = await NekroRuntime.create({
      coreDatabasePath: path.join(directory, 'core.sqlite'),
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      assetRoot: path.join(directory, 'assets'),
      extensionDataRoot: path.join(directory, 'extension-data'),
      extensionCacheRoot: path.join(directory, 'extension-cache'),
      llmSettingsPath: path.join(dshRoot, 'settings.yaml'),
      llmCredentialPath: path.join(dshRoot, 'credentials.yaml'),
      configureLlm: async (context: Context) => {
        context.llm.registerAdapter(['test-provider'], new ScriptedCommunicationModel())
        await context.credentials.set(credentialRef('DEEPSEEK_API_KEY'), 'configured-test-key')
      },
    })
    const webContext = new Context()
    await webContext.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const api = createNekroHostApi(webContext.webServer, runtime)
    const origin = `http://127.0.0.1:${api.port}`
    try {
      const response = await fetch(`${origin}/api/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          displayName: '搜索默认智能体',
          persona: '',
          model: { provider: 'test-provider', model: 'chat-model' },
        }),
      })
      expect(response.status, await response.clone().text()).toBe(201)
      const created = HostApiContracts.createAgent.parseResponse(await response.json())
      expect(runtime.repository.getAgent(created.agentId)?.revision.capabilities).toMatchObject({
        subagents: true,
        fileTools: false,
        webSearch: true,
      })
    } finally {
      api.dispose()
      await webContext.fiber.dispose()
      await runtime.dispose()
    }
  })

  it('revises persona and model through the immutable revision API', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-revision-api-'))
    temporaryDirectories.push(directory)
    const runtime = await NekroRuntime.create({
      coreDatabasePath: path.join(directory, 'core.sqlite'),
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      assetRoot: path.join(directory, 'assets'),
      extensionDataRoot: path.join(directory, 'extension-data'),
      extensionCacheRoot: path.join(directory, 'extension-cache'),
    })
    const seeded = runtime.core.createAgentWithChannel(
      {
        displayName: '旧名称',
        persona: '旧人设',
        model: { provider: 'old-provider', model: 'old-model', reasoningEffort: 'high' },
      },
      {
        connectionId: runtime.webConnectionId,
        kind: 'web',
        triggerPolicy: 'always',
      },
    )
    const entity = { agentId: seeded.definition.id, channelId: seeded.channel.id }
    const before = runtime.repository.getAgent(entity.agentId)!
    const webContext = new Context()
    await webContext.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const api = createNekroHostApi(webContext.webServer, runtime)
    const origin = `http://127.0.0.1:${api.port}`
    try {
      const response = await fetch(`${origin}/api/agents/${entity.agentId}/revision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedCurrentRevisionId: before.revision.id,
          displayName: '新名称',
          persona: '新人设',
          model: { provider: 'new-provider', model: 'new-model' },
        }),
      })
      expect(response.ok).toBe(true)
      const after = runtime.repository.getAgent(entity.agentId)!
      expect(after.revision.id).not.toBe(before.revision.id)
      expect(after.revision).toMatchObject({
        displayName: '新名称',
        persona: '新人设',
        model: { provider: 'new-provider', model: 'new-model' },
        capabilities: before.revision.capabilities,
      })
    } finally {
      api.dispose()
      await webContext.fiber.dispose()
      await runtime.dispose()
    }
  })

  it('persists a DSH provider and write-only credential, then restores it after restart', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-llm-settings-'))
    temporaryDirectories.push(directory)
    const settingsPath = path.join(directory, 'dsh', 'settings.yaml')
    const credentialPath = path.join(directory, 'dsh', '.credentials.yaml')
    const createRuntime = () =>
      NekroRuntime.create({
        coreDatabasePath: path.join(directory, 'core.sqlite'),
        sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
        assetRoot: path.join(directory, 'assets'),
        extensionDataRoot: path.join(directory, 'extension-data'),
        extensionCacheRoot: path.join(directory, 'extension-cache'),
        llmSettingsPath: settingsPath,
        llmCredentialPath: credentialPath,
        configureLlm: configureDshLlmProviders([]),
      })

    const first = await createRuntime()
    const firstWeb = new Context()
    await firstWeb.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const firstApi = createNekroHostApi(firstWeb.webServer, first)
    try {
      const before = LlmProviderSnapshotSchema.parse(
        await (await fetch(`http://127.0.0.1:${firstApi.port}/api/llm/providers`)).json(),
      )
      const opencode = before.providers.find((provider) => provider.provider === 'opencode-go')!
      expect(opencode.configured).toBe(false)
      const savedResponse = await fetch(`http://127.0.0.1:${firstApi.port}/api/llm/providers/opencode-go`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedRevision: opencode.settingsRevision, apiKey: 'write-only-test-key' }),
      })
      expect(savedResponse.ok).toBe(true)
      const savedText = await savedResponse.text()
      expect(savedText).not.toContain('write-only-test-key')
      const saved = LlmProviderSnapshotSchema.parse(JSON.parse(savedText))
      expect(saved.providers.find((provider) => provider.provider === 'opencode-go')?.active).toBe(true)

      const customResponse = await fetch(`http://127.0.0.1:${firstApi.port}/api/llm/providers/acme-gateway`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: saved.providers[0]!.settingsRevision,
          apiKey: 'custom-write-only-test-key',
          displayName: 'Acme Gateway',
          baseURL: 'https://gateway.example.test/v1',
          api: 'openai-completions',
          models: [{ id: 'acme-chat', name: 'Acme Chat', contextWindow: 64_000, maxTokens: 8_000 }],
        }),
      })
      expect(customResponse.ok).toBe(true)
      const customText = await customResponse.text()
      expect(customText).not.toContain('custom-write-only-test-key')
      const custom = LlmProviderSnapshotSchema.parse(JSON.parse(customText))
      expect(custom.providers.find((provider) => provider.provider === 'acme-gateway')?.active).toBe(true)
      const customRow = custom.providers.find((provider) => provider.provider === 'acme-gateway')!
      const editedResponse = await fetch(`http://127.0.0.1:${firstApi.port}/api/llm/providers/acme-gateway`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: customRow.settingsRevision,
          displayName: 'Acme Gateway Updated',
          baseURL: 'https://gateway.example.test/v2',
          api: 'openai-responses',
          models: [{ id: 'acme-next', name: 'Acme Next' }],
        }),
      })
      expect(editedResponse.ok).toBe(true)

      const pluginResponse = await fetch(`http://127.0.0.1:${firstApi.port}/api/dsh/plugins`)
      expect(pluginResponse.ok).toBe(true)
      const pluginCatalog = DshPluginCatalogSchema.parse(await pluginResponse.json())
      expect(pluginCatalog.plugins).toContainEqual(
        expect.objectContaining({
          packageName: '@deepseek-ai/dsh-web-search-deepseek',
          overall: 'verified',
          settingsNamespaces: ['web-search-deepseek'],
        }),
      )

      const settingsResponse = await fetch(`http://127.0.0.1:${firstApi.port}/api/dsh/settings`)
      expect(settingsResponse.ok).toBe(true)
      const settingsText = await settingsResponse.text()
      expect(settingsText).not.toContain('write-only-test-key')
      expect(settingsText).not.toContain('custom-write-only-test-key')
      const settings = DshSettingsSnapshotSchema.parse(JSON.parse(settingsText))
      const webSearch = settings.namespaces.find((namespace) => namespace.ns === 'web-search-deepseek')!
      expect(webSearch.resolved).toMatchObject({ apiKeyEnv: 'DEEPSEEK_API_KEY', maxTokens: 1024, maxUses: 2 })
      expect(webSearch.secrets).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: ['apiKey'], set: false })]),
      )

      const mutateResponse = await fetch(
        `http://127.0.0.1:${firstApi.port}/api/dsh/settings/web-search-deepseek/mutate`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            expectedRevision: webSearch.revision,
            ops: [{ op: 'set', path: ['maxUses'], value: 3 }],
          }),
        },
      )
      expect(mutateResponse.ok).toBe(true)
      const mutated = DshSettingsMutationSchema.parse(await mutateResponse.json())
      expect(mutated).toMatchObject({ resolved: { maxUses: 3 } })
      const conflictResponse = await fetch(
        `http://127.0.0.1:${firstApi.port}/api/dsh/settings/web-search-deepseek/mutate`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            expectedRevision: webSearch.revision,
            ops: [{ op: 'set', path: ['maxUses'], value: 4 }],
          }),
        },
      )
      expect(conflictResponse.status).toBe(409)
      const unsetResponse = await fetch(
        `http://127.0.0.1:${firstApi.port}/api/dsh/settings/web-search-deepseek/mutate`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            expectedRevision: mutated.revision,
            ops: [{ op: 'unset', path: ['maxUses'] }],
          }),
        },
      )
      expect(unsetResponse.ok).toBe(true)
      expect(await unsetResponse.json()).toMatchObject({ resolved: { maxUses: 2 } })

      const credentialSet = await fetch(`http://127.0.0.1:${firstApi.port}/api/dsh/credentials/DEEPSEEK_API_KEY`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: 'generic-write-only-key' }),
      })
      expect(credentialSet.ok).toBe(true)
      expect(await credentialSet.text()).not.toContain('generic-write-only-key')
      const credentialDescribe = await fetch(`http://127.0.0.1:${firstApi.port}/api/dsh/credentials/describe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refs: ['DEEPSEEK_API_KEY'] }),
      })
      expect(await credentialDescribe.json()).toEqual({
        credentials: { DEEPSEEK_API_KEY: { configured: true, source: 'file', writable: true } },
      })
      const invalidCredentialRef = await fetch(`http://127.0.0.1:${firstApi.port}/api/dsh/credentials/describe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refs: ['invalid/ref'] }),
      })
      expect(invalidCredentialRef.status).toBe(400)
      const credentialUnset = await fetch(`http://127.0.0.1:${firstApi.port}/api/dsh/credentials/DEEPSEEK_API_KEY`, {
        method: 'DELETE',
      })
      expect(await credentialUnset.json()).toEqual({ configured: false, writable: true })
    } finally {
      firstApi.dispose()
      await firstWeb.fiber.dispose()
      await first.dispose()
    }

    expect((await stat(credentialPath)).mode & 0o777).toBe(0o600)
    const second = await createRuntime()
    try {
      const restored = await second.host.getLlmProviderSettings()
      const restoredProvider = restored.providers.find((provider) => provider.provider === 'opencode-go')
      expect(restoredProvider?.configured).toBe(true)
      expect(restoredProvider?.active).toBe(true)
      expect(restoredProvider?.credential).toMatchObject({ configured: true, source: 'file' })
      const restoredCustom = restored.providers.find((provider) => provider.provider === 'acme-gateway')
      expect(restoredCustom?.active).toBe(true)
      expect(restoredCustom?.displayName).toBe('Acme Gateway Updated')
      expect(restoredCustom?.baseURL).toBe('https://gateway.example.test/v2')
      expect(restoredCustom?.api).toBe('openai-responses')
      expect(restoredCustom?.models).toEqual([{ id: 'acme-next', name: 'Acme Next' }])
      expect(await second.host.listAvailableLlmModels()).not.toHaveLength(0)
    } finally {
      await second.dispose()
    }
  })
})
