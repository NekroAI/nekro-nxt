import { Context } from '@deepseek-ai/cordis'
import { SessionStore } from '@deepseek-ai/dsh-session'
import {
  DshPluginEntryIdSchema,
  DshPluginPackageIdSchema,
  type DshPluginEntryId,
  type DshPluginPackageRecord,
} from '@nekro-nxt/contracts'
import { DSH_RUNTIME_RELEASE } from '@nekro-nxt/dsh-compat/release'
import { openMigratedCoreDatabase, SqliteCoreRepository } from '@nekro-nxt/storage-sqlite'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DSH_PLUGIN_ISOLATED_SERVICE_KEYS,
  dshPluginServiceAccess,
  isOfficialDshPluginPackage,
} from '../src/dsh-plugin-access.js'
import { DshPluginLifecycleCoordinator, DshPluginSessionDependencyError } from '../src/dsh-plugin-lifecycle.js'

const INTEGRITY = `sha512-${'A'.repeat(86)}==`
const official = {
  packageName: '@deepseek-ai/dsh-fixture-offload',
  packageVersion: DSH_RUNTIME_RELEASE.dshVersion,
  source: 'registry',
  integrity: INTEGRITY,
} as const satisfies Pick<DshPluginPackageRecord, 'packageName' | 'packageVersion' | 'source' | 'integrity'>

describe('official DSH plugin check', () => {
  it('accepts a registry install of the current DSH release with npm integrity', () => {
    expect(isOfficialDshPluginPackage(official)).toBe(true)
  })

  const withoutIntegrity = {
    packageName: official.packageName,
    packageVersion: official.packageVersion,
    source: official.source,
  }
  it.each([
    ['an uploaded tarball with the same name', { ...official, source: 'tarball' as const }],
    ['an imported share package', { ...official, source: 'imported' as const }],
    ['another DSH version', { ...official, packageVersion: '0.1.9' }],
    ['a package outside the DSH scope', { ...official, packageName: '@example/dsh-fixture-offload' }],
    ['a registry install without integrity', withoutIntegrity],
    ['a non-sha512 integrity', { ...official, integrity: 'sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA=' }],
  ])('rejects %s', (_label, record) => {
    expect(isOfficialDshPluginPackage(record)).toBe(false)
  })

  it('follows a package pinned by the release matrix', () => {
    const [name, version] = Object.entries(DSH_RUNTIME_RELEASE.packages).find(([candidate]) =>
      candidate.startsWith('@deepseek-ai/cordis'),
    )!
    expect(isOfficialDshPluginPackage({ ...official, packageName: name, packageVersion: version })).toBe(true)
    expect(
      isOfficialDshPluginPackage({ ...official, packageName: name, packageVersion: DSH_RUNTIME_RELEASE.dshVersion }),
    ).toBe(version === DSH_RUNTIME_RELEASE.dshVersion)
  })
})

describe('DSH plugin service access', () => {
  it('opens only declared private services to an official plugin', () => {
    const access = dshPluginServiceAccess(official, ['agents', 'sessions', 'tools'])
    expect(access).toEqual({
      official: true,
      granted: ['agents', 'sessions'],
      isolated: DSH_PLUGIN_ISOLATED_SERVICE_KEYS.filter((key) => key !== 'agents' && key !== 'sessions'),
    })
    expect(access.isolated).toContain('llm')
  })

  it('keeps the full isolation for a third-party plugin that declares the same services', () => {
    expect(dshPluginServiceAccess({ ...official, source: 'tarball' }, ['agents', 'sessions'])).toEqual({
      official: false,
      granted: [],
      isolated: DSH_PLUGIN_ISOLATED_SERVICE_KEYS,
    })
  })

  it('leaves skills open to every installed plugin', () => {
    expect(DSH_PLUGIN_ISOLATED_SERVICE_KEYS).not.toContain('skills')
    expect(DSH_PLUGIN_ISOLATED_SERVICE_KEYS).toEqual(expect.arrayContaining(['agents', 'sessions', 'llm', 'web']))
  })
})

