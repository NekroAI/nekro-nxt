import { LlmAdapter, CallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NekroRuntime } from '../src/bootstrap.js'
import { createNekroHostApi } from '../src/host-api.js'
import { configureDshLlmProviders } from '../src/main.js'

const temporaryDirectories: string[] = []

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
        name: 'send_message',
        arguments: JSON.stringify({
          target: { type: 'current' },
          parts: [{ type: 'text', text: '这是通信工具确认发送的回复。' }],
        }),
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '这段模型原始文字只能留在运行轨迹。' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '这段模型原始文字只能留在运行轨迹。' } }
      yield { type: 'block-start', index: 1, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 1, id: callId, name: 'send_message', argumentsDelta: toolCall.arguments }
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
      const created = (await createdResponse.json()) as { agentId: string; channelId: string; connectionId: string }
      expect(created.agentId.length).toBeGreaterThan(0)
      expect(created.channelId.length).toBeGreaterThan(0)

      // The authoritative snapshot exposes the new intelligent-agent + its Web Channel.
      const snapshot = (await (await fetch(`${origin}/api/snapshot`)).json()) as {
        connectionAdapters: Array<{ key: string; displayName: string; userCreatable: boolean }>
        models: Array<{ provider: string; id: string; name: string }>
        agents: Array<{ id: string; displayName: string; channels: string[] }>
        channels: Array<{
          id: string
          boundAgentId?: string
          bindings: Array<{ agentId: string; triggerPolicy: string }>
        }>
        messages: Array<{ role: string; parts: Array<{ type: string; text?: string }> }>
      }
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
      expect(snapshot.channels.some((channel) => channel.id === created.channelId)).toBe(true)
      expect(snapshot.channels.find((channel) => channel.id === created.channelId)?.boundAgentId).toBe(created.agentId)

      // Admit a Web message through the real HTTP surface.
      const admitted = await fetch(`${origin}/api/channels/${created.channelId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ parts: [{ type: 'text', text: '你好，请回复我。' }], clientEventId: 'browser-1' }),
      })
      expect(admitted.status).toBe(200)

      // Wait for the DSH Agent Loop to settle (the scripted model replies via send_message).
      const web = runtime.web
      const session = runtime.host
      const before = Date.now()
      // Poll the snapshot until the agent reply lands (bounded wait, no fake clock).
      for (;;) {
        const latest = (await (await fetch(`${origin}/api/snapshot`)).json()) as {
          messages: Array<{ role: string; parts: Array<{ type: string; text?: string }> }>
        }
        const agentMessages = latest.messages.filter((message) => message.role === 'agent')
        if (
          agentMessages.some((message) => message.parts.some((part) => part.text === '这是通信工具确认发送的回复。'))
        ) {
          break
        }
        if (Date.now() - before > 10_000) throw new Error('Timed out waiting for the communication-tool reply.')
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      void web
      void session

      // Only the communication-tool reply is a channel message; raw model text stays internal.
      const finalSnapshot = (await (await fetch(`${origin}/api/snapshot`)).json()) as {
        messages: Array<{ role: string; parts: Array<{ type: string; text?: string }> }>
      }
      const allTexts = finalSnapshot.messages.flatMap((message) =>
        message.parts.map((part) => part.text ?? '').filter((text) => text.length > 0),
      )
      expect(allTexts).toContain('这是通信工具确认发送的回复。')
      expect(allTexts.join(' ')).not.toContain('模型原始文字只能留在运行轨迹')
      expect(allTexts.join(' ')).not.toContain('工具完成后的原始结束文字也不会发送')

      const observerResponse = await fetch(`${origin}/api/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          displayName: '观察智能体',
          persona: '',
          model: { provider: 'test-provider', model: 'chat-model' },
        }),
      })
      const observer = (await observerResponse.json()) as { agentId: string }
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
      const reboundSnapshot = (await (await fetch(`${origin}/api/snapshot`)).json()) as {
        agents: Array<{ id: string; channels: string[] }>
        channels: Array<{ id: string; bindings: Array<{ agentId: string; triggerPolicy: string }> }>
      }
      expect(reboundSnapshot.agents.find((agent) => agent.id === observer.agentId)?.channels).toContain(
        created.channelId,
      )
      expect(reboundSnapshot.channels.find((channel) => channel.id === created.channelId)?.bindings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ agentId: created.agentId, triggerPolicy: 'always' }),
          expect.objectContaining({ agentId: observer.agentId, triggerPolicy: 'observe-only' }),
        ]),
      )
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
    const entity = runtime.createAgentWithWebChannel({
      displayName: '能力智能体',
      persona: '',
      model: { provider: 'test-provider', model: 'chat-model' },
    })
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
      const result = (await response.json()) as { currentRevisionId: string; capabilities: Record<string, boolean> }
      expect(result.capabilities).toMatchObject({
        dynamicCreation: true,
        developmentShell: false,
        fullFileAccess: false,
      })
      // 不可变 Revision：新 Revision id 与原不同。
      expect(result.currentRevisionId).not.toBe(before.revision.id)
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
    const entity = runtime.createAgentWithWebChannel({
      displayName: '旧名称',
      persona: '旧人设',
      model: { provider: 'old-provider', model: 'old-model', reasoningEffort: 'high' },
    })
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
      const before = (await (await fetch(`http://127.0.0.1:${firstApi.port}/api/llm/providers`)).json()) as {
        providers: Array<{ provider: string; settingsRevision: number; configured: boolean }>
      }
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
      const saved = JSON.parse(savedText) as {
        providers: Array<{ provider: string; active: boolean; settingsRevision: number }>
      }
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
      const custom = JSON.parse(customText) as {
        providers: Array<{ provider: string; active: boolean; settingsRevision: number }>
      }
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
