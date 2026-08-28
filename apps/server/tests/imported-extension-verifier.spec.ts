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
      contractVersion: 'nekro-nxt-extension-v3',
      scope: 'host-ui',
      origin: { pluginRunId: 'local-runtime-verification' },
      rpcMethods: ['status'],
      renderedPages: [page],
      permissions: { permissions: ['runtime.read'], networkOrigins: [] },
    })
  })
})
