import { Context, type FiberState, type Fiber } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import Loader, { Entry } from '@deepseek-ai/cordis-plugin-loader'
import { readPluginInventory } from '@deepseek-ai/dsh-host-plugin-inventory'
import { evaluatePluginCompatibility } from '@deepseek-ai/dsh-app-boot'
import { DSH_RUNTIME_FINGERPRINT, DSH_RUNTIME_RELEASE } from '@nekro-nxt/dsh-compat/release'
import { JsonValueSchema, RuntimeCompatibilityDiagnosticSchema } from '@nekro-nxt/contracts'
import type {
  AgentId,
  DshPluginActivationRecord,
  DshPluginActivationScope,
  DshPluginDiagnosticRecord,
  DshPluginEntryId,
  DshPluginEntryRecord,
  DshPluginPackageId,
  JsonValue,
  RuntimeCompatibilityDiagnostic,
} from '@nekro-nxt/contracts'
import type { DshPluginRepository, SqliteCoreRepository } from '@nekro-nxt/storage-sqlite'

interface OwnedLoader {
  readonly context: Context
  readonly services: Context
  readonly loaderIds: Map<DshPluginEntryId, string>
}

export type DshPluginConfigInspection =
  | { readonly mode: 'schema'; readonly schema: JsonValue }
  | { readonly mode: 'json' }
  | { readonly mode: 'incompatible'; readonly reason: string }

const inventoryEntry = async (loader: OwnedLoader, loaderId: string) =>
  (await readPluginInventory(loader.services)).entries.find((candidate) => candidate.entryId === loaderId)

export interface DshPluginCompatibilityFailure {
  readonly entryId: DshPluginEntryId
  readonly phase: 'compatibility' | 'import' | 'apply' | 'dispose'
  readonly reasonCode: 'incompatible-peers' | 'invalid-manifest' | 'inactive-plugin' | 'dispose-failed'
  readonly reason: string
  readonly runtimeFingerprint: string
}

export class DshPluginQuiescenceError extends Error {
  constructor(cause: unknown) {
    super('DSH 插件资源未完整静止，不能继续隔离或启动。', { cause })
  }
}

const disposalObservedRoots = new WeakSet<Context>()
const failedDisposalFibers = new WeakSet<Fiber>()
const FIBER_UNLOADING: FiberState = 5

/** Retain rollback-disposal failures that Cordis logs before an unsuccessful mount settles. */
export function observeDshPluginDisposal(context: Context): void {
  const root = context.root
  if (disposalObservedRoots.has(root)) return
  disposalObservedRoots.add(root)
  root.logger.exporter({
    levels: { default: 0 },
    export(message) {
      let fiber = message.fiber?.deref()
      if (message.type !== 'error' || fiber?.state !== FIBER_UNLOADING) return
      const visited = new Set<Fiber>()
      while (fiber && !visited.has(fiber)) {
        visited.add(fiber)
        failedDisposalFibers.add(fiber)
        fiber = fiber.parent.fiber
      }
    },
  })
}

export function assertDshPluginDisposalHealthy(context: Context): void {
  if (failedDisposalFibers.has(context.fiber)) {
    throw new DshPluginQuiescenceError(new Error('A plugin resource release failed in this context.'))
  }
}

/** Cordis logs disposer failures instead of rejecting Fiber.dispose; observe that public diagnostic seam. */
export async function disposeDshPluginFiber(context: Context, fiber: Fiber): Promise<void> {
  const diagnostics = new Context()
  diagnostics.logger = context.logger
  const failures: unknown[] = []
  const stop = diagnostics.logger.exporter({
    levels: { default: 0 },
    export(message) {
      if (message.type !== 'error') return
      let owner = message.fiber?.deref()
      const visited = new Set<Fiber>()
      while (owner && !visited.has(owner)) {
        if (owner === fiber) {
          failures.push(new Error('DSH plugin emitted an error during disposal.'))
          break
        }
        visited.add(owner)
        owner = owner.parent.fiber
      }
    },
  })
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      fiber.dispose(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('DSH plugin disposal did not settle within 30 seconds.')), 30_000)
      }),
    ])
    if (failures.length > 0 || failedDisposalFibers.has(fiber))
      throw new AggregateError(failures, 'DSH plugin disposal reported errors.')
  } catch (cause) {
    throw new DshPluginQuiescenceError(cause)
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    await stop()
    await diagnostics.fiber.dispose()
  }
}

