import { configSchema } from '@nekro-nxt/contracts'
import { describe, expect, it } from 'vitest'
import {
  carryExtensionConfig,
  extensionManifestSchema,
  extensionUiContributions,
  permissionRequirement,
  resolveExtensionConfig,
} from '../src/index.ts'

const identity = {
  schemaVersion: 6,
  extensionId: 'ext_MANIFEST',
  revisionId: 'xrv_MANIFEST',
} as const

const panel = (anchor: string, extra: Record<string, unknown> = {}) => ({
  kind: 'panel',
  id: `${anchor}-status`,
  anchor,
  title: '状态',
  densities: ['compact', 'full'],
  ...extra,
})

const agentManifest = (contributions: readonly unknown[], extra: Record<string, unknown> = {}) => ({
  ...identity,
  scope: 'agent',
  entrypoints: { host: 'source/host.ts', client: 'source/client.ts' },
  contributions,
  ...extra,
})

const withCapabilities = (capabilities: Record<string, unknown>) => ({
  permissions: { permissions: [], networkOrigins: [], capabilities },
})

const hostAgentManifest = (extra: Record<string, unknown> = {}) =>
  agentManifest([], { entrypoints: { host: 'source/host.ts' }, ...extra })

const adapterManifest = (contributions: readonly unknown[]) => ({
  ...identity,
  scope: 'host-adapter',
  entrypoints: { host: 'source/host.ts', client: 'source/client.ts' },
  contributions: [
    { kind: 'adapter', apiVersion: 2, key: 'fixture', descriptorDigest: 'a'.repeat(64) },
    ...contributions,
  ],
})

describe('Extension Manifest V6', () => {
  it('accepts agent panels, matching tool views and defaults an empty permission set', () => {
    const manifest = extensionManifestSchema.parse(
      agentManifest([
        { kind: 'tool', name: 'weather_lookup', description: '查询天气。' },
        panel('agent'),
        panel('channel', { id: 'channel-status', densities: ['compact'], when: { channelKinds: ['group'] } }),
        { kind: 'tool-view', tool: 'weather_lookup' },
      ]),
    )
    expect(manifest.permissions).toEqual({ permissions: [], networkOrigins: [] })
    expect(extensionUiContributions(manifest)).toEqual({
      panels: [
        expect.objectContaining({ id: 'agent-status', anchor: 'agent' }),
        expect.objectContaining({ id: 'channel-status', anchor: 'channel' }),
      ],
      toolViews: ['weather_lookup'],
      messageRenderers: [],
    })
    expect(extensionUiContributions(undefined)).toEqual({ panels: [], toolViews: [], messageRenderers: [] })
  })

  it('rejects tool views for undeclared tools, wrong anchors, duplicate panels and missing clients', () => {
    expect(() => extensionManifestSchema.parse(agentManifest([{ kind: 'tool-view', tool: 'missing' }]))).toThrow(
      '本扩展声明的工具',
    )
    expect(() => extensionManifestSchema.parse(agentManifest([panel('connection')]))).toThrow('不能把面板放在')
    expect(() => extensionManifestSchema.parse(agentManifest([panel('agent'), panel('agent')]))).toThrow('面板 id 重复')
    expect(() =>
      extensionManifestSchema.parse({ ...agentManifest([panel('agent')]), entrypoints: { host: 'source/host.ts' } }),
    ).toThrow()
  })

  it('requires a role on connection panels and accepts message renderers only for adapters', () => {
    expect(() => extensionManifestSchema.parse(adapterManifest([panel('connection')]))).toThrow()
    const manifest = extensionManifestSchema.parse(
      adapterManifest([
        panel('connection', { role: 'status' }),
        panel('channel', { id: 'channel-info' }),
        { kind: 'message-renderer', richKind: 'fixture.card' },
      ]),
    )
    expect(extensionUiContributions(manifest).messageRenderers).toEqual(['fixture.card'])
    expect(() =>
      extensionManifestSchema.parse(agentManifest([{ kind: 'message-renderer', richKind: 'fixture.card' }])),
    ).toThrow()
  })

  it('rejects older schema versions and keeps credential fields to agent extensions without defaults', () => {
    expect(() => extensionManifestSchema.parse({ ...agentManifest([]), schemaVersion: 5 })).toThrow()
    const secretConfig = { config: { schema: configSchema.object({ token: configSchema.secret('令牌') }) } }
    expect(extensionManifestSchema.parse(hostAgentManifest(secretConfig)).config).toBeDefined()
    expect(() =>
      extensionManifestSchema.parse({
        ...adapterManifest([]),
        ...secretConfig,
      }),
    ).toThrow(/凭据字段/u)
    const withDefault = configSchema.object({ token: configSchema.secret('令牌') })
    const tokenNode = withDefault.dict['token']
    if (tokenNode === undefined) throw new Error('fixture token field missing')
    const defaulted = {
      ...withDefault,
      dict: { token: { ...tokenNode, meta: { ...tokenNode.meta, default: 'fixture-default' } } },
    }
    expect(() => extensionManifestSchema.parse(hostAgentManifest({ config: { schema: defaulted } }))).toThrow(/默认值/u)
  })

  it('accepts additive capabilities and rejects Revisions that need a newer Host', () => {
    const manifest = extensionManifestSchema.parse(
      hostAgentManifest({
        requires: { sdk: 2 },
        permissions: {
          permissions: [],
          networkOrigins: [],
          capabilities: {
            network: { mode: 'domains', domains: ['api.example.com', '*.cdn.example.com'] },
            storage: { scopes: ['agent', 'member'] },
            assets: { write: true },
            context: [{ name: 'mood', kind: 'dynamic', maxChars: 200 }],
          },
        },
      }),
    )
    expect(manifest.permissions.capabilities?.network).toEqual({
      mode: 'domains',
      domains: ['api.example.com', '*.cdn.example.com'],
    })
    expect(() => extensionManifestSchema.parse(hostAgentManifest({ requires: { sdk: 999 } }))).toThrow(/升级/u)
    expect(() =>
      extensionManifestSchema.parse(
        hostAgentManifest(withCapabilities({ network: { mode: 'domains', domains: ['https://api.example.com'] } })),
      ),
    ).toThrow()
    expect(() =>
      extensionManifestSchema.parse(
        hostAgentManifest(withCapabilities({ network: { mode: 'config', fields: ['baseUrl'] } })),
      ),
    ).toThrow(/文本字段/u)
    expect(
      extensionManifestSchema.parse(
        hostAgentManifest({
          config: { schema: configSchema.object({ baseUrl: configSchema.string('服务地址') }) },
          ...withCapabilities({ network: { mode: 'config', fields: ['baseUrl'] } }),
        }),
      ).scope,
    ).toBe('agent')
  })
})

