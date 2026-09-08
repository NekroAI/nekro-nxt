import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ExtensionIdSchema, ExtensionRevisionIdSchema, HostUiPageEntrySchema } from '@nekro-nxt/contracts'
import { ExtensionBuilder, ExtensionSourceStore, materializeDynamicPackage } from '@nekro-nxt/extension-runtime'
import { stylesSnapshot, stylesPage } from '../../../packages/extension-runtime/tests/fixtures/host-ui-styles.js'
import { HostUiModuleRuntime, readHostUiNavigation } from '../src/host-ui-client.tsx'

describe('Host UI Client Runtime', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('renders a materialized CSS page on initial load and a fresh runtime, then retracts it', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nxt-host-ui-styles-'))
    const links = new Set<EventTarget & { remove(): void }>()
    vi.stubGlobal('document', {
      createElement: () => {
        const link = Object.assign(new EventTarget(), {
          dataset: {},
          remove() {
            links.delete(link)
          },
        })
        return link
      },
      head: {
        append: (link: EventTarget & { remove(): void }) => {
          links.add(link)
          queueMicrotask(() => link.dispatchEvent(new Event('load')))
        },
      },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ recorded: true })))),
    )
    try {
      const materialized = materializeDynamicPackage({
        extensionId: ExtensionIdSchema.parse('ext_STYLESPROBE'),
        revisionId: ExtensionRevisionIdSchema.parse('xrv_STYLESPROBE'),
        snapshot: stylesSnapshot,
      })
      const sources = new ExtensionSourceStore(path.join(directory, 'sources'))
      await sources.publish(materialized.manifest.extensionId, materialized.manifest.revisionId, materialized)
      const builder = new ExtensionBuilder(path.join(directory, 'cache'))
      const input = {
        revisionId: materialized.manifest.revisionId,
        contentDigest: materialized.contentDigest,
        sourceDirectory: sources.revisionSourceDirectory(
          materialized.manifest.extensionId,
          materialized.manifest.revisionId,
        ),
      }
      const artifact = await builder.build(input)
      expect((await builder.build(input)).buildKey).toBe(artifact.buildKey)
      expect(await readFile(artifact.clientCssEntry!, 'utf8')).toContain('.stylesProbe')
      const entry = HostUiPageEntrySchema.parse({
        entryId: stylesPage.entryId,
        title: stylesPage.title,
        icon: stylesPage.icon,
        objectPane: stylesPage.objectPane,
        startPath: stylesPage.startPath,
        pageInstanceId: 'hup_STYLESPROBE',
        owner: {
          kind: 'extension',
          extensionId: materialized.manifest.extensionId,
          revisionId: materialized.manifest.revisionId,
        },
        visible: true,
        sortOrder: 0,
        routeBase: '/apps/hup_STYLESPROBE',
        client: { moduleUrl: artifact.clientEntry!, buildKey: artifact.buildKey },
        createdAt: 1,
        updatedAt: 1,
      })
      // Recreating the runtime exercises refresh without retaining factory closure state.
      for (let mount = 0; mount < 2; mount += 1) {
        const runtime = new HostUiModuleRuntime([entry])
        try {
          await runtime.ensureLoaded()
          const registered = runtime.registration(stylesPage.entryId)
          expect(registered).toBeDefined()
          const html = renderToStaticMarkup(
            createElement(registered!.component, {
              pageInstanceId: entry.pageInstanceId,
              entryId: stylesPage.entryId,
              relativePath: '',
              search: {},
              navigate: () => undefined,
            }),
          )
          expect(html).toContain('class="nxt-extension-section-heading"')
          expect(html).toContain('class="nxt-extension-secondary-text"')
          expect(html).toContain('保存后样式正常')
          expect(links.size).toBe(1)
        } finally {
          await runtime.dispose()
        }
        expect(runtime.registration(stylesPage.entryId)).toBeUndefined()
        expect(links.size).toBe(0)
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('returns a cached external-store snapshot until runtime state changes', () => {
    const runtime = new HostUiModuleRuntime([])
    const first = runtime.snapshot()
    expect(runtime.snapshot()).toBe(first)
    expect(first).toEqual({ loading: false, revision: 0 })
  })

  it('projects invalid or throwing Navigation Providers into an isolated failure state', () => {
    expect(
      readHostUiNavigation({
        getSnapshot: () => ({ revision: -1, groups: [] }),
        subscribe: () => () => undefined,
      }),
    ).toMatchObject({ status: 'failed' })
    expect(
      readHostUiNavigation({
        getSnapshot: () => {
          throw new Error('synthetic navigation failure')
        },
        subscribe: () => () => undefined,
      }),
    ).toMatchObject({ status: 'failed', error: { message: 'synthetic navigation failure' } })
  })
})
