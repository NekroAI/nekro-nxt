import { describe, expect, it } from 'vitest'
import {
  ExtensionCapabilitiesSchema,
  ExtensionMcpCapabilitySchema,
  ExtensionNetworkDomainSchema,
  extensionCapabilitiesExpand,
  mcpSecretFields,
  McpServerFormSchema,
  summarizeExtensionCapabilities,
  hostLayerAsCapabilities,
  type ExtensionCapabilities,
} from '../src/index.js'

const caps = (value: unknown): ExtensionCapabilities => ExtensionCapabilitiesSchema.parse(value)

const remote = (url: string) => ({
  transport: 'streamable-http',
  name: 'docs',
  url,
  headers: { Authorization: { secret: 'header_1' }, 'X-Mode': 'read' },
})

describe('capability schemas', () => {
  it('accepts plain and wildcard domains only', () => {
    expect(ExtensionNetworkDomainSchema.parse(' API.Example.com ')).toBe('api.example.com')
    expect(ExtensionNetworkDomainSchema.parse('*.example.com')).toBe('*.example.com')
    for (const bad of ['https://example.com', 'example.com:443', 'example.com/path', 'localhost']) {
      expect(ExtensionNetworkDomainSchema.safeParse(bad).success, bad).toBe(false)
    }
  })

  it('rejects duplicate storage scopes, context names, declared jobs and MCP servers', () => {
    expect(caps({ storage: { scopes: ['agent'] } }).storage?.scopes).toEqual(['agent'])
    expect(ExtensionCapabilitiesSchema.safeParse({ storage: { scopes: ['agent', 'agent'] } }).success).toBe(false)
    expect(
      ExtensionCapabilitiesSchema.safeParse({
        context: [
          { name: 'usage', kind: 'static', maxChars: 100 },
          { name: 'usage', kind: 'dynamic', maxChars: 100 },
        ],
      }).success,
    ).toBe(false)
    expect(
      ExtensionCapabilitiesSchema.safeParse({ context: [{ name: 'state', kind: 'dynamic', maxChars: 3000 }] }).success,
    ).toBe(false)
    expect(
      ExtensionCapabilitiesSchema.safeParse({
        jobs: {
          declared: [
            { id: 'daily', label: '每日', cron: '0 8 * * *' },
            { id: 'daily', label: '又一个', cron: '0 9 * * *' },
          ],
        },
      }).success,
    ).toBe(false)
    expect(
      ExtensionMcpCapabilitySchema.safeParse({
        servers: [remote('https://a.example.com/mcp'), remote('https://b.example.com/mcp')],
      }).success,
    ).toBe(false)
    expect(ExtensionMcpCapabilitySchema.safeParse({ servers: [remote('ftp://a.example.com/mcp')] }).success).toBe(false)
    expect(
      ExtensionMcpCapabilitySchema.safeParse({
        servers: [{ ...remote('https://a.example.com/mcp'), name: 'bad name' }],
      }).success,
    ).toBe(false)
  })

  it('defaults MCP rows and lists the credential fields they reference', () => {
    const stdio = ExtensionMcpCapabilitySchema.parse({
      servers: [
        { transport: 'stdio', name: 'local', command: 'example-mcp', env: { TOKEN: { secret: 'env_1' }, MODE: 'x' } },
        remote('https://docs.example.com/mcp'),
        { ...remote('https://more.example.com/mcp'), name: 'more', headers: { Authorization: { secret: 'env_1' } } },
      ],
    })
    expect(stdio.servers[0]).toMatchObject({ args: [] })
    expect(mcpSecretFields(stdio)).toEqual(['env_1', 'header_1'])
    expect(mcpSecretFields(undefined)).toEqual([])
    expect(McpServerFormSchema.parse({ transport: 'stdio', name: 'local', command: ' example-mcp ' })).toEqual({
      transport: 'stdio',
      name: 'local',
      command: 'example-mcp',
      args: [],
      env: [],
    })
    const form = McpServerFormSchema.parse({
      transport: 'streamable-http',
      name: 'docs',
      url: 'https://docs.example.com/mcp',
      headers: [{ name: 'Authorization', value: 'Bearer x' }],
    })
    expect(form.transport === 'streamable-http' ? form.headers : []).toEqual([
      { name: 'Authorization', value: 'Bearer x', secret: false },
    ])
    expect(
      McpServerFormSchema.safeParse({
        transport: 'streamable-http',
        name: 'docs',
        url: 'https://docs.example.com/mcp',
        headers: [{ name: 'bad header', value: '' }],
      }).success,
    ).toBe(false)
  })
})

