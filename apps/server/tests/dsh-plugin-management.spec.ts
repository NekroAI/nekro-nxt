import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { HostApiContracts } from '@nekro-nxt/contracts'
import { strFromU8, unzipSync } from 'fflate'
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { create as createTarball } from 'tar'
import { afterEach, describe, expect, it } from 'vitest'
import { NekroRuntime } from '../src/bootstrap.js'
import { createNekroHostApi } from '../src/host-api.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const createFixtureTarball = async (
  root: string,
  options: { readonly name?: string; readonly installScript?: boolean; readonly moduleSource?: string } = {},
): Promise<Uint8Array> => {
  const packageName = options.name ?? '@example/dsh-managed-fixture'
  const source = path.join(root, `package-source-${packageName.replaceAll(/[^a-z0-9]/giu, '-')}`)
  const tarball = path.join(root, `${path.basename(packageName)}.tgz`)
  await mkdir(source, { recursive: true })
  await writeFile(
    path.join(source, 'package.json'),
    JSON.stringify(
      {
        name: packageName,
        version: '1.2.3',
        type: 'module',
        exports: './index.js',
        ...(options.installScript
          ? { scripts: { postinstall: `node -e "require('fs').writeFileSync('built.txt','built')"` } }
          : {}),
      },
      null,
      2,
    ) + '\n',
  )
  await writeFile(
    path.join(source, 'index.js'),
    options.moduleSource ??
      `export default function managedFixture(context) {
  context.effect(() => () => undefined, 'managed fixture lifecycle')
}
`,
  )
  await createTarball({ cwd: source, file: tarball, gzip: true }, ['package.json', 'index.js'])
  return readFile(tarball)
}

const createBundleFixtureTarball = async (root: string): Promise<Uint8Array> => {
  const packageName = '@example/dsh-bundle-fixture'
  const source = path.join(root, 'package-source-dsh-bundle-fixture')
  const tarball = path.join(root, 'dsh-bundle-fixture.tgz')
  await mkdir(source, { recursive: true })
  await writeFile(
    path.join(source, 'package.json'),
    JSON.stringify(
      {
        name: packageName,
        version: '1.2.3',
        type: 'module',
        exports: { './service': './service.js', './tool': './tool.js' },
        dsh: { bundle: { patch: 'cordis.patch.yml' } },
      },
      null,
      2,
    ) + '\n',
  )
  await writeFile(path.join(source, 'service.js'), 'export default function service() {}\n')
  await writeFile(path.join(source, 'tool.js'), 'export default function tool() {}\n')
  await writeFile(
    path.join(source, 'cordis.patch.yml'),
    [
      '- insert:',
      '    - id: service-entry',
      `      name: '${packageName}/service'`,
      '      config: {}',
      '    - id: tool-entry',
      `      name: '${packageName}/tool'`,
      '      config: {}',
      '',
    ].join('\n'),
  )
  await createTarball({ cwd: source, file: tarball, gzip: true }, [
    'package.json',
    'service.js',
    'tool.js',
    'cordis.patch.yml',
  ])
  return readFile(tarball)
}

class QuietModel extends LlmAdapter {
  override providerInfo(provider: string) {
    return { id: provider, name: 'quiet model' }
  }
  override listModels(provider: string) {
    return Promise.resolve([{ provider, id: 'chat-model', name: 'chat', inputModalities: ['text'] as const }])
  }
  override resolveModel(provider: string, model: string) {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      inputModalities: ['text'] as const,
      context: { contextWindow: 128_000 },
    })
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    void options
    await Promise.resolve()
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

