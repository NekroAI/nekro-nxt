import { describe, expect, it, vi } from 'vitest'
import { configSchema, type ExtensionCapabilities, type JsonValue } from '@nekro-nxt/contracts'
import { extensionManifestSchema } from '@nekro-nxt/extension-runtime'
import type { NxtCallContext, NxtPromptRenderApi } from '@nekro-nxt/extension-sdk'
import { memoryNxtStorage, resolveExtensionSecret } from '../src/extension-host-backends.js'
import {
  createNxtHostService,
  NxtCapabilityError,
  type NxtPromptRegistry,
  type NxtServiceBackends,
  type NxtServiceBinding,
} from '../src/extension-host-service.js'
import { commitExtensionConfigWithSecrets, maskExtensionSecrets } from '../src/extension-secret-config.js'

const callContext: NxtCallContext = {
  agent: { id: 'agt_FIXTURE', name: '示例智能体' },
  channel: { id: 'chn_FIXTURE', kind: 'group', displayName: '示例群' },
  latestInbound: {
    logicalMessageId: 'msg_FIXTURE',
    sender: { memberId: 'mbr_FIXTURE', displayName: '示例成员' },
    text: '你好',
    receivedAt: 1,
  },
}

const fixture = (capabilities: ExtensionCapabilities | undefined, config: JsonValue = {}) => {
  const fetch = vi.fn<NxtServiceBackends['fetch']>(() =>
    Promise.resolve({
      url: 'https://api.example.com/',
      status: 200,
      headers: {},
      contentType: 'text/plain',
      text: 'ok',
    }),
  )
  const createAsset = vi.fn<NxtServiceBackends['createAsset']>((_channelId, input) =>
    Promise.resolve({
      assetId: 'ast_FIXTURE',
      byteSize: (input.text ?? input.base64 ?? '').length,
      mediaType: 'text/plain',
    }),
  )
  const complete = vi.fn<NxtServiceBackends['complete']>((_binding, request, maxOutputTokens) =>
    Promise.resolve({ text: `reply:${request.messages.length}:${maxOutputTokens}` }),
  )
  const backends: NxtServiceBackends = {
    fetch,
    complete,
    storage: memoryNxtStorage(() => 1),
    secret: (binding, key) =>
      resolveExtensionSecret(
        { resolveCredential: (reference) => Promise.resolve(`secret-of:${reference}`) },
        binding.config(),
        key,
      ),
    createAsset,
    callContext: () => Promise.resolve(callContext),
    history: {
      list: () => Promise.resolve({ messages: [] }),
      search: () => Promise.resolve([]),
    },
  }
  const binding: NxtServiceBinding = {
    mode: 'activation',
    agentId: 'agt_FIXTURE',
    ownerKey: 'ext_FIXTURE',
    displayName: '示例扩展',
    channelId: 'chn_FIXTURE',
    capabilities: () => capabilities,
    config: () => config,
  }
  const sections: { name: string; text: string }[] = []
  const contexts = new Map<string, () => string>()
  const turnStarts = new Set<() => Promise<void>>()
  const prompt: NxtPromptRegistry = {
    section: (section) => {
      sections.push(section)
      return () => undefined
    },
    context: (entry) => {
      contexts.set(entry.name, entry.text)
      return () => contexts.delete(entry.name)
    },
    onTurnStart: (listener) => {
      turnStarts.add(listener)
      return () => turnStarts.delete(listener)
    },
  }
  return {
    nxt: createNxtHostService(binding, backends, prompt),
    fetch,
    complete,
    createAsset,
    sections,
    contexts,
    startTurn: async () => {
      for (const listener of turnStarts) await listener()
    },
  }
}

