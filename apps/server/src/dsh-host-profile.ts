import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { Context, type FiberState, type Plugin } from '@deepseek-ai/cordis'
import Loader, { type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import {
  composeEntries,
  loadProfileDirectory,
  mountRootInclude,
  readProfilePatches,
  reconcileProfilePatches,
  type ProfileContext,
} from '@deepseek-ai/dsh-app-boot'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import SettingsForms from '@deepseek-ai/dsh-settings'
import type { RuntimeCompatibilityDiagnostic } from '@nekro-nxt/contracts'
import { DSH_RUNTIME_FINGERPRINT, DSH_RUNTIME_RELEASE } from '@nekro-nxt/dsh-compat/release'
import { parse, stringify } from 'yaml'
import { z } from 'zod'
import {
  disposeDshPluginFiber,
  DshPluginQuiescenceError,
  observeDshPluginDisposal,
  assertDshPluginDisposalHealthy,
} from './dsh-plugin-lifecycle.js'

/** Stable product addresses; they deliberately do not follow upstream package renames. */
export const DSH_HOST_PROFILE_ENTRIES = {
  piAi: 'llm-pi-ai',
  deepSeek: 'llm-deepseek',
  agentLoop: 'agent-loop',
  webSearch: 'web-search-deepseek',
  subagent: 'subagent',
  spill: 'spill-policy',
} as const

export interface DshHostProfileDiagnostic {
  readonly entryId: string
  readonly provider?: string
  readonly phase: 'settings-migration' | 'config-validation' | 'import' | 'apply'
  readonly reasonCode: 'unknown-entry' | 'invalid-config' | 'unavailable-plugin' | 'inactive-plugin'
  /** Does not include raw configuration, credentials, or an upstream error message. */
  readonly reason: string
  readonly retryable: true
  readonly runtimeFingerprint: string
}

export interface DshHostProfileOptions {
  /** The old settings document is read once and retained byte-for-byte. */
  readonly settingsPath?: string
  readonly credentialPath?: string
}

export interface DshHostProfileEntry {
  readonly id: string
  readonly name: string
  readonly config?: Readonly<Record<string, unknown>>
  /** Failure of a product-owned mandatory service must fail startup. */
  readonly required?: boolean
}

interface ProfileState {
  readonly options: DshHostProfileOptions
  readonly entries: Map<string, DshHostProfileEntry>
  readonly diagnostics: DshHostProfileDiagnostic[]
  readonly checkedAt: number
  readonly configurationRevisions: Map<string, string>
  active: boolean
  settingsTail: Promise<void>
  maintenance: Promise<void> | undefined
}

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

const profiles = new WeakMap<Context, ProfileState>()
// Cordis publishes FiberState as an ambient const enum; it has no ESM runtime export.
const FIBER_ACTIVE: FiberState = 2
const objectSchema = z.record(z.string(), z.unknown())
const diagnosticSchema = z.object({
  entryId: z.string(),
  provider: z.string().optional(),
  phase: z.enum(['settings-migration', 'config-validation', 'import', 'apply']),
  reasonCode: z.enum(['unknown-entry', 'invalid-config', 'unavailable-plugin', 'inactive-plugin']),
  reason: z.string(),
  retryable: z.literal(true),
  runtimeFingerprint: z.string(),
})
const markerSchema = z.object({
  format: z.literal('nxt.dsh-host-profile'),
  version: z.literal(1),
  settingsFormatVersion: z.number().int(),
  legacySourceSha256: z.string().optional(),
  diagnostics: z.array(diagnosticSchema),
  configurationRevisions: z.record(z.string(), z.string()).default({}),
  checkedAt: z.number().int().nonnegative().default(0),
})
type ProfileMarker = z.output<typeof markerSchema>
const configRevision = (config: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(config ?? {}))
    .digest('hex')

const missing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT'
const profileDirectory = (settingsPath: string): string => path.join(path.dirname(settingsPath), 'host-profile')
const profileMarker = (directory: string): string => path.join(directory, 'nxt-profile.json')

async function readOptional(filename: string): Promise<string | undefined> {
  try {
    return await readFile(filename, 'utf8')
  } catch (error) {
    if (missing(error)) return undefined
    throw error
  }
}

/** All profile publications use a private same-directory temporary file and atomic rename. */
async function writeAtomic(filename: string, content: string): Promise<void> {
  const temporary = `${filename}.${randomUUID()}.tmp`
  const file = await open(temporary, 'wx', 0o600)
  try {
    await file.writeFile(content)
    await file.sync()
    await file.close()
    await rename(temporary, filename)
  } catch (error) {
    await file.close().catch(() => undefined)
    await rm(temporary, { force: true })
    throw error
  }
}

function diagnostic(
  entryId: string,
  phase: DshHostProfileDiagnostic['phase'],
  reasonCode: DshHostProfileDiagnostic['reasonCode'],
  provider?: string,
): DshHostProfileDiagnostic {
  const reason = {
    'unknown-entry': '旧设置没有对应的宿主插件入口，原始配置已保留。',
    'invalid-config': '配置与当前引擎不兼容，已隔离该项；请重新检查模型或供应商配置。',
    'unavailable-plugin': '当前宿主无法载入此插件，已保留其配置以供修复。',
    'inactive-plugin': '插件未成功进入运行状态，已停止该实例并保留配置。',
  }[reasonCode]
  return {
    entryId,
    ...(provider === undefined ? {} : { provider }),
    phase,
    reasonCode,
    reason,
    retryable: true,
    runtimeFingerprint: DSH_RUNTIME_FINGERPRINT,
  }
}

/** Prepare before configureLlm. Without paths this only creates an in-memory Loader. */
export async function prepareDshHostProfile(context: Context, options: DshHostProfileOptions = {}): Promise<void> {
  if (profiles.has(context)) throw new Error('NXT DSH Host Profile 已准备。')
  if ((options.settingsPath === undefined) !== (options.credentialPath === undefined)) {
    throw new TypeError('DSH settings and credential paths must be configured together.')
  }
  for (const filename of [options.settingsPath, options.credentialPath]) {
    if (filename !== undefined && !path.isAbsolute(filename)) throw new TypeError('DSH profile paths must be absolute.')
  }
  context.baseUrl = import.meta.url
  observeDshPluginDisposal(context)
  await context.plugin(Loader, { baseUrl: import.meta.url })
  if (options.credentialPath !== undefined) {
    await context.plugin(LocalCredentialProvider, { path: options.credentialPath })
  }
  profiles.set(context, {
    options,
    entries: new Map(),
    diagnostics: [],
    checkedAt: Date.now(),
    configurationRevisions: new Map(),
    active: false,
    settingsTail: Promise.resolve(),
    maintenance: undefined,
  })
  context.on('agent/created', async () => {
    // The factory keeps waking input parked until this public initialization event settles.
    await profiles.get(context)?.maintenance
    return undefined
  })
  context.effect(
    () => () => {
      profiles.delete(context)
    },
    'nekro-nxt: DSH Host Profile ownership',
  )
}

/** Claim the real idle phase, retaining new input in DSH's own inbox until the write settles. */
export function runDshSettingsMaintenance<T>(context: Context, operation: () => Promise<T>): Promise<T> {
  const state = profiles.get(context)
  if (!state?.active) return Promise.reject(new Error('DSH Host Profile 尚未就绪。'))
  const result = state.settingsTail.then(async () => {
    while (true) {
      if (!profiles.has(context)) throw new Error('DSH Host Profile 已停止。')
      const agents = context.get('agents')?.list() ?? []
      await Promise.all(agents.map((agent) => agent.whenIdle()))
      const released = deferred()
      const tasks: Promise<void>[] = []
      let claimed = true
      try {
        // No await between these synchronous claims. If input won the idle race,
        // release every claim before waiting again; never park a child's parent alone.
        for (const agent of context.get('agents')?.list() ?? []) {
          tasks.push(agent.runMaintenance(() => released.promise))
        }
      } catch {
        claimed = false
      }
      if (!claimed) {
        released.resolve()
        await Promise.allSettled(tasks)
        continue
      }
      state.maintenance = released.promise
      let coldReloadRejected = false
      const stopReloadGuard = context.on('loader/partial-dispose', (entry, legacy, active) => {
        if (!active || !state.entries.has(entry.options.id) || tasks.length === 0) return
        if (isDeepStrictEqual(entry.options, legacy)) return
        // Include forces an update even when Loader has already committed only
        // volatile fields. The hook itself therefore does not prove a remount.
        const schema = entry.fiber?.runtime?.Config
        const toJSON: unknown = schema && Reflect.get(schema, 'toJSON')
        const liveFields = new Set<string>()
        if (schema && typeof toJSON === 'function') {
          const envelope = z
            .object({ uid: z.number(), refs: z.record(z.string(), z.unknown()) })
            .parse(Reflect.apply(toJSON, schema, []))
          const node = objectSchema.parse(envelope.refs[String(envelope.uid)])
          const fields = objectSchema.parse(node['dict'] ?? {})
          for (const [key, reference] of Object.entries(fields)) {
            const field = objectSchema.parse(
              typeof reference === 'number' ? envelope.refs[String(reference)] : reference,
            )
            if (objectSchema.parse(field['meta'] ?? {})['volatile'] === true) liveFields.add(key)
          }
        }
        const coldOptions = (options: Partial<EntryOptions>) => ({
          ...options,
          config: Object.fromEntries(
            Object.entries(objectSchema.parse(options.config ?? {})).filter(([key]) => !liveFields.has(key)),
          ),
        })
        if (isDeepStrictEqual(coldOptions(entry.options), coldOptions(legacy))) return
        // A real remount would dispose AgentLoop's parked agents and deadlock on
        // this maintenance task. Product Profile schemas use top-level live fields.
        // Restore the public entry options before refusing that cold reload.
        for (const key of Object.keys(entry.options))
          if (!Object.hasOwn(legacy, key)) Reflect.deleteProperty(entry.options, key)
        Object.assign(entry.options, legacy)
        coldReloadRejected = true
        throw new Error('此配置变更需要重启宿主后生效；当前会话未被重载。')
      })
      try {
        if (!profiles.has(context)) throw new Error('DSH Host Profile 已停止。')
        assertDshPluginDisposalHealthy(context)
        assertDshProfileMatchesRuntime(context, state)
        const value = await operation()
        if (coldReloadRejected) throw new Error('配置包含需要重启生效的变更，运行中的会话未被重载。')
        assertDshPluginDisposalHealthy(context)
        return value
      } finally {
        stopReloadGuard()
        state.maintenance = undefined
        released.resolve()
        await Promise.all(tasks)
      }
    }
  })
  state.settingsTail = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

function assertDshProfileMatchesRuntime(context: Context, state: ProfileState): void {
  const profile = context.get('profileContext')
  if (!profile) return
  const desired = composeEntries([readProfilePatches('nekro-nxt', profile)])
  const current = [...context.loader.entries()].filter((entry) => state.entries.has(entry.options.id))
  if (
    desired.length !== current.length ||
    desired.some((row) => {
      const entry = current.find(({ options }) => options.id === row.id)
      return (
        !entry ||
        entry.options.name !== row.name ||
        entry.disabled !== Boolean(row.disabled) ||
        !isDeepStrictEqual(entry.options.config ?? {}, row.config ?? {})
      )
    })
  ) {
    throw new Error('磁盘上的 DSH Profile 已变化，请重启宿主后再修改设置；当前会话未被重载。')
  }
}

/** Register only NXT's chosen roster. No upstream base bundle or UI is mounted. */
export function registerDshHostProfileEntry(context: Context, entry: DshHostProfileEntry): void {
  const state = profiles.get(context)
  if (!state || state.active) throw new Error('DSH Host Profile 不在装配阶段。')
  if (!/^[a-z][a-z0-9-]*$/u.test(entry.id) || entry.id === 'include')
    throw new TypeError('Invalid NXT profile entry ID.')
  if (state.entries.has(entry.id)) throw new Error(`DSH Host Profile 入口重复：${entry.id}`)
  state.entries.set(entry.id, { ...entry, config: structuredClone(entry.config ?? {}) })
}

/** Same callback contract as main.ts used before the Settings migration. */
export const configureDshLlmProviders =
  (routes: readonly string[]) =>
  async (context: Context): Promise<void> => {
    if (!profiles.has(context)) await prepareDshHostProfile(context)
    registerDshHostProfileEntry(context, {
      id: DSH_HOST_PROFILE_ENTRIES.piAi,
      name: '@deepseek-ai/dsh-llm-pi-ai',
      config: {
        providers: Object.fromEntries(
          routes.filter((route) => route !== 'deepseek-official').map((route) => [route, {}]),
        ),
      },
    })
    registerDshHostProfileEntry(context, {
      id: DSH_HOST_PROFILE_ENTRIES.deepSeek,
      name: '@deepseek-ai/dsh-llm-deepseek-api-key',
    })
  }

const isPlugin = (value: unknown): value is Plugin =>
  typeof value === 'function' ||
  (value !== null && typeof value === 'object' && typeof Reflect.get(value, 'apply') === 'function')

function pluginFrom(context: Context, module: unknown): Plugin {
  const plugin: unknown = context.loader.unwrapExports(module)
  if (isPlugin(plugin)) return plugin
  throw new TypeError('Module does not export a Cordis plugin.')
}

async function importPlugin(context: Context, name: string): Promise<Plugin> {
  return pluginFrom(context, await context.loader.import(name))
}

async function validateConfig(plugin: Plugin, config: unknown): Promise<void> {
  const result = await plugin.Config?.['~standard'].validate(config)
  if (result?.issues) throw new TypeError('Plugin configuration does not match its public Config schema.')
}

/** Config plus provider semantic validation; no LLM call or network access is made. */
async function validatePiProvider(provider: string, profile: unknown): Promise<void> {
  const probe = new Context()
  try {
    await probe.plugin(LlmRuntime)
    await probe.plugin<Plugin>(LlmPiAi, { providers: { [provider]: profile } })
    // A catalog removed by upstream remains an explicit unusable provider, never a renamed model.
    const models = await probe.llm.listModels(provider)
    if (models.length === 0) throw new Error('Provider has no serviceable models.')
    const configured = objectSchema.parse(profile)['models']
    if (
      Array.isArray(configured) &&
      configured.some((model: unknown) => !models.some(({ id }) => id === objectSchema.parse(model)['id']))
    ) {
      throw new Error('Provider contains an unavailable model.')
    }
  } finally {
    // A failed disposer invalidates this preflight; never silently accept a leaking probe.
    await disposeDshPluginFiber(probe, probe.fiber)
  }
}

type Patch = { id?: string; name?: string; config?: unknown; disabled?: boolean; insert?: EntryOptions[] }

async function convertLegacy(context: Context, state: ProfileState, source: string | undefined): Promise<Patch[]> {
  if (source === undefined) return []
  // A malformed whole document has no reliable entry boundary. Fail before publishing anything.
  const sections = objectSchema.parse(parse(source) ?? {})
  const patches: Patch[] = []
  for (const [id, raw] of Object.entries(sections)) {
    state.configurationRevisions.set(id, configRevision(raw))
    const entry = state.entries.get(id)
    if (!entry) {
      state.diagnostics.push(diagnostic(id, 'settings-migration', 'unknown-entry'))
      continue
    }
    const section = objectSchema.safeParse(raw)
    if (!section.success) {
      state.diagnostics.push(diagnostic(id, 'settings-migration', 'invalid-config'))
      patches.push({ id, disabled: true })
      continue
    }
    let config = section.data
    if (id === DSH_HOST_PROFILE_ENTRIES.piAi) {
      const providers = objectSchema.safeParse(config['providers'] ?? {})
      if (!providers.success) {
        state.diagnostics.push(diagnostic(id, 'settings-migration', 'invalid-config'))
        patches.push({ id, disabled: true })
        continue
      }
      const accepted: Record<string, unknown> = { ...objectSchema.parse(entry.config?.['providers'] ?? {}) }
      for (const [provider, profile] of Object.entries(providers.data)) {
        state.configurationRevisions.set(`${id}/${provider}`, configRevision(profile))
        try {
          await validatePiProvider(provider, profile)
          accepted[provider] = profile
        } catch (error) {
          if (error instanceof DshPluginQuiescenceError) throw error
          delete accepted[provider]
          state.diagnostics.push(diagnostic(id, 'settings-migration', 'invalid-config', provider))
        }
      }
      config = { ...config, providers: accepted }
    }
    let plugin: Plugin
    try {
      plugin = await importPlugin(context, entry.name)
    } catch {
      // Preserve the raw configuration for the next runtime; an absent package
      // is not evidence that the user's configuration is invalid.
      patches.push({ id, config: { ...entry.config, ...config } })
      state.configurationRevisions.set(id, configRevision({ ...entry.config, ...config }))
      state.diagnostics.push(diagnostic(id, 'import', 'unavailable-plugin'))
      continue
    }
    try {
      await validateConfig(plugin, { ...entry.config, ...config })
      patches.push({ id, config: { ...entry.config, ...config } })
    } catch {
      state.diagnostics.push(diagnostic(id, 'settings-migration', 'invalid-config'))
      patches.push({ id, config, disabled: true })
    }
  }
  return patches
}

function rows(state: ProfileState): EntryOptions[] {
  return [...state.entries.values()].map(({ id, name, config }) => ({ id, name, config: config ?? {} }))
}

async function preparePersistentProfile(context: Context, state: ProfileState): Promise<ProfileContext> {
  const sourcePath = state.options.settingsPath!
  const directory = profileDirectory(sourcePath)
  const markerText = await readOptional(profileMarker(directory))
  if (markerText === undefined) {
    // A pre-existing directory without our marker is not an authorized legacy format.
    try {
      await readFile(path.join(directory, 'package.json'))
      throw new Error('Existing DSH Host Profile has no NXT format marker.')
    } catch (error) {
      if (!missing(error)) throw error
    }
    const source = await readOptional(sourcePath)
    const patches = await convertLegacy(context, state, source)
    const marker: ProfileMarker = {
      format: 'nxt.dsh-host-profile',
      version: 1,
      settingsFormatVersion: DSH_RUNTIME_RELEASE.settingsFormatVersion,
      ...(source === undefined ? {} : { legacySourceSha256: createHash('sha256').update(source).digest('hex') }),
      diagnostics: state.diagnostics,
      configurationRevisions: Object.fromEntries(state.configurationRevisions),
      checkedAt: state.checkedAt,
    }
    await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 })
    const temporary = `${directory}.${randomUUID()}.tmp`
    await mkdir(temporary, { mode: 0o700 })
    try {
      await writeAtomic(
        path.join(temporary, 'package.json'),
        JSON.stringify({ private: true, dsh: { profile: { bundles: [] } } }, null, 2) + '\n',
      )
      await writeAtomic(path.join(temporary, 'cordis.yml'), '[]\n')
      await writeAtomic(path.join(temporary, 'cordis.patch.yml'), stringify([{ insert: rows(state) }, ...patches]))
      await writeAtomic(profileMarker(temporary), JSON.stringify(marker, null, 2) + '\n')
      if ((await readOptional(sourcePath)) !== source) throw new Error('旧 DSH 设置在迁移期间被修改，请重试。')
      // Publish config and receipt together; the source document is never renamed or edited.
      await rename(temporary, directory)
    } catch (error) {
      await rm(temporary, { recursive: true, force: true })
      throw error
    }
  } else {
    const marker = markerSchema.parse(JSON.parse(markerText))
    if (marker.settingsFormatVersion !== DSH_RUNTIME_RELEASE.settingsFormatVersion) {
      throw new Error('DSH Host Profile settings format requires a registered migration.')
    }
    state.diagnostics.push(
      ...marker.diagnostics.map(({ provider, ...item }) => ({
        ...item,
        ...(provider === undefined ? {} : { provider }),
      })),
    )
    for (const [key, revision] of Object.entries(marker.configurationRevisions))
      state.configurationRevisions.set(key, revision)
    const patches = z.array(objectSchema).parse(parse(await readFile(path.join(directory, 'cordis.patch.yml'), 'utf8')))
    if (
      patches.length === 0 ||
      !Array.isArray(patches[0]?.['insert']) ||
      patches.slice(1).some((patch) => patch['insert'] !== undefined)
    ) {
      throw new Error('NXT Host Profile roster is not recognized.')
    }
    // Only update the product-owned insertion. ConfigEditor owns the following override rows.
    await writeAtomic(
      path.join(directory, 'cordis.patch.yml'),
      stringify([{ insert: rows(state) }, ...patches.slice(1)]),
    )
  }
  const profile: ProfileContext = {
    name: 'nekro-nxt-host',
    dir: directory,
    patchPath: path.join(directory, 'cordis.patch.yml'),
    installAnchor: fileURLToPath(new URL('../package.json', import.meta.url)),
    cwd: path.dirname(sourcePath),
    // Deliberately separate from the old settings.yaml and the user's ambient ~/.dsh.
    // SettingsForms' upstream automatic importer must not own our migration.
    home: path.join(directory, 'home'),
    startedBundles: [],
    overlays: [],
    telemetryDisabledEnv: '1',
  }
  loadProfileDirectory('nekro-nxt', directory, profile.installAnchor)
  return profile
}

