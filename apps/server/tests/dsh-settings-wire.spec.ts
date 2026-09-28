import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostModelSettings, isDshSettingsSchemaWireSafe } from '../src/host-model-settings.js'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { stringify } from 'yaml'
import {
  DshPluginEntryIdSchema,
  DshPluginPackageIdSchema,
  RuntimeCompatibilityDiagnosticSchema,
  type DshPluginEntryId,
  type JsonValue,
} from '@nekro-nxt/contracts'
import { openMigratedCoreDatabase, SqliteCoreRepository } from '@nekro-nxt/storage-sqlite'
import {
  activateDshHostProfile,
  prepareDshHostProfile,
  registerDshHostProfileEntry,
  retryDshHostProfileEntry,
  retryDshHostProfileCompatibility,
  getDshHostProfileDiagnostics,
} from '../src/dsh-host-profile.js'
import { DshPluginLifecycleCoordinator, DshPluginQuiescenceError } from '../src/dsh-plugin-lifecycle.js'

const envelope = (root: Record<string, unknown>, extra: Record<number, Record<string, unknown>> = {}) => ({
  uid: 1,
  refs: { 1: root, ...extra },
})

describe('DSH Settings wire safety', () => {
  it('accepts Secrets reached through supported containers', () => {
    expect(
      isDshSettingsSchemaWireSafe(
        envelope(
          { type: 'object', dict: { token: 2, rows: 3 } },
          {
            2: { type: 'string', meta: { role: 'secret' } },
            3: { type: 'array', inner: 2 },
          },
        ),
      ),
    ).toBe(true)
  })

  it('rejects a Secret hidden behind unsupported lazy schema', () => {
    expect(
      isDshSettingsSchemaWireSafe(
        envelope(
          { type: 'lazy', inner: 2 },
          {
            2: { type: 'string', meta: { role: 'secret' } },
          },
        ),
      ),
    ).toBe(false)
  })

  it.each(['union', 'intersect', 'transform'])('accepts %s redacted by the target DSH', (type) => {
    expect(
      isDshSettingsSchemaWireSafe(
        envelope(type === 'transform' ? { type, inner: 2 } : { type, list: [2] }, {
          2: { type: 'string', meta: { role: 'secret' } },
        }),
      ),
    ).toBe(true)
  })

  it('rejects serialized Secret defaults even on a directly redacted field', () => {
    expect(
      isDshSettingsSchemaWireSafe(
        envelope(
          { type: 'object', dict: { token: 2 } },
          { 2: { type: 'string', meta: { role: 'secret', default: 'must-not-cross-the-wire' } } },
        ),
      ),
    ).toBe(false)
  })
})