class DshPluginCompatibilityError extends Error {
  constructor(readonly failure: DshPluginCompatibilityFailure) {
    super(failure.reason)
  }
}

export interface DshPluginLifecycleOptions {
  readonly repository: DshPluginRepository &
    Partial<Pick<SqliteCoreRepository, 'getSystemSetting' | 'putSystemSetting'>>
  readonly rootContext: Context
  readonly isolateContext: (context: Context) => Context
  readonly resolveModule: (packageId: DshPluginPackageId, moduleName: string) => string
  readonly listAgentSessions: (agentId: AgentId) => readonly {
    readonly sessionId: string
    readonly context: Context
    readonly waitUntilSafe: () => Promise<void>
  }[]
  readonly now?: () => number
  readonly onCompatibilityFailure?: (failure: RuntimeCompatibilityDiagnostic) => void
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const assertConfigContainsNoSecrets = (value: JsonValue, path: readonly string[] = []): void => {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertConfigContainsNoSecrets(item, [...path, String(index)]))
    return
  }
  if (value === null || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) {
    if (/(?:^|[-_])(secret|password|passwd|token|api[-_]?key|credential)(?:$|[-_])/iu.test(key)) {
      throw new Error(`DSH Plugin Config 不得保存 Secret 或凭据字段：${[...path, key].join('.')}`)
    }
    assertConfigContainsNoSecrets(item, [...path, key])
  }
}

const serializedConfigSchema = (input: unknown): DshPluginConfigInspection => {
  if (typeof input !== 'object' || input === null) return { mode: 'json' }
  const toJSON: unknown = Reflect.get(input, 'toJSON')
  if (typeof toJSON !== 'function') return { mode: 'json' }
  let schema: JsonValue
  try {
    const serializedValue: unknown = Reflect.apply(toJSON, input, [])
    schema = JsonValueSchema.parse(JSON.parse(JSON.stringify(serializedValue)))
  } catch {
    return { mode: 'json' }
  }
  const visit = (value: JsonValue): string | undefined => {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = visit(item)
        if (found) return found
      }
      return undefined
    }
    if (value === null || typeof value !== 'object') return undefined
    const role = value['role']
    if (role === 'secret' || role === 'credential-ref') return role
    for (const item of Object.values(value)) {
      const found = visit(item)
      if (found) return found
    }
    return undefined
  }
  const prohibitedRole = visit(schema)
  return prohibitedRole
    ? {
        mode: 'incompatible',
        reason: `Config Schema 包含 ${prohibitedRole} 字段；请改用 DSH Settings/Credentials。`,
      }
    : { mode: 'schema', schema }
}

const pluginConfigSchema = (plugin: unknown): DshPluginConfigInspection => {
  if ((typeof plugin !== 'object' || plugin === null) && typeof plugin !== 'function') return { mode: 'json' }
  return serializedConfigSchema(Reflect.get(plugin, 'Config'))
}

const phaseOf = (error: unknown, fallback: DshPluginDiagnosticRecord['phase']): DshPluginDiagnosticRecord['phase'] => {
  const message = messageOf(error)
  if (message.includes('failed to import')) return 'import'
  if (message.includes('failed to dispose')) return 'dispose'
  if (message.includes('failed to apply')) return 'apply'
  if (message.includes('failed to rollback') || message.includes('failed to update')) return 'update'
  return fallback
}