async function persistDiagnostics(profile: ProfileContext, state: ProfileState): Promise<void> {
  const marker = markerSchema.parse(JSON.parse(await readFile(profileMarker(profile.dir), 'utf8')))
  await writeAtomic(
    profileMarker(profile.dir),
    JSON.stringify(
      {
        ...marker,
        diagnostics: state.diagnostics,
        configurationRevisions: Object.fromEntries(state.configurationRevisions),
        checkedAt: state.checkedAt,
      },
      null,
      2,
    ) + '\n',
  )
}

function isolationOverlays(profile: ProfileContext, state: ProfileState): NonNullable<ProfileContext['overlays']> {
  const effective = composeEntries([readProfilePatches('nekro-nxt', { ...profile, overlays: [] })])
  return state.diagnostics.flatMap((item) => {
    if (item.phase !== 'import' && item.phase !== 'apply') return []
    if (item.runtimeFingerprint !== DSH_RUNTIME_FINGERPRINT) return []
    const row = effective.find(({ id }) => id === item.entryId)
    return row && state.configurationRevisions.get(item.entryId) === configRevision(row.config)
      ? [{ id: item.entryId, disabled: true }]
      : []
  })
}

async function stopEntry(context: Context, id: string): Promise<void> {
  const entry = context.loader.resolve(id)
  // Loader.remove is synchronous and starts disposal without awaiting it. Await the Fiber first.
  if (entry.fiber) await disposeDshPluginFiber(context, entry.fiber)
  context.loader.remove(id)
  await context.loader.await()
}

