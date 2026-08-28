import {
  DshNxtHostUiSchema,
  HostPageContributionSchema,
  HostPageIconSchema,
  HostUiNavigationModelSchema,
  HostUiNetworkOriginSchema,
  HostUiOwnerSchema,
  HostUiPageEntrySchema,
  HostUiPermissionDeclarationSchema,
} from '../src/index.ts'
import { describe, expect, it } from 'vitest'

const hostPage = {
  kind: 'host-page' as const,
  entryId: 'overview',
  title: '项目概览',
  description: '查看项目状态。',
  icon: { kind: 'host-icon' as const, name: 'layout-dashboard' as const },
  objectPane: 'navigation' as const,
  startPath: 'overview',
}

describe('Host UI contracts', () => {
  it('accepts both icon owners and a complete page entry', () => {
    expect(HostPageIconSchema.parse(hostPage.icon)).toEqual(hostPage.icon)
    expect(
      HostPageIconSchema.parse({ kind: 'svg', path: 'assets/project-mark.svg', sha256: 'a'.repeat(64) }),
    ).toMatchObject({ kind: 'svg' })
    expect(HostPageContributionSchema.parse(hostPage)).toEqual(hostPage)
    expect(
      HostPageContributionSchema.parse({ ...hostPage, description: undefined, objectPane: 'hidden' }),
    ).toMatchObject({
      objectPane: 'hidden',
    })
    expect(
      HostUiOwnerSchema.parse({ kind: 'extension', extensionId: 'ext_project', revisionId: 'xrv_project1' }),
    ).toMatchObject({ kind: 'extension' })
    expect(
      HostUiOwnerSchema.parse({ kind: 'dsh-plugin', entryId: 'dpe_project', artifactDigest: 'b'.repeat(64) }),
    ).toMatchObject({ kind: 'dsh-plugin' })
    expect(
      HostUiPageEntrySchema.parse({
        pageInstanceId: 'hup_project',
        owner: { kind: 'extension', extensionId: 'ext_project', revisionId: 'xrv_project1' },
        entryId: hostPage.entryId,
        title: hostPage.title,
        description: hostPage.description,
        icon: hostPage.icon,
        objectPane: hostPage.objectPane,
        startPath: hostPage.startPath,
        visible: true,
        sortOrder: 0,
        routeBase: '/apps/hup_project',
        client: { moduleUrl: '/api/extensions/ext_project/client.mjs', buildKey: 'c'.repeat(64) },
        diagnostic: { status: 'ready', message: 'ok', observedAt: 1 },
        createdAt: 1,
        updatedAt: 2,
      }),
    ).toMatchObject({ pageInstanceId: 'hup_project', diagnostic: { status: 'ready' } })
  })

  it('normalizes HTTP origins and rejects unsafe origin shapes', () => {
    expect(HostUiNetworkOriginSchema.parse('https://example.com/')).toBe('https://example.com')
    expect(HostUiNetworkOriginSchema.safeParse('ftp://example.com').success).toBe(false)
    expect(HostUiNetworkOriginSchema.safeParse('https://example.com/path').success).toBe(false)
    expect(HostUiNetworkOriginSchema.safeParse('https://user@example.com').success).toBe(false)
  })

  it('requires unique permissions and explicit network authority', () => {
    expect(
      HostUiPermissionDeclarationSchema.parse({
        permissions: ['network.request', 'agents.read'],
        networkOrigins: ['https://example.com'],
      }),
    ).toEqual({ permissions: ['network.request', 'agents.read'], networkOrigins: ['https://example.com'] })
    expect(
      HostUiPermissionDeclarationSchema.safeParse({ permissions: ['agents.read', 'agents.read'], networkOrigins: [] })
        .success,
    ).toBe(false)
    expect(
      HostUiPermissionDeclarationSchema.safeParse({
        permissions: ['network.request'],
        networkOrigins: ['https://example.com', 'https://example.com'],
      }).success,
    ).toBe(false)
    expect(
      HostUiPermissionDeclarationSchema.safeParse({
        permissions: ['agents.read'],
        networkOrigins: ['https://example.com'],
      }).success,
    ).toBe(false)
  })

  it('bounds navigation totals and DSH package paths', () => {
    expect(
      HostUiNavigationModelSchema.parse({
        revision: 1,
        groups: [
          {
            id: 'main',
            label: '项目',
            items: [
              {
                id: 'overview',
                label: '概览',
                description: '查看状态',
                icon: hostPage.icon,
                badge: '1',
                status: 'success',
                disabledReason: '只读',
                path: 'overview',
              },
            ],
          },
        ],
      }),
    ).toMatchObject({ revision: 1 })
    expect(
      HostUiNavigationModelSchema.safeParse({
        revision: 1,
        groups: [
          {
            id: 'first',
            items: Array.from({ length: 256 }, (_, index) => ({ id: `a${index}`, label: 'A', path: '' })),
          },
          { id: 'second', items: [{ id: 'overflow', label: 'B', path: '' }] },
        ],
      }).success,
    ).toBe(false)
    expect(
      DshNxtHostUiSchema.parse({
        schemaVersion: 1,
        entryKey: 'main',
        client: 'client.mjs',
        css: 'client.css',
        pages: [hostPage],
      }),
    ).toMatchObject({ permissions: { permissions: [], networkOrigins: [] } })
    expect(
      DshNxtHostUiSchema.safeParse({ schemaVersion: 1, entryKey: 'main', client: '../client.mjs', pages: [hostPage] })
        .success,
    ).toBe(false)
  })
})
