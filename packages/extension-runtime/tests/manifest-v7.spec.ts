import { configSchema, EMPTY_CONFIG_SCHEMA, EXTENSION_SDK_LEVEL } from '@nekro-nxt/contracts'
import { describe, expect, it } from 'vitest'
import {
  agentPermissionRequirement,
  carryExtensionConfig,
  configSecretReferences,
  contributionLayer,
  extensionManifestSchema,
  extensionProvides,
  extensionUiContributions,
  hasAgentLayer,
  hostPermissionRequirement,
  layerConfigSchema,
  LEGACY_EXTENSION_MESSAGE,
  manifestAdapter,
  materializeImportedRevision,
  resolveExtensionConfig,
} from '../src/index.ts'

const identity = { schemaVersion: 7, extensionId: 'ext_MANIFEST', revisionId: 'xrv_MANIFEST' } as const
const tool = { kind: 'tool', name: 'weather_lookup', description: '查询示例天气。' } as const
const adapter = { kind: 'adapter', apiVersion: 2, key: 'fixture', descriptorDigest: 'a'.repeat(64) } as const
const page = (entryId: string, extra: Record<string, unknown> = {}) => ({
  kind: 'host-page',
  entryId,
  title: '示例页面',
  icon: { kind: 'host-icon', name: 'layout-dashboard' },
  objectPane: 'hidden',
  startPath: '',
  ...extra,
})
const panel = (anchor: string, extra: Record<string, unknown> = {}) => ({
  kind: 'panel',
  id: `${anchor}-status`,
  anchor,
  title: '状态',
  densities: ['compact', 'full'],
  ...extra,
})
const manifestInput = (contributions: readonly unknown[], extra: Record<string, unknown> = {}) => ({
  ...identity,
  entrypoints: { host: 'source/host.ts', client: 'source/client.ts' },
  contributions,
  ...extra,
})
const hostManifest = (extra: Record<string, unknown> = {}) =>
  manifestInput([tool], { entrypoints: { host: 'source/host.ts' }, ...extra })
const mcp = { servers: [{ name: 'fixture', transport: 'streamable-http', url: 'https://mcp.example.com' }] }

