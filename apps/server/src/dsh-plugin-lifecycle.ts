import type { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import PluginInventory from '@deepseek-ai/dsh-host-plugin-inventory'
import { JsonValueSchema } from '@nekro-nxt/contracts'
import type {
  AgentId,
  DshPluginActivationRecord,
  DshPluginActivationScope,
  DshPluginDiagnosticRecord,
  DshPluginEntryId,
  DshPluginEntryRecord,
  DshPluginPackageId,
  JsonValue,
} from '@nekro-nxt/contracts'
import type { DshPluginRepository } from '@nekro-nxt/storage-sqlite'

interface OwnedLoader {
  readonly context: Context
  readonly services: Context
  readonly loaderIds: Map<DshPluginEntryId, string>
}

export type DshPluginConfigInspection =
  | { readonly mode: 'schema'; readonly schema: JsonValue }
  | { readonly mode: 'json' }
  | { readonly mode: 'incompatible'; readonly reason: string }

const inventoryEntry = (loader: OwnedLoader, loaderId: string) => {
  const inventory: unknown = loader.services.get('pluginInventory')
  if (!(inventory instanceof PluginInventory)) throw new Error('DSH Plugin Inventory Service 未挂载。')
  return inventory.list().entries.find((candidate) => candidate.entryId === loaderId)
}

export interface DshPluginLifecycleOptions {
  readonly repository: DshPluginRepository
  readonly rootContext: Context
  readonly isolateContext: (context: Context) => Context
  readonly resolveModule: (packageId: DshPluginPackageId, moduleName: string) => string
  readonly listAgentSessions: (agentId: AgentId) => readonly {
    readonly sessionId: string
    readonly context: Context
    readonly waitUntilSafe: () => Promise<void>
  }[]
  readonly now?: () => number
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
  readonly #repository: DshPluginRepository
  readonly #rootContext: Context
  readonly #isolateContext: (context: Context) => Context
  readonly #resolveModule: DshPluginLifecycleOptions['resolveModule']
  readonly #listAgentSessions: DshPluginLifecycleOptions['listAgentSessions']
  readonly #now: () => number
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
        await this.#mount(this.#hostLoader, entry)
        this.#diagnose(entry.id, activation.targetKey, 'active', 'restore')
        restored += 1
      } catch (error) {
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
          await this.#mount(owned, entry)
          this.#diagnose(entry.id, activation.targetKey, 'active', 'restore')
        } catch (error) {
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
    const outcomes = await Promise.allSettled(contexts.map((context) => context.fiber.dispose()))
    const failures = outcomes
      .filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
      .map((outcome): unknown => outcome.reason)
    if (failures.length) throw new AggregateError(failures, 'DSH plugin Loader disposal failed.')
  }

  async #mount(loader: OwnedLoader, entry: DshPluginEntryRecord): Promise<void> {
    if (loader.loaderIds.has(entry.id)) return
    const packageRecord = this.#repository.getDshPluginPackage(entry.packageId)
    if (!packageRecord) throw new Error(`DSH 插件包不存在：${entry.packageId}`)
    const name = this.#resolveModule(packageRecord.id, entry.moduleName)
    const loaderId = await loader.services.loader.create({ name, config: entry.config })
    await loader.services.loader.await()
    const observed = inventoryEntry(loader, loaderId)
    if (!observed?.enabled || observed.fiberPhase !== 'active') {
      await loader.services.loader.remove(loaderId).catch(() => undefined)
      throw new Error(`DSH Loader Inventory 未确认入口进入 active：${entry.entryKey}`)
    }
    const configInspection = serializedConfigSchema(loader.services.loader.resolve(loaderId).fiber?.runtime?.Config)
    if (configInspection.mode === 'incompatible') {
      await loader.services.loader.remove(loaderId)
      await loader.services.loader.await()
      throw new Error(configInspection.reason)
    }
    loader.loaderIds.set(entry.id, loaderId)
  }

  async #mountOrUpdate(loader: OwnedLoader, entry: DshPluginEntryRecord): Promise<void> {
    const loaderId = loader.loaderIds.get(entry.id)
    if (!loaderId) return this.#mount(loader, entry)
    await loader.services.loader.update(loaderId, { config: entry.config })
    await loader.services.loader.await()
    const observed = inventoryEntry(loader, loaderId)
    if (!observed?.enabled || observed.fiberPhase !== 'active') {
      throw new Error(`DSH Loader Inventory 未确认入口更新后保持 active：${entry.entryKey}`)
    }
  }

  async #unmount(loader: OwnedLoader, entryId: DshPluginEntryId): Promise<void> {
    const loaderId = loader.loaderIds.get(entryId)
    if (!loaderId) return
    await loader.services.loader.remove(loaderId)
    await loader.services.loader.await()
    loader.loaderIds.delete(entryId)
  }

  #requireEntry(entryId: DshPluginEntryId): DshPluginEntryRecord {
    const entry = this.#repository.getDshPluginEntry(entryId)
    if (!entry) throw new Error(`DSH 插件入口不存在：${entryId}`)
    return entry
  }

  async #createLoader(context: Context): Promise<OwnedLoader> {
    await context.plugin(Loader, { baseUrl: import.meta.url })
    await context.plugin(PluginInventory)
    let services: Context | undefined
    await context.registry.inject(['loader', 'pluginInventory'], (injected) => {
      services = injected
    })
    if (!services) throw new Error('DSH Loader Service 注入未完成。')
    return { context, services, loaderIds: new Map() }
  }

  #diagnose(
    entryId: DshPluginEntryId,
    targetKey: string,
    status: DshPluginDiagnosticRecord['status'],
    phase: DshPluginDiagnosticRecord['phase'],
    error?: unknown,
  ): void {
    this.#repository.upsertDshPluginDiagnostic({
      entryId,
      targetKey,
      status,
      phase,
      ...(error === undefined ? {} : { message: messageOf(error) }),
      observedAt: this.#timestamp(),
    })
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
