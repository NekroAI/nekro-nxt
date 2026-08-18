import { isValidElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { materializeDynamicPackage, ExtensionBuilder, ExtensionSourceStore } from '@nekro-nxt/extension-runtime'
import { AgentIdSchema, ExtensionIdSchema, ExtensionRevisionIdSchema } from '@nekro-nxt/contracts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
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
    const extensionId = ExtensionIdSchema.parse('ext_client')
    const revisionId = ExtensionRevisionIdSchema.parse('xrv_client')
    const materialized = materializeDynamicPackage({
      extensionId,
      revisionId,
      snapshot: {
        name: 'Client 渲染探针',
        purpose: '验证真实 Client Slot 生命周期。',
        clientCode: `return {
          inject: ['slots'],
          apply(ctx) {
            ctx.slots.register({ name: 'root' }, () => React.createElement('section', { 'data-extension': 'client-probe' }, '扩展界面已渲染'))
          }
        }`,
      },
    })
    const sourceStore = new ExtensionSourceStore(path.join(directory, 'data'))
    await sourceStore.publish(extensionId, revisionId, materialized)
    const artifact = await new ExtensionBuilder(path.join(directory, 'cache')).build({
      extensionId,
      revisionId,
      contentDigest: materialized.contentDigest,
      sourceDirectory: sourceStore.revisionSourceDirectory(extensionId, revisionId),
    })
    expect(artifact.clientEntry).toBeDefined()

    const runtime = new ExtensionClientRuntime()
    try {
      const mounted = await runtime.mount(pathToFileURL(artifact.clientEntry!).href, {
        call: () => Promise.reject(new Error('not used')),
      })
      const [entry] = runtime.slots.entriesOfSlot('root')
      expect(entry).toBeDefined()
      if (typeof entry?.component !== 'function') throw new TypeError('Client Slot component must be callable.')
      const rendered: unknown = Reflect.apply(entry.component, undefined, [{}])
      if (!isValidElement(rendered)) throw new TypeError('Client Slot component must return a React element.')
      expect(renderToStaticMarkup(rendered)).toBe('<section data-extension="client-probe">扩展界面已渲染</section>')
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
    const activationKey = `${AgentIdSchema.parse('agt_client')}\0${ExtensionIdSchema.parse('ext_client')}`
    publish([{ activationId: activationKey, moduleUrl: 'client-v1.mjs', host }])
    await coordinator.idle()
    publish([{ activationId: activationKey, moduleUrl: 'client-v2.mjs', host }])
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
