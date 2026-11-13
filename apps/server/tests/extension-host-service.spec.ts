import { describe, expect, it, vi } from 'vitest'
import {
  AgentIdSchema,
  ChannelEventIdSchema,
  ChannelIdSchema,
  configSchema,
  CredentialIdSchema,
  ExtensionCapabilitiesSchema,
  ExtensionIdSchema,
  ExtensionRevisionIdSchema,
  LogicalMessageIdSchema,
  type ChannelEventId,
  type ChannelId,
  type ExtensionCapabilities,
  type JsonValue,
} from '@nekro-nxt/contracts'
import {
  CoreService,
  type BindingRecord,
  type ChannelEventRecord,
  type ChannelMemberRecord,
  type ChannelRecord,
} from '@nekro-nxt/core'
import { extensionManifestSchema } from '@nekro-nxt/extension-runtime'
import type { NxtCallContext, NxtInboundHandler, NxtInboundMessage, NxtPromptRenderApi } from '@nekro-nxt/extension-sdk'
import { openMigratedCoreDatabase, SqliteCoreRepository } from '@nekro-nxt/storage-sqlite'
import {
  createNxtProductBackends,
  memoryNxtJobs,
  memoryNxtStorage,
  resolveExtensionSecret,
  type NamedCredentialResolver,
  type NamedCredentialUse,
  type NxtProductFacts,
} from '../src/extension-host-backends.js'
import {
  createNxtHostService,
  NxtCapabilityError,
  type NxtPromptRegistry,
  type NxtServiceBackends,
  type NxtServiceBinding,
} from '../src/extension-host-service.js'
import { memoryIndexEngine } from '../src/extension-index.js'
import { emptyExtensionLibrary, unusedNxtBackends, unusedMediaBackends } from './fixtures/unused-nxt-backends.js'
import { commitExtensionConfigWithSecrets, maskExtensionSecrets } from '../src/extension-secret-config.js'
import { ExtensionInboundHookGate, memoryInboundHookDecisionStore } from '../src/extension-inbound-hooks.js'
import type { PersistentInboundHandler } from '../src/persistent-extension-mounts.js'

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

/** Secret fields the fixture Manifest declares in the agent layer. */
const DECLARED_SECRETS = ['token', 'plain', 'missing', 'named', 'requestOnly', 'foreign']