describe('Extension Manifest V7', () => {
  it('combines both layers and derives ownership and provides from contributions', () => {
    const manifest = extensionManifestSchema.parse(
      manifestInput([
        tool,
        { kind: 'tool-view', tool: tool.name },
        { kind: 'rpc', method: 'items.list' },
        adapter,
        page('overview'),
        panel('agent'),
        panel('channel', { when: { channelKinds: ['group'] } }),
        panel('extension'),
        panel('connection', { role: 'status' }),
        { kind: 'message-renderer', richKind: 'fixture.card' },
      ]),
    )
    expect(manifest.permissions).toEqual({ permissions: [], networkOrigins: [] })
    expect(manifest).not.toHaveProperty('scope')
    expect(manifest.contributions.map(contributionLayer)).toEqual([
      'agent',
      'agent',
      'host',
      'host',
      'host',
      'agent',
      'agent',
      'host',
      'host',
      'host',
    ])
    expect(hasAgentLayer(manifest)).toBe(true)
    expect(extensionProvides(manifest)).toEqual(['agent', 'page', 'adapter'])
    expect(manifestAdapter(manifest)).toEqual(adapter)
    expect(extensionUiContributions(manifest)).toEqual({
      panels: manifest.contributions.filter((entry) => entry.kind === 'panel'),
      toolViews: [tool.name],
      messageRenderers: ['fixture.card'],
    })
    expect(extensionUiContributions(undefined)).toEqual({ panels: [], toolViews: [], messageRenderers: [] })
    expect(manifestAdapter(extensionManifestSchema.parse(hostManifest()))).toBeUndefined()
  })

  it('accepts host-only panels and message renderers without an adapter', () => {
    const manifest = extensionManifestSchema.parse(
      manifestInput(
        [
          panel('extension'),
          panel('connection', { role: 'setup' }),
          { kind: 'message-renderer', richKind: 'fixture.card' },
        ],
        { entrypoints: { client: 'source/client.ts' } },
      ),
    )
    expect(hasAgentLayer(manifest)).toBe(false)
    expect(extensionProvides(manifest)).toEqual([])
    expect(extensionUiContributions(manifest).messageRenderers).toEqual(['fixture.card'])
  })

  it('requires matching tools, valid panel anchors and a role only on connection panels', () => {
    expect(() => extensionManifestSchema.parse(manifestInput([{ kind: 'tool-view', tool: 'missing' }]))).toThrow(
      '本扩展声明的工具',
    )
    expect(() => extensionManifestSchema.parse(manifestInput([panel('unknown')]))).toThrow()
    expect(() => extensionManifestSchema.parse(manifestInput([panel('connection')]))).toThrow('连接面板必须声明')
    expect(() => extensionManifestSchema.parse(manifestInput([panel('agent', { role: 'status' })]))).toThrow(
      '只有连接面板',
    )
  })

  it('requires the source half used by each contribution and rejects an unused Client', () => {
    expect(() =>
      extensionManifestSchema.parse(manifestInput([panel('agent')], { entrypoints: { host: 'source/host.ts' } })),
    ).toThrow('界面贡献需要 Client')
    for (const contribution of [tool, adapter, { kind: 'rpc', method: 'items.list' }]) {
      expect(() =>
        extensionManifestSchema.parse(
          manifestInput([contribution, page('overview')], { entrypoints: { client: 'source/client.ts' } }),
        ),
      ).toThrow('需要 Host 源码')
    }
    expect(() => extensionManifestSchema.parse(manifestInput([tool]))).toThrow('Client 源码必须至少贡献')
  })

  it('accepts the page, panel and adapter limits and rejects one extra', () => {
    const pages = Array.from({ length: 8 }, (_, index) => page(`page-${index}`))
    const panels = Array.from({ length: 16 }, (_, index) => panel('agent', { id: `panel-${index}` }))
    expect(() => extensionManifestSchema.parse(manifestInput([adapter, ...pages, ...panels]))).not.toThrow()
    expect(() => extensionManifestSchema.parse(manifestInput([...pages, page('overflow')]))).toThrow(
      '最多贡献 8 个顶级页面',
    )
    expect(() => extensionManifestSchema.parse(manifestInput([...panels, panel('agent')]))).toThrow(
      '最多贡献 16 个面板',
    )
    expect(() =>
      extensionManifestSchema.parse(hostManifest({ contributions: [adapter, { ...adapter, key: 'other' }] })),
    ).toThrow('最多注册一个适配器')
  })

  it('rejects duplicate contribution identities and allows only one page with rail', () => {
    expect(() => extensionManifestSchema.parse(manifestInput([panel('agent'), panel('agent')]))).toThrow('面板 id 重复')
    expect(() => extensionManifestSchema.parse(manifestInput([page('overview'), page('overview')]))).toThrow(
      'entryId 不能重复',
    )
    expect(() => extensionManifestSchema.parse(hostManifest({ contributions: [tool, tool] }))).toThrow(
      '工具名称不能重复',
    )
    expect(() =>
      extensionManifestSchema.parse(
        hostManifest({
          contributions: [
            { kind: 'rpc', method: 'items.list' },
            { kind: 'rpc', method: 'items.list' },
          ],
        }),
      ),
    ).toThrow('method 不能重复')
    expect(() =>
      extensionManifestSchema.parse(manifestInput([page('overview', { rail: {} }), page('details')])),
    ).not.toThrow()
    expect(() =>
      extensionManifestSchema.parse(
        manifestInput([page('overview', { rail: {} }), page('details', { rail: { order: 1 } })]),
      ),
    ).toThrow('最多有一个页面注册导航轨入口')
  })

  it('requires agent capabilities for empty contributions, with a distinct MCP provides label', () => {
    for (const permissions of [{}, { host: { storage: {} } }, { agent: {} }]) {
      expect(() => extensionManifestSchema.parse(hostManifest({ contributions: [], permissions }))).toThrow(
        '扩展至少要提供一项内容',
      )
    }
    const mcpOnly = extensionManifestSchema.parse(hostManifest({ contributions: [], permissions: { agent: { mcp } } }))
    expect(hasAgentLayer(mcpOnly)).toBe(true)
    expect(extensionProvides(mcpOnly)).toEqual(['mcp'])
    const withHistory = extensionManifestSchema.parse(
      hostManifest({ contributions: [], permissions: { agent: { mcp, history: { read: true } } } }),
    )
    expect(extensionProvides(withHistory)).toEqual(['agent', 'mcp'])
  })

  it('supports secret fields in both layers, but rejects defaults and overlapping field names', () => {
    const hostSchema = configSchema.object({ hostToken: configSchema.secret('本机令牌') })
    const agentSchema = configSchema.object({ agentToken: configSchema.secret('智能体令牌') })
    const manifest = extensionManifestSchema.parse(
      hostManifest({ config: { host: { schema: hostSchema }, agent: { schema: agentSchema } } }),
    )
    expect(layerConfigSchema(manifest, 'host')).toEqual(hostSchema)
    expect(layerConfigSchema(manifest, 'agent')).toEqual(agentSchema)
    expect(layerConfigSchema(undefined, 'host')).toEqual(EMPTY_CONFIG_SCHEMA)
    const hostOnly = extensionManifestSchema.parse(
      manifestInput([page('overview')], { config: { host: { schema: hostSchema } } }),
    )
    expect(hasAgentLayer(hostOnly)).toBe(false)
    expect(layerConfigSchema(hostOnly, 'agent')).toEqual(EMPTY_CONFIG_SCHEMA)
    expect(() =>
      extensionManifestSchema.parse(
        hostManifest({ config: { host: { schema: hostSchema }, agent: { schema: hostSchema } } }),
      ),
    ).toThrow('不能使用同名字段')
    expect(() =>
      extensionManifestSchema.parse(manifestInput([page('overview')], { config: { agent: { schema: agentSchema } } })),
    ).toThrow('不能声明 config.agent')
    const token = hostSchema.dict['hostToken']
    if (token === undefined) throw new Error('fixture token field missing')
    const defaulted = {
      ...hostSchema,
      dict: { hostToken: { ...token, meta: { ...token.meta, default: 'fixture-default' } } },
    }
    for (const layer of ['host', 'agent']) {
      expect(() => extensionManifestSchema.parse(hostManifest({ config: { [layer]: { schema: defaulted } } }))).toThrow(
        '凭据字段不能声明默认值',
      )
    }
  })

  it('validates network config field references in their own layer and rejects the old capabilities path', () => {
    const config = {
      host: { schema: configSchema.object({ hostUrl: configSchema.string('本机地址') }) },
      agent: {
        schema: configSchema.object({
          agentUrl: configSchema.string('智能体地址'),
          count: configSchema.number('条数'),
        }),
      },
    }
    expect(() =>
      extensionManifestSchema.parse(
        hostManifest({
          config,
          permissions: {
            host: { network: { mode: 'config', fields: ['hostUrl'] } },
            agent: { network: { mode: 'config', fields: ['agentUrl'] } },
          },
        }),
      ),
    ).not.toThrow()
    for (const [layer, field] of [
      ['host', 'agentUrl'],
      ['agent', 'hostUrl'],
      ['agent', 'count'],
      ['agent', 'missing'],
    ] as const) {
      expect(() =>
        extensionManifestSchema.parse(
          hostManifest({ config, permissions: { [layer]: { network: { mode: 'config', fields: [field] } } } }),
        ),
      ).toThrow(`permissions.${layer}.network.fields 只能引用 config.${layer} 中的文本字段`)
    }
    expect(() =>
      extensionManifestSchema.parse(hostManifest({ permissions: { capabilities: { history: { read: true } } } })),
    ).toThrow('capabilities')
    expect(() =>
      extensionManifestSchema.parse(
        hostManifest({
          permissions: { agent: { network: { mode: 'domains', domains: ['https://api.example.com'] } } },
        }),
      ),
    ).toThrow()
  })

  it('requires MCP credential references to resolve to secret fields in either layer', () => {
    const withSecret = {
      servers: [
        {
          name: 'fixture',
          transport: 'streamable-http',
          url: 'https://mcp.example.com',
          headers: { Authorization: { secret: 'token' } },
        },
      ],
    }
    for (const layer of ['host', 'agent']) {
      expect(() =>
        extensionManifestSchema.parse(
          hostManifest({
            contributions: [],
            permissions: { agent: { mcp: withSecret } },
            config: { [layer]: { schema: configSchema.object({ token: configSchema.secret('令牌') }) } },
          }),
        ),
      ).not.toThrow()
    }
    expect(() =>
      extensionManifestSchema.parse(
        hostManifest({
          permissions: { agent: { mcp: withSecret } },
          config: { agent: { schema: configSchema.object({ token: configSchema.string('令牌') }) } },
        }),
      ),
    ).toThrow('必须是配置中的凭据字段')
  })

  it('accepts the supported SDK level and asks for an upgrade above it', () => {
    expect(() => extensionManifestSchema.parse(hostManifest({ requires: { sdk: EXTENSION_SDK_LEVEL } }))).not.toThrow()
    expect(() => extensionManifestSchema.parse(hostManifest({ requires: { sdk: EXTENSION_SDK_LEVEL + 1 } }))).toThrow(
      '请先升级',
    )
  })

  it('rejects V6 imports with the actionable legacy-format message and refuses scope on V7', () => {
    expect(() =>
      materializeImportedRevision({
        manifest: { ...hostManifest(), schemaVersion: 6, scope: 'agent' },
        sources: { host: 'export default {}' },
      }),
    ).toThrow(LEGACY_EXTENSION_MESSAGE)
    expect(() => extensionManifestSchema.parse(hostManifest({ scope: 'agent' }))).toThrow('scope')
  })
})