const contexts: Context[] = []
const directories: string[] = []
afterEach(async () => {
  for (const context of contexts.splice(0)) await context.fiber.dispose()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

const moduleUrl = (source: string): string => `data:text/javascript,${encodeURIComponent(source)}`

/** A plugin that reads the host `agents` service and owns the `fixture/marker` session event. */
const OFFLOAD_SOURCE = `
  export const inject = ['agents', 'sessions']
  export function apply(ctx) {
    ctx.sessions.registerMessageProjection({ type: 'fixture/marker', project: () => new Map() })
    ctx.provide('fixtureOffloadSawAgents', ctx.agents.label)
  }
`

const lifecycleFixture = async (
  storedEventTypes: readonly (readonly string[])[],
  sources: Readonly<Record<string, string>> = {},
) => {
  const root = await mkdtemp(path.join(tmpdir(), 'nxt-dsh-access-test-'))
  directories.push(root)
  const database = await openMigratedCoreDatabase(path.join(root, 'core.sqlite'))
  const repository = new SqliteCoreRepository(database)
  const context = new Context()
  contexts.push(context)
  await context.plugin(SessionStore)
  await context.plugin({
    name: 'fixture-host-services',
    apply(ctx: Context) {
      ctx.provide('agents', { label: 'fixture-agents' })
      ctx.provide('sessionPersistence', {
        list: () => Promise.resolve(storedEventTypes.map((_types, index) => ({ header: { id: `ses_${index}` } }))),
        open: (id: string) =>
          Promise.resolve({
            read: () =>
              Promise.resolve({
                events: (storedEventTypes[Number(id.slice(4))] ?? []).map((type, seq) => ({ type, seq })),
              }),
            close: () => Promise.resolve(),
          }),
      })
    },
  })
  /** An official registry install, or with `uploaded` the same package as a local tarball. */
  const seed = (suffix: string, uploaded = false): DshPluginEntryId => {
    const packageId = DshPluginPackageIdSchema.parse(`dsp_${suffix}`)
    const entryId = DshPluginEntryIdSchema.parse(`dse_${suffix}`)
    repository.saveDshPluginPackage({
      package: {
        id: packageId,
        packageName: official.packageName,
        packageVersion: official.packageVersion,
        source: uploaded ? 'tarball' : 'registry',
        ...(uploaded ? {} : { integrity: INTEGRITY }),
        packageDigest: createHash('sha256').update(suffix).digest('hex'),
        lockfileDigest: 'b'.repeat(64),
        manifest: {},
        approvedBuilds: [],
        installedAt: 1,
      },
      entries: [
        {
          id: entryId,
          packageId,
          entryKey: 'default',
          moduleName: suffix,
          suggestedScope: 'host',
          selectedScope: 'host',
          config: {},
          createdAt: 1,
        },
      ],
    })
    repository.upsertDshPluginActivation({ entryId, targetKey: 'host', target: 'host', activatedAt: 1 })
    return entryId
  }
  const coordinator = () =>
    new DshPluginLifecycleCoordinator({
      repository,
      rootContext: context,
      serviceAccess: dshPluginServiceAccess,
      isolatedServices: DSH_PLUGIN_ISOLATED_SERVICE_KEYS,
      resolveModule: (_packageId, name) => moduleUrl(sources[name] ?? OFFLOAD_SOURCE),
      listAgentSessions: () => [],
    })
  return { database, repository, context, seed, coordinator }
}

describe('DSH plugin lifecycle service isolation', () => {
  it('loads an official plugin with its declared services and keeps a same-named upload waiting', async () => {
    const f = await lifecycleFixture([])
    try {
      const officialEntry = f.seed('OFFICIAL')
      const uploadedEntry = f.seed('UPLOADED', true)
      const lifecycle = f.coordinator()
      await lifecycle.initialize()

      expect(f.repository.getDshPluginDiagnostic(officialEntry, 'host')).toEqual(
        expect.objectContaining({ status: 'active' }),
      )
      expect(lifecycle.serviceView(officialEntry, 'host')).toEqual({ official: true, granted: ['agents', 'sessions'] })

      expect(f.repository.getDshPluginDiagnostic(uploadedEntry, 'host')).toEqual(
        expect.objectContaining({
          status: 'pending',
          phase: 'dependency',
          message: '需要 agents、sessions 服务，只对官方插件开放',
        }),
      )
      expect(lifecycle.serviceView(uploadedEntry, 'host')).toEqual({
        official: false,
        granted: [],
        waitingFor: ['agents', 'sessions'],
        restricted: ['agents', 'sessions'],
      })
      await lifecycle.dispose()
    } finally {
      f.database.close()
    }
  })
})

describe('DSH plugin lifecycle across official and isolated Loaders', () => {
  it('lets a third-party consumer follow an official provider of a public service', async () => {
    const f = await lifecycleFixture([], {
      CONSUMER: `export const inject = ['fixtureShared']; export function apply() {}`,
      PROVIDER: `export const inject = ['agents']; export function apply(ctx) { ctx.provide('fixtureShared', true) }`,
    })
    try {
      // The consumer restores first and waits; the official provider then wakes it from the other Loader.
      const consumer = f.seed('CONSUMER', true)
      const provider = f.seed('PROVIDER')
      const lifecycle = f.coordinator()
      expect(await lifecycle.initialize()).toEqual({ restored: 2, failed: 0 })
      expect(f.repository.getDshPluginDiagnostic(consumer, 'host')).toEqual(
        expect.objectContaining({ status: 'active' }),
      )

      await lifecycle.disable(provider, 'host')
      expect(f.repository.getDshPluginDiagnostic(consumer, 'host')).toEqual(
        expect.objectContaining({ status: 'pending', message: '等待 fixtureShared 服务' }),
      )
      expect(lifecycle.serviceView(consumer, 'host')).toEqual(
        expect.objectContaining({ waitingFor: ['fixtureShared'], restricted: [] }),
      )
      await lifecycle.dispose()
    } finally {
      f.database.close()
    }
  })
})

describe('DSH plugin conversation protection', () => {
  it('blocks closing or removing a plugin whose session events stored conversations contain', async () => {
    const f = await lifecycleFixture([['user/message', 'fixture/marker'], ['user/message'], ['fixture/marker']])
    try {
      const entry = f.seed('OFFICIAL')
      const lifecycle = f.coordinator()
      await lifecycle.initialize()

      await expect(lifecycle.sessionDependence([entry])).resolves.toEqual({
        sessions: 2,
        eventTypes: ['fixture/marker'],
      })
      const closing = lifecycle.assertSessionIndependent([entry], '关闭')
      await expect(closing).rejects.toBeInstanceOf(DshPluginSessionDependencyError)
      await expect(closing).rejects.toThrow('不能关闭：2 个对话里有这个插件写入的内容，关闭后这些对话将无法恢复。')
      await lifecycle.dispose()

      // Ownership is remembered across restarts, also while the plugin is no longer loaded.
      const restarted = f.coordinator()
      await expect(restarted.assertSessionIndependent([entry], '移除')).rejects.toThrow('不能移除：2 个对话')
    } finally {
      f.database.close()
    }
  })

  it('lets a plugin go when no conversation uses its events', async () => {
    const f = await lifecycleFixture([['user/message']])
    try {
      const officialEntry = f.seed('OFFICIAL')
      const uploadedEntry = f.seed('UPLOADED', true)
      const lifecycle = f.coordinator()
      await lifecycle.initialize()
      await expect(lifecycle.assertSessionIndependent([officialEntry, uploadedEntry], '移除')).resolves.toBeUndefined()
      await expect(lifecycle.sessionDependence([uploadedEntry])).resolves.toEqual({ sessions: 0, eventTypes: [] })
      await lifecycle.disable(officialEntry, 'host')
      expect(f.repository.listDshPluginActivations(officialEntry)).toEqual([])
      await lifecycle.dispose()
    } finally {
      f.database.close()
    }
  })
})
