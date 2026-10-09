import { createHash } from 'node:crypto'
import { strToU8, zipSync } from 'fflate'
import { verifyExtensionPackage } from '@nekro-nxt/extension-format'
import { NekroRuntime } from '../src/bootstrap.js'
import { extensionVerification } from './fixtures/extension-verification.js'
import { ExtensionIdSchema, ExtensionRevisionIdSchema, type HostUiPermission } from '@nekro-nxt/contracts'
import {
  ExtensionBuilder,
  ExtensionSourceStore,
  materializeDynamicPackage,
  type DynamicPackageSnapshot,
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
        contributions: [page, { kind: 'rpc', method: 'status' }],
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
      provides: materialized.provides,
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
      contractVersion: 'nekro-nxt-extension-v5',

      origin: { pluginRunId: 'local-runtime-verification' },
      rpcMethods: ['status'],
      renderedPages: [page],
      permissions: { permissions: ['runtime.read'], networkOrigins: [] },
    })
  })

  const verifyAgent = async (name: string, clientCode: string, permissions: readonly HostUiPermission[]) => {
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
        provides: materialized.provides,
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
      contractVersion: 'nekro-nxt-extension-v5',
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

it('saves and imports one V7 extension with a tool and page, then installs and attaches it', async () => {
  const createRuntime = async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nxt-combined-extension-'))
    directories.push(directory)
    return NekroRuntime.create({
      coreDatabasePath: path.join(directory, 'core.sqlite'),
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      assetRoot: path.join(directory, 'assets'),
      extensionDataRoot: path.join(directory, 'extensions'),
      extensionCacheRoot: path.join(directory, 'cache'),
    })
  }
  const source = await createRuntime()
  const target = await createRuntime()
  const page = {
    kind: 'host-page' as const,
    entryId: 'overview',
    title: '组合扩展',
    icon: { kind: 'host-icon' as const, name: 'puzzle' as const },
    objectPane: 'hidden' as const,
    startPath: '',
  }
  const snapshot: DynamicPackageSnapshot = {
    name: '工具与页面组合',
    purpose: '验证统一形态可以保存、导入、安装与启用。',
    hostCode: `harness.handle('status', (_input, caller) => ({ surface: caller.surface, hostOption: harness.config().hostOption }))
return {
  inject: ['tools'],
  apply(ctx) {
    harness.registerTool(ctx, harness.defineTool({ name: 'combined_probe', description: '组合探针', parameters: {}, output: { schema: { type: 'string' }, render(_args, value) { return [{ type: 'text', text: value }] } }, execute() { return 'ok' } }))
  }
}`,
    clientCode: `return { apply(ctx) { ctx.pages.register({ page: ${JSON.stringify(page)} }, () => React.createElement('section', null, '组合页面')) } }`,
    permissions: { permissions: [], networkOrigins: [] },
    config: {
      host: {
        schema: {
          type: 'object',
          dict: { hostOption: { type: 'string', meta: { description: '本机选项', default: 'host-default' } } },
        },
      },
      agent: {
        schema: {
          type: 'object',
          dict: { agentOption: { type: 'string', meta: { description: '智能体选项', default: 'agent-default' } } },
        },
      },
    },
    contributions: [
      page,
      { kind: 'tool' as const, name: 'combined_probe', description: '组合探针' },
      { kind: 'rpc' as const, method: 'status' },
    ],
  }
  try {
    const saved = await source.extensionService.saveDynamicPackage({
      snapshot,
      slug: 'combined-probe',
      displayName: snapshot.name,
      description: snapshot.purpose,
      verification: { ...extensionVerification(['combined_probe'], ['status']), renderedPages: [page] },
    })
    expect(saved.extension.provides).toEqual(['agent', 'page'])
    const materialized = materializeDynamicPackage({
      extensionId: saved.extension.id,
      revisionId: saved.revision.id,
      snapshot,
    })
    expect(materialized.manifest).not.toHaveProperty('scope')
    const files = {
      'revision/manifest.json': strToU8(JSON.stringify(materialized.manifest)),
      'revision/source/host.ts': strToU8(materialized.sources.host!),
      'revision/source/client.ts': strToU8(materialized.sources.client!),
    }
    const transfer = {
      schemaVersion: 2,
      kind: 'nekro-nxt-extension',
      extension: {
        id: saved.extension.id,
        slug: saved.extension.slug,
        displayName: saved.extension.displayName,
        description: saved.extension.description,
        createdAt: saved.extension.createdAt,
      },
      revision: {
        id: saved.revision.id,
        revisionNumber: saved.revision.revisionNumber,
        contentDigest: saved.revision.contentDigest,
        payloadDigest: saved.revision.payloadDigest,
        createdAt: saved.revision.createdAt,
      },
      sourceVerification: null,
      files: Object.entries(files).map(([path, bytes]) => ({
        path,
        size: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      })),
    }
    const verified = verifyExtensionPackage(zipSync({ 'manifest.json': strToU8(JSON.stringify(transfer)), ...files }))
    expect(verified.revision.provides).toEqual(['agent', 'page'])
    const imported = await target.extensionService.importRevision({
      extension: transfer.extension,
      revision: transfer.revision,
      manifest: verified.revision.manifest,
      sources: verified.revision.sources,
    })
    expect(target.repository.getExtensionRevisionVerification(imported.revision.id)).toMatchObject({
      contractVersion: 'nekro-nxt-extension-v5',
      toolInvocations: [{ name: 'combined_probe', succeeded: true }],
      renderedPages: [page],
    })
    const agent = target.core.createAgent({
      displayName: '组合验证智能体',
      persona: '',
      model: { provider: 'synthetic', model: 'fixture' },
    })
    // Activation automatically installs the same revision and resolves each layer's own defaults.
    await target.extensions.activate({
      agentId: agent.definition.id,
      extensionId: imported.extension.id,
      revisionId: imported.revision.id,
    })
    expect(target.repository.getHostInstallation(imported.extension.id)).toMatchObject({
      extensionRevisionId: imported.revision.id,
      config: { hostOption: 'host-default' },
    })
    expect(target.repository.getActivation(agent.definition.id, imported.extension.id)).toMatchObject({
      extensionRevisionId: imported.revision.id,
      config: { agentOption: 'agent-default' },
    })
    expect(target.repository.listHostUiPageEntries()).toHaveLength(1)
    await expect(
      target.extensions.call(imported.extension.id, 'status', null, { surface: 'verification' }),
    ).resolves.toEqual({ surface: 'verification', hostOption: 'host-default' })
    await target.extensions.disable(agent.definition.id, imported.extension.id)
    await expect(
      target.extensions.call(imported.extension.id, 'status', null, { surface: 'verification' }),
    ).resolves.toMatchObject({ surface: 'verification' })
    await target.extensions.uninstall(imported.extension.id)
    expect(target.repository.listHostUiPageEntries()).toHaveLength(0)
    await expect(
      target.extensions.call(imported.extension.id, 'status', null, { surface: 'verification' }),
    ).rejects.toThrow('没有在本机运行')
  } finally {
    await target.dispose()
    await source.dispose()
  }
})