describe('managed DSH plugin lifecycle', () => {
  it('installs a tgz closed, activates it through Loader, disables it, and removes its files', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-dsh-plugin-'))
    temporaryDirectories.push(directory)
    const runtime = await NekroRuntime.create({
      coreDatabasePath: path.join(directory, 'core.sqlite'),
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      assetRoot: path.join(directory, 'assets'),
      extensionDataRoot: path.join(directory, 'extension-data'),
      extensionCacheRoot: path.join(directory, 'extension-cache'),
      dshPluginRoot: path.join(directory, 'dsh'),
    })
    try {
      const inspection = await runtime.dshPluginInstaller.inspectTarball(await createFixtureTarball(directory))
      expect(inspection).toMatchObject({
        packageName: '@example/dsh-managed-fixture',
        packageVersion: '1.2.3',
        blockedBuilds: [],
        entries: [{ entryKey: 'default', suggestedScope: 'host' }],
      })

      const installed = await runtime.dshPluginInstaller.commit(inspection.token, [])
      const [entry] = runtime.repository.listDshPluginEntries(installed.id)
      expect(entry).toBeDefined()
      await expect(runtime.host.inspectInstalledDshPluginConfig(entry!.id)).resolves.toEqual({ mode: 'json' })
      expect(runtime.repository.listDshPluginActivations(entry!.id)).toEqual([])
      await expect(access(runtime.dshPluginInstaller.projectDirectory(installed.id))).resolves.toBeUndefined()

      await expect(
        runtime.host.activateInstalledDshPlugin({
          entryId: entry!.id,
          target: 'host',
          config: { api_key: 'must-not-be-stored' },
        }),
      ).rejects.toThrow('不得保存 Secret')

      const activation = await runtime.host.activateInstalledDshPlugin({
        entryId: entry!.id,
        target: 'host',
        config: {},
      })
      expect(activation.targetKey).toBe('host')
      expect(runtime.repository.getDshPluginDiagnostic(entry!.id, 'host')).toMatchObject({ status: 'active' })

      await runtime.host.disableInstalledDshPlugin(entry!.id, 'host')
      expect(runtime.repository.listDshPluginActivations(entry!.id)).toEqual([])

      const webContext = new Context()
      await webContext.plugin(WebServer, { host: '127.0.0.1', port: 0 })
      const api = createNekroHostApi(webContext.webServer, runtime)
      try {
        const response = await fetch(`http://127.0.0.1:${api.port}/api/dsh/plugin-installs/${installed.id}/export`)
        expect(response.ok).toBe(true)
        const transferBytes = new Uint8Array(await response.arrayBuffer())
        const transfer = unzipSync(transferBytes)
        expect(JSON.parse(strFromU8(transfer['manifest.json']!))).toMatchObject({
          kind: 'dsh-plugin-package',
          package: { name: '@example/dsh-managed-fixture', version: '1.2.3' },
        })
        expect(transfer['package.tgz']?.byteLength).toBeGreaterThan(0)

        const importDirectory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-dsh-import-'))
        temporaryDirectories.push(importDirectory)
        const importedRuntime = await NekroRuntime.create({
          coreDatabasePath: path.join(importDirectory, 'core.sqlite'),
          sessionDatabasePath: path.join(importDirectory, 'sessions.sqlite'),
          assetRoot: path.join(importDirectory, 'assets'),
          extensionDataRoot: path.join(importDirectory, 'extension-data'),
          extensionCacheRoot: path.join(importDirectory, 'extension-cache'),
          dshPluginRoot: path.join(importDirectory, 'dsh'),
        })
        const importContext = new Context()
        await importContext.plugin(WebServer, { host: '127.0.0.1', port: 0 })
        const importApi = createNekroHostApi(importContext.webServer, importedRuntime)
        try {
          const inspect = await fetch(`http://127.0.0.1:${importApi.port}/api/dsh/plugin-installs/inspect-tarball`, {
            method: 'POST',
            body: Buffer.from(transferBytes),
          })
          expect(inspect.ok).toBe(true)
          const inspection = HostApiContracts.inspectDshPluginInstall.parseResponse(await inspect.json())
          const commit = await fetch(`http://127.0.0.1:${importApi.port}/api/dsh/plugin-installs`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token: inspection.token, approvedBuilds: [] }),
          })
          expect(commit.ok).toBe(true)
          expect(importedRuntime.repository.listDshPluginPackages()).toEqual([
            expect.objectContaining({
              packageName: '@example/dsh-managed-fixture',
              packageVersion: '1.2.3',
              source: 'imported',
            }),
          ])
          expect(importedRuntime.repository.listDshPluginActivations()).toEqual([])
        } finally {
          importApi.dispose()
          await importContext.fiber.dispose()
          await importedRuntime.dispose()
        }
      } finally {
        api.dispose()
        await webContext.fiber.dispose()
      }

      const packageDirectory = runtime.dshPluginInstaller.packageDirectory(installed.id)
      await runtime.removeDshPluginPackage(installed.id)
      await expect(access(packageDirectory)).rejects.toThrow()
      expect(runtime.repository.getDshPluginPackage(installed.id)).toBeUndefined()
    } finally {
      await runtime.dispose()
    }
  }, 30_000)

  it('expands a public DSH Bundle into stable independently scoped entries', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-dsh-bundle-'))
    temporaryDirectories.push(directory)
    const runtime = await NekroRuntime.create({
      coreDatabasePath: path.join(directory, 'core.sqlite'),
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      assetRoot: path.join(directory, 'assets'),
      extensionDataRoot: path.join(directory, 'extension-data'),
      extensionCacheRoot: path.join(directory, 'extension-cache'),
      dshPluginRoot: path.join(directory, 'dsh'),
    })
    try {
      const inspection = await runtime.dshPluginInstaller.inspectTarball(await createBundleFixtureTarball(directory))
      expect(inspection.entries).toEqual([
        {
          entryKey: 'service-entry',
          moduleName: '@example/dsh-bundle-fixture/service',
          suggestedScope: 'host',
        },
        {
          entryKey: 'tool-entry',
          moduleName: '@example/dsh-bundle-fixture/tool',
          suggestedScope: 'agent',
        },
      ])
      const installed = await runtime.dshPluginInstaller.commit(inspection.token, [])
      expect(runtime.repository.listDshPluginEntries(installed.id)).toEqual([
        expect.objectContaining({ entryKey: 'service-entry', suggestedScope: 'host' }),
        expect.objectContaining({ entryKey: 'tool-entry', suggestedScope: 'agent' }),
      ])
      expect(runtime.repository.listDshPluginActivations()).toEqual([])
    } finally {
      await runtime.dispose()
    }
  }, 30_000)

  it('runs only the build dependency explicitly approved after inspection', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-dsh-build-'))
    temporaryDirectories.push(directory)
    const runtime = await NekroRuntime.create({
      coreDatabasePath: path.join(directory, 'core.sqlite'),
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      assetRoot: path.join(directory, 'assets'),
      extensionDataRoot: path.join(directory, 'extension-data'),
      extensionCacheRoot: path.join(directory, 'extension-cache'),
      dshPluginRoot: path.join(directory, 'dsh'),
    })
    try {
      const unapprovedName = '@example/dsh-unapproved-build-fixture'
      const unapprovedInspection = await runtime.dshPluginInstaller.inspectTarball(
        await createFixtureTarball(directory, { name: unapprovedName, installScript: true }),
      )
      expect(unapprovedInspection.blockedBuilds).toContain(unapprovedName)
      const unapproved = await runtime.dshPluginInstaller.commit(unapprovedInspection.token, [])
      await expect(
        readFile(
          path.join(
            runtime.dshPluginInstaller.projectDirectory(unapproved.id),
            'node_modules',
            unapprovedName,
            'built.txt',
          ),
          'utf8',
        ),
      ).rejects.toThrow()

      const packageName = '@example/dsh-approved-build-fixture'
      const inspection = await runtime.dshPluginInstaller.inspectTarball(
        await createFixtureTarball(directory, { name: packageName, installScript: true }),
      )
      const installed = await runtime.dshPluginInstaller.commit(inspection.token, [packageName])
      await expect(
        readFile(
          path.join(
            runtime.dshPluginInstaller.projectDirectory(installed.id),
            'node_modules',
            packageName,
            'built.txt',
          ),
          'utf8',
        ),
      ).resolves.toBe('built')
      expect(installed.approvedBuilds).toEqual([packageName])
    } finally {
      await runtime.dispose()
    }
  }, 30_000)

  it('restores a committed Host activation after process restart', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-dsh-restore-'))
    temporaryDirectories.push(directory)
    const options = {
      coreDatabasePath: path.join(directory, 'core.sqlite'),
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      assetRoot: path.join(directory, 'assets'),
      extensionDataRoot: path.join(directory, 'extension-data'),
      extensionCacheRoot: path.join(directory, 'extension-cache'),
      dshPluginRoot: path.join(directory, 'dsh'),
    }
    const first = await NekroRuntime.create(options)
    const inspection = await first.dshPluginInstaller.inspectTarball(await createFixtureTarball(directory))
    const installed = await first.dshPluginInstaller.commit(inspection.token, [])
    const entry = first.repository.listDshPluginEntries(installed.id)[0]!
    await first.host.activateInstalledDshPlugin({ entryId: entry.id, target: 'host', config: {} })
    await first.dispose()

    const restored = await NekroRuntime.create(options)
    try {
      expect(restored.repository.listDshPluginActivations(entry.id)).toEqual([
        expect.objectContaining({ target: 'host', targetKey: 'host' }),
      ])
      expect(restored.repository.getDshPluginDiagnostic(entry.id, 'host')).toMatchObject({
        status: 'active',
        phase: 'restore',
      })
      await restored.removeDshPluginPackage(installed.id)
    } finally {
      await restored.dispose()
    }
  }, 30_000)

  it('mounts an Agent-scoped Tool only into the selected intelligent agent sessions', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-dsh-agent-scope-'))
    temporaryDirectories.push(directory)
    const runtime = await NekroRuntime.create({
      coreDatabasePath: path.join(directory, 'core.sqlite'),
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      assetRoot: path.join(directory, 'assets'),
      extensionDataRoot: path.join(directory, 'extension-data'),
      extensionCacheRoot: path.join(directory, 'extension-cache'),
      dshPluginRoot: path.join(directory, 'dsh'),
      configureLlm: (context) => {
        context.llm.registerAdapter(['test-provider'], new QuietModel())
      },
    })
    await runtime.start()
    try {
      const first = await runtime.createAgentWithWebChannel({
        displayName: '甲智能体',
        persona: '',
        model: { provider: 'test-provider', model: 'chat-model' },
      })
      const second = await runtime.createAgentWithWebChannel({
        displayName: '乙智能体',
        persona: '',
        model: { provider: 'test-provider', model: 'chat-model' },
      })
      await runtime.web.postMessage({
        channelId: first.channelId,
        clientEventId: 'agent-a-session',
        parts: [{ type: 'text', text: '建立甲会话。' }],
      })
      await runtime.web.postMessage({
        channelId: second.channelId,
        clientEventId: 'agent-b-session',
        parts: [{ type: 'text', text: '建立乙会话。' }],
      })
      const firstSession = runtime.repository.listActiveEpisodesForAgent(first.agentId)[0]?.dshSessionId
      const secondSession = runtime.repository.listActiveEpisodesForAgent(second.agentId)[0]?.dshSessionId
      if (!firstSession || !secondSession) throw new Error('Expected both DSH Sessions to be live.')

      const inspection = await runtime.dshPluginInstaller.inspectTarball(
        await createFixtureTarball(directory, {
          name: '@example/dsh-tool-agent-fixture',
          moduleSource: `export default {
  inject: ['tools'],
  apply(context) {
    context.effect(() => context.tools.register({
      name: 'managed_agent_probe',
      description: 'Synthetic Agent scope probe.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]
      },
      execute: async () => ({ ok: true })
    }), 'managed Agent Tool')
  }
}
`,
        }),
      )
      expect(inspection.entries[0]?.suggestedScope).toBe('agent')
      const installed = await runtime.dshPluginInstaller.commit(inspection.token, [])
      const entry = runtime.repository.listDshPluginEntries(installed.id)[0]!
      await runtime.host.activateInstalledDshPlugin({
        entryId: entry.id,
        target: 'agent',
        agentId: first.agentId,
        config: {},
      })
      expect(runtime.host.toolNames(firstSession)).toContain('managed_agent_probe')
      expect(runtime.host.toolNames(secondSession)).not.toContain('managed_agent_probe')
      await runtime.host.disableInstalledDshPlugin(entry.id, first.agentId)
      expect(runtime.host.toolNames(firstSession)).not.toContain('managed_agent_probe')
    } finally {
      await runtime.dispose()
    }
  }, 30_000)
})
