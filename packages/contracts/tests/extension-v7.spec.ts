import { describe, expect, it } from 'vitest'
import {
  agentPermissionDeclaration,
  CommunityExtensionDetailSchema,
  configSchema,
  ExtensionLayeredConfigSchema,
  ExtensionPermissionsSchema,
  EXTENSION_SDK_LEVEL,
  EXTENSION_SDK_RELEASES,
  extensionSdkVersion,
  HostApiContracts,
  HostPageContributionSchema,
  HostSnapshotSchema,
  hostPermissionDeclaration,
} from '../src/index.ts'

const permissions = ExtensionPermissionsSchema.parse({
  permissions: ['agents.read', 'network.request'],
  networkOrigins: ['https://ui.example.com/'],
  host: { network: { mode: 'domains', domains: ['api.example.com'] }, storage: { quotaBytes: 4096 } },
  agent: { history: { read: true }, storage: { scopes: ['agent'] } },
})
const hostApproval = { permissionDigest: 'a'.repeat(64) }
const agentApproval = { permissionDigest: 'b'.repeat(64) }
const config = {
  host: { schema: configSchema.object({ hostToken: configSchema.secret('本机令牌') }) },
  agent: { schema: configSchema.object({ agentToken: configSchema.secret('智能体令牌') }) },
}