/** Activate after the host has installed its required services. Returns safe compatibility diagnostics. */
export async function activateDshHostProfile(context: Context): Promise<readonly RuntimeCompatibilityDiagnostic[]> {
  const state = profiles.get(context)
  if (!state || state.active) throw new Error('DSH Host Profile 不在装配阶段。')
  state.active = true
  if (state.options.settingsPath === undefined) {
    // No profile, ConfigEditor, credential file or temporary directory in fake-LLM tests.
    for (const row of rows(state)) {
      await context.loader.root.create(row)
    }
  } else {
    const prepared = await preparePersistentProfile(context, state)
    const profile = { ...prepared, overlays: isolationOverlays(prepared, state) }
    context.provide('profileContext', profile)
    await mountRootInclude(
      context,
      path.join(profile.dir, 'cordis.yml'),
      readProfilePatches('nekro-nxt', profile),
      import.meta.url,
      'nekro-nxt',
    )
    await context.loader.await()
  }
  await context.loader.await()
  for (const spec of state.entries.values()) {
    const entry = [...context.loader.entries()].find((candidate) => candidate.options.id === spec.id)
    if (entry?.disabled) {
      if (spec.required) throw new Error(`必需 DSH 入口已被禁用：${spec.id}`)
      continue
    }
    if (entry?.fiber?.state === FIBER_ACTIVE) {
      state.diagnostics.splice(
        0,
        state.diagnostics.length,
        ...state.diagnostics.filter(
          (item) => item.entryId !== spec.id || (item.phase !== 'import' && item.phase !== 'apply'),
        ),
      )
      continue
    }
    if (spec.required) throw new Error(`必需 DSH 入口未就绪：${spec.id}`)
    state.diagnostics.push(
      diagnostic(spec.id, entry?.fiber ? 'apply' : 'import', entry?.fiber ? 'inactive-plugin' : 'unavailable-plugin'),
    )
    state.configurationRevisions.set(spec.id, configRevision(entry?.options.config ?? spec.config))
    if (entry) await stopEntry(context, entry.id)
  }
  const profile = context.get('profileContext')
  if (profile) {
    const next = { ...profile, overlays: isolationOverlays(profile, state) }
    context.set('profileContext', next)
    await persistDiagnostics(next, state)
    // Restore isolated rows as disabled entries so future Settings writes cannot remount them.
    await reconcileProfilePatches(context, readProfilePatches('nekro-nxt', next), 'nekro-nxt')
    await context.plugin(ConfigEditor)
    await context.plugin(SettingsForms)
  }
  return getDshHostProfileDiagnostics(context)
}

