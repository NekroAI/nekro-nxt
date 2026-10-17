import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NekroRuntime } from '../src/bootstrap.js'
import { configureDshLlmProviders } from '../src/main.js'
import { assertReasoningEffort } from '../src/host-route-support.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const createRuntime = async (signedIn = false) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-llm-catalog-'))
  temporaryDirectories.push(directory)
  if (signedIn) {
    await mkdir(path.join(directory, 'dsh'))
    await writeFile(
      path.join(directory, 'dsh', '.credentials.yaml'),
      JSON.stringify({
        version: 1,
        records: {
          'llm-pi-ai/openai': {
            kind: 'grant',
            payload: {
              type: 'oauth',
              access: 'synthetic-account-catalog-token',
              refresh: 'synthetic-account-catalog-refresh',
              expires: Date.now() + 3_600_000,
              clientId: 'synthetic-issued-client',
            },
          },
        },
      }),
      { mode: 0o600 },
    )
  }
  const runtime = await NekroRuntime.create({
    coreDatabasePath: path.join(directory, 'core.sqlite'),
    sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
    assetRoot: path.join(directory, 'assets'),
    extensionDataRoot: path.join(directory, 'extension-data'),
    extensionCacheRoot: path.join(directory, 'extension-cache'),
    llmSettingsPath: path.join(directory, 'dsh', 'settings.yaml'),
    llmCredentialPath: path.join(directory, 'dsh', '.credentials.yaml'),
    configureLlm: configureDshLlmProviders([]),
  })
  return { runtime }
}

const providerView = async (runtime: NekroRuntime, provider: string) => {
  const view = (await runtime.host.getLlmProviderSettings()).providers.find((entry) => entry.provider === provider)
  if (!view) throw new Error(`missing provider ${provider}`)
  return view
}

