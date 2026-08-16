import { renderToStaticMarkup } from 'react-dom/server'
import { materializeDynamicPackage, ExtensionBuilder, ExtensionSourceStore } from '@nekro-nxt/extension-runtime'
import type {
  DraftPackageId,
  ExtensionDraftId,
  ExtensionId,
  ExtensionRevisionId,
  ExtensionSaveOperationId,
} from '@nekro-nxt/contracts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ExtensionClientActivationCoordinator,
  ExtensionClientRuntime,
  type ClientActivationDescriptor,
} from '../src/extension-client.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('Extension Client Runtime', () => {
  it('loads a built Client artifact, renders its real Slot component and retracts it on dispose', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-extension-client-'))
    temporaryDirectories.push(directory)
    const extensionId = 'ext_client' as ExtensionId
    const revisionId = 'xrv_client' as ExtensionRevisionId
    const materialized = materializeDynamicPackage({
      extensionId,
      revisionId,
      displayName: 'Client 渲染探针',
      draftPackage: {
        id: 'xdp_client' as DraftPackageId,
        draftId: 'xdr_client' as ExtensionDraftId,
        sourceDynamicPackageId: 'pkg-client',
        sequence: 1,
        name: 'Client 渲染探针',
        purpose: '验证真实 Client Slot 生命周期。',
        clientCode: `return {
          inject: ['slots'],
          apply(ctx) {
            ctx.slots.register({ name: 'root' }, () => React.createElement('section', { 'data-extension': 'client-probe' }, '扩展界面已渲染'))
          }
        }`,
        createdAt: 1,
      },
    })
    const sourceStore = new ExtensionSourceStore(path.join(directory, 'data'))
    const staging = sourceStore.stagingRelativePath('xop_client' as ExtensionSaveOperationId)
    const final = sourceStore.revisionRelativePath(extensionId, revisionId)
    await sourceStore.commit(staging, final, materialized)
    const artifact = await new ExtensionBuilder(path.join(directory, 'cache')).build({
      revisionId,
      contentDigest: materialized.contentDigest,
      sourceDirectory: sourceStore.absoluteRevisionPath(final),
    })
    expect(artifact.clientEntry).toBeDefined()

    const runtime = new ExtensionClientRuntime()
    try {
      const mounted = await runtime.mount(pathToFileURL(artifact.clientEntry!).href, {
        call: () => Promise.reject(new Error('not used')),
      })
      const [entry] = runtime.slots.entriesOfSlot('root')
      expect(entry).toBeDefined()
      expect(renderToStaticMarkup(createElement(entry!.component as () => ReturnType<typeof createElement>))).toBe(
        '<section data-extension="client-probe">扩展界面已渲染</section>',
      )
      await mounted.dispose()
      expect(runtime.slots.entriesOfSlot('root')).toEqual([])
    } finally {
      await runtime.dispose()
    }
  })

  it('automatically mounts, switches and retracts committed Client Activations', async () => {
    let snapshot: readonly ClientActivationDescriptor[] = []
    const listeners = new Set<() => void>()
    const lifecycle: string[] = []
    const coordinator = new ExtensionClientActivationCoordinator(
      {
        mount: (moduleUrl) => {
          lifecycle.push(`mount:${moduleUrl}`)
          return Promise.resolve({
            moduleUrl,
            dispose: () => {
              lifecycle.push(`dispose:${moduleUrl}`)
              return Promise.resolve()
            },
          })
        },
      },
      {
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      },
    )
    const publish = (next: readonly ClientActivationDescriptor[]): void => {
      snapshot = next
      for (const listener of listeners) listener()
    }
    const host = { call: () => Promise.resolve(null) }
    await coordinator.start()
    publish([{ activationId: 'activation-1', moduleUrl: 'client-v1.mjs', host }])
    await coordinator.idle()
    publish([{ activationId: 'activation-1', moduleUrl: 'client-v2.mjs', host }])
    await coordinator.idle()
    publish([])
    await coordinator.idle()
    await coordinator.dispose()
    expect(lifecycle).toEqual([
      'mount:client-v1.mjs',
      'dispose:client-v1.mjs',
      'mount:client-v2.mjs',
      'dispose:client-v2.mjs',
    ])
  })
})
