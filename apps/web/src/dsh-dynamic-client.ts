import { callHostApi } from './host-api-client.js'
import * as Cordis from '@deepseek-ai/cordis'
import { Context, Service, type Fiber, type Plugin } from '@deepseek-ai/cordis'
import clientRunnerBundle from '@deepseek-ai/dsh-cordis-client-runner/client?raw'
import type {
  ApprovalRequestId,
  CordisRunHostSeam,
  DynamicCordisLivePackage,
} from '@deepseek-ai/dsh-cordis-client-runner/client'
import clientModulesBundle from '@deepseek-ai/dsh-client-modules/client?raw'
import clientUiRendererBundle from '@deepseek-ai/dsh-client-ui-renderer/client?raw'
import * as SlotModule from '@deepseek-ai/dsh-client-ui-slots'
import { DSH_RUNTIME_FINGERPRINT } from '@nekro-nxt/dsh-compat/release'
import {
  DshCredentialsChangedSseDataSchema,
  DshSettingsChangedSseDataSchema,
  HostPageContributionSchema,
  HostApiContracts,
  HostUiNavigationModelSchema,
  parseJsonValue,
  type HostPageContribution,
  type HostUiKitComponentName,
  type HostUiPageGeometryEvidence,
  type HostUiPermissionDeclaration,
  type HostApiResponse,
  type PanelContribution,
} from '@nekro-nxt/contracts'
import type { HostUiNavigationProvider, HostUiPageProps } from '@nekro-nxt/extension-sdk'
import * as React from 'react'
import * as ReactDom from 'react-dom'
import * as ReactDomClient from 'react-dom/client'
import * as ReactJsxRuntime from 'react/jsx-runtime'
import type { ReactNode } from 'react'
import {
  requireApprovalRequestId,
  requireClientPluginHandoff,
  requireConstructorExport,
  requireCordisPlugin,
  requireModuleRecord,
  requireProductSlotComponent,
  requireSlotRegistry,
  type ClientPluginHandoff,
  type SlotRegistryFace,
} from './dsh-interop/unsafe.js'
import { productHostEventStream, type HostEventStream } from './host-event-stream.js'
import { createExtensionData } from './extension-ui/data.js'
import { ContributionRegistry, type ContributionOwner } from './extension-ui/registry.js'
import { extensionUiKit } from './extension-ui/ui-kit.js'
import type { ProductRuntime } from './product-runtime.js'

export interface DynamicHostPageEntry {
  readonly pluginId: string
  readonly page: HostPageContribution
  readonly component: (props: HostUiPageProps) => ReactNode
  readonly navigation?: HostUiNavigationProvider
  readonly usedUiComponents: () => readonly HostUiKitComponentName[]
  readonly recordUiComponents: (components: readonly HostUiKitComponentName[]) => void
  readonly pageGeometry: () => HostUiPageGeometryEvidence | undefined
  readonly recordPageGeometry: (geometry: HostUiPageGeometryEvidence) => void
}

/**
 * Which dynamic plugin a Cordis fiber belongs to. The loader names each package's fiber `dyn/<pluginId>` and records
 * the names it created; a Service method walks its traced caller (`this.ctx`) up to the nearest such fiber.
 */
class DynamicAttribution {
  readonly #names = new Set<string>()

  bind(moduleName: string): void {
    this.#names.add(moduleName)
  }

  release(moduleName: string): void {
    this.#names.delete(moduleName)
  }

  pluginOf(context: Context): string {
    let fiber: unknown = context.fiber
    for (let depth = 0; depth < 16 && typeof fiber === 'object' && fiber !== null; depth += 1) {
      const name: unknown = Reflect.get(fiber, 'name')
      if (typeof name === 'string' && this.#names.has(name)) return name.slice('dyn/'.length)
      const parent: unknown = Reflect.get(fiber, 'parent')
      const next: unknown = typeof parent === 'object' && parent !== null ? Reflect.get(parent, 'fiber') : undefined
      if (next === fiber) break
      fiber = next
    }
    throw new Error('无法识别注册界面的动态扩展。')
  }
}

interface DynamicServiceConfig {
  readonly attribution: DynamicAttribution
  readonly owner: (pluginId: string) => ContributionOwner
  readonly registry: ContributionRegistry
  readonly data: (pluginId: string) => ReturnType<typeof createExtensionData>
}

/**
 * V6 services of the preview context. They are built per runtime and close over their dependencies: Cordis treats a
 * plugin config as data, so live objects must not travel through it.
 */
const createDynamicServices = (config: DynamicServiceConfig) => {
  const ownerOf = (context: Context) => config.owner(config.attribution.pluginOf(context))
  class PanelsService extends Service {
    constructor(context: Context) {
      super(context, 'panels')
    }
    register(declaration: unknown, component: unknown): () => void {
      const dispose = config.registry.addPanel(ownerOf(this.ctx), declaration, component)
      this.ctx.effect(() => dispose, 'nekro-nxt: dynamic panel')
      return dispose
    }
  }
  class ToolViewsService extends Service {
    constructor(context: Context) {
      super(context, 'toolViews')
    }
    register(tool: unknown, component: unknown): () => void {
      const dispose = config.registry.addToolView(ownerOf(this.ctx), tool, component)
      this.ctx.effect(() => dispose, 'nekro-nxt: dynamic tool view')
      return dispose
    }
  }
  class MessageRenderersService extends Service {
    constructor(context: Context) {
      super(context, 'messageRenderers')
    }
    register(richKind: unknown, component: unknown): () => void {
      const dispose = config.registry.addMessageRenderer(ownerOf(this.ctx), richKind, component)
      this.ctx.effect(() => dispose, 'nekro-nxt: dynamic message renderer')
      return dispose
    }
  }
  /** Data hooks gated by the permissions the candidate declared (the same the saved Revision gets). */
  class DataService extends Service {
    constructor(context: Context) {
      super(context, 'data')
    }
    useAgent(agentId: string) {
      return config.data(config.attribution.pluginOf(this.ctx)).useAgent(agentId)
    }
    useChannel(channelId: string) {
      return config.data(config.attribution.pluginOf(this.ctx)).useChannel(channelId)
    }
    useConnection(connectionId: string) {
      return config.data(config.attribution.pluginOf(this.ctx)).useConnection(connectionId)
    }
    useChannelRuntime(channelId: string) {
      return config.data(config.attribution.pluginOf(this.ctx)).useChannelRuntime(channelId)
    }
  }
  class PagesService extends DynamicHostPagesRegistry {
    constructor(context: Context) {
      super(context, config.attribution)
    }
  }
  return { PanelsService, ToolViewsService, MessageRenderersService, DataService, PagesService }
}

class DynamicHostPagesRegistry extends Service {
  private readonly pageEntries = new Map<string, DynamicHostPageEntry>()
  private readonly pageListeners = new Set<() => void>()
  private pageRevision = 0
  private readonly attribution: DynamicAttribution