describe('nxt Host service', () => {
  it('names the Manifest field to add when a capability is missing', async () => {
    const { nxt } = fixture(undefined)
    await expect(nxt.http.fetch('https://api.example.com/')).rejects.toThrow(/permissions\.capabilities/u)
    await expect(nxt.storage.get('key')).rejects.toBeInstanceOf(NxtCapabilityError)
    await expect(nxt.assets.create({ text: 'x' })).rejects.toThrow(/assets/u)
    await expect(nxt.history.list()).rejects.toThrow(/history/u)
    expect(() => nxt.prompt.static('usage', '用法')).toThrow(/kind: 'static'/u)
  })

  it('derives the egress policy from the declaration and the user-configured host', async () => {
    const domains = fixture({ network: { mode: 'domains', domains: ['api.example.com'] } })
    await domains.nxt.http.fetch('https://api.example.com/v1')
    expect(domains.fetch.mock.calls[0]?.[0]).toEqual({ mode: 'domains', domains: ['api.example.com'] })

    const configured = fixture(
      { network: { mode: 'config', fields: ['baseUrl'] } },
      { baseUrl: 'http://search.example.lan:8080/api' },
    )
    await configured.nxt.http.fetch('http://search.example.lan:8080/api/search')
    expect(configured.fetch.mock.calls[0]?.[0]).toEqual({ mode: 'config', hosts: ['search.example.lan:8080'] })
  })

  it('isolates storage by declared scope and requires a member for member scope', async () => {
    const { nxt } = fixture({ storage: { scopes: ['agent', 'channel', 'member'] } })
    await nxt.storage.set('mood', { level: 'friendly' })
    await nxt.storage.set('mood', { level: 'busy' }, { scope: 'channel' })
    await nxt.storage.set('mood', 'warm', { scope: 'member', memberId: 'mbr_FIXTURE' })
    expect(await nxt.storage.get('mood')).toEqual({ level: 'friendly' })
    expect(await nxt.storage.get('mood', { scope: 'channel' })).toEqual({ level: 'busy' })
    expect(await nxt.storage.get('mood', { scope: 'member', memberId: 'mbr_FIXTURE' })).toBe('warm')
    await expect(nxt.storage.get('mood', { scope: 'member' })).rejects.toThrow(/memberId/u)
    await expect(nxt.storage.get('mood', { scope: 'shared' })).rejects.toThrow(/shared/u)
    await expect(nxt.storage.set('bad key!', 1)).rejects.toThrow(/存储键/u)
    expect((await nxt.storage.list({ prefix: 'mo' })).entries.map(({ key }) => key)).toEqual(['mood'])
  })

  it('enforces the declared storage quota', async () => {
    const { nxt } = fixture({ storage: { scopes: ['agent'], quotaBytes: 1024 } })
    await nxt.storage.set('a', 'x'.repeat(900))
    await expect(nxt.storage.set('b', 'x'.repeat(200))).rejects.toThrow(/存储已满/u)
    await nxt.storage.set('a', 'x'.repeat(100))
    await nxt.storage.set('b', 'x'.repeat(200))
  })

  it('saves channel assets and downloads through the controlled fetch', async () => {
    const { nxt, createAsset } = fixture({
      assets: { write: true },
      network: { mode: 'domains', domains: ['api.example.com'] },
    })
    expect(await nxt.assets.create({ text: 'poster' })).toMatchObject({ assetId: 'ast_FIXTURE' })
    await nxt.assets.fromUrl('https://api.example.com/image.png', { name: 'image.png' })
    expect(createAsset.mock.calls[1]).toEqual([
      'chn_FIXTURE',
      { text: 'ok', mediaType: 'text/plain', name: 'image.png' },
    ])
  })

  it('labels static sections and renders dynamic context once per turn within its budget', async () => {
    const { nxt, sections, contexts, startTurn } = fixture({
      storage: { scopes: ['agent'] },
      context: [
        { name: 'usage', kind: 'static', maxChars: 100 },
        { name: 'mood', kind: 'dynamic', maxChars: 10 },
      ],
    })
    nxt.prompt.static('usage', '查询天气时调用 weather_today。')
    expect(sections[0]?.text).toBe('[扩展：示例扩展]\n查询天气时调用 weather_today。')

    await nxt.storage.set('mood', 'friendly')
    const render = vi.fn(
      async ({ storage }: NxtPromptRenderApi) => `当前心情：${JSON.stringify(await storage.get('mood'))}，持续很久`,
    )
    nxt.prompt.dynamic('mood', render)
    const text = () => [...contexts.values()][0]?.()
    expect(text()).toBe('')
    await startTurn()
    expect(text()).toBe('[扩展：示例扩展]\n当前心情："fri…')
    expect(text()).toBe(text())
    expect(render).toHaveBeenCalledTimes(1)
    expect(() => nxt.prompt.dynamic('mood', () => '')).toThrow(/已注册/u)
  })

  it('keeps the previous dynamic snapshot when a render fails', async () => {
    const { nxt, contexts, startTurn } = fixture({ context: [{ name: 'mood', kind: 'dynamic', maxChars: 50 }] })
    let fail = false
    nxt.prompt.dynamic('mood', () => {
      if (fail) throw new Error('fixture failure')
      return '稳定'
    })
    await startTurn()
    fail = true
    await startTurn()
    expect([...contexts.values()][0]?.()).toBe('[扩展：示例扩展]\n稳定')
  })

  it('budgets model calls per turn and caps the output length to the declaration', async () => {
    const missing = fixture(undefined)
    await expect(missing.nxt.llm.complete({ messages: [{ role: 'user', text: '分类' }] })).rejects.toThrow(/llm/u)

    const { nxt, complete, startTurn } = fixture({ llm: { maxCallsPerTurn: 2, maxOutputTokens: 256 } })
    await startTurn()
    expect(await nxt.llm.complete({ messages: [{ role: 'user', text: '分类' }], maxOutputTokens: 9999 })).toEqual({
      text: 'reply:1:256',
    })
    await nxt.llm.complete({ messages: [{ role: 'user', text: '再分类' }], maxOutputTokens: 64 })
    expect(complete.mock.calls.map(([, , tokens]) => tokens)).toEqual([256, 64])
    await expect(nxt.llm.complete({ messages: [{ role: 'user', text: '第三次' }] })).rejects.toThrow(/上限 2/u)
    await expect(nxt.llm.complete({ messages: [] })).rejects.toThrow(/messages/u)
    await startTurn()
    await expect(nxt.llm.complete({ messages: [{ role: 'user', text: '新一轮' }] })).resolves.toMatchObject({
      text: 'reply:1:256',
    })
  })

  it('reads secrets only from Host credential references', async () => {
    const { nxt } = fixture(undefined, {
      token: 'credential:local:0123456789abcdef0123456789abcdef',
      plain: 'not-a-reference',
    })
    expect(await nxt.secrets.get('token')).toBe('secret-of:credential:local:0123456789abcdef0123456789abcdef')
    expect(await nxt.secrets.get('plain')).toBeUndefined()
    expect(await nxt.secrets.get('missing')).toBeUndefined()
  })
})

