import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  EMPTY_EXTENSION_UI_CONTRIBUTIONS,
  type ExtensionPanelDeclaration,
  type ExtensionUiContributions,
} from '@nekro-nxt/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { mountClient } from '../src/extension-ui/client.ts'
import { ContributionRegistry, type ContributionOwner } from '../src/extension-ui/registry.ts'
import { HostEventStream } from '../src/host-event-stream.ts'
import { createProductRuntime } from '../src/product-runtime.ts'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const writeModule = async (source: string): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nxt-extension-ui-'))
  directories.push(directory)
  const file = path.join(directory, 'client.mjs')
  await writeFile(file, source)
  return pathToFileURL(file).href
}

const owner: ContributionOwner = {
  kind: 'agent',
  key: 'agent:agt_alpha:ext_synthetic',
  label: '合成扩展',
  agentId: 'agt_alpha',
  extensionId: 'ext_synthetic',
  revisionId: 'xrv_synthetic',
  styleScope: 'c'.repeat(64),
}

const host = { call: () => Promise.resolve(null), subscribe: () => () => undefined }
const declaration: ExtensionPanelDeclaration = { id: 'summary', anchor: 'agent', title: '摘要', densities: ['full'] }
const declared: ExtensionUiContributions = {
  ...EMPTY_EXTENSION_UI_CONTRIBUTIONS,
  panels: [{ kind: 'panel', ...declaration }],
}

describe('mountClient', () => {
  it('applies an installed Client against the registry and removes it on dispose', async () => {
    const registry = new ContributionRegistry()
    let disposed = false
    const moduleUrl = await writeModule(`export default ({ React }) => ({
      inject: ['panels', 'ui'],
      apply(ctx) {
        ctx.panels.register(${JSON.stringify(declaration)}, () => React.createElement(ctx.ui.Stack, null, '摘要'))
        return () => { globalThis.__nxtDisposed = true }
      },
    })`)
    const mounted = await mountClient({
      owner,
      moduleUrl,
      declared,
      permissions: [],
      host,
      registry,
      store: createProductRuntime(new HostEventStream()).store,
    })
    expect(registry.panels().map((entry) => entry.declaration.id)).toEqual(['summary'])
    await mounted.dispose()
    disposed = Reflect.get(globalThis, '__nxtDisposed') === true
    expect(disposed).toBe(true)
    expect(registry.panels()).toEqual([])
  })

  it('rejects a Client that skips a declared contribution and leaves nothing behind', async () => {
    const registry = new ContributionRegistry()
    const moduleUrl = await writeModule(`export default () => ({ apply() {} })`)
    await expect(
      mountClient({
        owner,
        moduleUrl,
        declared,
        permissions: [],
        host,
        registry,
        store: createProductRuntime(new HostEventStream()).store,
      }),
    ).rejects.toThrow('没有注册声明的内容：面板 summary')
    expect(registry.panels()).toEqual([])
  })
})