  constructor(context: Context, attribution: DynamicAttribution) {
    super(context, 'pages')
    this.attribution = attribution
  }

  subscribe = (listener: () => void): (() => void) => {
    this.pageListeners.add(listener)
    return () => this.pageListeners.delete(listener)
  }

  version = (): number => this.pageRevision

  entries(): readonly DynamicHostPageEntry[] {
    return [...this.pageEntries.values()]
  }

  register(options: unknown, component: unknown): () => void {
    const optionsRecord = requireModuleRecord(options, 'Dynamic Host page registration')
    const page = HostPageContributionSchema.parse(optionsRecord['page'])
    const pageComponent = requireProductSlotComponent<HostUiPageProps>(component, `Dynamic Host page ${page.entryId}`)
    if (this.pageEntries.has(page.entryId)) throw new Error(`页面入口重复注册：${page.entryId}`)
    if (this.pageEntries.size >= 8) throw new Error('一个 Revision 最多注册 8 个顶级页面。')
    const navigationValue = optionsRecord['navigation']
    let navigation: HostUiNavigationProvider | undefined
    if (navigationValue !== undefined) {
      const navigationRecord = requireModuleRecord(navigationValue, `Dynamic Host page ${page.entryId} navigation`)
      const getSnapshot = navigationRecord['getSnapshot']
      const subscribe = navigationRecord['subscribe']
      if (typeof getSnapshot !== 'function' || typeof subscribe !== 'function') {
        throw new Error(`页面 ${page.entryId} 的 navigation Provider 无效。`)
      }
      let navigationSnapshot = HostUiNavigationModelSchema.parse(Reflect.apply(getSnapshot, navigationValue, []))
      const parsedNavigation: HostUiNavigationProvider = {
        getSnapshot: () => navigationSnapshot,
        subscribe: (listener) => {
          const dispose: unknown = Reflect.apply(subscribe, navigationValue, [
            () => {
              navigationSnapshot = HostUiNavigationModelSchema.parse(Reflect.apply(getSnapshot, navigationValue, []))
              listener()
            },
          ])
          if (typeof dispose !== 'function') throw new Error(`页面 ${page.entryId} 的 navigation 订阅无效。`)
          return () => void Reflect.apply(dispose, navigationValue, [])
        },
      }
      navigation = parsedNavigation
    }
    const usedUiComponents = new Set<HostUiKitComponentName>()
    let pageGeometry: HostUiPageGeometryEvidence | undefined
    const entry: DynamicHostPageEntry = {
      pluginId: this.attribution.pluginOf(this.ctx),
      page,
      component: pageComponent,
      ...(navigation === undefined ? {} : { navigation }),
      usedUiComponents: () => [...usedUiComponents],
      recordUiComponents: (components) => {
        usedUiComponents.clear()
        for (const component of components) usedUiComponents.add(component)
      },
      pageGeometry: () => pageGeometry,
      recordPageGeometry: (geometry) => {
        pageGeometry = geometry
      },
    }
    this.pageEntries.set(page.entryId, entry)
    this.publishPages()
    let active = true
    const dispose = () => {
      if (!active) return
      active = false
      if (this.pageEntries.get(page.entryId) === entry) this.pageEntries.delete(page.entryId)
      this.publishPages()
    }
    this.ctx.effect(() => dispose, `nekro-nxt: Dynamic Host page ${page.entryId}`)
    return dispose
  }

  clear(): void {
    if (this.pageEntries.size === 0) return
    this.pageEntries.clear()
    this.publishPages()
  }

  private publishPages(): void {
    this.pageRevision += 1
    for (const listener of this.pageListeners) listener()
  }
}

interface ClientModuleSystemFace {
  import(specifier: string): Promise<unknown>
  prefetch(id: string): Promise<void>
  invalidate(id: string): void
}

interface ClientModuleRegistrationTarget {
  mode: 'queue' | 'live'
  pendingQueue: ClientPluginHandoff[]
  load(registration: unknown): void
}

interface BrowserDynamicLoaderEntry {
  readonly fiber: Fiber
  readonly name: string
}

interface BrowserDynamicLoaderFace {
  create(options: { readonly name: string }): Promise<string>
  resolve(id: string): BrowserDynamicLoaderEntry
  remove(id: string): Promise<void>
}

/**
 * Browser-only subset of the Cordis Loader used by DSH's dynamic Client
 * runner. The published full Loader owns Node config/import machinery and
 * therefore cannot be bundled into the Web shell. Dynamic packages already
 * arrive through the official ClientModuleSystem, so this seam only turns one
 * module-table entry into a Cordis Fiber and disposes that Fiber on retract.
 */
class BrowserDynamicLoader implements BrowserDynamicLoaderFace {
  readonly #context: Context
  readonly #modules: ClientModuleSystemFace
  readonly #attribution: DynamicAttribution
  readonly #entries = new Map<string, BrowserDynamicLoaderEntry>()
  #sequence = 0