describe('extensionCapabilitiesExpand', () => {
  const cases: readonly (readonly [string, unknown, unknown, boolean])[] = [
    ['nothing declared', { storage: { scopes: ['agent'] } }, undefined, false],
    ['first declaration', undefined, { assets: { write: true } }, true],
    [
      'narrowing network',
      { network: { mode: 'unrestricted', purpose: '读取任意链接' } },
      { network: { mode: 'domains', domains: ['a.example.com'] } },
      false,
    ],
    [
      'raising network mode',
      { network: { mode: 'domains', domains: ['a.example.com'] } },
      { network: { mode: 'config', fields: ['baseUrl'] } },
      true,
    ],
    [
      'new domain',
      { network: { mode: 'domains', domains: ['a.example.com'] } },
      { network: { mode: 'domains', domains: ['a.example.com', 'b.example.com'] } },
      true,
    ],
    [
      'same domains',
      { network: { mode: 'domains', domains: ['a.example.com'] } },
      { network: { mode: 'domains', domains: ['a.example.com'] } },
      false,
    ],
    [
      'new config field',
      { network: { mode: 'config', fields: ['baseUrl'] } },
      { network: { mode: 'config', fields: ['baseUrl', 'mirror'] } },
      true,
    ],
    [
      'same unrestricted',
      { network: { mode: 'unrestricted', purpose: '读取任意链接' } },
      { network: { mode: 'unrestricted', purpose: '另一种说法' } },
      false,
    ],
    ['new storage scope', { storage: { scopes: ['agent'] } }, { storage: { scopes: ['agent', 'shared'] } }, true],
    ['quota only', { storage: { scopes: ['agent'] } }, { storage: { scopes: ['agent'], quotaBytes: 4096 } }, false],
    ['history added', {}, { history: { read: true } }, true],
    [
      'new platform action',
      { platform: { actions: [{ adapter: 'onebot', action: 'like_member' }] } },
      { platform: { actions: [{ adapter: 'onebot', action: 'mute_member' }] } },
      true,
    ],
    ['new raw adapter', { platform: { raw: ['onebot'] } }, { platform: { raw: ['onebot', 'wecom'] } }, true],
    [
      'hook added',
      {},
      { inboundHook: { reads: 'triggered', mayHide: false, mayForceTrigger: false, timeoutMs: 1000 } },
      true,
    ],
    [
      'hook reads all',
      { inboundHook: { reads: 'triggered', mayHide: false, mayForceTrigger: false, timeoutMs: 1000 } },
      { inboundHook: { reads: 'all', mayHide: false, mayForceTrigger: false, timeoutMs: 1000 } },
      true,
    ],
    [
      'hook may hide',
      { inboundHook: { reads: 'all', mayHide: false, mayForceTrigger: false, timeoutMs: 1000 } },
      { inboundHook: { reads: 'all', mayHide: true, mayForceTrigger: false, timeoutMs: 1000 } },
      true,
    ],
    [
      'hook may force',
      { inboundHook: { reads: 'all', mayHide: true, mayForceTrigger: false, timeoutMs: 1000 } },
      { inboundHook: { reads: 'all', mayHide: true, mayForceTrigger: true, timeoutMs: 5000 } },
      true,
    ],
    [
      'hook timeout only',
      { inboundHook: { reads: 'all', mayHide: true, mayForceTrigger: true, timeoutMs: 1000 } },
      { inboundHook: { reads: 'all', mayHide: true, mayForceTrigger: true, timeoutMs: 5000 } },
      false,
    ],
    ['runtime jobs added', {}, { jobs: { runtime: { maxActive: 3 } } }, true],
    ['more runtime jobs', { jobs: { runtime: { maxActive: 3 } } }, { jobs: { runtime: { maxActive: 5 } } }, true],
    ['fewer runtime jobs', { jobs: { runtime: { maxActive: 5 } } }, { jobs: { runtime: { maxActive: 3 } } }, false],
    ['model added', {}, { llm: { maxCallsPerTurn: 2, maxOutputTokens: 512 } }, true],
    [
      'more model calls',
      { llm: { maxCallsPerTurn: 2, maxOutputTokens: 512 } },
      { llm: { maxCallsPerTurn: 3, maxOutputTokens: 512 } },
      true,
    ],
    [
      'longer model output',
      { llm: { maxCallsPerTurn: 2, maxOutputTokens: 512 } },
      { llm: { maxCallsPerTurn: 2, maxOutputTokens: 1024 } },
      true,
    ],
    [
      'same model budget',
      { llm: { maxCallsPerTurn: 2, maxOutputTokens: 512 } },
      { llm: { maxCallsPerTurn: 1, maxOutputTokens: 256 } },
      false,
    ],
    [
      'MCP credentials only',
      { mcp: { servers: [remote('https://docs.example.com/mcp')] } },
      { mcp: { servers: [{ ...remote('https://docs.example.com/mcp'), headers: {} }] } },
      false,
    ],
    [
      'MCP address change',
      { mcp: { servers: [remote('https://docs.example.com/mcp')] } },
      { mcp: { servers: [remote('https://other.example.com/mcp')] } },
      true,
    ],
    [
      'MCP command args change',
      { mcp: { servers: [{ transport: 'stdio', name: 'local', command: 'example-mcp' }] } },
      { mcp: { servers: [{ transport: 'stdio', name: 'local', command: 'example-mcp', args: ['--write'] }] } },
      true,
    ],
  ]
  it.each(cases)('%s', (_name, previous, next, expanded) => {
    expect(
      extensionCapabilitiesExpand(
        previous === undefined ? undefined : caps(previous),
        next === undefined ? undefined : caps(next),
      ),
    ).toBe(expanded)
  })
})