it('requires v5 verification evidence before automatic installation on activation', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nxt-unverified-extension-'))
  directories.push(directory)
  const runtime = await NekroRuntime.create({
    coreDatabasePath: path.join(directory, 'core.sqlite'),
    sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
    assetRoot: path.join(directory, 'assets'),
    extensionDataRoot: path.join(directory, 'extensions'),
    extensionCacheRoot: path.join(directory, 'cache'),
  })
  try {
    const saved = await runtime.extensionService.saveDynamicPackage({
      slug: 'unverified-probe',
      displayName: '未验证探针',
      description: '',
      snapshot: {
        name: '未验证探针',
        purpose: '保存不等于安装授权',
        hostCode: 'return { apply() {} }',
        permissions: { permissions: [], networkOrigins: [], agent: { history: { read: true } } },
      },
    })
    const agent = runtime.core.createAgent({
      displayName: '验证智能体',
      persona: '',
      model: { provider: 'synthetic', model: 'fixture' },
    })
    await expect(
      runtime.extensions.activate({
        agentId: agent.definition.id,
        extensionId: saved.extension.id,
        revisionId: saved.revision.id,
      }),
    ).rejects.toThrow('只能安装在本机完成验证')
    expect(runtime.repository.getHostInstallation(saved.extension.id)).toBeUndefined()
    expect(runtime.repository.getActivation(agent.definition.id, saved.extension.id)).toBeUndefined()
  } finally {
    await runtime.dispose()
  }
})
