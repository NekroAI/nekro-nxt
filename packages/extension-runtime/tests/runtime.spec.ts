import type {
  DraftPackageId,
  ExtensionDraftId,
  ExtensionId,
  ExtensionRevisionId,
  ExtensionSaveOperationId,
} from '@nekro-nxt/contracts'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ExtensionBuilder, ExtensionSourceStore, materializeDynamicPackage } from '../src/index.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const materialize = (hostCode: string) =>
  materializeDynamicPackage({
    extensionId: 'ext_test' as ExtensionId,
    revisionId: 'xrv_test' as ExtensionRevisionId,
    displayName: '构建探针',
    draftPackage: {
      id: 'xdp_test' as DraftPackageId,
      draftId: 'xdr_test' as ExtensionDraftId,
      sourceDynamicPackageId: 'pkg-test',
      sequence: 1,
      name: '构建探针',
      purpose: '验证受控构建。',
      hostCode,
      createdAt: 1,
    },
  })

describe('Extension materialization and build policy', () => {
  it('normalizes the same immutable input to the same digest and versioned SDK source', () => {
    const first = materialize('return { apply() {} }\r\n')
    const second = materialize('return { apply() {} }\n')
    expect(first.contentDigest).toBe(second.contentDigest)
    expect(first.sources.host).toContain("from '@nekro-nxt/extension-sdk'")
    expect(first.sourceInput).toMatchObject({
      schemaVersion: 1,
      builderProtocol: 'nekro-nxt-esbuild-v1',
      allowedDependencies: ['@nekro-nxt/extension-sdk'],
    })
  })

  it('rejects undeclared bare imports and leaves no committed cache artifact', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-extension-policy-'))
    temporaryDirectories.push(directory)
    const sourceStore = new ExtensionSourceStore(path.join(directory, 'data'))
    const materialized = materialize("return await import('node:fs')")
    const staging = sourceStore.stagingRelativePath('xop_test' as ExtensionSaveOperationId)
    const final = sourceStore.revisionRelativePath(materialized.manifest.extensionId, materialized.manifest.revisionId)
    await sourceStore.commit(staging, final, materialized)
    const cache = path.join(directory, 'cache')
    await expect(
      new ExtensionBuilder(cache).build({
        revisionId: materialized.manifest.revisionId,
        contentDigest: materialized.contentDigest,
        sourceDirectory: sourceStore.absoluteRevisionPath(final),
      }),
    ).rejects.toThrow('Extension import is not allowed: node:fs')
    expect(await readdir(cache).catch(() => [])).toEqual([])
  })

  it('rejects absolute and parent-traversal storage identities', () => {
    const sourceStore = new ExtensionSourceStore('/tmp/nekro-nxt-extension-path-policy')
    expect(() => sourceStore.absoluteRevisionPath('../outside')).toThrow('Unsafe Extension storage path')
    expect(() => sourceStore.absoluteRevisionPath('/outside')).toThrow('Unsafe Extension storage path')
  })
})