describe('extension secret configuration', () => {
  const manifest = extensionManifestSchema.parse({
    schemaVersion: 6,
    extensionId: 'ext_FIXTURE',
    revisionId: 'xrv_FIXTURE',
    scope: 'agent',
    entrypoints: { host: 'source/host.ts' },
    contributions: [],
    config: {
      schema: configSchema.object({ city: configSchema.string('城市'), token: configSchema.secret('令牌') }),
    },
  })

  it('never returns secret references to the client', () => {
    expect(maskExtensionSecrets(manifest, { city: '示例市', token: 'credential:local:ref' })).toEqual({
      config: { city: '示例市' },
      configuredSecrets: ['token'],
    })
  })

  it('stores new secrets, keeps old ones on empty drafts and cleans up on failure', async () => {
    const saved: string[] = []
    const deleted: string[] = []
    const credentials = {
      save: (secret: string) => {
        saved.push(secret)
        return Promise.resolve(`credential:local:new${saved.length}`)
      },
      delete: (reference: string) => {
        deleted.push(reference)
        return Promise.resolve()
      },
    }
    const kept = await commitExtensionConfigWithSecrets({
      manifest,
      previous: { city: '旧市', token: 'credential:local:old' },
      config: { city: '新市', token: 'client-forged-reference' },
      secrets: { token: '' },
      credentials,
      commit: (config) => Promise.resolve(config),
    })
    expect(kept).toEqual({ city: '新市', token: 'credential:local:old' })

    const replaced = await commitExtensionConfigWithSecrets({
      manifest,
      previous: { city: '旧市', token: 'credential:local:old' },
      config: { city: '新市' },
      secrets: { token: 'fixture-secret' },
      credentials,
      commit: (config) => Promise.resolve(config),
    })
    expect(replaced).toEqual({ city: '新市', token: 'credential:local:new1' })
    expect(deleted).toEqual(['credential:local:old'])

    await expect(
      commitExtensionConfigWithSecrets({
        manifest,
        previous: { token: 'credential:local:old' },
        config: {},
        secrets: { token: 'second-secret' },
        credentials,
        commit: () => Promise.reject(new Error('fixture commit failure')),
      }),
    ).rejects.toThrow('fixture commit failure')
    expect(deleted).toEqual(['credential:local:old', 'credential:local:new2'])
    await expect(
      commitExtensionConfigWithSecrets({
        manifest,
        previous: {},
        config: {},
        secrets: { city: 'x' },
        credentials,
        commit: (config) => Promise.resolve(config),
      }),
    ).rejects.toThrow(/不是凭据字段/u)
  })
})