describe('Extension V7 contracts', () => {
  it('uses SDK level 8 and separates browser, host and agent permissions', () => {
    expect(EXTENSION_SDK_LEVEL).toBe(8)
    // Raising the level needs the NekroNXT version that ships it, which is what users are shown.
    expect(EXTENSION_SDK_RELEASES.at(-1)?.level).toBe(EXTENSION_SDK_LEVEL)
    expect(extensionSdkVersion(8)).toBe('0.5.0')
    expect(extensionSdkVersion(7)).toBe('0.4.0')
    expect(extensionSdkVersion(EXTENSION_SDK_LEVEL + 1)).toBeUndefined()
    expect(ExtensionPermissionsSchema.parse({})).toEqual({ permissions: [], networkOrigins: [] })
    expect(hostPermissionDeclaration(permissions)).toEqual({
      permissions: ['agents.read', 'network.request'],
      networkOrigins: ['https://ui.example.com'],
      capabilities: {
        network: { mode: 'domains', domains: ['api.example.com'] },
        storage: { scopes: ['shared'], quotaBytes: 4096 },
      },
    })
    expect(agentPermissionDeclaration(permissions)).toEqual({
      permissions: [],
      networkOrigins: [],
      capabilities: { history: { read: true }, storage: { scopes: ['agent'] } },
    })
    expect(ExtensionPermissionsSchema.safeParse({ capabilities: { history: { read: true } } }).success).toBe(false)
    expect(ExtensionPermissionsSchema.safeParse({ host: { history: { read: true } } }).success).toBe(false)
    expect(ExtensionPermissionsSchema.safeParse({ host: { storage: { scopes: ['shared'] } } }).success).toBe(false)
  })

  it('checks browser permission uniqueness and network authority in the new permissions shape', () => {
    expect(ExtensionPermissionsSchema.safeParse({ permissions: ['agents.read', 'agents.read'] }).success).toBe(false)
    expect(ExtensionPermissionsSchema.safeParse({ networkOrigins: ['https://ui.example.com'] }).success).toBe(false)
    expect(
      ExtensionPermissionsSchema.safeParse({
        permissions: ['network.request'],
        networkOrigins: ['https://ui.example.com', 'https://ui.example.com/'],
      }).success,
    ).toBe(false)
  })

  it('accepts layered config with secrets and rejects the retired flat declaration', () => {
    expect(ExtensionLayeredConfigSchema.parse(config)).toEqual(config)
    expect(ExtensionLayeredConfigSchema.safeParse({ schema: config.host.schema }).success).toBe(false)
    expect(ExtensionLayeredConfigSchema.parse({ host: config.host })).toEqual({ host: config.host })
  })

  it('supports a page rail declaration and bounds its order', () => {
    const page = {
      kind: 'host-page',
      entryId: 'overview',
      title: '示例概览',
      icon: { kind: 'host-icon', name: 'layout-dashboard' },
      objectPane: 'hidden',
      startPath: '',
    }
    expect(HostPageContributionSchema.parse({ ...page, rail: {} })).toHaveProperty('rail', {})
    expect(HostPageContributionSchema.parse({ ...page, rail: { order: 999 } })).toHaveProperty('rail', { order: 999 })
    for (const order of [-1, 1000, 1.5]) {
      expect(HostPageContributionSchema.safeParse({ ...page, rail: { order } }).success).toBe(false)
    }
  })

  it('carries both approvals on enable/install and accepts host secret drafts', () => {
    const revisionId = 'xrv_CONTRACTFIXTURE'
    expect(
      HostApiContracts.activateExtension.request.parse({
        revisionId,
        permissionApproval: agentApproval,
        hostPermissionApproval: hostApproval,
      }),
    ).toEqual({ revisionId, permissionApproval: agentApproval, hostPermissionApproval: hostApproval })
    expect(
      HostApiContracts.installHostExtension.request.parse({
        revisionId,
        permissionApproval: hostApproval,
        agentPermissionApproval: agentApproval,
      }),
    ).toEqual({ revisionId, permissionApproval: hostApproval, agentPermissionApproval: agentApproval })
    expect(
      HostApiContracts.updateHostExtensionConfig.request.parse({
        config: {},
        secrets: { hostToken: 'fictional-draft' },
      }),
    ).toEqual({ config: {}, secrets: { hostToken: 'fictional-draft' } })
    expect(
      HostApiContracts.updateHostExtensionConfig.response.parse({ config: {}, configuredSecrets: ['hostToken'] }),
    ).toEqual({ config: {}, configuredSecrets: ['hostToken'] })
  })

  it('allows page calls without an agent and passes explicit panel anchors', () => {
    expect(HostApiContracts.extensionClientCall.request.parse({ method: 'items.list' })).toEqual({
      method: 'items.list',
    })
    for (const kind of ['agent', 'channel', 'extension', 'connection']) {
      const request = {
        anchor: { kind, id: 'fixture-anchor' },
        agentId: 'agt_CONTRACTFIXTURE',
        method: 'items.list',
        input: { limit: 3 },
      }
      expect(HostApiContracts.extensionClientCall.request.parse(request)).toEqual(request)
    }
    expect(
      HostApiContracts.extensionClientCall.request.safeParse({
        anchor: { kind: 'unknown', id: 'fixture' },
        method: 'items.list',
      }).success,
    ).toBe(false)
  })

  it('projects provides, two config schemas, separate approvals and configured host secrets in snapshots', () => {
    const requirement = {
      declaration: { permissions: [], networkOrigins: [] },
      permissionDigest: 'a'.repeat(64),
      approvalRequired: false,
    }
    const verification = {
      verifiedAt: 1,
      dshVersion: 'fixture-dsh',
      contractVersion: 'nekro-nxt-extension-v5',
      hostBuilt: true,
      clientBuilt: false,
      buildKey: 'fixture-build',
      toolInvocationCount: 1,
      rpcMethods: [],
      permissions,
      hostPermission: requirement,
      agentPermission: { ...requirement, permissionDigest: 'b'.repeat(64), approvalRequired: true },
    }
    const extension = {
      id: 'ext_CONTRACTFIXTURE',
      provides: ['agent', 'page'],
      slug: 'contract-fixture',
      displayName: '契约扩展',
      description: '',
      revisions: [
        {
          id: 'xrv_CONTRACTFIXTURE',
          revisionNumber: 1,
          createdAt: 1,
          provides: ['agent', 'page'],
          agentLayer: true,
          contributions: ['tool:fixture'],
          hostConfigSchema: config.host.schema,
          agentConfigSchema: config.agent.schema,
          verification,
        },
      ],
      activations: [],
      clientDiagnostics: [],
      installation: {
        extensionRevisionId: 'xrv_CONTRACTFIXTURE',
        installedAt: 2,
        config: {},
        configuredSecrets: ['hostToken'],
      },
      hostPermission: requirement,
    }
    const schema = HostSnapshotSchema.shape.extensions.element
    expect(schema.parse(extension)).toMatchObject(extension)
    expect(schema.safeParse({ ...extension, scope: 'agent' }).success).toBe(false)
    expect(
      schema.safeParse({
        ...extension,
        revisions: [{ ...extension.revisions[0], verification: { ...verification, permissionApprovalRequired: true } }],
      }).success,
    ).toBe(false)
  })

  it('filters community extensions by provides and tolerates future response fields at every level', () => {
    expect(HostApiContracts.listCommunityExtensions.params.parse({ provides: 'mcp' })).toMatchObject({
      provides: 'mcp',
    })
    expect(HostApiContracts.listCommunityExtensions.params.safeParse({ scope: 'agent' }).success).toBe(false)
    const publisher = { handle: 'fixture-publisher', displayName: '示例作者', avatarUrl: null }
    const latest = {
      id: 'rel_CONTRACTFIXTURE',
      reviewStatus: 'passed',
      rating: {
        standard: 'v1',
        score: 4.5,
        dimensions: [{ key: 'security', stars: 5, headline: '权限与用途一致' }],
        badges: ['least-privilege'],
      },
      permissions: [{ key: 'host.storage', level: 'normal', label: '本机存储', layer: 'host' as const }],
      packageSize: 128,
      requiresSdk: 7,
      notes: '',
      createdAt: 1,
    }
    const detail = {
      id: 'ext_CONTRACTFIXTURE',
      provides: ['agent', 'page'],
      displayName: '社区样本',
      summary: '',
      tags: [],
      iconUrl: null,
      official: false,
      publisher,
      latest,
      downloads: 0,
      updatedAt: 1,
      pageUrl: 'https://community.example.com/extensions/fixture',
      description: '',
      sourceUrl: null,
      review: {
        status: 'passed',
        rating: {
          standard: 'v1',
          score: 4.5,
          dimensions: [{ key: 'security', stars: 5, headline: '权限与用途一致' }],
          badges: ['least-privilege'],
        },
        summary: '',
        dimensions: [{ key: 'security', notes: '说明' }],
        findings: [{ dimension: 'security', severity: 'info', title: '示例说明' }],
        checks: [],
        reviewedAt: 1,
      },
    }
    expect(
      CommunityExtensionDetailSchema.parse({
        ...detail,
        future: true,
        publisher: { ...publisher, future: true },
        latest: { ...latest, future: true, permissions: [{ ...latest.permissions[0], future: true }] },
        review: { ...detail.review, future: true, findings: [{ ...detail.review.findings[0], future: true }] },
      }),
    ).toEqual(detail)
  })
})

describe('cross-layer permissions', () => {
  const stickers = { name: 'stickers', fields: [{ name: 'meaning' }] }

  it('keeps host model calls out of the agent layer', () => {
    expect(() =>
      ExtensionPermissionsSchema.parse({ agent: { models: { maxCallsPerMinute: 1, maxOutputTokens: 64 } } }),
    ).toThrow('models 只能在 permissions.host 中声明')
  })

  it('requires a collection both layers declare to mean the same thing', () => {
    expect(
      ExtensionPermissionsSchema.parse({
        host: { index: { collections: [stickers] } },
        agent: { index: { collections: [stickers] } },
      }),
    ).toMatchObject({ agent: { index: { collections: [{ name: 'stickers' }] } } })
    expect(() =>
      ExtensionPermissionsSchema.parse({
        host: { index: { collections: [stickers] } },
        agent: { index: { collections: [{ ...stickers, filters: ['scope'] }] } },
      }),
    ).toThrow('定义不一致')
  })
})