describe('Extension permissions and configuration', () => {
  const declaration = { permissions: ['channels.read', 'agents.read'], networkOrigins: [] }

  it('requires approval only when a declaration expands the current grant', () => {
    const first = permissionRequirement(declaration, undefined)
    expect(first.approvalRequired).toBe(true)
    expect(first.declaration.permissions).toEqual(['agents.read', 'channels.read'])
    const grant = {
      ownerKey: 'activation:agt_A:ext_B',
      artifactDigest: 'a'.repeat(64),
      permissionDigest: first.permissionDigest,
      declaration: first.declaration,
      approvedAt: 1,
    }
    expect(permissionRequirement(declaration, grant).approvalRequired).toBe(false)
    expect(permissionRequirement({ permissions: ['agents.read'], networkOrigins: [] }, grant).approvalRequired).toBe(
      false,
    )
    expect(
      permissionRequirement({ permissions: ['agents.read', 'runtime.read'], networkOrigins: [] }, grant)
        .approvalRequired,
    ).toBe(true)
    expect(permissionRequirement(undefined, undefined).approvalRequired).toBe(false)
  })

  it('validates config against the Manifest schema and carries valid values across Revisions', () => {
    const manifest = extensionManifestSchema.parse(
      agentManifest([{ kind: 'tool', name: 'probe', description: '探针。' }], {
        entrypoints: { host: 'source/host.ts' },
        config: {
          schema: configSchema.object({
            city: configSchema.string('城市', { default: '示例市' }),
            limit: configSchema.number('条数', { default: 3, min: 1 }),
          }),
        },
      }),
    )
    expect(resolveExtensionConfig(manifest, undefined)).toEqual({ city: '示例市', limit: 3 })
    expect(resolveExtensionConfig(manifest, { limit: 5 })).toEqual({ city: '示例市', limit: 5 })
    expect(() => resolveExtensionConfig(manifest, { limit: 0 })).toThrow('条数不能小于 1')
    expect(() => resolveExtensionConfig(manifest, { unknown: true })).toThrow('未知配置项')
    expect(carryExtensionConfig(manifest, { city: '另一市', limit: 2 })).toEqual({ city: '另一市', limit: 2 })
    expect(carryExtensionConfig(manifest, { city: 42 })).toEqual({ city: '示例市', limit: 3 })
    expect(resolveExtensionConfig(undefined, undefined)).toEqual({})
  })
})