describe('Extension permissions and configuration', () => {
  const permissions = {
    permissions: ['channels.read', 'agents.read'],
    networkOrigins: [],
    host: { storage: {} },
    agent: { history: { read: true } },
  }
  const base = extensionManifestSchema.parse(hostManifest({ permissions }))

  it('keeps the asset library, search index and model calls in what each layer approves', () => {
    const stickers = {
      name: 'stickers',
      fields: [
        { name: 'meaning', weight: 2 },
        { name: 'caption', weight: 1 },
      ],
      filters: ['sources', 'scope'],
    }
    const media = extensionManifestSchema.parse(
      hostManifest({
        permissions: {
          permissions: [],
          networkOrigins: [],
          host: {
            assets: { library: {} },
            index: { collections: [stickers] },
            models: { maxCallsPerMinute: 30, maxOutputTokens: 512 },
          },
          agent: { assets: { library: {} }, index: { collections: [stickers] } },
        },
      }),
    )
    const collection = { ...stickers, filters: ['scope', 'sources'] }
    expect(hostPermissionRequirement(media, undefined).declaration.capabilities).toEqual({
      assets: { library: {} },
      index: { collections: [collection] },
      models: { maxCallsPerMinute: 30, maxOutputTokens: 512 },
    })
    expect(agentPermissionRequirement(media, undefined).declaration.capabilities).toEqual({
      assets: { library: {} },
      index: { collections: [collection] },
    })
  })

  it('approves each layer separately and requires reapproval only for expansion of that layer', () => {
    const firstHost = hostPermissionRequirement(base, undefined)
    const firstAgent = agentPermissionRequirement(base, undefined)
    expect(firstHost.approvalRequired).toBe(true)
    expect(firstAgent.approvalRequired).toBe(true)
    expect(firstHost.declaration).toEqual({
      permissions: ['agents.read', 'channels.read'],
      networkOrigins: [],
      capabilities: { storage: { scopes: ['shared'] } },
    })
    expect(firstAgent.declaration).toEqual({
      permissions: [],
      networkOrigins: [],
      capabilities: { history: { read: true } },
    })
    const hostGrant = {
      ownerKey: 'extension:ext_MANIFEST',
      artifactDigest: 'a'.repeat(64),
      permissionDigest: firstHost.permissionDigest,
      declaration: firstHost.declaration,
      approvedAt: 1,
    }
    const agentGrant = {
      ...hostGrant,
      ownerKey: 'activation:agt_FIXTURE:ext_MANIFEST',
      permissionDigest: firstAgent.permissionDigest,
      declaration: firstAgent.declaration,
    }
    expect(hostPermissionRequirement(base, hostGrant).approvalRequired).toBe(false)
    expect(agentPermissionRequirement(base, agentGrant).approvalRequired).toBe(false)
    const hostExpanded = extensionManifestSchema.parse(
      hostManifest({ permissions: { ...permissions, permissions: [...permissions.permissions, 'runtime.read'] } }),
    )
    expect(hostPermissionRequirement(hostExpanded, hostGrant).approvalRequired).toBe(true)
    expect(agentPermissionRequirement(hostExpanded, agentGrant).approvalRequired).toBe(false)
    const agentExpanded = extensionManifestSchema.parse(
      hostManifest({ permissions: { ...permissions, agent: { ...permissions.agent, assets: { write: true } } } }),
    )
    expect(hostPermissionRequirement(agentExpanded, hostGrant).approvalRequired).toBe(false)
    expect(agentPermissionRequirement(agentExpanded, agentGrant).approvalRequired).toBe(true)
    const reduced = extensionManifestSchema.parse(hostManifest({ permissions: { permissions: ['agents.read'] } }))
    expect(hostPermissionRequirement(reduced, hostGrant).approvalRequired).toBe(false)
    expect(agentPermissionRequirement(reduced, agentGrant).approvalRequired).toBe(false)
    expect(hostPermissionRequirement(undefined, undefined).approvalRequired).toBe(false)
    expect(agentPermissionRequirement(undefined, undefined).approvalRequired).toBe(false)
  })

  it('validates and carries configuration independently for each layer, including secret references', () => {
    const manifest = extensionManifestSchema.parse(
      hostManifest({
        config: {
          host: {
            schema: configSchema.object({
              endpoint: configSchema.string('地址', { default: 'https://api.example.com' }),
              hostToken: configSchema.secret('本机令牌'),
            }),
          },
          agent: {
            schema: configSchema.object({
              city: configSchema.string('城市', { default: '示例市' }),
              limit: configSchema.number('条数', { default: 3, min: 1 }),
              agentToken: configSchema.secret('智能体令牌'),
            }),
          },
        },
      }),
    )
    expect(resolveExtensionConfig(manifest, 'host', undefined)).toEqual({ endpoint: 'https://api.example.com' })
    expect(resolveExtensionConfig(manifest, 'agent', undefined)).toEqual({ city: '示例市', limit: 3 })
    expect(resolveExtensionConfig(manifest, 'agent', { limit: 5 })).toEqual({ city: '示例市', limit: 5 })
    expect(() => resolveExtensionConfig(manifest, 'agent', { limit: 0 })).toThrow('条数不能小于 1')
    expect(() => resolveExtensionConfig(manifest, 'agent', { endpoint: 'https://example.com' })).toThrow('未知配置项')
    expect(() => resolveExtensionConfig(manifest, 'host', { city: '示例市' })).toThrow('未知配置项')
    expect(
      carryExtensionConfig(manifest, 'agent', { city: '另一市', limit: 2, agentToken: 'sec_FIXTUREAGENT' }),
    ).toEqual({ city: '另一市', limit: 2, agentToken: 'sec_FIXTUREAGENT' })
    expect(carryExtensionConfig(manifest, 'agent', { city: 42, agentToken: 'sec_FIXTUREAGENT' })).toEqual({
      city: '示例市',
      limit: 3,
      agentToken: 'sec_FIXTUREAGENT',
    })
    expect(carryExtensionConfig(manifest, 'host', { endpoint: 42, hostToken: 'sec_FIXTUREHOST' })).toEqual({
      endpoint: 'https://api.example.com',
      hostToken: 'sec_FIXTUREHOST',
    })
    expect(
      configSecretReferences(manifest, 'host', { hostToken: 'sec_FIXTUREHOST', agentToken: 'sec_FIXTUREAGENT' }),
    ).toEqual(['sec_FIXTUREHOST'])
    expect(
      configSecretReferences(manifest, 'agent', { hostToken: 'sec_FIXTUREHOST', agentToken: 'sec_FIXTUREAGENT' }),
    ).toEqual(['sec_FIXTUREAGENT'])
    expect(resolveExtensionConfig(undefined, 'agent', undefined)).toEqual({})
  })
})