const fixture = (
  capabilities: ExtensionCapabilities | undefined,
  config: JsonValue = {},
  options: { readonly sdk?: number; readonly namedCredential?: NamedCredentialResolver } = {},
) => {
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
  const facts = {
    resolveCredential: (reference: string) => Promise.resolve(`secret-of:${reference}`),
    ...(options.namedCredential === undefined ? {} : { namedCredential: options.namedCredential }),
  }
  const backends: NxtServiceBackends = {
    ...unusedMediaBackends(),
    fetch,
    complete,
    storage: memoryNxtStorage(() => 1),
    jobs: memoryNxtJobs(),
    platform: {
      catalog: () =>
        Promise.resolve({
          adapterKey: 'onebot-11',
          raw: true,
          actions: [
            { name: 'like_member', title: '点赞', description: '给成员点赞', risk: 'low' as const, parameters: {} },
            { name: 'mute_member', title: '禁言', description: '禁言成员', risk: 'admin' as const, parameters: {} },
          ],
        }),
      invoke: (_binding, action, args) =>
        Promise.resolve({ status: 'succeeded' as const, message: action, value: args }),
      raw: (_binding, api) => Promise.resolve({ status: 'succeeded' as const, message: api }),
      selfPlatformUserId: () => Promise.resolve('10001'),
    },
    secret: async (binding, key) => (await resolveExtensionSecret(facts, binding, key, 'program'))?.value,
    requestSecret: (binding, key, targetHost) => resolveExtensionSecret(facts, binding, key, 'request', targetHost),
    createAsset,
    callContext: () => Promise.resolve(callContext),
    members: {
      describe: (_channelId, memberId) =>
        Promise.resolve(memberId === 'mbr_SELF' ? { memberId, self: true as const } : undefined),
    },
    library: emptyExtensionLibrary(),
    files: unusedNxtBackends().files,
    index: memoryIndexEngine(),
    models: {
      list: () => Promise.resolve([]),
      complete: () => Promise.reject(new Error('Unexpected model call.')),
    },
    history: {
      list: () => Promise.resolve({ messages: [] }),
      search: () => Promise.resolve([]),
    },
  }
  const binding: NxtServiceBinding = {
    ...(options.sdk === undefined ? {} : { sdk: options.sdk }),
    mode: 'activation',
    agentId: 'agt_FIXTURE',
    ownerKey: 'ext_FIXTURE',
    displayName: '示例扩展',
    channelId: 'chn_FIXTURE',
    capabilities: () => capabilities,
    config: () => config,
    declaredSecrets: () => ({ config: DECLARED_SECRETS, hostConfig: [] }),
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
    await expect(nxt.http.fetch('https://api.example.com/')).rejects.toThrow(/permissions\.agent/u)
    await expect(nxt.storage.get('key')).rejects.toBeInstanceOf(NxtCapabilityError)
    await expect(nxt.assets.create({ text: 'x' })).rejects.toThrow(/assets/u)
    await expect(nxt.history.list()).rejects.toThrow(/history/u)
    expect(() => nxt.prompt.static('usage', '用法')).toThrow(/kind: 'static'/u)
  })

  it('renders and parses without any declared capability', async () => {
    const { nxt } = fixture(undefined)
    const image = await nxt.render.svg('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>', { scale: 1 })
    expect(image).toMatchObject({ mediaType: 'image/png', width: 10, height: 10 })
    expect(
      (await nxt.parse.html('<p>示例 <a href="/a">链接</a></p>', { url: 'https://example.com/', mode: 'full' }))
        .markdown,
    ).toBe('示例 [链接](https://example.com/a)')
    expect((await nxt.parse.feed('<rss><channel><title>示例</title></channel></rss>')).title).toBe('示例')
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

  // Downloads into Assets are covered with real work files in extension-files.spec.ts.
  it('saves channel assets', async () => {
    const { nxt } = fixture({ assets: { write: true } })
    expect(await nxt.assets.create({ text: 'poster' })).toMatchObject({ assetId: 'ast_FIXTURE' })
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

  it('validates job schedules and enforces the runtime job quota', async () => {
    const missing = fixture({ jobs: { declared: [] } })
    await expect(missing.nxt.jobs.schedule({ label: '提醒', at: Date.now() + 60_000 })).rejects.toThrow(/runtime/u)

    const { nxt } = fixture({ jobs: { runtime: { maxActive: 2 } } })
    await expect(nxt.jobs.schedule({ label: '提醒' })).rejects.toThrow(/at.*cron|cron.*at/u)
    await expect(nxt.jobs.schedule({ label: '提醒', at: 1 })).rejects.toThrow(/未来/u)
    await expect(nxt.jobs.schedule({ label: '提醒', cron: '* * *' })).rejects.toThrow(/五段/u)
    await expect(nxt.jobs.schedule({ label: '提醒', cron: '0 8 * * *', timezone: 'Not/AZone' })).rejects.toThrow(
      /时区/u,
    )
    const daily = await nxt.jobs.schedule({ label: '每日早报', cron: '0 8 * * *', timezone: 'Asia/Shanghai' })
    expect(daily).toMatchObject({ label: '每日早报', cron: '0 8 * * *' })
    expect(daily.nextRunAt).toBeGreaterThan(Date.now())
    await nxt.jobs.schedule({ label: '一次', at: Date.now() + 60_000, payload: { topic: '示例' } })
    await expect(nxt.jobs.schedule({ label: '超额', at: Date.now() + 60_000 })).rejects.toThrow(/最多保留 2/u)
    expect((await nxt.jobs.list()).map(({ label }) => label)).toEqual(['每日早报', '一次'])
    expect(await nxt.jobs.cancel(daily.jobId)).toBe(true)
    expect(await nxt.jobs.cancel(daily.jobId)).toBe(false)
  })

  it('runs only declared platform actions the channel supports and gates raw passthrough separately', async () => {
    await expect(fixture(undefined).nxt.platform.invoke('like_member', {})).rejects.toThrow(/platform/u)
    const { nxt } = fixture({
      platform: {
        actions: [
          { adapter: 'onebot-11', action: 'like_member' },
          { adapter: 'onebot-11', action: 'set_title' },
        ],
        raw: [],
      },
    })
    expect((await nxt.platform.actions()).map(({ name }) => name)).toEqual(['like_member'])
    await expect(nxt.platform.invoke('like_member', { memberId: 'mbr_FIXTURE', times: 1 })).resolves.toMatchObject({
      status: 'succeeded',
      value: { memberId: 'mbr_FIXTURE', times: 1 },
    })
    await expect(nxt.platform.invoke('mute_member', {})).rejects.toThrow(/没有声明平台动作/u)
    await expect(nxt.platform.invoke('set_title', {})).rejects.toThrow(/不支持动作/u)
    await expect(nxt.platform.raw('get_group_info', {})).rejects.toThrow(/platform\.raw/u)
    await expect(nxt.platform.selfPlatformUserId()).rejects.toThrow(/platform\.raw/u)
    const raw = fixture({ platform: { actions: [], raw: ['onebot-11'] } })
    await expect(raw.nxt.platform.raw('get_group_info', { group_id: 1 })).resolves.toMatchObject({
      status: 'succeeded',
    })
    // The account's platform id is only for extensions already trusted with the raw API.
    await expect(raw.nxt.platform.selfPlatformUserId()).resolves.toBe('10001')
    // Who a member is needs no capability.
    await expect(fixture(undefined).nxt.members.describe('mbr_SELF')).resolves.toEqual({
      memberId: 'mbr_SELF',
      self: true,
    })
  })

  it('reads secrets only from Host credential references in declared secret fields', async () => {
    const { nxt } = fixture(undefined, {
      token: 'credential:local:0123456789abcdef0123456789abcdef',
      plain: 'not-a-reference',
      undeclared: 'credential:local:0123456789abcdef0123456789abcdef',
    })
    expect(await nxt.secrets.get('token')).toBe('secret-of:credential:local:0123456789abcdef0123456789abcdef')
    expect(await nxt.secrets.get('plain')).toBeUndefined()
    expect(await nxt.secrets.get('missing')).toBeUndefined()
    // A reference in a field the Manifest does not declare as a secret is never resolved.
    expect(await nxt.secrets.get('undeclared')).toBeUndefined()
  })

  it('resolves a named credential only for an agent in scope, and program reads only for program use', async () => {
    const uses: NamedCredentialUse[] = []
    const namedCredential: NamedCredentialResolver = (use) => {
      uses.push(use)
      if (use.id === 'crd_FOREIGN') return undefined
      if (use.id === 'crd_REQUEST' && use.purpose === 'program') return undefined
      return {
        value: `value-of:${use.id}`,
        usage: use.id === 'crd_REQUEST' ? 'request' : 'program',
        domains: use.id === 'crd_REQUEST' ? ['api.example.com'] : [],
      }
    }
    const { nxt } = fixture(
      undefined,
      {
        named: 'credential:named:crd_PROGRAM',
        requestOnly: 'credential:named:crd_REQUEST',
        foreign: 'credential:named:crd_FOREIGN',
      },
      { namedCredential },
    )
    expect(await nxt.secrets.get('named')).toBe('value-of:crd_PROGRAM')
    expect(await nxt.secrets.get('requestOnly')).toBeUndefined()
    expect(await nxt.secrets.get('foreign')).toBeUndefined()
    expect(uses.map((use) => [use.id, use.agentId, use.purpose, use.extensionId])).toEqual([
      ['crd_PROGRAM', 'agt_FIXTURE', 'program', 'ext_FIXTURE'],
      ['crd_REQUEST', 'agt_FIXTURE', 'program', 'ext_FIXTURE'],
      ['crd_FOREIGN', 'agt_FIXTURE', 'program', 'ext_FIXTURE'],
    ])
  })

  it('fills credential placeholders in requests the host sends, never handing the value to code', async () => {
    const namedCredential: NamedCredentialResolver = (use) =>
      use.id === 'crd_REQUEST'
        ? { value: 'request-only-fixture-key', usage: 'request', domains: ['api.example.com'] }
        : undefined
    const network = { network: { mode: 'domains' as const, domains: ['api.example.com'] } }
    const { nxt, fetch } = fixture(
      network,
      { requestOnly: 'credential:named:crd_REQUEST', foreign: 'credential:named:crd_FOREIGN' },
      { sdk: 12, namedCredential },
    )
    const token = nxt.secrets.placeholder('requestOnly')
    expect(token).toMatch(/^\{\{nxt-credential:[a-f0-9]{24}\}\}$/u)
    expect(nxt.secrets.placeholder('requestOnly')).toBe(token)
    expect(token).not.toContain('request-only-fixture-key')

    await nxt.http.fetch(`https://api.example.com/v1?key=${token}`, { headers: { authorization: `Bearer ${token}` } })
    expect(fetch.mock.calls[0]?.[3]).toEqual([
      { token, value: 'request-only-fixture-key', domains: ['api.example.com'] },
    ])

    const foreign = nxt.secrets.placeholder('foreign')
    await expect(nxt.http.fetch(`https://api.example.com/?k=${foreign}`)).rejects.toThrow('还没有设置')
    await expect(
      nxt.http.fetch('https://api.example.com/?k={{nxt-credential:0123456789abcdef01234567}}'),
    ).rejects.toThrow('不属于这个扩展')
    expect(() => fixture(network, {}, { sdk: 11 }).nxt.secrets.placeholder('requestOnly')).toThrow('requires.sdk')
  })

  it('hands code placeholders for secret fields in config() and never sends a stored reference (#143, #144)', async () => {
    const namedCredential: NamedCredentialResolver = (use) =>
      use.id === 'crd_REQUEST'
        ? { value: 'request-only-fixture-key', usage: 'request', domains: ['api.example.com'] }
        : undefined
    const network = { network: { mode: 'domains' as const, domains: ['api.example.com'] } }
    const stored = { city: '示例市', requestOnly: 'credential:named:crd_REQUEST' }
    const { nxt, fetch } = fixture(network, stored, { sdk: 12, namedCredential })

    const token = nxt.secrets.placeholder('requestOnly')
    const config = nxt.config()
    expect(config).toMatchObject({ city: '示例市', requestOnly: token })
    expect(JSON.stringify(config)).not.toContain('credential:named:')
    await nxt.http.fetch('https://api.example.com/v1', { headers: { authorization: `Bearer ${token}` } })
    expect(fetch.mock.calls[0]?.[3]).toEqual([
      { token, value: 'request-only-fixture-key', domains: ['api.example.com'] },
    ])
    // The same token comes from another `nxt` of the extension, such as the host layer's in the factory.
    expect(fixture(network, stored, { sdk: 12 }).nxt.secrets.placeholder('requestOnly')).toBe(token)

    await expect(
      nxt.http.fetch('https://api.example.com/v1', {
        headers: { authorization: 'Bearer credential:named:crd_REQUEST' },
      }),
    ).rejects.toThrow('凭据的内部引用')
    // The credential's name instead of the field's: saving or enabling would not help, so say so.
    const byName = nxt.secrets.placeholder('示例 API Key')
    await expect(nxt.http.fetch(`https://api.example.com/?k=${byName}`)).rejects.toThrow(
      /「示例 API Key」不是这个扩展的凭据字段.*requestOnly/u,
    )
    expect(fetch).toHaveBeenCalledTimes(1)

    // Without placeholder support the field is simply absent.
    expect(fixture(network, stored, { sdk: 11 }).nxt.config()).toEqual({ city: '示例市' })
  })

  it('says which request header is not text instead of failing inside the egress (#145)', async () => {
    const { nxt, fetch } = fixture({ network: { mode: 'domains', domains: ['api.example.com'] } }, {}, { sdk: 12 })
    // What `{ 'api-key': ctx.config().apiKey }` sends when the field is not there.
    const headers: Record<string, string> = {}
    Reflect.set(headers, 'api-key', undefined)
    await expect(nxt.http.fetch('https://api.example.com/v1', { headers })).rejects.toThrow(
      '请求头「api-key」的值是 undefined',
    )
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe.each(['host', 'agent'] as const)('extension %s secret configuration', (layer) => {
  const manifest = extensionManifestSchema.parse({
    schemaVersion: 7,
    extensionId: 'ext_FIXTURE',
    revisionId: 'xrv_FIXTURE',
    entrypoints: { host: 'source/host.ts' },
    contributions: [{ kind: 'tool', name: 'secret_probe', description: '凭据探针' }],
    config: {
      [layer]: {
        schema: configSchema.object({ city: configSchema.string('城市'), token: configSchema.secret('令牌') }),
      },
    },
  })

  it('never returns secret references to the client', () => {
    expect(maskExtensionSecrets(manifest, layer, { city: '示例市', token: 'credential:local:ref' })).toEqual({
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
      layer,
      previous: { city: '旧市', token: 'credential:local:old' },
      config: { city: '新市', token: 'client-forged-reference' },
      secrets: { token: '' },
      credentials,
      commit: (config) => Promise.resolve(config),
    })
    expect(kept).toEqual({ city: '新市', token: 'credential:local:old' })

    const replaced = await commitExtensionConfigWithSecrets({
      manifest,
      layer,
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
        layer,
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
        layer,
        previous: {},
        config: {},
        secrets: { city: 'x' },
        credentials,
        commit: (config) => Promise.resolve(config),
      }),
    ).rejects.toThrow(/不是凭据字段/u)
  })

  it('binds a secret field to a named credential and lists the binding, never deleting the credential', async () => {
    const deleted: string[] = []
    const credentials = {
      save: () => Promise.reject(new Error('nothing is typed')),
      delete: (reference: string) => {
        deleted.push(reference)
        return Promise.resolve()
      },
    }
    const known = CredentialIdSchema.parse('crd_WEATHER')
    const bound = await commitExtensionConfigWithSecrets({
      manifest,
      layer,
      previous: { city: '旧市', token: 'credential:local:old' },
      config: { city: '新市' },
      secrets: undefined,
      bindings: { token: known },
      credentialExists: (id) => id === known,
      credentials,
      commit: (config) => Promise.resolve(config),
    })
    expect(bound).toEqual({ city: '新市', token: 'credential:named:crd_WEATHER' })
    expect(deleted).toEqual(['credential:local:old'])
    expect(maskExtensionSecrets(manifest, layer, bound)).toEqual({
      config: { city: '新市' },
      configuredSecrets: ['token'],
      boundCredentials: { token: known },
    })

    const cleared = await commitExtensionConfigWithSecrets({
      manifest,
      layer,
      previous: bound,
      config: { city: '新市' },
      secrets: undefined,
      bindings: { token: null },
      credentialExists: () => true,
      credentials,
      commit: (config) => Promise.resolve(config),
    })
    expect(cleared).toEqual({ city: '新市' })
    expect(deleted).toEqual(['credential:local:old'])
    await expect(
      commitExtensionConfigWithSecrets({
        manifest,
        layer,
        previous: {},
        config: {},
        secrets: undefined,
        bindings: { token: CredentialIdSchema.parse('crd_GONE') },
        credentialExists: () => false,
        credentials,
        commit: (config) => Promise.resolve(config),
      }),
    ).rejects.toThrow('已不存在')
  })
})

const agentId = AgentIdSchema.parse('agt_INBOUNDIDENTITY')
const channelId = ChannelIdSchema.parse('chn_INBOUNDIDENTITY')
const binding: BindingRecord = {
  channelId,
  agentId,
  triggerPolicy: 'always',
  paused: false,
  processingFeedback: 'auto',
  localAgentMessages: 'observe',
  activityTriggerOverrides: {},
  responseTiming: {},
  boundAt: 1,
}
const event: ChannelEventRecord = {
  id: ChannelEventIdSchema.parse('evt_INBOUNDIDENTITY'),
  logicalMessageId: LogicalMessageIdSchema.parse('msg_INBOUNDIDENTITY'),
  channelId,
  kind: 'message-created',
  parts: [{ type: 'text', text: '示例消息' }],
  sourceTimestamp: 2,
  receivedAt: 2,
  dedupeKey: 'inbound-identity-fixture',
  searchText: '示例消息',
}
const hook = { reads: 'all', mayHide: false, mayForceTrigger: false, timeoutMs: 1000 } as const

const handler = (name: string, run: NxtInboundHandler): PersistentInboundHandler => ({
  agentId,
  revision: {
    id: ExtensionRevisionIdSchema.parse(`xrv_${name}`),
    extensionId: ExtensionIdSchema.parse(`ext_${name}`),
    revisionNumber: 1,
    contentDigest: 'a'.repeat(64),
    payloadDigest: 'b'.repeat(64),
    createdAt: 1,
    ancestry: [],
    origin: 'file',
    dataVersion: 1,
  },
  config: {},
  hostConfig: {},
  handler: run,
})

const projection = (_event: ChannelEventRecord, defaultTriggered: boolean, identities: boolean): NxtInboundMessage => ({
  logicalMessageId: event.logicalMessageId,
  channel: { id: channelId, kind: 'group', displayName: '示例频道' },
  sender: {
    memberId: 'mem_INBOUNDIDENTITY',
    displayName: '示例成员',
    ...(identities ? { identityId: 'pid_INBOUNDIDENTITY', platformUserId: 'example-account' } : {}),
  },
  text: '示例消息',
  images: [],
  mentionsAgent: false,
  wouldTrigger: defaultTriggered,
  receivedAt: event.receivedAt,
})

const gate = (
  handlers: readonly PersistentInboundHandler[],
  capabilities: ReadonlyMap<string, ExtensionCapabilities>,
  message: typeof projection,
) =>
  new ExtensionInboundHookGate({
    handlers: () => handlers,
    describe: ({ revision }) => ({
      displayName: revision.extensionId,
      capabilities: capabilities.get(revision.extensionId),
    }),
    nxtFor: ({ revision }) =>
      createNxtHostService(
        {
          mode: 'activation',
          sdk: 16,
          agentId,
          channelId,
          ownerKey: revision.extensionId,
          displayName: revision.extensionId,
          capabilities: () => capabilities.get(revision.extensionId),
          config: () => ({}),
          declaredSecrets: () => ({ config: [], hostConfig: [] }),
        },
        unusedNxtBackends(),
      ),
    message,
    store: memoryInboundHookDecisionStore(),
    now: () => 3,
  })

describe('inbound member identity projections', () => {
  it.each(['authorized-first', 'authorized-last'] as const)(
    'isolates each handler declaration and message mutations with %s (#156)',
    async (order) => {
      const received = new Map<string, NxtInboundMessage>()
      const snapshots = new Map<string, NxtInboundMessage>()
      const authorized = handler('IDENTITYALLOWED', (message) => {
        received.set('authorized', message)
        snapshots.set('authorized', structuredClone(message))
        Object.assign(message.sender!, {
          displayName: '被修改的成员',
          identityId: 'pid_MUTATED',
          platformUserId: 'modified-account',
        })
        Object.assign(message, { text: '被修改的消息' })
        return undefined
      })
      const ordinary = handler('IDENTITYORDINARY', (message) => {
        received.set('ordinary', message)
        snapshots.set('ordinary', structuredClone(message))
        return undefined
      })
      const capabilities = new Map([
        [
          authorized.revision.extensionId,
          ExtensionCapabilitiesSchema.parse({ inboundHook: hook, members: { identities: true } }),
        ],
        [ordinary.revision.extensionId, ExtensionCapabilitiesSchema.parse({ inboundHook: hook })],
      ])
      const message = vi.fn(projection)
      const handlers = order === 'authorized-first' ? [authorized, ordinary] : [ordinary, authorized]

      await expect(
        gate(handlers, capabilities, message).decide({ binding, event, defaultTriggered: true }),
      ).resolves.toEqual({
        trigger: 'default',
        hidden: false,
      })

      expect(message.mock.calls.map((call) => call[2])).toEqual(
        order === 'authorized-first' ? [true, false] : [false, true],
      )
      expect(snapshots.get('authorized')?.sender).toEqual({
        memberId: 'mem_INBOUNDIDENTITY',
        displayName: '示例成员',
        identityId: 'pid_INBOUNDIDENTITY',
        platformUserId: 'example-account',
      })
      expect(snapshots.get('ordinary')?.sender).toEqual({ memberId: 'mem_INBOUNDIDENTITY', displayName: '示例成员' })
      expect(received.get('ordinary')).toEqual(snapshots.get('ordinary'))
      expect(received.get('ordinary')?.text).toBe('示例消息')
      expect(received.get('ordinary')).not.toBe(received.get('authorized'))
      expect(received.get('ordinary')?.sender).not.toBe(received.get('authorized')?.sender)
    },
  )

  it('does not project or invoke a handler without an inbound hook declaration', async () => {
    const run = vi.fn<NxtInboundHandler>()
    const undeclared = handler('IDENTITYUNDECLARED', run)
    const message = vi.fn(projection)
    const capabilities = new Map([
      [undeclared.revision.extensionId, ExtensionCapabilitiesSchema.parse({ members: { identities: true } })],
    ])

    await gate([undeclared], capabilities, message).decide({ binding, event, defaultTriggered: true })

    expect(run).not.toHaveBeenCalled()
    expect(message).not.toHaveBeenCalled()
  })
})

const createMemberIdentityFixture = async () => {
  const database = await openMigratedCoreDatabase(':memory:')
  const repository = new SqliteCoreRepository(database)
  let sequence = 0
  const core = new CoreService(repository, { now: () => 100 + sequence, nextUlid: () => `IDENTITY${++sequence}` })
  const connection = core.createConnection({ adapterKey: 'fixture-identity', config: {} })
  const otherConnection = core.createConnection({ adapterKey: 'fixture-identity', config: {} })
  const firstChannel = core.createChannel({
    connectionId: connection.id,
    platformChannelId: 'example-first',
    kind: 'group',
    displayName: '示例频道甲',
  })
  const secondChannel = core.createChannel({
    connectionId: connection.id,
    platformChannelId: 'example-second',
    kind: 'group',
    displayName: '示例频道乙',
  })
  const foreignChannel = core.createChannel({
    connectionId: otherConnection.id,
    platformChannelId: 'example-foreign',
    kind: 'group',
  })
  const observe = (channel: ChannelRecord, platformUserId: string, displayName: string) =>
    core.observeChannelMember({
      connectionId: channel.connectionId,
      channelId: channel.id,
      platformUserId,
      displayName,
      observedAt: 150,
    }).member
  const firstMember = observe(firstChannel, 'example-member', '示例成员甲')
  const secondMember = observe(secondChannel, 'example-member', '示例成员甲')
  const foreignMember = observe(foreignChannel, 'example-member', '示例成员甲')
  const latestMember = observe(firstChannel, 'example-later-member', '示例成员乙')
  const selfMember = core.ensureSelfChannelMember(firstChannel.id)
  let eventSequence = 0
  const append = (channel: ChannelRecord, sender: ChannelMemberRecord, text: string) => {
    eventSequence += 1
    return core.appendInbound({
      connectionId: channel.connectionId,
      channelId: channel.id,
      adapterKey: 'fixture-identity',
      kind: 'message-created',
      senderMemberId: sender.id,
      parts: [{ type: 'text', text }],
      platformTimestamp: 200 + eventSequence,
      receivedAt: 200 + eventSequence,
      dedupeKey: `identity-event-${eventSequence}`,
    }).event
  }
  const trigger = append(firstChannel, firstMember, '示例唤醒消息')
  const latest = append(firstChannel, latestMember, '示例后续消息')
  const secondTrigger = append(secondChannel, secondMember, '示例另一频道消息')
  const foreignTrigger = append(foreignChannel, foreignMember, '示例其他连接消息')
  const triggers = new Map<string, ChannelEventId>([
    [firstChannel.id, trigger.id],
    [secondChannel.id, secondTrigger.id],
    [foreignChannel.id, foreignTrigger.id],
  ])
  const infrastructure = unusedNxtBackends()
  const facts: NxtProductFacts = {
    history: repository,
    getConnectionName: () => '示例连接',
    getAgentName: () => '示例智能体',
    createAsset: infrastructure.createAsset,
    resolveCredential: () => Promise.reject(new Error('Unexpected credential lookup.')),
    turnTrigger: (source: string | { readonly channelId: string }) => {
      const channelId = typeof source === 'string' ? source : source.channelId
      const eventId = triggers.get(channelId)
      const event = eventId === undefined ? undefined : repository.getChannelEvent(eventId)
      return event?.senderMemberId === undefined
        ? undefined
        : { event, senderMemberId: event.senderMemberId, requester: { kind: 'member', memberId: event.senderMemberId } }
    },
    members: {
      describe: (memberId) => {
        const record = repository.getChannelMember(memberId)
        return record !== undefined && repository.getPlatformIdentity(record.platformIdentityId)?.self !== undefined
          ? { kind: 'self' }
          : { kind: 'member' }
      },
      self: (id) => ({ memberId: core.ensureSelfChannelMember(id).id }),
      localAgents: () => [],
    },
  }
  const backends = createNxtProductBackends(facts, infrastructure)
  const service = (
    options: {
      readonly mode?: 'activation' | 'dynamic'
      readonly sdk?: number
      readonly identities?: boolean
      readonly channelId?: ChannelId
    } = {},
  ) =>
    createNxtHostService(
      {
        mode: options.mode ?? 'activation',
        sdk: options.sdk ?? 16,
        agentId: 'agt_IDENTITYFIXTURE',
        ownerKey: 'ext_IDENTITYFIXTURE',
        displayName: '示例扩展',
        channelId: options.channelId ?? firstChannel.id,
        episodeId: () => options.channelId ?? firstChannel.id,
        capabilities: () =>
          ExtensionCapabilitiesSchema.parse({
            history: { read: true },
            ...(options.identities === true ? { members: { identities: true } } : {}),
          }),
        config: () => ({}),
        declaredSecrets: () => ({ config: [], hostConfig: [] }),
      },
      backends,
    )
  return {
    database,
    repository,
    service,
    append,
    triggers,
    firstChannel,
    secondChannel,
    foreignChannel,
    firstMember,
    secondMember,
    foreignMember,
    latestMember,
    selfMember,
    trigger,
    latest,
    foreignTrigger,
  }
}

describe('member identities across nxt product surfaces', () => {
  it.each([
    ['SDK 16 with permission', 'activation', 16, true, true],
    ['SDK 16 without permission', 'activation', 16, false, false],
    ['SDK 15 with permission', 'activation', 15, true, false],
    ['SDK 15 without permission', 'activation', 15, false, false],
    ['dynamic with identity declaration before activation approval', 'dynamic', 16, true, false],
    ['dynamic without permission', 'dynamic', 16, false, false],
  ] as const)('projects every surface for %s (#156)', async (_name, mode, sdk, identities, allowed) => {
    const f = await createMemberIdentityFixture()
    try {
      const nxt = f.service({ mode, sdk, identities })
      const expectedSender = (record: ChannelMemberRecord) => ({
        memberId: record.id,
        displayName: record.displayName,
        ...(allowed
          ? {
              identityId: record.platformIdentityId,
              platformUserId: f.repository.getPlatformIdentity(record.platformIdentityId)?.platformUserId,
            }
          : {}),
      })
      const context = await nxt.context.current()
      expect(context.latestInbound).toEqual({
        logicalMessageId: f.latest.logicalMessageId,
        sender: expectedSender(f.latestMember),
        text: '示例后续消息',
        receivedAt: f.latest.receivedAt,
      })
      expect(context.trigger).toEqual({
        kind: 'message',
        sender: expectedSender(f.firstMember),
        message: {
          logicalMessageId: f.trigger.logicalMessageId,
          text: '示例唤醒消息',
          receivedAt: f.trigger.receivedAt,
        },
        administrator: false,
      })
      expect(await nxt.members.describe(f.firstMember.id)).toEqual(expectedSender(f.firstMember))
      const listed = await nxt.history.list()
      const searched = await nxt.history.search('示例')
      for (const messages of [listed.messages, searched]) {
        expect(messages.map(({ logicalMessageId }) => logicalMessageId)).toEqual([
          f.latest.logicalMessageId,
          f.trigger.logicalMessageId,
        ])
        expect(messages[0]?.sender).toEqual(expectedSender(f.latestMember))
        expect(messages[1]?.sender).toEqual(expectedSender(f.firstMember))
      }
    } finally {
      f.database.close()
    }
  })

  it('reuses identity only across channels of one connection and refuses foreign channel members', async () => {
    const f = await createMemberIdentityFixture()
    try {
      const first = f.service({ identities: true })
      const second = f.service({ identities: true, channelId: f.secondChannel.id })
      const foreign = f.service({ identities: true, channelId: f.foreignChannel.id })
      const firstPerson = await first.members.describe(f.firstMember.id)
      const secondPerson = await second.members.describe(f.secondMember.id)
      const foreignPerson = await foreign.members.describe(f.foreignMember.id)
      expect(firstPerson?.identityId).toBeDefined()
      expect(secondPerson?.identityId).toBe(firstPerson?.identityId)
      expect(secondPerson?.memberId).not.toBe(firstPerson?.memberId)
      expect(foreignPerson?.identityId).not.toBe(firstPerson?.identityId)
      expect(foreignPerson?.platformUserId).toBe(firstPerson?.platformUserId)
      await expect(first.members.describe(f.secondMember.id)).resolves.toBeUndefined()
      await expect(first.members.describe(f.foreignMember.id)).resolves.toBeUndefined()
      f.triggers.set(f.firstChannel.id, f.foreignTrigger.id)
      expect((await first.context.current()).trigger).toBeUndefined()
    } finally {
      f.database.close()
    }
  })

  it('keeps the self placeholder account and identity out of every surface even with permission', async () => {
    const f = await createMemberIdentityFixture()
    try {
      const selfEvent = f.append(f.firstChannel, f.selfMember, '示例自身消息')
      f.triggers.set(f.firstChannel.id, selfEvent.id)
      const nxt = f.service({ identities: true })
      const expected = { memberId: f.selfMember.id, self: true }
      expect(f.repository.getPlatformIdentity(f.selfMember.platformIdentityId)?.platformUserId).toBe('nxt:self')
      await expect(nxt.members.describe(f.selfMember.id)).resolves.toEqual(expected)
      const context = await nxt.context.current()
      expect(context.trigger?.sender).toEqual(expected)
      expect(context.latestInbound?.sender).toEqual(expected)
      expect((await nxt.history.list()).messages[0]?.sender).toEqual(expected)
      expect((await nxt.history.search('示例自身消息'))[0]?.sender).toEqual(expected)
    } finally {
      f.database.close()
    }
  })
})