export function getDshHostProfileDiagnostics(context: Context): readonly RuntimeCompatibilityDiagnostic[] {
  const state = profiles.get(context)
  return (state?.diagnostics ?? []).map((item) => ({
    objectKind: item.provider !== undefined || item.entryId.startsWith('llm-') ? 'model-provider' : 'dsh-plugin',
    objectId:
      item.provider ?? (item.entryId === DSH_HOST_PROFILE_ENTRIES.deepSeek ? 'deepseek-official' : item.entryId),
    objectVersion: DSH_RUNTIME_RELEASE.dshVersion,
    configurationRevision:
      state?.configurationRevisions.get(item.provider ? `${item.entryId}/${item.provider}` : item.entryId) ??
      configRevision(state?.entries.get(item.entryId)?.config),
    runtimeFingerprint: item.runtimeFingerprint,
    status: 'isolated',
    phase: item.phase === 'import' ? 'dependency' : item.phase === 'apply' ? 'load' : 'configuration',
    reason: item.reason,
    retryable: item.retryable && state?.entries.has(item.entryId) === true,
    checkedAt: state?.checkedAt ?? 0,
  }))
}

/** Explicit repair of an isolated entry; persistence precedes verified Loader reconciliation. */
async function repairDshHostProfileEntry(
  context: Context,
  id: string,
  config: Readonly<Record<string, unknown>>,
  onlyProvider?: string,
): Promise<void> {
  const state = profiles.get(context)
  const spec = state?.entries.get(id)
  const profile = context.get('profileContext')
  if (!state?.active || !spec || !profile) throw new Error('DSH Host Profile 入口不可修复。')
  await validateConfig(await importPlugin(context, spec.name), config)
  if (id === DSH_HOST_PROFILE_ENTRIES.piAi) {
    for (const [provider, value] of Object.entries(objectSchema.parse(config['providers'] ?? {})))
      await validatePiProvider(provider, value)
  }
  const previous = await readFile(profile.patchPath, 'utf8')
  const patches = z.array(objectSchema).parse(parse(previous))
  const next = [...patches.filter((patch) => patch['id'] !== id), { id, config, disabled: false }]
  composeEntries([next])
  await writeAtomic(profile.patchPath, stringify(next))
  const retryProfile = { ...profile, overlays: profile.overlays.filter((patch) => patch.id !== id) }
  context.set('profileContext', retryProfile)
  try {
    await reconcileProfilePatches(context, readProfilePatches('nekro-nxt', retryProfile), 'nekro-nxt', [id])
    assertDshPluginDisposalHealthy(context)
    const entry = [...context.loader.entries()].find((candidate) => candidate.options.id === id)
    if (entry?.fiber?.state !== FIBER_ACTIVE) throw new Error('DSH 插件修复后仍未就绪。')
  } catch (error) {
    await writeAtomic(profile.patchPath, previous)
    context.set('profileContext', profile)
    try {
      await reconcileProfilePatches(context, readProfilePatches('nekro-nxt', profile), 'nekro-nxt')
      assertDshPluginDisposalHealthy(context)
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'DSH 配置修复失败，且旧运行状态未完整恢复。')
    }
    throw error
  }
  state.diagnostics.splice(
    0,
    state.diagnostics.length,
    ...state.diagnostics.filter(
      (item) => item.entryId !== id || (onlyProvider !== undefined && item.provider !== onlyProvider),
    ),
  )
  state.configurationRevisions.set(id, configRevision(config))
  await persistDiagnostics(retryProfile, state)
}