export class DshPluginLifecycleCoordinator {
  readonly #repository: DshPluginLifecycleOptions['repository']
  readonly #rootContext: Context
  readonly #isolateContext: (context: Context) => Context
  readonly #resolveModule: DshPluginLifecycleOptions['resolveModule']
  readonly #listAgentSessions: DshPluginLifecycleOptions['listAgentSessions']
  readonly #now: () => number
  readonly #onCompatibilityFailure: DshPluginLifecycleOptions['onCompatibilityFailure']
  readonly #compatibilityFailures = new Map<string, DshPluginCompatibilityError>()
  readonly #agentLoaders = new Map<string, OwnedLoader>()
  readonly #transitions = new Map<DshPluginEntryId, Promise<void>>()
  #hostLoader: OwnedLoader | undefined
  #agentProbeLoader: OwnedLoader | undefined
  #disposed = false

  constructor(options: DshPluginLifecycleOptions) {
    this.#repository = options.repository
    this.#rootContext = options.rootContext
    this.#isolateContext = options.isolateContext
    this.#resolveModule = options.resolveModule
    this.#listAgentSessions = options.listAgentSessions
    this.#now = options.now ?? Date.now
    this.#onCompatibilityFailure = options.onCompatibilityFailure
  }

  async initialize(): Promise<{ readonly restored: number; readonly failed: number }> {
    this.#assertActive()
    const context = this.#isolateContext(this.#rootContext).isolate('loader').isolate('pluginInventory')
    this.#hostLoader = await this.#createLoader(context)
    const probeContext = this.#isolateContext(this.#rootContext).isolate('loader').isolate('pluginInventory')
    this.#agentProbeLoader = await this.#createLoader(probeContext)
    let restored = 0
    let failed = 0
    for (const activation of this.#repository
      .listDshPluginActivations()
      .filter((candidate) => candidate.target === 'host')) {
      const entry = this.#repository.getDshPluginEntry(activation.entryId)
      if (!entry) continue
      try {
        if (this.#previousIsolation(entry, activation.targetKey)) {
          failed += 1
          continue
        }
        await this.#mount(this.#hostLoader, entry)
        this.#diagnose(entry.id, activation.targetKey, 'active', 'restore')
        restored += 1
      } catch (error) {
        if (error instanceof DshPluginQuiescenceError) throw error
        this.#diagnose(entry.id, activation.targetKey, 'restore-failed', phaseOf(error, 'restore'), error)
        failed += 1
      }
    }
    return { restored, failed }
  }