describe('summarizeExtensionCapabilities', () => {
  it('phrases host-layer storage for the host instance instead of as data shared between agents', () => {
    const host = hostLayerAsCapabilities({ storage: {}, network: { mode: 'config', fields: ['endpoint'] } })
    expect(summarizeExtensionCapabilities(host, { layer: 'host' })).toEqual([
      { key: 'network', risk: 'normal', label: '访问你在配置中填写的地址', detail: 'endpoint' },
      { key: 'storage', risk: 'normal', label: '在本机保存扩展数据，页面与启用它的智能体共用' },
    ])
    expect(summarizeExtensionCapabilities(host)[1]).toMatchObject({ risk: 'sensitive' })
  })

  it('describes every capability with its risk tier', () => {
    expect(summarizeExtensionCapabilities(undefined)).toEqual([])
    const summary = summarizeExtensionCapabilities(
      caps({
        network: { mode: 'config', fields: ['baseUrl'] },
        storage: { scopes: ['agent', 'shared'] },
        assets: { write: true },
        history: { read: true },
        inboundHook: { reads: 'all', mayHide: true, mayForceTrigger: true, timeoutMs: 1000 },
        jobs: { declared: [{ id: 'daily', label: '每日摘要', cron: '0 8 * * *' }], runtime: { maxActive: 3 } },
        platform: { actions: [{ adapter: 'onebot', action: 'like_member' }], raw: ['onebot'] },
        llm: { maxCallsPerTurn: 2, maxOutputTokens: 512 },
        mcp: {
          servers: [
            remote('https://docs.example.com/mcp'),
            { transport: 'stdio', name: 'local', command: 'example-mcp', args: ['--readonly'] },
          ],
        },
        context: [{ name: 'usage', kind: 'static', maxChars: 100 }],
      }),
    )
    expect(summary.map(({ key, risk }) => `${key}:${risk}`)).toEqual([
      'network:normal',
      'storage:sensitive',
      'assets:normal',
      'history:normal',
      'inboundHook:high',
      'jobs.declared:normal',
      'jobs.runtime:sensitive',
      'platform.actions:high',
      'platform.raw:high',
      'llm:sensitive',
      'mcp.docs:sensitive',
      'mcp.local:high',
      'context:normal',
    ])
    expect(summary.find(({ key }) => key === 'inboundHook')?.detail).toBe(
      '可以对智能体隐藏消息、让智能体回应原本不会回应的消息',
    )
    expect(summary.find(({ key }) => key === 'mcp.docs')?.detail).toBe('docs.example.com')
    expect(summary.find(({ key }) => key === 'mcp.local')?.detail).toBe('example-mcp --readonly')
  })

  it('distinguishes narrower variants', () => {
    const domains = summarizeExtensionCapabilities(
      caps({
        network: { mode: 'domains', domains: ['a.example.com', 'b.example.com'] },
        storage: { scopes: ['agent'] },
        inboundHook: { reads: 'triggered', mayHide: false, mayForceTrigger: false, timeoutMs: 1000 },
        jobs: { declared: [] },
        platform: {},
        context: [],
      }),
    )
    expect(domains).toEqual([
      { key: 'network', risk: 'normal', label: '访问指定网站', detail: 'a.example.com、b.example.com' },
      { key: 'storage', risk: 'normal', label: '为这个智能体保存数据' },
      { key: 'inboundHook', risk: 'sensitive', label: '在智能体回应前查看要回应的消息' },
    ])
    expect(
      summarizeExtensionCapabilities(caps({ network: { mode: 'unrestricted', purpose: '打开任意链接' } }))[0],
    ).toMatchObject({ risk: 'high', detail: '打开任意链接' })
  })
})