/** Serialize repairs with ConfigEditor using its public cross-process profile lock. */
export async function retryDshHostProfileEntry(
  context: Context,
  id: string,
  config: Readonly<Record<string, unknown>>,
  onlyProvider?: string,
): Promise<void> {
  const profile = context.get('profileContext')
  if (!profile) throw new Error('DSH Host Profile 不可修复。')
  await withFileLock(path.join(profile.dir, 'package.json'), () =>
    repairDshHostProfileEntry(context, id, config, onlyProvider),
  )
}

/** Recheck the saved configuration of exactly one isolated product object. */
export async function retryDshHostProfileCompatibility(context: Context, objectId: string): Promise<void> {
  const state = profiles.get(context)
  const profile = context.get('profileContext')
  const issue = state?.diagnostics.find(
    (item) =>
      (item.provider ?? (item.entryId === DSH_HOST_PROFILE_ENTRIES.deepSeek ? 'deepseek-official' : item.entryId)) ===
      objectId,
  )
  if (!state?.active || !profile || !issue) throw new Error('没有可重试的 DSH 配置兼容性诊断。')
  await withFileLock(path.join(profile.dir, 'package.json'), async () => {
    const row = composeEntries([readProfilePatches('nekro-nxt', { ...profile, overlays: [] })]).find(
      ({ id }) => id === issue.entryId,
    )
    if (!row) throw new Error('当前宿主没有此设置对应的插件入口。')
    let config = objectSchema.parse(row.config ?? {})
    if (issue.provider !== undefined) {
      const providers = objectSchema.parse(config['providers'] ?? {})
      let candidate = providers[issue.provider]
      if (candidate === undefined && state.options.settingsPath !== undefined) {
        const legacy = objectSchema.parse(parse(await readFile(state.options.settingsPath, 'utf8')))
        const section = objectSchema.parse(legacy[issue.entryId])
        candidate = objectSchema.parse(section['providers'])[issue.provider]
      }
      if (candidate === undefined) throw new Error('找不到此供应商的保留配置，请先保存供应商设置。')
      await validatePiProvider(issue.provider, candidate)
      config = { ...config, providers: { ...providers, [issue.provider]: candidate } }
    }
    await repairDshHostProfileEntry(context, issue.entryId, config, issue.provider)
  })
}
