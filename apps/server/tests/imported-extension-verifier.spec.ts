import { ExtensionIdSchema, ExtensionRevisionIdSchema } from '@nekro-nxt/contracts'
import {
  ExtensionBuilder,
  ExtensionSourceStore,
  materializeDynamicPackage,
  type LocalExtension,
  type Revision,
} from '@nekro-nxt/extension-runtime'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyImportedExtensionRevision } from '../src/imported-extension-verifier.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('imported Extension Runtime verification', () => {
  it('executes Host UI factory, RPC, page registration, component and dispose on this Host', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-import-verifier-'))
    directories.push(directory)
    const extensionId = ExtensionIdSchema.parse('ext_IMPORTHOSTUI')
    const revisionId = ExtensionRevisionIdSchema.parse('xrv_IMPORTHOSTUIONE')
    const page = {
      kind: 'host-page' as const,
      entryId: 'overview',
      title: '导入概览',
      icon: { kind: 'host-icon' as const, name: 'layout-dashboard' as const },
      objectPane: 'hidden' as const,
      startPath: '',
    }
    const materialized = materializeDynamicPackage({
      extensionId,
      revisionId,
      snapshot: {
        name: '导入页面验证',
        purpose: '验证本机页面 Runtime。',
        hostCode: `harness.handle('status', () => ({ ok: true }))\nreturn { apply() {} }`,
        clientCode: `return {
  apply(ctx) {
    return ctx.pages.register(
      { page: ${JSON.stringify(page)} },
      ({ entryId }) => React.createElement('section', null, entryId)
    )
  }
}`,
        permissions: { permissions: ['runtime.read'], networkOrigins: [] },
        contributions: [page],
      },
    })
    const sourceStore = new ExtensionSourceStore(path.join(directory, 'sources'))
    await sourceStore.publish(extensionId, revisionId, materialized)
    const builder = new ExtensionBuilder(path.join(directory, 'cache'))
    const artifact = await builder.build({
      extensionId,
      revisionId,
      contentDigest: materialized.contentDigest,
      sourceDirectory: sourceStore.revisionSourceDirectory(extensionId, revisionId),
    })
    const extension: LocalExtension = {
      id: extensionId,
      scope: 'host-ui',
      slug: 'import-host-ui',
      displayName: '导入页面验证',
      description: '',
      createdAt: 1,
    }
    const revision: Revision = {
      id: revisionId,
      extensionId,
      revisionNumber: 1,
      contentDigest: materialized.contentDigest,
      payloadDigest: materialized.payloadDigest,
      createdAt: 1,
    }

    await expect(
      verifyImportedExtensionRevision({ extension, revision, materialized, artifact, dshVersion: '0.1.1-rc.2' }),
    ).resolves.toMatchObject({
      contractVersion: 'nekro-nxt-extension-v4',
      scope: 'host-ui',
      origin: { pluginRunId: 'local-runtime-verification' },
      rpcMethods: ['status'],
      renderedPages: [page],
      permissions: { permissions: ['runtime.read'], networkOrigins: [] },
    })
  })

  const verifyAgent = async (name: string, clientCode: string, permissions: readonly string[]) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-import-agent-'))
    directories.push(directory)
    const extensionId = ExtensionIdSchema.parse(`ext_IMPORT${name.toUpperCase()}`)
    const revisionId = ExtensionRevisionIdSchema.parse(`xrv_IMPORT${name.toUpperCase()}`)
    const materialized = materializeDynamicPackage({
      extensionId,
      revisionId,
      snapshot: {
        name: '导入面板验证',
        purpose: '验证面板与工具视图。',
        hostCode: `return {
  inject: ['tools'],
  apply(ctx) {
    ctx.tools.register(harness.defineTool({
      name: 'weather_lookup',
      description: '查询天气。',
      parameters: {},
      execute() { return 'sunny' }
    }))
  }
}`,
        clientCode,
        permissions: { permissions: [...permissions], networkOrigins: [] },
        contributions: [
          { kind: 'tool', name: 'weather_lookup', description: '查询天气。' },
          { kind: 'panel', id: 'status', anchor: 'agent', title: '状态', densities: ['compact', 'full'] },
          { kind: 'tool-view', tool: 'weather_lookup' },
        ],
      },
    })
    const sourceStore = new ExtensionSourceStore(path.join(directory, 'sources'))
    await sourceStore.publish(extensionId, revisionId, materialized)
    const artifact = await new ExtensionBuilder(path.join(directory, 'cache')).build({
      extensionId,
      revisionId,
      contentDigest: materialized.contentDigest,
      sourceDirectory: sourceStore.revisionSourceDirectory(extensionId, revisionId),
    })
    return verifyImportedExtensionRevision({
      extension: {
        id: extensionId,
        scope: 'agent',
        slug: `import-${name}`,
        displayName: '导入面板验证',
        description: '',
        createdAt: 1,
      },
      revision: {
        id: revisionId,
        extensionId,
        revisionNumber: 1,
        contentDigest: materialized.contentDigest,
        payloadDigest: materialized.payloadDigest,
        createdAt: 1,
      },
      materialized,
      artifact,
      dshVersion: '0.1.1-rc.2',
    })
  }

  const panelClient = `const densities = []
const views = []
return {
  apply(ctx) {
    ctx.panels.register(
      { id: 'status', anchor: 'agent', title: '状态', densities: ['compact', 'full'] },
      ({ anchor, density }) => {
        densities.push(density)
        const agent = ctx.data.useAgent(anchor.id)
        return React.createElement(ctx.ui.Section, null, agent ? agent.name : '')
      },
    )
    ctx.toolViews.register('weather_lookup', ({ call, density }) => {
      views.push(density)
      return React.createElement(ctx.ui.StatusBadge, null, call.toolName)
    })
  }
}`

  it('renders every declared panel density and both tool-view densities for an Agent Extension', async () => {
    await expect(verifyAgent('panel', panelClient, ['agents.read'])).resolves.toMatchObject({
      contractVersion: 'nekro-nxt-extension-v4',
      toolInvocations: [{ name: 'weather_lookup', succeeded: true }],
      renderedPanels: ['status'],
      renderedToolViews: ['weather_lookup'],
      renderedMessageRenderers: [],
      permissions: { permissions: ['agents.read'], networkOrigins: [] },
    })
  })

  it('rejects a data hook whose permission the Manifest did not declare', async () => {
    await expect(verifyAgent('nopermission', panelClient, [])).rejects.toThrow('agents.read')
  })
})
