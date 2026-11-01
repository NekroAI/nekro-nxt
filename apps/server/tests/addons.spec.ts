import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HostSseEvent, JsonValue } from '@nekro-nxt/contracts'
import {
  AddonRegistry,
  AddonRequestError,
  browserAddon,
  directoryBytes,
  githubCliAddon,
  nodeAddon,
  type AddonCapability,
  type AddonProviderState,
  type AddonSettingsStore,
} from '../src/addons.ts'
import { CodeRunNode } from '../src/code-run-node.ts'
import { GithubCli } from '../src/github-cli.ts'
import type { HostRouteContext } from '../src/host-route-support.ts'
import { registerAddonRoutes } from '../src/host-routes-addons.ts'
import { VerificationBrowser } from '../src/verification-browser.ts'

const temporaryDirectories: string[] = []
const servers: Server[] = []
const temporary = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-addons-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))))
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const memorySettings = (): AddonSettingsStore & { readonly values: Map<string, JsonValue> } => {
  const values = new Map<string, JsonValue>()
  let revision = 0
  return {
    values,
    get: (key) => {
      const value = values.get(key)
      return value === undefined ? undefined : { value, revision }
    },
    put: (key, value) => {
      values.set(key, value)
      revision += 1
    },
  }
}

/** A capability with a program found on this device and one that downloads on request, both controlled by the test. */
const fakeCapability = () => {
  const listeners = new Set<() => void>()
  let system: AddonProviderState | undefined = {
    state: 'available',
    source: 'system',
    version: '1.0.0',
    removable: false,
  }
  let download: AddonProviderState = { state: 'not-installed', version: '2.0.0', downloadBytes: 1000, removable: false }
  const installs: string[] = []
  const notify = () => {
    for (const listener of listeners) listener()
  }
  const capability: AddonCapability = {
    id: 'github-cli',
    group: 'agent',
    title: '示例工具',
    summary: '示例简介。',
    usedBy: ['示例用途'],
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    providers: [
      {
        id: 'system',
        title: '这台设备的示例工具',
        summary: '',
        programs: [{ name: 'tool' }],
        state: () => system,
        program: () => '/usr/bin/tool',
      },
      {
        id: 'download',
        title: '下载的示例工具',
        summary: '',
        licenses: [{ name: 'MIT', url: 'https://example.test/LICENSE' }],
        sources: ['example.test'],
        programs: [{ name: 'tool' }],
        directories: ['/fixture/tool'],
        state: () => download,
        install: () => {
          installs.push('download')
          download = { ...download, state: 'installing', progress: { receivedBytes: 0, totalBytes: 1000 } }
          notify()
        },
        remove: () => {
          download = { state: 'not-installed', version: '2.0.0', downloadBytes: 1000, removable: false }
          notify()
          return Promise.resolve()
        },
        program: () => '/data/runtimes/tool/bin/tool',
      },
    ],
  }
  return {
    capability,
    installs,
    finish: () => {
      download = { state: 'installed', source: 'downloaded', version: '2.0.0', downloadBytes: 1000, removable: true }
      notify()
    },
    report: (receivedBytes: number) => {
      download = { ...download, progress: { receivedBytes, totalBytes: 1000 } }
      notify()
    },
    loseSystem: () => {
      system = undefined
      notify()
    },
  }
}