  async inspectConfig(entryId: DshPluginEntryId): Promise<DshPluginConfigInspection> {
    this.#assertActive()
    const entry = this.#requireEntry(entryId)
    if (!this.#hostLoader) throw new Error('DSH Host Loader 尚未初始化。')
    const moduleName = this.#resolveModule(entry.packageId, entry.moduleName)
    this.#preflight(entry)
    const imported: unknown = await this.#hostLoader.services.loader.import(moduleName)
    return pluginConfigSchema(this.#hostLoader.services.loader.unwrapExports(imported))
  }

  async mountAgentSession(agentId: AgentId, sessionId: string, agentContext: Context): Promise<void> {
    this.#assertActive()
    if (this.#agentLoaders.has(sessionId)) throw new Error(`DSH plugin Loader already exists for Session: ${sessionId}`)
    const context = this.#isolateContext(agentContext).isolate('loader').isolate('pluginInventory')
    const owned = await this.#createLoader(context)
    this.#agentLoaders.set(sessionId, owned)
    try {
      for (const activation of this.#repository
        .listDshPluginActivations()
        .filter((candidate) => candidate.target === 'agent' && candidate.agentId === agentId)) {
        const entry = this.#repository.getDshPluginEntry(activation.entryId)
        if (!entry) continue
        try {
          if (this.#previousIsolation(entry, activation.targetKey)) continue
          await this.#mount(owned, entry)
          this.#diagnose(entry.id, activation.targetKey, 'active', 'restore')
        } catch (error) {
          if (error instanceof DshPluginQuiescenceError) throw error
          this.#diagnose(entry.id, activation.targetKey, 'restore-failed', phaseOf(error, 'restore'), error)
        }
      }
      context.effect(
        () => () => {
          if (this.#agentLoaders.get(sessionId) === owned) this.#agentLoaders.delete(sessionId)
        },
        'nekro-nxt: DSH plugin Agent Loader ownership',
      )
    } catch (error) {
      this.#agentLoaders.delete(sessionId)
      try {
        await context.fiber.dispose()
      } catch (disposeError) {
        throw new AggregateError([error, disposeError], 'DSH Agent Loader 创建失败，且临时 Context 未完整静止。')
      }
      throw error
    }
  }

  async activate(input: {
    readonly entryId: DshPluginEntryId
    readonly target: DshPluginActivationScope
    readonly agentId?: AgentId
    readonly config: JsonValue
    readonly hostUi?: Parameters<DshPluginRepository['commitDshPluginActivationState']>[0]['hostUi']
  }): Promise<DshPluginActivationRecord> {
    return this.#exclusive(input.entryId, async () => {
      this.#assertActive()
      const entry = this.#requireEntry(input.entryId)
      assertConfigContainsNoSecrets(input.config)
      const targetKey = input.target === 'host' ? 'host' : input.agentId
      if (!targetKey || (input.target === 'host' && input.agentId !== undefined)) {
        throw new Error('DSH 智能体作用域必须提供 agentId，Host 作用域不得提供。')
      }
      const existingActivations = this.#repository.listDshPluginActivations(entry.id)
      if (existingActivations.some((activation) => activation.target !== input.target)) {
        throw new Error('普通 DSH 插件入口切换作用域前必须先关闭全部现有启用关系。')
      }
      if (entry.selectedScope !== undefined && entry.selectedScope !== input.target && existingActivations.length) {
        throw new Error('DSH 插件入口当前作用域仍在使用，不能直接切换。')
      }
      const candidate = { ...entry, selectedScope: input.target, config: input.config }
      const changed = new Map<OwnedLoader, boolean>()
      try {
        if (input.target === 'host') {
          if (!this.#hostLoader) throw new Error('DSH Host Loader 尚未初始化。')
          changed.set(this.#hostLoader, this.#hostLoader.loaderIds.has(entry.id))
          await this.#mountOrUpdate(this.#hostLoader, candidate)
        } else {
          const agentIds = new Set(
            existingActivations
              .filter((activation) => activation.target === 'agent' && activation.agentId !== undefined)
              .map((activation) => activation.agentId!),
          )
          agentIds.add(input.agentId!)
          const sessions = [...agentIds].flatMap((agentId) => this.#listAgentSessions(agentId))
          await Promise.all(sessions.map((session) => session.waitUntilSafe()))
          if (sessions.length === 0) {
            if (!this.#agentProbeLoader) throw new Error('DSH Agent Probe Loader 尚未初始化。')
            changed.set(this.#agentProbeLoader, false)
            await this.#mount(this.#agentProbeLoader, candidate)
            await this.#unmount(this.#agentProbeLoader, candidate.id)
            changed.delete(this.#agentProbeLoader)
          } else {
            for (const session of sessions) {
              const loader = this.#agentLoaders.get(session.sessionId)
              if (!loader) throw new Error(`智能体 Session 缺少 DSH 插件 Loader：${session.sessionId}`)
              if (changed.has(loader)) continue
              changed.set(loader, loader.loaderIds.has(entry.id))
              await this.#mountOrUpdate(loader, candidate)
            }
          }
        }
      } catch (error) {
        const rollback = await Promise.allSettled(
          [...changed].map(([loader, existed]) =>
            existed ? this.#mountOrUpdate(loader, entry) : this.#unmount(loader, entry.id),
          ),
        )
        this.#diagnose(entry.id, targetKey, 'load-failed', phaseOf(error, 'apply'), error)
        const failures = rollback
          .filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
          .map((outcome): unknown => outcome.reason)
        if (failures.length) throw new AggregateError([error, ...failures], 'DSH 插件变更失败，且旧配置未完整恢复。')
        throw error
      }
      const activation: DshPluginActivationRecord = {
        entryId: entry.id,
        targetKey,
        target: input.target,
        ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
        activatedAt: this.#timestamp(),
      }
      try {
        this.#repository.commitDshPluginActivationState({
          entry: candidate,
          activation,
          ...(input.hostUi === undefined ? {} : { hostUi: input.hostUi }),
        })
        this.#diagnose(entry.id, targetKey, 'active', 'apply')
      } catch (error) {
        const rollback = await Promise.allSettled(
          [...changed].map(([loader, existed]) =>
            existed ? this.#mountOrUpdate(loader, entry) : this.#unmount(loader, entry.id),
          ),
        )
        const failures = rollback
          .filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
          .map((outcome): unknown => outcome.reason)
        if (failures.length) throw new AggregateError([error, ...failures], 'DSH 插件提交失败，且旧配置未完整恢复。')
        throw error
      }
      return activation
    })
  }

  async disable(entryId: DshPluginEntryId, targetKey: string): Promise<void> {
    await this.#exclusive(entryId, async () => {
      this.#assertActive()
      const activation = this.#repository
        .listDshPluginActivations(entryId)
        .find((candidate) => candidate.targetKey === targetKey)
      if (!activation) throw new Error('DSH 插件入口在该作用域尚未启用。')
      const sessions = activation.target === 'agent' ? this.#listAgentSessions(activation.agentId!) : []
      await Promise.all(sessions.map((session) => session.waitUntilSafe()))
      const sessionIds = new Set(sessions.map((session) => session.sessionId))
      const loaders =
        activation.target === 'host'
          ? this.#hostLoader
            ? [this.#hostLoader]
            : []
          : [...this.#agentLoaders.entries()]
              .filter(([sessionId]) => sessionIds.has(sessionId))
              .map(([, loader]) => loader)
      const entry = this.#requireEntry(entryId)
      const unmounted: OwnedLoader[] = []
      try {
        for (const loader of loaders) {
          const existed = loader.loaderIds.has(entryId)
          await this.#unmount(loader, entryId)
          if (existed) unmounted.push(loader)
        }
      } catch (error) {
        this.#diagnose(entryId, targetKey, 'dispose-failed', 'dispose', error)
        const rollback = await Promise.allSettled(unmounted.map((loader) => this.#mount(loader, entry)))
        const failures = rollback
          .filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
          .map((outcome): unknown => outcome.reason)
        if (failures.length) {
          throw new AggregateError([error, ...failures], 'DSH 插件关闭失败，且已卸载 Session 未完整恢复。')
        }
        throw error
      }
      try {
        this.#repository.deleteDshPluginActivationState({ entryId, targetKey, now: this.#timestamp() })
      } catch (error) {
        const rollback = await Promise.allSettled(unmounted.map((loader) => this.#mount(loader, entry)))
        const failures = rollback
          .filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
          .map((outcome): unknown => outcome.reason)
        if (failures.length) {
          throw new AggregateError([error, ...failures], 'DSH 插件关闭提交失败，且运行时未完整恢复。')
        }
        throw error
      }
    })
  }

  async disablePackage(packageId: DshPluginPackageId): Promise<void> {
    const entryIds = new Set(this.#repository.listDshPluginEntries(packageId).map((entry) => entry.id))
    for (const activation of this.#repository
      .listDshPluginActivations()
      .filter((candidate) => entryIds.has(candidate.entryId))) {
      await this.disable(activation.entryId, activation.targetKey)
    }
  }

  /** Explicit retry bypasses restore suppression, but can only use persisted activation scopes. */
  async retry(entryId: DshPluginEntryId): Promise<void> {
    this.#assertActive()
    const entry = this.#requireEntry(entryId)
    const activations = this.#repository.listDshPluginActivations(entryId)
    if (activations.length === 0) throw new Error('DSH 插件没有保留的启用记录，不能按兼容性重试启用。')
    for (const activation of activations) {
      await this.activate({
        entryId,
        target: activation.target,
        ...(activation.agentId === undefined ? {} : { agentId: activation.agentId }),
        config: entry.config,
      })
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    await Promise.allSettled([...this.#transitions.values()])
    const contexts = [
      this.#hostLoader?.context,
      this.#agentProbeLoader?.context,
      ...[...this.#agentLoaders.values()].map(({ context }) => context),
    ].filter((context): context is Context => context !== undefined)
    this.#hostLoader = undefined
    this.#agentProbeLoader = undefined
    this.#agentLoaders.clear()
    const outcomes = await Promise.allSettled(contexts.map((context) => disposeDshPluginFiber(context, context.fiber)))
    const failures = outcomes
      .filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
      .map((outcome): unknown => outcome.reason)
    if (failures.length) throw new AggregateError(failures, 'DSH plugin Loader disposal failed.')
  }

  async #mount(loader: OwnedLoader, entry: DshPluginEntryRecord): Promise<void> {
    if (loader.loaderIds.has(entry.id)) return
    this.#preflight(entry)
    const packageRecord = this.#repository.getDshPluginPackage(entry.packageId)
    if (!packageRecord) throw new Error(`DSH 插件包不存在：${entry.packageId}`)
    const name = this.#resolveModule(packageRecord.id, entry.moduleName)
    const loaderId = await loader.services.loader.create({ name, config: entry.config })
    await loader.services.loader.await()
    loader.loaderIds.set(entry.id, loaderId)
    try {
      const observed = await inventoryEntry(loader, loaderId)
      if (!observed?.enabled || observed.fiberPhase !== 'active') {
        // Fiber.await is public and retains the actual plugin error for the existing diagnostic UI.
        await loader.services.loader.resolve(loaderId).fiber?.await()
        throw new Error(`DSH Loader Inventory 未确认入口进入 active：${entry.entryKey}`)
      }
      const configInspection = serializedConfigSchema(loader.services.loader.resolve(loaderId).fiber?.runtime?.Config)
      if (configInspection.mode === 'incompatible') throw new Error(configInspection.reason)
    } catch (error) {
      await this.#unmount(loader, entry.id)
      throw error
    }
  }

  async #mountOrUpdate(loader: OwnedLoader, entry: DshPluginEntryRecord): Promise<void> {
    const loaderId = loader.loaderIds.get(entry.id)
    if (!loaderId) return this.#mount(loader, entry)
    await loader.services.loader.update(loaderId, { config: entry.config })
    await loader.services.loader.await()
    const observed = await inventoryEntry(loader, loaderId)
    if (!observed?.enabled || observed.fiberPhase !== 'active') {
      throw new Error(`DSH Loader Inventory 未确认入口更新后保持 active：${entry.entryKey}`)
    }
  }

  async #unmount(loader: OwnedLoader, entryId: DshPluginEntryId): Promise<void> {
    const loaderId = loader.loaderIds.get(entryId)
    if (!loaderId) return
    try {
      // remove() is void and detaches the entry immediately; its tree no longer owns the pending disposer.
      // Await the public Fiber disposal before allowing Loader to unlink it.
      const fiber = loader.services.loader.resolve(loaderId).fiber
      if (fiber) await disposeDshPluginFiber(loader.context, fiber)
      loader.services.loader.remove(loaderId)
      await loader.services.loader.await()
    } catch (cause) {
      throw new DshPluginQuiescenceError(cause)
    }
    loader.loaderIds.delete(entryId)
  }

  #requireEntry(entryId: DshPluginEntryId): DshPluginEntryRecord {
    const entry = this.#repository.getDshPluginEntry(entryId)
    if (!entry) throw new Error(`DSH 插件入口不存在：${entryId}`)
    return entry
  }

  async #createLoader(context: Context): Promise<OwnedLoader> {
    observeDshPluginDisposal(context)
    // AgentLoop now lives in a Profile entry. A child Loader must own a fresh tree,
    // rather than inherit that entry's metadata and overwrite its subtree pointer.
    const owner = await context.extend({ [Entry.key]: undefined }).plugin(Loader, { baseUrl: import.meta.url })
    const ownedContext = owner.ctx
    let services: Context | undefined
    await ownedContext.registry.inject(['loader'], (injected) => {
      services = injected
    })
    if (!services) throw new Error('DSH Loader Service 注入未完成。')
    return { context: ownedContext, services, loaderIds: new Map() }
  }

  #preflight(entry: DshPluginEntryRecord): void {
    const installed = this.#repository.getDshPluginPackage(entry.packageId)
    if (!installed) throw new Error(`DSH 插件包不存在：${entry.packageId}`)
    const identity = JSON.stringify([
      entry.id,
      installed.packageDigest,
      installed.lockfileDigest,
      entry.config,
      DSH_RUNTIME_FINGERPRINT,
    ])
    const cached = this.#compatibilityFailures.get(identity)
    if (cached) throw cached
    let reasonCode: DshPluginCompatibilityFailure['reasonCode'] | undefined
    try {
      const manifest = installed.manifest
      if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest))
        throw new TypeError('Invalid manifest')
      const issue = evaluatePluginCompatibility(manifest, {}, DSH_RUNTIME_RELEASE.dshVersion)
      if (issue !== undefined) reasonCode = 'incompatible-peers'
      // A plugin may pin DSH in dependencies instead of peers. That still cannot
      // opt an old engine into this process just because its peer list is empty.
      const dependencies = manifest['dependencies']
      if (dependencies !== undefined) {
        if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies))
          throw new TypeError('Invalid dependencies')
        if (
          evaluatePluginCompatibility(
            { ...manifest, peerDependencies: dependencies },
            {},
            DSH_RUNTIME_RELEASE.dshVersion,
          )
        ) {
          reasonCode = 'incompatible-peers'
        }
      }
    } catch {
      reasonCode = 'invalid-manifest'
    }
    if (reasonCode === undefined) return
    const failure: DshPluginCompatibilityFailure = {
      entryId: entry.id,
      phase: 'compatibility',
      reasonCode,
      reason:
        reasonCode === 'incompatible-peers'
          ? `插件 ${installed.packageName}@${installed.packageVersion} 声明的 DSH 版本与当前宿主不兼容；安装和启用记录已保留。`
          : '插件的版本兼容声明无效，已隔离且保留安装和启用记录。',
      runtimeFingerprint: DSH_RUNTIME_FINGERPRINT,
    }
    const error = new DshPluginCompatibilityError(failure)
    this.#compatibilityFailures.set(identity, error)
    throw error
  }

  /** Public projection of owner-held checks, without another activation table. */
  compatibilityDiagnostics(): readonly RuntimeCompatibilityDiagnostic[] {
    return this.#repository.listDshPluginActivations().flatMap((activation) => {
      const record = this.#repository.getSystemSetting?.(this.#diagnosticKey(activation.entryId, activation.targetKey))
      const parsed = RuntimeCompatibilityDiagnosticSchema.safeParse(record?.value)
      return parsed.success ? [parsed.data] : []
    })
  }

  #diagnosticKey(entryId: DshPluginEntryId, targetKey: string): string {
    return `dsh.plugins.compatibility.${entryId}.${targetKey}`
  }

  #configurationRevision(entry: DshPluginEntryRecord): string {
    const installed = this.#repository.getDshPluginPackage(entry.packageId)
    return createHash('sha256')
      .update(JSON.stringify([installed?.packageDigest, installed?.lockfileDigest, entry.config]))
      .digest('hex')
  }

  #previousIsolation(entry: DshPluginEntryRecord, targetKey: string): boolean {
    const previous = this.#repository.getSystemSetting?.(this.#diagnosticKey(entry.id, targetKey))
    const parsed = RuntimeCompatibilityDiagnosticSchema.safeParse(previous?.value)
    if (!parsed.success || parsed.data.status !== 'isolated' || parsed.data.phase === 'dispose') return false
    if (
      parsed.data.runtimeFingerprint !== DSH_RUNTIME_FINGERPRINT ||
      parsed.data.configurationRevision !== this.#configurationRevision(entry)
    )
      return false
    this.#onCompatibilityFailure?.(parsed.data)
    return true
  }

  #diagnose(
    entryId: DshPluginEntryId,
    targetKey: string,
    status: DshPluginDiagnosticRecord['status'],
    phase: DshPluginDiagnosticRecord['phase'],
    error?: unknown,
  ): void {
    if (error instanceof DshPluginCompatibilityError) phase = 'import'
    if (error instanceof DshPluginQuiescenceError) phase = 'dispose'
    this.#repository.upsertDshPluginDiagnostic({
      entryId,
      targetKey,
      status,
      phase,
      ...(error === undefined ? {} : { message: messageOf(error) }),
      observedAt: this.#timestamp(),
    })
    const entry = this.#repository.getDshPluginEntry(entryId)
    if (!entry) return
    const installed = this.#repository.getDshPluginPackage(entry.packageId)
    if (!installed) return
    const diagnostic: RuntimeCompatibilityDiagnostic = {
      objectKind: 'dsh-plugin',
      objectId: entryId,
      objectVersion: installed.packageVersion,
      configurationRevision: this.#configurationRevision(entry),
      runtimeFingerprint: DSH_RUNTIME_FINGERPRINT,
      status: status === 'active' ? 'compatible' : 'isolated',
      phase:
        error instanceof DshPluginCompatibilityError
          ? 'dependency'
          : phase === 'dispose'
            ? 'dispose'
            : phase === 'restore'
              ? 'restore'
              : 'load',
      ...(error === undefined
        ? {}
        : {
            reason:
              error instanceof DshPluginCompatibilityError
                ? error.message
                : '插件加载或释放失败，请检查此插件的诊断；安装和启用记录已保留。',
          }),
      retryable: phase !== 'dispose',
      checkedAt: this.#timestamp(),
    }
    if (this.#repository.getSystemSetting && this.#repository.putSystemSetting) {
      const key = this.#diagnosticKey(entryId, targetKey)
      const previous = this.#repository.getSystemSetting(key)
      this.#repository.putSystemSetting(
        key,
        JsonValueSchema.parse(diagnostic),
        previous?.revision,
        diagnostic.checkedAt,
      )
    }
    if (status !== 'active') this.#onCompatibilityFailure?.(diagnostic)
  }

  async #exclusive<T>(entryId: DshPluginEntryId, operation: () => Promise<T>): Promise<T> {
    const previous = this.#transitions.get(entryId) ?? Promise.resolve()
    const result = previous.catch(() => undefined).then(operation)
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    this.#transitions.set(entryId, tail)
    try {
      return await result
    } finally {
      if (this.#transitions.get(entryId) === tail) this.#transitions.delete(entryId)
    }
  }

  #timestamp(): number {
    const value = this.#now()
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Clock must return a non-negative integer.')
    return value
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error('DSH plugin lifecycle coordinator is disposed.')
  }
}