describe('LLM model catalog management', () => {
  it('queries the account catalog when discovery echoes the saved protocol and address', async () => {
    const network = vi.fn(() =>
      Promise.resolve(
        Response.json({
          models: [
            { slug: 'synthetic-account-chat', display_name: '账号模型', visibility: 'list' },
            { slug: 'synthetic-hidden', display_name: '隐藏模型', visibility: 'hide' },
          ],
        }),
      ),
    )
    vi.stubGlobal('fetch', network)
    const { runtime } = await createRuntime(true)
    try {
      const initial = await providerView(runtime, 'openai')
      await runtime.host.subscriptionAction('openai', {
        action: 'use-subscription',
        expectedRevision: initial.settingsRevision,
      })
      const switched = await providerView(runtime, 'openai')
      await runtime.host.saveLlmProvider({
        provider: 'openai',
        expectedRevision: switched.settingsRevision,
        baseURL: 'https://api.openai.com/v1',
        api: 'openai-responses',
      })
      for (const echo of [
        {},
        { api: 'openai-responses' },
        { baseURL: 'https://api.openai.com/v1', api: 'openai-responses' },
      ]) {
        expect(
          await runtime.host.discoverLlmProviderModels({ provider: 'openai', settingsNs: 'llm-pi-ai', ...echo }),
        ).toEqual([{ id: 'synthetic-account-chat', name: '账号模型' }])
      }
      expect(network).toHaveBeenCalledTimes(3)
      for (const call of network.mock.calls) {
        expect(call).toMatchObject([
          'https://api.openai.com/v1/models',
          {
            headers: { authorization: 'Bearer synthetic-account-catalog-token' },
          },
        ])
      }
      network.mockClear()
      for (const draft of [
        { api: 'openai-completions' },
        { baseURL: 'https://gateway.example.test/v1' },
        { apiKey: 'synthetic-draft-key' },
      ]) {
        const models = await runtime.host.discoverLlmProviderModels({ provider: 'openai', ...draft })
        expect(models.some((model) => model.id === 'gpt-4')).toBe(true)
      }
      expect(network).not.toHaveBeenCalled()

      const customized = await providerView(runtime, 'openai')
      await runtime.host.saveLlmProvider({
        provider: 'openai',
        expectedRevision: customized.settingsRevision,
        models: [{ id: 'synthetic-custom-selection' }],
      })
      const restored = await runtime.host.restoreLlmProviderModels(
        'openai',
        (await providerView(runtime, 'openai')).settingsRevision,
      )
      expect(
        restored.providers.find((provider) => provider.provider === 'openai')?.models.map((model) => model.id),
      ).toEqual(['synthetic-account-chat'])
      expect(network).toHaveBeenCalledTimes(1)
    } finally {
      await runtime.dispose()
    }
  })

  it('reports account catalog failures instead of returning the installed directory', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(null, { status: 503 })))
    const { runtime } = await createRuntime(true)
    try {
      await runtime.host.subscriptionAction('openai', {
        action: 'use-subscription',
        expectedRevision: (await providerView(runtime, 'openai')).settingsRevision,
      })
      await expect(
        runtime.host.discoverLlmProviderModels({ provider: 'openai', api: 'openai-responses' }),
      ).rejects.toThrow('没能读取')
    } finally {
      await runtime.dispose()
    }
  })

  it('does not offer the installed directory before a subscription has a model selection', async () => {
    const { runtime } = await createRuntime()
    try {
      await runtime.host.subscriptionAction('openai', {
        action: 'use-subscription',
        expectedRevision: (await providerView(runtime, 'openai')).settingsRevision,
      })
      const pending = await providerView(runtime, 'openai')
      expect(pending.models).toEqual([])
      expect((await runtime.host.listAvailableLlmModels()).filter((model) => model.provider === 'openai')).toEqual([])
      await runtime.host.saveLlmProvider({
        provider: 'openai',
        expectedRevision: pending.settingsRevision,
        models: [{ id: 'synthetic-account-chat', name: '账号模型' }],
      })
      expect((await providerView(runtime, 'openai')).models.map((model) => model.id)).toEqual([
        'synthetic-account-chat',
      ])
      expect(
        (await runtime.host.listAvailableLlmModels()).filter((model) => model.provider === 'openai'),
      ).toMatchObject([{ id: 'synthetic-account-chat' }])
    } finally {
      await runtime.dispose()
    }
  })

  it('offers the thinking levels a saved model declares and refuses one it does not', async () => {
    const { runtime } = await createRuntime()
    try {
      const openai = await providerView(runtime, 'openai')
      await runtime.host.saveLlmProvider({
        provider: 'openai',
        expectedRevision: openai.settingsRevision,
        api: 'openai-responses',
        models: [{ id: 'sample-reasoner', name: '示例推理模型', reasoningEfforts: ['low', 'medium', 'max'] }],
      })
      const listed = (await runtime.host.listAvailableLlmModels()).find((model) => model.id === 'sample-reasoner')
      expect(listed?.reasoning?.efforts.map((effort) => effort.id)).toEqual(['low', 'medium', 'max'])
      // The provider page reads the declared levels back, so a later save keeps them.
      expect((await providerView(runtime, 'openai')).models[0]?.reasoningEfforts).toEqual(['low', 'medium', 'max'])

      const choice = { provider: 'openai', model: 'sample-reasoner' }
      await expect(assertReasoningEffort(runtime, { ...choice, reasoningEffort: 'max' })).resolves.toBeUndefined()
      await expect(assertReasoningEffort(runtime, { ...choice, reasoningEffort: 'xhigh' })).rejects.toThrow('思考强度')
      await expect(assertReasoningEffort(runtime, choice)).resolves.toBeUndefined()
    } finally {
      await runtime.dispose()
    }
  })

  it('keeps a signed-in route marked as a ChatGPT plan in the list a save returns', async () => {
    const { runtime } = await createRuntime()
    try {
      const openai = await providerView(runtime, 'openai')
      expect(openai.subscription).toEqual({ label: 'ChatGPT', active: false, accountLabel: null })
      await runtime.host.subscriptionAction('openai', {
        action: 'use-subscription',
        expectedRevision: openai.settingsRevision,
      })
      const switched = await providerView(runtime, 'openai')
      const saved = await runtime.host.saveLlmProvider({
        provider: 'openai',
        expectedRevision: switched.settingsRevision,
        models: [{ id: 'gpt-5', name: 'GPT-5' }],
      })
      // The page replaces its list with this response; without the mark the accounts disappear.
      expect(saved.providers.find((entry) => entry.provider === 'openai')?.subscription).toMatchObject({ active: true })
    } finally {
      await runtime.dispose()
    }
  })

  it('edits the DeepSeek catalog with vision models and restores the built-in list', async () => {
    const { runtime } = await createRuntime()
    try {
      const initial = await providerView(runtime, 'deepseek-official')
      expect(initial).toMatchObject({ modelsCustomized: false, discoverable: false })
      expect(initial.models.find((model) => model.id === 'deepseek-flash')?.inputModalities).toContain('image')
      await expect(runtime.host.discoverLlmProviderModels({ provider: 'deepseek-official' })).rejects.toThrow(
        '请手动添加模型',
      )

      await runtime.host.saveLlmProvider({
        provider: 'deepseek-official',
        expectedRevision: initial.settingsRevision,
        models: [
          { id: 'deepseek-flash', name: 'DeepSeek Flash', inputModalities: ['text', 'image'] },
          {
            id: 'deepseek-synthetic-next',
            name: '合成新模型',
            contextWindow: 200_000,
            inputModalities: ['text', 'image'],
          },
        ],
      })
      const edited = await providerView(runtime, 'deepseek-official')
      expect(edited.modelsCustomized).toBe(true)
      expect(edited.models.map((model) => model.id)).toEqual(['deepseek-flash', 'deepseek-synthetic-next'])
      const available = await runtime.host.listAvailableLlmModels()
      expect(available.find((model) => model.id === 'deepseek-synthetic-next')).toMatchObject({
        provider: 'deepseek-official',
        inputModalities: ['text', 'image'],
      })
      // The adapter's own per-model hints survive an edit made through product settings.
      const userLayer = JSON.stringify(
        runtime.host.listDshSettings().find((namespace) => namespace.ns === 'llm-deepseek')?.user,
      )
      expect(userLayer).toContain('systemPromptUpdate')
      expect(userLayer).toContain('deepseek-synthetic-next')

      await runtime.host.restoreLlmProviderModels('deepseek-official', edited.settingsRevision)
      const restored = await providerView(runtime, 'deepseek-official')
      expect(restored.modelsCustomized).toBe(false)
      expect(restored.models.map((model) => model.id)).toEqual(initial.models.map((model) => model.id))
    } finally {
      await runtime.dispose()
    }
  })

  it('adds an uncatalogued model to a built-in route once the route names its endpoint', async () => {
    const { runtime } = await createRuntime()
    try {
      const opencode = await providerView(runtime, 'opencode-go')
      expect(opencode.discoverable).toBe(true)
      await runtime.host.saveLlmProvider({
        provider: 'opencode-go',
        expectedRevision: opencode.settingsRevision,
        apiKey: 'synthetic-write-only-key',
      })
      const configured = await providerView(runtime, 'opencode-go')
      const [first] = configured.models
      if (!first) throw new Error('catalog route serves no models')
      await expect(
        runtime.host.saveLlmProvider({
          provider: 'opencode-go',
          expectedRevision: configured.settingsRevision,
          models: [{ id: first.id }, { id: 'synthetic-uncatalogued' }],
        }),
      ).rejects.toThrow('请在高级设置中填写 API 地址并选择协议')
      await runtime.host.saveLlmProvider({
        provider: 'opencode-go',
        expectedRevision: configured.settingsRevision,
        baseURL: 'https://gateway.example.test/v1',
        api: 'openai-completions',
        models: [
          { id: first.id, name: first.name },
          { id: 'synthetic-vision-model', name: '合成视觉模型', inputModalities: ['text', 'image'] },
        ],
      })
      const edited = await providerView(runtime, 'opencode-go')
      expect(edited.modelsCustomized).toBe(true)
      expect(edited.models.find((model) => model.id === 'synthetic-vision-model')?.inputModalities).toEqual([
        'text',
        'image',
      ])
      await runtime.host.restoreLlmProviderModels('opencode-go', edited.settingsRevision)
      const restored = await providerView(runtime, 'opencode-go')
      expect(restored.modelsCustomized).toBe(false)
      expect(restored.models.map((model) => model.id)).toEqual(configured.models.map((model) => model.id))
    } finally {
      await runtime.dispose()
    }
  })

  it('rejects duplicate model ids and restoring a custom provider', async () => {
    const { runtime } = await createRuntime()
    try {
      const deepseek = await providerView(runtime, 'deepseek-official')
      await expect(
        runtime.host.saveLlmProvider({
          provider: 'deepseek-official',
          expectedRevision: deepseek.settingsRevision,
          models: [{ id: 'same' }, { id: 'same' }],
        }),
      ).rejects.toThrow('模型 ID 不能重复')
      await runtime.host.saveLlmProvider({
        provider: 'synthetic-gateway',
        expectedRevision: (await providerView(runtime, 'opencode-go')).settingsRevision,
        displayName: '合成网关',
        baseURL: 'https://gateway.example.test/v1',
        api: 'openai-completions',
        apiKey: 'synthetic-write-only-key',
        models: [{ id: 'synthetic-chat' }],
      })
      const custom = await providerView(runtime, 'synthetic-gateway')
      await expect(runtime.host.restoreLlmProviderModels('synthetic-gateway', custom.settingsRevision)).rejects.toThrow(
        '没有可恢复的默认模型列表',
      )
    } finally {
      await runtime.dispose()
    }
  })
})
