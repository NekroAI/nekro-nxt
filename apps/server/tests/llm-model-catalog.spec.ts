import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NekroRuntime } from '../src/bootstrap.js'
import { configureDshLlmProviders } from '../src/main.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const createRuntime = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-llm-catalog-'))
  temporaryDirectories.push(directory)
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