const contexts: Context[] = []
const directories: string[] = []
afterEach(async () => {
  for (const context of contexts.splice(0)) await context.fiber.dispose()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

const directory = async () => {
  const result = await mkdtemp(path.join(tmpdir(), 'nxt-dsh-settings-test-'))
  directories.push(result)
  return result
}
const createProfile = async (root?: string) => {
  const context = new Context()
  contexts.push(context)
  await prepareDshHostProfile(
    context,
    root
      ? {
          settingsPath: path.join(root, 'settings.yaml'),
          credentialPath: path.join(root, '.credentials.yaml'),
        }
      : {},
  )
  await context.plugin(LlmRuntime)
  registerDshHostProfileEntry(context, {
    id: 'llm-pi-ai',
    name: '@deepseek-ai/dsh-llm-pi-ai',
    config: { providers: {} },
  })
  return context
}

const customProvider = {
  baseURL: 'https://model.example.invalid/v1',
  api: 'openai-completions',
  apiKeyEnv: 'FIXTURE_MODEL_KEY',
  models: [{ id: 'fixture-model', name: 'Fixture model' }],
}

describe('NXT DSH profile migration and Settings', () => {
  it('supports fake-model hosts without creating any file-backed services', async () => {
    const context = await createProfile()
    expect(await activateDshHostProfile(context)).toEqual([])
    expect(context.get('settings')).toBeUndefined()
    expect(context.get('credentials')).toBeUndefined()
    expect(context.get('profileContext')).toBeUndefined()
    expect([...context.loader.entries()].map((entry) => entry.options.id)).toEqual(['llm-pi-ai'])
  })

  it('persists edits through ConfigEditor, rejects stale revisions and restores after restart', async () => {
    const root = await directory()
    const first = await createProfile(root)
    expect(await activateDshHostProfile(first)).toEqual([])
    const settings = new HostModelSettings(first, true)
    const before = settings.listDshSettings().find((entry) => entry.ns === 'llm-pi-ai')!
    expect(before).toBeDefined()
    await first.credentials.set(credentialRef('FIXTURE_MODEL_KEY'), 'fixture-secret')
    const after = await settings.mutateDshSettings('llm-pi-ai', before.revision, [
      { op: 'set', path: ['providers', 'fixture'], value: customProvider },
    ])
    expect(after.revision).toBeGreaterThan(before.revision)
    await expect(
      settings.mutateDshSettings('llm-pi-ai', before.revision, [{ op: 'unset', path: ['providers', 'fixture'] }]),
    ).rejects.toMatchObject({ code: 'SETTINGS_CONFLICT' })
    expect(await readFile(path.join(root, 'host-profile', 'cordis.patch.yml'), 'utf8')).not.toContain('fixture-secret')
    await first.fiber.dispose()
    contexts.splice(contexts.indexOf(first), 1)
    const second = await createProfile(root)
    expect(await activateDshHostProfile(second)).toEqual([])
    expect(await second.llm.listModels('fixture')).toEqual([expect.objectContaining({ id: 'fixture-model' })])
    expect(await second.credentials.resolve(credentialRef('FIXTURE_MODEL_KEY'))).toMatchObject({
      value: 'fixture-secret',
    })
    expect((await stat(path.join(root, 'host-profile', 'cordis.patch.yml'))).mode & 0o077).toBe(0)
  })

  it('atomically imports good providers, quarantines bad ones and never overwrites the source', async () => {
    const root = await directory()
    const source = stringify({
      'llm-pi-ai': { providers: { fixture: customProvider, broken: { api: 'retired-protocol' } } },
      'retired-entry': { value: 'retained' },
    })
    await writeFile(path.join(root, 'settings.yaml'), source)
    const first = await createProfile(root)
    const issues = await activateDshHostProfile(first)
    expect(issues.map((issue) => RuntimeCompatibilityDiagnosticSchema.parse(issue).objectId)).toEqual([
      'broken',
      'retired-entry',
    ])
    expect(await readFile(path.join(root, 'settings.yaml'), 'utf8')).toBe(source)
    expect(await first.llm.listModels('fixture')).toEqual([expect.objectContaining({ id: 'fixture-model' })])
    expect(first.llm.listProviders().some(({ id }) => id === 'broken')).toBe(false)
    await first.fiber.dispose()
    contexts.splice(contexts.indexOf(first), 1)
    await writeFile(path.join(root, 'settings.yaml'), 'invalid: [')
    const second = await createProfile(root)
    expect((await activateDshHostProfile(second)).map((issue) => issue.objectId)).toEqual(['broken', 'retired-entry'])
    expect(await second.llm.listModels('fixture')).toHaveLength(1)
  })

  it('refuses malformed legacy documents without publishing a partial profile', async () => {
    const root = await directory()
    await writeFile(path.join(root, 'settings.yaml'), 'invalid: [')
    const context = await createProfile(root)
    await expect(activateDshHostProfile(context)).rejects.toThrow()
    await expect(readFile(path.join(root, 'host-profile', 'nxt-profile.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(await readFile(path.join(root, 'settings.yaml'), 'utf8')).toBe('invalid: [')
  })

  it('keeps an invalid entry disabled until a validated explicit repair', async () => {
    const root = await directory()
    await writeFile(path.join(root, 'settings.yaml'), stringify({ 'llm-pi-ai': 'invalid' }))
    const context = await createProfile(root)
    expect((await activateDshHostProfile(context))[0]).toMatchObject({ status: 'isolated', phase: 'configuration' })
    expect(context.llm.listProviders()).toEqual([])
    await retryDshHostProfileEntry(context, 'llm-pi-ai', { providers: { fixture: customProvider } })
    expect(await context.llm.listModels('fixture')).toHaveLength(1)
    expect(new HostModelSettings(context, true).listDshSettings()).toHaveLength(1)
  })

  it('only clears the provider being retried after validating and activating its saved config', async () => {
    const root = await directory()
    await writeFile(
      path.join(root, 'settings.yaml'),
      stringify({
        'llm-pi-ai': {
          providers: {
            one: { api: 'removed-api' },
            two: { api: 'removed-api' },
          },
        },
      }),
    )
    const context = await createProfile(root)
    expect(await activateDshHostProfile(context)).toHaveLength(2)
    await expect(retryDshHostProfileCompatibility(context, 'one')).rejects.toThrow()
    expect(getDshHostProfileDiagnostics(context)).toHaveLength(2)
    const settings = new HostModelSettings(context, true)
    const current = settings.listDshSettings()[0]!
    await settings.mutateDshSettings('llm-pi-ai', current.revision, [
      { op: 'set', path: ['providers', 'one'], value: customProvider },
    ])
    await retryDshHostProfileCompatibility(context, 'one')
    expect(getDshHostProfileDiagnostics(context).map(({ objectId }) => objectId)).toEqual(['two'])
    expect(await context.llm.listModels('one')).toHaveLength(1)
  })

  it('suppresses a failed optional plugin across Settings writes and restarts', async () => {
    const root = await directory()
    const source = `data:text/javascript,${encodeURIComponent('export default function() { throw new Error("synthetic mount failure") }')}`
    const first = await createProfile(root)
    registerDshHostProfileEntry(first, { id: 'optional-fixture', name: source })
    expect(await activateDshHostProfile(first)).toEqual([
      expect.objectContaining({ objectId: 'optional-fixture', phase: 'load' }),
    ])
    const settings = new HostModelSettings(first, true)
    await settings.mutateDshSettings('llm-pi-ai', settings.listDshSettings()[0]!.revision, [
      { op: 'set', path: ['providers', 'fixture'], value: customProvider },
    ])
    expect([...first.loader.entries()].find((entry) => entry.options.id === 'optional-fixture')?.disabled).toBe(true)
    await first.fiber.dispose()
    contexts.splice(contexts.indexOf(first), 1)
    const second = await createProfile(root)
    registerDshHostProfileEntry(second, { id: 'optional-fixture', name: source })
    expect(await activateDshHostProfile(second)).toHaveLength(1)
    expect([...second.loader.entries()].find((entry) => entry.options.id === 'optional-fixture')?.fiber).toBeUndefined()
  })

  it('does not declare a failed plugin isolated if rollback disposal reported an error', async () => {
    const context = await createProfile()
    registerDshHostProfileEntry(context, {
      id: 'dispose-fixture',
      name: `data:text/javascript,${encodeURIComponent(`
      export default function(ctx) {
        ctx.effect(() => () => { throw new Error('synthetic disposal failure') })
        throw new Error('synthetic startup failure')
      }
    `)}`,
    })
    await expect(activateDshHostProfile(context)).rejects.toBeInstanceOf(DshPluginQuiescenceError)
  })
})

describe('DSH plugin compatibility lifecycle', () => {
  const fixture = async () => {
    const root = await directory()
    const database = await openMigratedCoreDatabase(path.join(root, 'core.sqlite'))
    const repository = new SqliteCoreRepository(database)
    const seed = (suffix: string, manifest: JsonValue = {}) => {
      const packageId = DshPluginPackageIdSchema.parse(`dsp_${suffix}`)
      const entryId = DshPluginEntryIdSchema.parse(`dse_${suffix}`)
      repository.saveDshPluginPackage({
        package: {
          id: packageId,
          packageName: `@example/${suffix.toLowerCase()}`,
          packageVersion: '1.0.0',
          source: 'tarball',
          packageDigest: 'a'.repeat(64),
          lockfileDigest: 'b'.repeat(64),
          manifest,
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
    const create = (resolveModule: (packageId: unknown, moduleName: string) => string) => {
      const context = new Context()
      contexts.push(context)
      return new DshPluginLifecycleCoordinator({
        repository,
        rootContext: context,
        isolateContext: (ctx) => ctx,
        resolveModule,
        listAgentSessions: () => [],
      })
    }
    return { database, repository, seed, create }
  }

  it('preflights incompatible peers without importing, persists isolation and preserves activation', async () => {
    const f = await fixture()
    try {
      const bad = f.seed('OLD', {
        name: '@example/old',
        version: '1.0.0',
        peerDependencies: { '@deepseek-ai/dsh-agent': '0.1.1-rc.2' },
      })
      f.seed('GOOD')
      const resolve = vi.fn(
        (_packageId: unknown, name: string) =>
          `data:text/javascript,${encodeURIComponent(`export default function(ctx) { ctx.provide('fixture${name}', true) }`)}`,
      )
      const first = f.create(resolve)
      expect(await first.initialize()).toEqual({ restored: 1, failed: 1 })
      expect(resolve.mock.calls.map(([, name]) => name)).toEqual(['GOOD'])
      expect(f.repository.listDshPluginActivations(bad)).toHaveLength(1)
      expect(first.compatibilityDiagnostics()).toContainEqual(
        expect.objectContaining({ objectId: bad, status: 'isolated', phase: 'dependency' }),
      )
      await first.dispose()
      resolve.mockClear()
      const second = f.create(resolve)
      expect(await second.initialize()).toEqual({ restored: 1, failed: 1 })
      expect(resolve.mock.calls.map(([, name]) => name)).toEqual(['GOOD'])
      await expect(second.retry(bad)).rejects.toThrow('不兼容')
      expect(f.repository.listDshPluginActivations(bad)).toHaveLength(1)
      await second.dispose()
    } finally {
      f.database.close()
    }
  })

  it('retry rechecks a retained activation and commits success only after actual loading', async () => {
    const f = await fixture()
    try {
      const entryId: DshPluginEntryId = f.seed('RETRY')
      let failing = true
      const resolve = vi.fn(
        () =>
          `data:text/javascript,${encodeURIComponent(
            failing
              ? 'export default function() { throw new Error("synthetic failed plugin") }'
              : 'export default function(ctx) { ctx.provide("fixtureRetry", true) }',
          )}`,
      )
      const coordinator = f.create(resolve)
      expect(await coordinator.initialize()).toEqual({ restored: 0, failed: 1 })
      failing = false
      await coordinator.retry(entryId)
      expect(coordinator.compatibilityDiagnostics()).toEqual([
        expect.objectContaining({ status: 'compatible', objectId: entryId }),
      ])
      expect(f.repository.listDshPluginActivations(entryId)).toHaveLength(1)
      await coordinator.dispose()
    } finally {
      f.database.close()
    }
  })

  it('retains enablement and propagates disposer errors when disabling an active plugin', async () => {
    const f = await fixture()
    try {
      const entryId = f.seed('DISPOSE')
      const coordinator = f.create(
        () =>
          `data:text/javascript,${encodeURIComponent(`export default function(ctx) {
        ctx.effect(() => () => { throw new Error('synthetic disposal failure') })
      }`)}`,
      )
      expect(await coordinator.initialize()).toEqual({ restored: 1, failed: 0 })
      await expect(coordinator.disable(entryId, 'host')).rejects.toBeInstanceOf(DshPluginQuiescenceError)
      expect(f.repository.listDshPluginActivations(entryId)).toHaveLength(1)
      expect(coordinator.compatibilityDiagnostics()).toContainEqual(
        expect.objectContaining({ phase: 'dispose', retryable: false }),
      )
      await expect(coordinator.dispose()).rejects.toThrow()
    } finally {
      f.database.close()
    }
  })
})