describe('add-on registry', () => {
  it('uses the first usable provider, and the chosen one once it is installed', async () => {
    const fake = fakeCapability()
    const settings = memorySettings()
    const registry = new AddonRegistry([fake.capability], { settings, measure: () => Promise.resolve(4096) })
    await registry.prepare()
    let changes = 0
    registry.subscribe(() => (changes += 1))

    expect(registry.status('github-cli')).toMatchObject({
      state: 'available',
      selected: 'system',
      providers: [
        { id: 'system', state: 'available', source: 'system', installable: false, removable: false },
        {
          id: 'download',
          state: 'not-installed',
          version: '2.0.0',
          resources: { downloadBytes: 1000, notes: [] },
          licenses: [{ name: 'MIT', url: 'https://example.test/LICENSE' }],
          sources: ['example.test'],
          installable: true,
          removable: false,
        },
      ],
    })
    expect(registry.active('github-cli')?.program('tool')).toBe('/usr/bin/tool')
    expect(() => registry.select('github-cli', 'download')).toThrow(AddonRequestError)

    registry.install('github-cli', 'download')
    expect(fake.installs).toEqual(['download'])
    // The system program stays in use until the download is ready.
    expect(registry.status('github-cli')).toMatchObject({ selected: 'system', state: 'available' })
    expect(registry.status('github-cli').providers[1]).toMatchObject({ state: 'installing' })
    fake.report(500)
    fake.report(500)
    const beforeFinish = changes
    fake.finish()
    await expect.poll(() => registry.status('github-cli').providers[1]?.resources.installedBytes).toBe(4096)
    expect(changes).toBeGreaterThan(beforeFinish)
    expect(registry.status('github-cli')).toMatchObject({ state: 'installed', selected: 'download' })
    expect(registry.active('github-cli')).toMatchObject({ id: 'download', source: 'downloaded' })
    expect(registry.active('github-cli')?.program('tool')).toBe('/data/runtimes/tool/bin/tool')
    expect(settings.values.get('addons')).toEqual({ selection: { 'github-cli': 'download' } })

    registry.select('github-cli', 'system')
    expect(registry.active('github-cli')?.id).toBe('system')
    registry.select('github-cli', 'download')

    // Removing the chosen provider falls back to the next usable one.
    await registry.remove('github-cli', 'download')
    expect(registry.status('github-cli')).toMatchObject({ state: 'available', selected: 'system' })
    expect(registry.status('github-cli').providers[1]?.resources.installedBytes).toBeUndefined()

    fake.loseSystem()
    expect(registry.status('github-cli')).toMatchObject({ state: 'not-installed' })
    expect(registry.status('github-cli').selected).toBeUndefined()
    expect(registry.status('github-cli').providers.map(({ id }) => id)).toEqual(['download'])
    expect(registry.active('github-cli')).toBeUndefined()
  })

  it('hears only real changes', async () => {
    const fake = fakeCapability()
    const registry = new AddonRegistry([fake.capability], { settings: memorySettings() })
    await registry.prepare()
    let changes = 0
    registry.subscribe(() => (changes += 1))
    registry.install('github-cli', 'download')
    expect(changes).toBe(1)
    fake.report(100)
    fake.report(100)
    expect(changes).toBe(2)
  })

  it('refuses what a provider cannot do', async () => {
    const fake = fakeCapability()
    const registry = new AddonRegistry([fake.capability], { settings: memorySettings() })
    await registry.prepare()
    expect(() => registry.install('github-cli', 'system')).toThrow('这台设备的示例工具不需要安装。')
    await expect(registry.remove('github-cli', 'system')).rejects.toThrow('不能在这里删除')
    expect(() => registry.install('github-cli', 'elsewhere')).toThrow('示例工具没有这种提供方式。')
    expect(() => registry.status('node')).toThrow('没有这项附加功能。')
    registry.install('github-cli', 'download')
    await expect(registry.remove('github-cli', 'download')).rejects.toThrow('下载的示例工具正在安装，完成后再删除。')
  })

  it('maps the existing programs onto providers', async () => {
    const root = await temporary()
    const node = new CodeRunNode({ root: path.join(root, 'node'), embedded: false })
    const cli = new GithubCli({
      root: path.join(root, 'gh'),
      findSystem: () => Promise.resolve(undefined),
      release: { version: '1.0.0', baseUrl: 'https://downloads.example.test', artifacts: {} },
    })
    const browser = new VerificationBrowser({ root: path.join(root, 'chromium') })
    const registry = new AddonRegistry(
      [
        nodeAddon(node, path.join(root, 'node')),
        githubCliAddon(cli, path.join(root, 'gh')),
        browserAddon(browser, path.join(root, 'chromium')),
      ],
      { settings: memorySettings() },
    )
    await registry.prepare()
    const [nodeStatus, cliStatus, browserStatus] = registry.list()
    // The server runs programs with its own Node and offers nothing else.
    expect(nodeStatus).toMatchObject({
      id: 'node',
      group: 'agent',
      title: '编排运行环境',
      state: 'available',
      selected: 'bundled',
      providers: [{ id: 'bundled', source: 'bundled', version: process.versions.node, removable: false }],
    })
    expect(nodeStatus?.providers).toHaveLength(1)
    expect(registry.active('node')?.source).toBe('bundled')
    // No gh here and no build for this platform.
    expect(cliStatus).toMatchObject({
      id: 'github-cli',
      state: 'unsupported',
      providers: [{ id: 'download', state: 'unsupported', installable: false }],
    })
    expect(() => registry.install('github-cli', 'download')).toThrow('这台设备不支持下载的 gh。')
    expect(browserStatus).toMatchObject({
      id: 'browser',
      group: 'host',
      state: 'not-installed',
      providers: [{ id: 'download', state: 'not-installed', installable: true }],
    })
  })

  it('measures folders without following links', async () => {
    const root = await temporary()
    await mkdir(path.join(root, 'nested'), { recursive: true })
    await writeFile(path.join(root, 'a.bin'), Buffer.alloc(10))
    await writeFile(path.join(root, 'nested', 'b.bin'), Buffer.alloc(20))
    expect(await directoryBytes(root)).toBe(30)
    expect(await directoryBytes(path.join(root, 'missing'))).toBe(0)
  })
})