describe('asset library, search index and host model capabilities', () => {
  const stickers = {
    name: 'stickers',
    fields: [{ name: 'meaning', weight: 2 }, { name: 'caption' }],
    filters: ['scope'],
  }

  it('accepts library and index declarations and keeps write separate from the library', () => {
    const declared = caps({ assets: { library: { quotaBytes: 64 * 1024 * 1024 } }, index: { collections: [stickers] } })
    expect(declared.index?.collections[0]?.fields[1]).toEqual({ name: 'caption', weight: 1 })
    expect(() => caps({ assets: {} })).toThrow('assets 至少声明 write 或 library')
    expect(() =>
      caps({ index: { collections: [{ name: 'stickers', fields: [{ name: 'scope' }], filters: ['scope'] }] } }),
    ).toThrow('不能重名')
    expect(() => caps({ index: { collections: [{ name: 'Stickers', fields: [{ name: 'a' }] }] } })).toThrow()
  })

  it('treats a new library or larger model allowance as an expansion, unlike a new index', () => {
    const before = caps({ assets: { write: true } })
    expect(extensionCapabilitiesExpand(before, caps({ assets: { write: true, library: {} } }))).toBe(true)
    expect(
      extensionCapabilitiesExpand(before, caps({ assets: { write: true }, index: { collections: [stickers] } })),
    ).toBe(false)
    const models = caps({ models: { maxCallsPerMinute: 10, maxOutputTokens: 512 } })
    expect(extensionCapabilitiesExpand(models, caps({ models: { maxCallsPerMinute: 20, maxOutputTokens: 512 } }))).toBe(
      true,
    )
    expect(extensionCapabilitiesExpand(models, caps({ models: { maxCallsPerMinute: 5, maxOutputTokens: 256 } }))).toBe(
      false,
    )
  })

  it('describes the new capabilities on the approval page', () => {
    expect(
      summarizeExtensionCapabilities(
        hostLayerAsCapabilities({
          assets: { library: { quotaBytes: 2 * 1024 * 1024 * 1024 } },
          index: { collections: [{ ...stickers, fields: [{ name: 'meaning', weight: 2 }], filters: [] }] },
          models: { maxCallsPerMinute: 30, maxOutputTokens: 1024 },
        }),
        { layer: 'host' },
      ),
    ).toEqual([
      {
        key: 'assets.library',
        risk: 'sensitive',
        label: '把频道里的图片收进扩展资源库，之后可以在其他频道使用',
        detail: '最多 2 GB',
      },
      { key: 'index', risk: 'normal', label: '建立可搜索的索引', detail: 'stickers' },
      {
        key: 'models',
        risk: 'sensitive',
        label: '使用本机已配置的模型，可以发送图片',
        detail: '每分钟最多 30 次，计入所选模型的用量',
      },
    ])
  })
})