  constructor(context: Context, modules: ClientModuleSystemFace, attribution: DynamicAttribution) {
    this.#context = context
    this.#modules = modules
    this.#attribution = attribution
  }

  async create(options: { readonly name: string }): Promise<string> {
    const exported = await this.#modules.import(options.name)
    const plugin =
      typeof exported === 'object' && exported !== null && 'default' in exported ? exported['default'] : exported
    const id = `dynamic-client-entry-${++this.#sequence}`
    const fiber = this.#context.plugin(requireCordisPlugin(plugin, `DSH Client module ${options.name}`))
    // The runner names each package's module (and so its fiber) `dyn/<pluginId>`.
    this.#attribution.bind(options.name)
    this.#entries.set(id, { fiber, name: options.name })
    return id
  }

  resolve(id: string): BrowserDynamicLoaderEntry {
    const entry = this.#entries.get(id)
    if (!entry) throw new Error(`Dynamic Client loader entry is unavailable: ${id}`)
    return entry
  }

  async remove(id: string): Promise<void> {
    const entry = this.#entries.get(id)
    if (!entry) return
    this.#entries.delete(id)
    await entry.fiber.dispose()
    if (![...this.#entries.values()].some((other) => other.name === entry.name)) this.#attribution.release(entry.name)
  }
}

interface ClientModuleSystemConstructor {
  new (options: {
    readonly manifest: {
      readonly rev: string
      readonly modules: readonly unknown[]
      readonly plugins: readonly unknown[]
    }
    readonly staticModules: Readonly<Record<string, unknown>>
    readonly registrationTarget: ClientModuleRegistrationTarget
    readonly bootstrapModule: {
      readonly id: string
      readonly exports: Record<string, unknown>
    }
    readonly loadBundle: (url: string) => Promise<void>
  }): ClientModuleSystemFace
}

interface DynamicPackageRunnerFace {
  readonly renderFailures: unknown
  load(half: unknown): Promise<unknown>
  retract(pluginId: string, pluginRunId: string): void
  subscribe(listener: () => void): () => void
  getSnapshot(): readonly DynamicCordisLivePackage[]
  isLoaded(pluginId: string): boolean
  dispose(): Promise<void>
}

interface DynamicPackageRunnerConstructor {
  new (environment: {
    readonly ctx: Context
    readonly loader: BrowserDynamicLoaderFace
    readonly modules: ClientModuleSystemFace
    readonly slots: SlotRegistryFace
    readonly invoke: (pluginId: string, pluginRunId: string, method: string, args: unknown) => Promise<unknown>
    readonly reportRenderFailure: (agentId: string, pluginId: string, pluginRunId: string, failure: unknown) => void
    readonly reportGuardFailure: (agentId: string, pluginId: string, pluginRunId: string, failure: unknown) => void
  }): DynamicPackageRunnerFace
}

interface RunOrchestratorFace {
  readonly lastRunError: {
    getSnapshot(): ReadonlyMap<
      string,
      { readonly reason: string; readonly message?: string; readonly stack?: string; readonly packageId: string }
    >
    subscribe(listener: () => void): () => void
  }
  reconcileApprovals(rows: readonly DynamicInventoryRow[]): void
  approve(requestId: ApprovalRequestId, approveFutureVersions: boolean): Promise<void>
  decline(requestId: ApprovalRequestId): Promise<void>
}

interface RunOrchestratorConstructor {
  new (environment: {
    readonly runner: DynamicPackageRunnerFace
    readonly host: CordisRunHostSeam
  }): RunOrchestratorFace
}

const staticObservable = <T>(snapshot: T) => ({
  getSnapshot: (): T => snapshot,
  subscribe: (): (() => void) => () => undefined,
})

interface RemoteBridgeFace {
  $on(event: string, listener: (...args: unknown[]) => void): () => void
}

class DshRemoteBridge implements RemoteBridgeFace {
  readonly #listeners = new Map<string, Set<(...args: unknown[]) => void>>()

  $on(event: string, listener: (...args: unknown[]) => void): () => void {
    const listeners = this.#listeners.get(event) ?? new Set()
    listeners.add(listener)
    this.#listeners.set(event, listeners)
    return () => listeners.delete(listener)
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.#listeners.get(event) ?? []) listener(...args)
  }
}

const rpcOk = <T>(value: T) => ({ rpcId: 'nekro-nxt-dsh-bridge', result: { ok: true as const, value } })

const parseDshSettingsChangedEvent = (text: string) => {
  try {
    return DshSettingsChangedSseDataSchema.parse(parseJsonValue(JSON.parse(text)))
  } catch {
    return undefined
  }
}

const parseDshCredentialsChangedEvent = (text: string) => {
  try {
    return DshCredentialsChangedSseDataSchema.parse(parseJsonValue(JSON.parse(text)))
  } catch {
    return undefined
  }
}

const unsupportedRemoteError = (): Error & { code: 'unsupported-remote' } =>
  Object.assign(new Error('DSH 原生界面请求了当前桥接未支持的 Remote。'), {
    code: 'unsupported-remote' as const,
  })

const createDshConnectionBridge = () => ({
  isLoopback: true,
  api: {
    settings: {
      describe: async () => {
        const response = await callHostApi(HostApiContracts.dshSettings, {}, undefined)
        return rpcOk({
          writable: response.namespaces.every((namespace) => namespace.writable !== false),
          hasDocument: true,
          namespaces: response.namespaces.map((namespace) => ({
            ns: namespace.ns,
            schema: namespace.schema,
            value: namespace.resolved,
            ...(namespace.base === undefined ? {} : { base: namespace.base }),
            ...(namespace.user === undefined ? {} : { user: namespace.user }),
            applies: namespace.applies,
            secrets: namespace.secrets,
            revision: namespace.revision,
          })),
        })
      },
      mutate: async (payload: {
        readonly ns: string
        readonly ops: readonly unknown[]
        readonly expectedRevision?: number
      }) => {
        const value = await callHostApi(
          HostApiContracts.dshSettingsMutate,
          { namespace: payload.ns },
          HostApiContracts.dshSettingsMutate.parseRequest({
            expectedRevision: payload.expectedRevision ?? 0,
            ops: payload.ops,
          }),
        )
        return rpcOk({
          ns: value.ns,
          schema: value.schema,
          value: value.resolved,
          ...(value.base === undefined ? {} : { base: value.base }),
          ...(value.user === undefined ? {} : { user: value.user }),
          applies: value.applies,
          secrets: value.secrets,
          revision: value.revision,
        })
      },
    },
    credentials: {
      describe: async (payload: { readonly refs: readonly string[] }) =>
        rpcOk(await callHostApi(HostApiContracts.dshCredentialsDescribe, {}, { refs: [...payload.refs] })),
      set: async (payload: { readonly ref: string; readonly value: string }) => {
        await callHostApi(HostApiContracts.dshCredentialSet, { ref: payload.ref }, { value: payload.value })
        return rpcOk({})
      },
      unset: async (payload: { readonly ref: string }) => {
        await callHostApi(HostApiContracts.dshCredentialUnset, { ref: payload.ref }, undefined)
        return rpcOk({})
      },
    },
  },
  hostDescription: staticObservable(undefined),
  rpc: {
    call: () => Promise.reject(unsupportedRemoteError()),
  },
  start: () => {
    throw new Error('NekroNxt DSH Bridge 不开放完整 DSH Connection stream。')
  },
})

interface DynamicClientModules {
  readonly ClientModuleSystem: ClientModuleSystemConstructor
  readonly uiRenderer: Plugin
  readonly DynamicCordisPackageRunner: DynamicPackageRunnerConstructor
  readonly CordisRunOrchestrator: RunOrchestratorConstructor
}

type DynamicInventoryResponseRow = HostApiResponse<'dynamicInventory'>['rows'][number]
type DynamicInventoryLatestRun = NonNullable<DynamicInventoryResponseRow['latestRun']>

export type DynamicInventoryRow = Pick<
  DynamicInventoryResponseRow,
  'pluginId' | 'agentId' | 'packages' | 'activeRun'
> & {
  readonly latestRun?: Pick<
    DynamicInventoryLatestRun,
    'pluginRunId' | 'packageId' | 'mode' | 'status' | 'approvalRequestId' | 'requiresApproval'
  > &
    Partial<Pick<DynamicInventoryLatestRun, 'host' | 'client' | 'error'>>
}

/** What the Host returns for one candidate's Client, plus the permissions it declared. */
export type DynamicClientSource = Awaited<ReturnType<CordisRunHostSeam['getClientCode']>> & {
  readonly permissions?: HostUiPermissionDeclaration
}

/** What the browser actually rendered for one candidate; the Host builds the saved Manifest from it. */
export interface DynamicClientEvidence {
  readonly renderedPanels: readonly PanelContribution[]
  readonly renderedToolViews: readonly string[]
  readonly renderedMessageRenderers: readonly string[]
  readonly renderedPages: readonly HostPageContribution[]
  readonly usedUiComponents: readonly HostUiKitComponentName[]
  readonly pageGeometry: readonly HostUiPageGeometryEvidence[]
  readonly navigationEntries: readonly string[]
}

export interface DynamicClientHostPort extends CordisRunHostSeam {
  getClientCode(agentId: string, pluginId: string, pluginRunId: string): Promise<DynamicClientSource>
  invoke(pluginId: string, pluginRunId: string, method: string, args: unknown): Promise<unknown>
  reportRenderFailure(agentId: string, pluginId: string, pluginRunId: string, failure: unknown): Promise<void>
  reportGuardFailure(agentId: string, pluginId: string, pluginRunId: string, failure: unknown): Promise<void>
  reportClientVerification(
    agentId: string,
    pluginId: string,
    packageId: string,
    pluginRunId: string,
    evidence: DynamicClientEvidence,
  ): Promise<void>
}

const evaluateClientBundle = (source: string, moduleWindow: Record<string, unknown>, documentValue: unknown): void => {
  // The published DSH Client export is a classic ModuleLoader registration bundle, not a normal ESM module.
  // Dynamic Cordis already requires closure evaluation; this executes only the exact lockfile-pinned trusted bundle.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- DSH publishes this exact Client entry as a classic registration bundle.
  const evaluate = new Function('window', 'document', source)
  Reflect.apply(evaluate, undefined, [moduleWindow, documentValue])
}

const captureBootstrapModule = (
  source: string,
  moduleWindow: Record<string, unknown>,
  documentValue: unknown,
): { readonly handoff: ClientPluginHandoff; readonly exports: Record<string, unknown> } => {
  let captured: ClientPluginHandoff | undefined
  moduleWindow['__ModuleLoader__'] = {
    load: (handoff: unknown) => {
      if (captured) throw new Error('DSH bootstrap bundle registered more than one module.')
      captured = requireClientPluginHandoff(handoff)
    },
  }
  evaluateClientBundle(source, moduleWindow, documentValue)
  if (!captured) throw new Error('DSH bootstrap bundle did not register its module.')
  const handoff = captured
  const exports = handoff.factory((specifier: string) => {
    throw new Error(`DSH bootstrap module unexpectedly required: ${specifier}`)
  })
  return { handoff, exports }
}

const createRegistrationTarget = (): ClientModuleRegistrationTarget => {
  const target: ClientModuleRegistrationTarget = {
    mode: 'queue',
    pendingQueue: [],
    load(registration: unknown) {
      if (target.mode !== 'queue') {
        throw new Error('DSH Client registration target did not install its live loader.')
      }
      target.pendingQueue.push(requireClientPluginHandoff(registration))
    },
  }
  return target
}

const loadDynamicClientModules = async (
  documentValue: unknown,
): Promise<{
  readonly modules: DynamicClientModules
  readonly moduleSystem: ClientModuleSystemFace
  readonly moduleLoader: ClientModuleRegistrationTarget
}> => {
  const moduleWindow = requireModuleRecord(globalThis, 'DSH Client global')
  if (moduleWindow['__ModuleLoader__']) {
    throw new Error('A DSH Client module loader is already installed in this page.')
  }
  try {
    const bootstrap = captureBootstrapModule(clientModulesBundle, moduleWindow, documentValue)
    const ClientModuleSystem = requireConstructorExport<ClientModuleSystemConstructor>(
      bootstrap.exports,
      'ClientModuleSystem',
      ['import', 'prefetch', 'invalidate'],
    )
    const registrationTarget = createRegistrationTarget()
    moduleWindow['__ModuleLoader__'] = registrationTarget
    const moduleSystem = new ClientModuleSystem({
      manifest: { rev: DSH_RUNTIME_FINGERPRINT, modules: [], plugins: [] },
      staticModules: {
        react: React,
        'react/jsx-runtime': ReactJsxRuntime,
        '@deepseek-ai/cordis': Cordis,
        'react-dom': ReactDom,
        'react-dom/client': ReactDomClient,
        '@deepseek-ai/dsh-client-ui-slots': SlotModule,
      },
      registrationTarget,
      bootstrapModule: { id: bootstrap.handoff.id, exports: bootstrap.exports },
      loadBundle: () => Promise.reject(new Error('Unexpected external DSH Client bundle load.')),
    })
    evaluateClientBundle(clientUiRendererBundle, moduleWindow, documentValue)
    evaluateClientBundle(clientRunnerBundle, moduleWindow, documentValue)
    const uiRenderer = requireCordisPlugin(
      await moduleSystem.import('@deepseek-ai/dsh-client-ui-renderer'),
      'DSH Client UI renderer',
    )
    const runner = requireModuleRecord(
      await moduleSystem.import('@deepseek-ai/dsh-cordis-client-runner'),
      'DSH Cordis Client Runner module',
    )
    const DynamicCordisPackageRunner = requireConstructorExport<DynamicPackageRunnerConstructor>(
      runner,
      'DynamicCordisPackageRunner',
      ['load', 'retract', 'subscribe', 'getSnapshot', 'isLoaded', 'dispose'],
    )
    const CordisRunOrchestrator = requireConstructorExport<RunOrchestratorConstructor>(
      runner,
      'CordisRunOrchestrator',
      ['reconcileApprovals', 'approve', 'decline'],
    )
    return {
      moduleSystem,
      moduleLoader: registrationTarget,
      modules: { ClientModuleSystem, uiRenderer, DynamicCordisPackageRunner, CordisRunOrchestrator },
    }
  } catch (error) {
    Reflect.deleteProperty(moduleWindow, '__ModuleLoader__')
    throw error
  }
}

/** Gate late network responses and wait until all accepted work has settled. */
class ClientLifecycle {
  #closed = false
  #approvalRequests = new Set<string>()
  readonly #pending = new Set<Promise<unknown>>()

  assertActive(): void {
    if (this.#closed) throw new Error('DSH Client Runtime is disposed.')
  }

  setInventory(rows: readonly DynamicInventoryRow[]): void {
    this.#approvalRequests = new Set(
      rows.flatMap((row) => (row.latestRun?.approvalRequestId ? [row.latestRun.approvalRequestId] : [])),
    )
  }

  hasApproval(requestId: string): boolean {
    return this.#approvalRequests.has(requestId)
  }

  run<T>(operation: () => Promise<T>, current: () => boolean = () => true): Promise<T> {
    const pending = Promise.resolve().then(async () => {
      this.assertActive()
      if (!current()) throw new Error('动态审批已失效。')
      const result = await operation()
      this.assertActive()
      if (!current()) throw new Error('动态审批已失效。')
      return result
    })
    this.#pending.add(pending)
    void pending.then(
      () => this.#pending.delete(pending),
      () => this.#pending.delete(pending),
    )
    return pending
  }

  close(): void {
    this.#closed = true
  }

  async drain(): Promise<void> {
    while (this.#pending.size > 0) await Promise.allSettled([...this.#pending])
  }
}

const scopedHost = (host: DynamicClientHostPort, lifecycle: ClientLifecycle): DynamicClientHostPort => ({
  runHostHalf: (...args) =>
    lifecycle.run(
      () => host.runHostHalf(...args),
      () => args[4] === null || lifecycle.hasApproval(args[4]),
    ),
  getClientCode: (...args) => lifecycle.run(() => host.getClientCode(...args)),
  resolveRequestRun: (...args) =>
    lifecycle.run(
      () => host.resolveRequestRun(...args),
      () => lifecycle.hasApproval(args[0]),
    ),
  settleUserRun: (...args) => lifecycle.run(() => host.settleUserRun(...args)),
  invoke: (...args) => lifecycle.run(() => host.invoke(...args)),
  reportRenderFailure: (...args) => lifecycle.run(() => host.reportRenderFailure(...args)),
  reportGuardFailure: (...args) => lifecycle.run(() => host.reportGuardFailure(...args)),
  reportClientVerification: (...args) => lifecycle.run(() => host.reportClientVerification(...args)),
})

interface DynamicPackageMeta {
  readonly agentId?: string
  readonly name?: string
  readonly permissions?: HostUiPermissionDeclaration
}

const NO_PERMISSIONS: HostUiPermissionDeclaration = { permissions: [], networkOrigins: [] }

/**
 * Single browser owner for NekroNXT dynamic Client Packages. Candidates register V6 contributions into a private
 * preview registry (never into the installed shell); the workshop preview renders and verifies them.
 */
export class DshClientRuntime {
  readonly slots: SlotRegistryFace
  readonly pages: DynamicHostPagesRegistry
  readonly previews: ContributionRegistry
  readonly #dynamicContext: Context
  readonly #runner: DynamicPackageRunnerFace
  readonly #orchestrator: RunOrchestratorFace
  readonly #unsubscribeHostEvents: () => void
  readonly #host: DynamicClientHostPort
  readonly #moduleLoader: ClientModuleRegistrationTarget
  readonly #packages: Map<string, DynamicPackageMeta>
  readonly #pluginByApprovalRequest = new Map<string, string>()
  #disposed = false
  #disposePromise: Promise<void> | undefined
  #queue: Promise<void> = Promise.resolve()
  #inventoryRevision = 0
  readonly #lifecycle: ClientLifecycle

  private constructor(input: {
    readonly dynamicContext: Context
    readonly slots: SlotRegistryFace
    readonly pages: DynamicHostPagesRegistry
    readonly previews: ContributionRegistry
    readonly packages: Map<string, DynamicPackageMeta>
    readonly runner: DynamicPackageRunnerFace
    readonly orchestrator: RunOrchestratorFace
    readonly unsubscribeHostEvents: () => void
    readonly host: DynamicClientHostPort
    readonly moduleLoader: ClientModuleRegistrationTarget
    readonly lifecycle: ClientLifecycle
  }) {
    this.#dynamicContext = input.dynamicContext
    this.slots = input.slots
    this.pages = input.pages
    this.previews = input.previews
    this.#packages = input.packages
    this.#runner = input.runner
    this.#orchestrator = input.orchestrator
    this.#unsubscribeHostEvents = input.unsubscribeHostEvents
    this.#host = input.host
    this.#moduleLoader = input.moduleLoader
    this.#lifecycle = input.lifecycle
  }

  static async create(
    host: DynamicClientHostPort,
    store: ProductRuntime['store'],
    documentValue: unknown = document,
    events: HostEventStream = productHostEventStream,
  ): Promise<DshClientRuntime> {
    const { modules, moduleSystem, moduleLoader } = await loadDynamicClientModules(documentValue)
    const dynamicContext = new Context()
    const lifecycle = new ClientLifecycle()
    const packages = new Map<string, DynamicPackageMeta>()
    const remember = (pluginId: string, meta: DynamicPackageMeta) =>
      packages.set(pluginId, { ...packages.get(pluginId), ...meta })
    const port = host
    const capturing: DynamicClientHostPort = {
      runHostHalf: (...args) => port.runHostHalf(...args),
      resolveRequestRun: (...args) => port.resolveRequestRun(...args),
      settleUserRun: (...args) => port.settleUserRun(...args),
      invoke: (...args) => port.invoke(...args),
      reportRenderFailure: (...args) => port.reportRenderFailure(...args),
      reportGuardFailure: (...args) => port.reportGuardFailure(...args),
      reportClientVerification: (...args) => port.reportClientVerification(...args),
      getClientCode: async (agentId, pluginId, pluginRunId) => {
        const source = await port.getClientCode(agentId, pluginId, pluginRunId)
        remember(source.pluginId, {
          agentId,
          name: source.name,
          permissions: source.permissions ?? NO_PERMISSIONS,
        })
        return source
      },
    }
    host = scopedHost(capturing, lifecycle)
    const attribution = new DynamicAttribution()
    const previews = new ContributionRegistry()
    const owner = (pluginId: string): ContributionOwner => {
      const meta = packages.get(pluginId)
      return {
        kind: 'dynamic',
        key: `dynamic:${pluginId}`,
        label: meta?.name ?? '预览',
        agentId: meta?.agentId ?? '',
        pluginId,
        styleScope: 'dynamic-preview',
      }
    }
    const dataByPlugin = new Map<string, ReturnType<typeof createExtensionData>>()
    const data = (pluginId: string) => {
      let hooks = dataByPlugin.get(pluginId)
      if (!hooks) {
        hooks = createExtensionData(store, new Set(packages.get(pluginId)?.permissions?.permissions ?? []))
        dataByPlugin.set(pluginId, hooks)
      }
      return hooks
    }
    let createdRunner: DynamicPackageRunnerFace | undefined
    let unsubscribeHostEvents: (() => void) | undefined
    try {
      const dynamicLoader = new BrowserDynamicLoader(dynamicContext, moduleSystem, attribution)
      const services = createDynamicServices({ attribution, owner, registry: previews, data })
      await dynamicContext.plugin(services.PagesService)
      const pagesValue: unknown = dynamicContext.get('pages')
      if (!(pagesValue instanceof DynamicHostPagesRegistry)) throw new Error('Dynamic Host pages Service 未挂载。')
      const pages = pagesValue
      await dynamicContext.plugin(services.PanelsService)
      await dynamicContext.plugin(services.ToolViewsService)
      await dynamicContext.plugin(services.MessageRenderersService)
      await dynamicContext.plugin(services.DataService)
      dynamicContext.reflect.provide('ui', extensionUiKit)
      const remote = new DshRemoteBridge()
      const connection = createDshConnectionBridge()
      dynamicContext.reflect.provide('connection', connection)
      dynamicContext.reflect.provide('remote', remote)
      await dynamicContext.plugin(modules.uiRenderer)
      // The renderer installs DSH's SlotRegistry, which the runner requires. NXT never mounts DSH's native WebUI
      // and declares no product Slots: V6 contributions go through the services above.
      const slots = requireSlotRegistry(dynamicContext.get('slots'), 'DSH Dynamic SlotRegistry')
      const runner = new modules.DynamicCordisPackageRunner({
        ctx: dynamicContext,
        loader: dynamicLoader,
        modules: moduleSystem,
        slots,
        invoke: (pluginId, pluginRunId, method, args) => host.invoke(pluginId, pluginRunId, method, args),
        reportRenderFailure: (agentId, pluginId, pluginRunId, failure) => {
          void host.reportRenderFailure(agentId, pluginId, pluginRunId, failure).catch(() => undefined)
        },
        reportGuardFailure: (agentId, pluginId, pluginRunId, failure) => {
          void host.reportGuardFailure(agentId, pluginId, pluginRunId, failure).catch(() => undefined)
        },
      })
      createdRunner = runner
      const orchestrator = new modules.CordisRunOrchestrator({
        host,
        runner: {
          renderFailures: runner.renderFailures,
          load: (half) => lifecycle.run(() => runner.load(half)),
          retract: (pluginId, pluginRunId) => runner.retract(pluginId, pluginRunId),
          subscribe: (listener) => runner.subscribe(listener),
          getSnapshot: () => runner.getSnapshot(),
          isLoaded: (pluginId) => runner.isLoaded(pluginId),
          dispose: () => runner.dispose(),
        },
      })
      unsubscribeHostEvents = events.subscribe({
        'dsh-settings-changed': (event) => {
          if (!(event instanceof MessageEvent) || typeof event.data !== 'string') return
          const value = parseDshSettingsChangedEvent(event.data)
          if (value) remote.emit('settings/document-updated', value.namespace, value.revision)
        },
        'dsh-credentials-changed': (event) => {
          if (!(event instanceof MessageEvent) || typeof event.data !== 'string') return
          const value = parseDshCredentialsChangedEvent(event.data)
          if (value) remote.emit('credentials/updated', value.ref)
        },
      })
      return new DshClientRuntime({
        dynamicContext,
        slots,
        pages,
        previews,
        packages,
        runner,
        orchestrator,
        unsubscribeHostEvents,
        host,
        moduleLoader,
        lifecycle,
      })
    } catch (error) {
      lifecycle.close()
      unsubscribeHostEvents?.()
      await lifecycle.drain()
      try {
        await createdRunner?.dispose()
      } finally {
        await dynamicContext.fiber.dispose()
      }
      if (Reflect.get(globalThis, '__ModuleLoader__') === moduleLoader) {
        Reflect.deleteProperty(globalThis, '__ModuleLoader__')
      }
      throw error
    }
  }

  reconcile(rows: readonly DynamicInventoryRow[]): Promise<void> {
    const revision = ++this.#inventoryRevision
    this.#lifecycle.setInventory(rows)
    return this.#enqueue(() => this.#reconcile(rows, revision))
  }

  async #reconcile(rows: readonly DynamicInventoryRow[], revision: number): Promise<void> {
    this.#assertActive()
    if (revision !== this.#inventoryRevision) return
    this.#pluginByApprovalRequest.clear()
    for (const row of rows) {
      this.#packages.set(row.pluginId, { ...this.#packages.get(row.pluginId), agentId: row.agentId })
      if (row.latestRun?.approvalRequestId) {
        this.#pluginByApprovalRequest.set(row.latestRun.approvalRequestId, row.pluginId)
      }
    }
    this.#orchestrator.reconcileApprovals(rows)
    const activeRuns = new Map(
      rows.flatMap((row) => (row.activeRun ? [[row.pluginId, row.activeRun.pluginRunId]] : [])),
    )
    const retractions: Promise<void>[] = []
    for (const loaded of this.#runner.getSnapshot()) {
      if (activeRuns.get(loaded.pluginId) !== loaded.pluginRunId) {
        retractions.push(this.#retracted(loaded.pluginId))
        this.#runner.retract(loaded.pluginId, loaded.pluginRunId)
      }
    }
    await Promise.all(retractions)
    this.#assertActive()
    if (revision !== this.#inventoryRevision) return
    for (const row of rows) {
      const activeRun = row.activeRun
      if (activeRun === undefined || this.#runner.isLoaded(row.pluginId)) continue
      const activePackage = row.packages.find((candidate) => candidate.packageId === activeRun.packageId)
      if (activePackage === undefined) {
        throw new Error(`动态 Client 恢复失败：运行中的 Package ${activeRun.packageId} 不在 Host 清单中。`)
      }
      if (!activePackage.hasClientHalf) continue
      const source = await this.#host.getClientCode(row.agentId, row.pluginId, activeRun.pluginRunId)
      if (revision !== this.#inventoryRevision) return
      if (
        source.pluginId !== row.pluginId ||
        source.packageId !== activeRun.packageId ||
        source.pluginRunId !== activeRun.pluginRunId
      ) {
        throw new Error(`动态 Client 恢复失败：Host 返回的 Client 源码与当前运行版本不一致。`)
      }
      const loaded = await this.#runner.load({
        pluginId: source.pluginId,
        packageId: source.packageId,
        pluginRunId: source.pluginRunId,
        agentId: row.agentId,
        name: source.name,
        code: source.code,
      })
      if (!loaded || typeof loaded !== 'object' || !('ok' in loaded) || loaded.ok !== true) {
        const message =
          loaded && typeof loaded === 'object' && 'message' in loaded && typeof loaded.message === 'string'
            ? loaded.message
            : '浏览器未能重新加载界面代码。'
        throw new Error(`动态 Client 恢复失败：${message}`)
      }
    }
    await this.#requireContributions()
  }

  approve(requestId: string, approveFutureVersions = false): Promise<void> {
    return this.#enqueue(() => this.#approve(requestId, approveFutureVersions))
  }

  async #approve(requestId: string, approveFutureVersions: boolean): Promise<void> {
    this.#assertActive()
    const pluginId = this.#pluginByApprovalRequest.get(requestId)
    await this.#orchestrator.approve(requireApprovalRequestId(requestId), approveFutureVersions)
    this.#assertActive()
    await this.#requireContributions()
    const failure = pluginId === undefined ? undefined : this.#orchestrator.lastRunError.getSnapshot().get(pluginId)
    if (failure) throw new Error(failure.message ?? `动态 Client ${failure.reason}。`)
  }

  decline(requestId: string): Promise<void> {
    return this.#enqueue(() => this.#orchestrator.decline(requireApprovalRequestId(requestId)))
  }

  loaded(): readonly DynamicCordisLivePackage[] {
    this.#assertActive()
    return this.#runner.getSnapshot()
  }

  /** Agent a loaded candidate belongs to. */
  agentOf(pluginId: string): string | undefined {
    return this.#packages.get(pluginId)?.agentId
  }

  pageEntries(): readonly DynamicHostPageEntry[] {
    this.#assertActive()
    return this.pages.entries()
  }

  subscribePages(listener: () => void): () => void {
    this.#assertActive()
    return this.pages.subscribe(listener)
  }

  async reportRenderFailure(pluginId: string, failure: unknown): Promise<void> {
    this.#assertActive()
    const loaded = this.#runner.getSnapshot().find((candidate) => candidate.pluginId === pluginId)
    const agentId = this.#packages.get(pluginId)?.agentId
    if (!loaded || !agentId) return
    await this.#host.reportRenderFailure(agentId, loaded.pluginId, loaded.pluginRunId, failure)
  }

  async reportVerification(pluginId: string, evidence: DynamicClientEvidence): Promise<void> {
    this.#assertActive()
    const loaded = this.#runner.getSnapshot().find((candidate) => candidate.pluginId === pluginId)
    const agentId = this.#packages.get(pluginId)?.agentId
    if (!loaded || !agentId) return
    await this.#host.reportClientVerification(agentId, loaded.pluginId, loaded.packageId, loaded.pluginRunId, evidence)
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise
    this.#disposed = true
    this.#lifecycle.close()
    this.#unsubscribeHostEvents()
    this.#disposePromise = this.#dispose()
    return this.#disposePromise
  }

  async #dispose(): Promise<void> {
    await this.#queue.catch(() => undefined)
    await this.#lifecycle.drain()
    try {
      await this.#runner.dispose()
    } finally {
      this.pages.clear()
      await this.#dynamicContext.fiber.dispose()
    }
    // Keep ownership until resources are quiet. A failed teardown must not
    // allow a second runtime to reuse a still-live module loader.
    if (Reflect.get(globalThis, '__ModuleLoader__') === this.#moduleLoader) {
      Reflect.deleteProperty(globalThis, '__ModuleLoader__')
    }
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.#queue.then(() => this.#lifecycle.run(operation))
    this.#queue = next.catch(() => undefined)
    return next
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error('DSH Client Runtime is disposed.')
  }

  #retracted(pluginId: string): Promise<void> {
    return new Promise((resolve) => {
      const unsubscribe = this.#runner.subscribe(() => {
        if (this.#runner.isLoaded(pluginId)) return
        unsubscribe()
        resolve()
      })
    })
  }

  /**
   * A candidate Client must contribute through the V6 services: DSH product Slots are not part of NekroNXT, and a
   * Client that registers nothing has nothing to verify.
   */
  async #requireContributions(): Promise<void> {
    for (const loaded of this.#runner.getSnapshot()) {
      const owner = `dynamic:${loaded.pluginId}`
      const registered =
        this.previews.panels().some((entry) => entry.owner.key === owner) ||
        this.previews.toolViews().some((entry) => entry.owner.key === owner) ||
        this.previews.messageRenderers().some((entry) => entry.owner.key === owner) ||
        this.pages.entries().some((entry) => entry.pluginId === loaded.pluginId)
      if (loaded.slots.length === 0 && registered) continue
      const message =
        loaded.slots.length > 0
          ? `Client 注册了 NekroNXT 不支持的 DSH Slot：${loaded.slots.join('、')}。请改用 ctx.panels、ctx.toolViews、ctx.messageRenderers 或 ctx.pages。`
          : 'Client 没有注册任何面板、工具视图、富消息渲染器或页面。'
      const agentId = this.#packages.get(loaded.pluginId)?.agentId
      if (agentId) {
        await this.#host
          .reportGuardFailure(agentId, loaded.pluginId, loaded.pluginRunId, { phase: 'client-slot', message })
          .catch(() => undefined)
      }
      const retracted = this.#retracted(loaded.pluginId)
      this.#runner.retract(loaded.pluginId, loaded.pluginRunId)
      await retracted
      throw new Error(message)
    }
  }
}

/** Backward-compatible name while callers migrate to the shared runtime terminology. */
export { DshClientRuntime as DshDynamicClientRuntime }