describe('add-on routes', () => {
  const serve = async (registry: AddonRegistry) => {
    type Route = Parameters<HostRouteContext['registerRoute']>[0]
    let route: Route | undefined
    const events: HostSseEvent[] = []
    const dispose = registerAddonRoutes({
      runtime: { addons: registry },
      registerRoute: (registered) => {
        route = registered
      },
      broadcast: (event) => events.push(event),
    })
    const server = createServer((req, res) => void route?.handler(req, res))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    servers.push(server)
    const address = server.address()
    const origin = typeof address === 'object' && address !== null ? `http://127.0.0.1:${address.port}` : ''
    const call = async (method: string, url: string, body?: unknown) => {
      const response = await fetch(`${origin}${url}`, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
      })
      const json: unknown = await response.json()
      return { status: response.status, body: json }
    }
    return { call, events, dispose }
  }

  it('lists, installs, selects and removes, and announces each change', async () => {
    const fake = fakeCapability()
    const registry = new AddonRegistry([fake.capability], { settings: memorySettings() })
    await registry.prepare()
    const { call, events, dispose } = await serve(registry)

    const listed = await call('GET', '/api/addons')
    expect(listed).toMatchObject({ status: 200, body: { addons: [{ id: 'github-cli', selected: 'system' }] } })

    const installed = await call('POST', '/api/addons/github-cli/providers/download/install')
    expect(installed.status).toBe(200)
    expect(installed.body).toMatchObject({ providers: [{ id: 'system' }, { id: 'download', state: 'installing' }] })
    expect(events).toContainEqual({ event: 'snapshot-changed', data: { changed: true } })

    const early = await call('PUT', '/api/addons/github-cli/selection', { provider: 'download' })
    expect(early.status).toBe(400)
    expect(early.body).toMatchObject({ error: { code: 'addon-unavailable' } })
    fake.finish()
    const fixed = await call('DELETE', '/api/addons/github-cli/providers/system')
    expect(fixed).toMatchObject({ status: 400, body: { error: { code: 'addon-not-removable' } } })

    const selected = await call('PUT', '/api/addons/github-cli/selection', { provider: 'system' })
    expect(selected).toMatchObject({ status: 200, body: { selected: 'system' } })

    const removed = await call('DELETE', '/api/addons/github-cli/providers/download')
    expect(removed).toMatchObject({
      status: 200,
      body: { providers: [{}, { id: 'download', state: 'not-installed' }] },
    })

    expect((await call('POST', '/api/addons/unknown/providers/x/install')).status).toBe(404)
    expect((await call('GET', '/api/addons/github-cli/providers/download/install')).status).toBe(405)
    dispose()
  })
})
