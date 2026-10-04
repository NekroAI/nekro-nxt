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

  it('rejects older schema versions and secret fields in extension config', () => {
    expect(() => extensionManifestSchema.parse({ ...agentManifest([]), schemaVersion: 5 })).toThrow()
    expect(() =>
      extensionManifestSchema.parse(
        agentManifest([], { config: { schema: configSchema.object({ token: configSchema.secret('令牌') }) } }),
      ),
    ).toThrow()
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
