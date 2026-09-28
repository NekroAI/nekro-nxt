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
  HostUiPermissionDeclarationSchema,
  parseJsonValue,
  type HostPageContribution,
  type HostUiKitComponentName,
  type HostUiPageGeometryEvidence,
  type HostUiPermissionDeclaration,
  type HostApiResponse,
} from '@nekro-nxt/contracts'
import type {
  AdapterClientSlotPropsMap,
  HostUiNavigationProvider,
  HostUiPageProps,
  NekroNxtClientSlotName,
  NekroNxtClientSlotPropsMap,
} from '@nekro-nxt/extension-sdk'
import type { AdapterClientSlotName, AgentClientSlotName } from '@nekro-nxt/contracts'
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
import { hostUiKit } from './host-ui-client.js'

export interface DynamicHostPageEntry {
  readonly page: HostPageContribution
  readonly component: (props: HostUiPageProps) => ReactNode
  readonly navigation?: HostUiNavigationProvider
  readonly usedUiComponents: () => readonly HostUiKitComponentName[]
  readonly recordUiComponents: (components: readonly HostUiKitComponentName[]) => void
  readonly pageGeometry: () => HostUiPageGeometryEvidence | undefined
  readonly recordPageGeometry: (geometry: HostUiPageGeometryEvidence) => void
}

class DynamicHostPagesRegistry extends Service {
  private readonly pageEntries = new Map<string, DynamicHostPageEntry>()
  private readonly pageListeners = new Set<() => void>()
  private permissionDeclaration: HostUiPermissionDeclaration = { permissions: [], networkOrigins: [] }
  private pageRevision = 0

  constructor(context: Context) {
    super(context, 'pages')
  }

  subscribe = (listener: () => void): (() => void) => {
    this.pageListeners.add(listener)
    return () => this.pageListeners.delete(listener)
  }

  version = (): number => this.pageRevision

  entries(): readonly DynamicHostPageEntry[] {
    return [...this.pageEntries.values()]
  }

  permissions(): HostUiPermissionDeclaration {
    return this.permissionDeclaration
  }

  declarePermissions(declaration: unknown): void {
    const parsed = HostUiPermissionDeclarationSchema.parse(declaration)
    if (this.pageEntries.size > 0) throw new Error('页面注册完成后不能再改变权限声明。')
    this.permissionDeclaration = parsed
    this.publishPages()
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
      if (this.pageEntries.size === 0) this.permissionDeclaration = { permissions: [], networkOrigins: [] }
      this.publishPages()
    }
    this.ctx.effect(() => dispose, `nekro-nxt: Dynamic Host page ${page.entryId}`)
    return dispose
  }

  clear(): void {
    if (this.pageEntries.size === 0 && this.permissionDeclaration.permissions.length === 0) return
    this.pageEntries.clear()
    this.permissionDeclaration = { permissions: [], networkOrigins: [] }
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
  readonly #entries = new Map<string, BrowserDynamicLoaderEntry>()
  #sequence = 0

  constructor(context: Context, modules: ClientModuleSystemFace) {
    this.#context = context
    this.#modules = modules
  }

  async create(options: { readonly name: string }): Promise<string> {
    const exported = await this.#modules.import(options.name)
    const plugin =
      typeof exported === 'object' && exported !== null && 'default' in exported ? exported['default'] : exported
    const id = `dynamic-client-entry-${++this.#sequence}`
    const fiber = this.#context.plugin(requireCordisPlugin(plugin, `DSH Client module ${options.name}`))
    this.#entries.set(id, { fiber })
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

interface DynamicProductRootProps {
  readonly agentId: string
  readonly displayName: string
  readonly renderSlot: (name: string, props: object) => ReactNode
}

export type DynamicProductSlotName = NekroNxtClientSlotName | AdapterClientSlotName
export interface DynamicProductSlotPropsMap extends NekroNxtClientSlotPropsMap, AdapterClientSlotPropsMap {}

const DynamicProductRoot = ({ renderSlot, agentId, displayName }: DynamicProductRootProps): ReactNode =>
  React.createElement(
    React.Fragment,
    null,
    renderSlot('agent.workbench.sections', { agentId, displayName }),
    renderSlot('extension.details.panels', {
      agentId,
      extensionId: 'dynamic-preview',
      revisionId: 'dynamic-preview',
      activation: 'active',
    }),
  )

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

export interface DynamicClientHostPort extends CordisRunHostSeam {
  getClientCode(agentId: string, pluginId: string, pluginRunId: string): ReturnType<CordisRunHostSeam['getClientCode']>
  invoke(pluginId: string, pluginRunId: string, method: string, args: unknown): Promise<unknown>
  reportRenderFailure(agentId: string, pluginId: string, pluginRunId: string, failure: unknown): Promise<void>
  reportGuardFailure(agentId: string, pluginId: string, pluginRunId: string, failure: unknown): Promise<void>
  reportClientVerification(
    agentId: string,
    pluginId: string,
    packageId: string,
    pluginRunId: string,
    renderedSlots: readonly AgentClientSlotName[],
    renderedHostSlots: readonly { readonly name: AdapterClientSlotName; readonly key: string }[],
    renderedPages: readonly HostPageContribution[],
    usedUiComponents: readonly HostUiKitComponentName[],
    pageGeometry: readonly HostUiPageGeometryEvidence[],
    permissions: HostUiPermissionDeclaration,
    navigationEntries: readonly string[],
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

/** Single browser owner for NekroNXT dynamic Client Packages. */
export class DshClientRuntime {
  readonly slots: SlotRegistryFace
  readonly pages: DynamicHostPagesRegistry
  readonly #dynamicContext: Context
  readonly #runner: DynamicPackageRunnerFace
  readonly #orchestrator: RunOrchestratorFace
  readonly #unsubscribeHostEvents: () => void
  readonly #host: DynamicClientHostPort
  readonly #moduleLoader: ClientModuleRegistrationTarget
  readonly #agentByPlugin = new Map<string, string>()
  readonly #pluginByApprovalRequest = new Map<string, string>()
  #disposed = false
  #disposePromise: Promise<void> | undefined
  #queue: Promise<void> = Promise.resolve()
  #inventoryRevision = 0
  readonly #lifecycle: ClientLifecycle

  private constructor(
    dynamicContext: Context,
    slots: SlotRegistryFace,
    pages: DynamicHostPagesRegistry,
    runner: DynamicPackageRunnerFace,
    orchestrator: RunOrchestratorFace,
    unsubscribeHostEvents: () => void,
    host: DynamicClientHostPort,
    moduleLoader: ClientModuleRegistrationTarget,
    lifecycle: ClientLifecycle,
  ) {
    this.#dynamicContext = dynamicContext
    this.slots = slots
    this.pages = pages
    this.#runner = runner
    this.#orchestrator = orchestrator
    this.#unsubscribeHostEvents = unsubscribeHostEvents
    this.#host = host
    this.#moduleLoader = moduleLoader
    this.#lifecycle = lifecycle
  }

  static async create(
    host: DynamicClientHostPort,
    documentValue: unknown = document,
    events: HostEventStream = productHostEventStream,
  ): Promise<DshClientRuntime> {
    const { modules, moduleSystem, moduleLoader } = await loadDynamicClientModules(documentValue)
    const dynamicContext = new Context()
    const lifecycle = new ClientLifecycle()
    host = scopedHost(host, lifecycle)
    let createdRunner: DynamicPackageRunnerFace | undefined
    let unsubscribeHostEvents: (() => void) | undefined
    try {
      const dynamicLoader = new BrowserDynamicLoader(dynamicContext, moduleSystem)
      await dynamicContext.plugin(DynamicHostPagesRegistry)
      const pagesValue: unknown = dynamicContext.get('pages')
      if (!(pagesValue instanceof DynamicHostPagesRegistry)) throw new Error('Dynamic Host pages Service 未挂载。')
      const pages = pagesValue
      dynamicContext.reflect.provide('ui', hostUiKit)
      const remote = new DshRemoteBridge()
      const connection = createDshConnectionBridge()
      dynamicContext.reflect.provide('connection', connection)
      dynamicContext.reflect.provide('remote', remote)
      await dynamicContext.plugin(modules.uiRenderer)
      const slots = requireSlotRegistry(dynamicContext.get('slots'), 'DSH Dynamic SlotRegistry')
      // Apply installs only the renderer and registry. NXT owns the React root:
      // never call uiRenderer.mount(), which would assemble DSH's native WebUI.
      // Declare only NXT product slots beneath this private composition root.
      slots.register(
        {
          name: 'root',
          priority: 0,
          children: {
            'agent.workbench.sections': { kind: 'list', scope: 'root' },
            'extension.activation.panels': { kind: 'list', scope: 'root' },
            'extension.details.panels': { kind: 'list', scope: 'root' },
            'channel.inspector.agent.sections': { kind: 'list', scope: 'root' },
            'conversation.tool.card': { kind: 'list', scope: 'root' },
            'conversation.message.rich': { kind: 'list', scope: 'root' },
            'connection.adapter.setup': { kind: 'list', scope: 'root' },
            'connection.adapter.status': { kind: 'list', scope: 'root' },
            'connection.adapter.test': { kind: 'list', scope: 'root' },
            'channel.inspector.adapter.sections': { kind: 'list', scope: 'root' },
          },
        },
        DynamicProductRoot,
      )
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
      return new DshClientRuntime(
        dynamicContext,
        slots,
        pages,
        runner,
        orchestrator,
        unsubscribeHostEvents,
        host,
        moduleLoader,
        lifecycle,
      )
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
    this.#agentByPlugin.clear()
    this.#pluginByApprovalRequest.clear()
    for (const row of rows) {
      this.#agentByPlugin.set(row.pluginId, row.agentId)
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
        retractions.push(
          new Promise((resolve) => {
            const unsubscribe = this.#runner.subscribe(() => {
              if (this.#runner.isLoaded(loaded.pluginId)) return
              unsubscribe()
              resolve()
            })
          }),
        )
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
    await this.#rejectUnsupportedSlots()
  }

  approve(requestId: string, approveFutureVersions = false): Promise<void> {
    return this.#enqueue(() => this.#approve(requestId, approveFutureVersions))
  }

  async #approve(requestId: string, approveFutureVersions: boolean): Promise<void> {
    this.#assertActive()
    const pluginId = this.#pluginByApprovalRequest.get(requestId)
    await this.#orchestrator.approve(requireApprovalRequestId(requestId), approveFutureVersions)
    this.#assertActive()
    await this.#rejectUnsupportedSlots()
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

  pageEntries(): readonly DynamicHostPageEntry[] {
    this.#assertActive()
    return this.pages.entries()
  }

  pagePermissions(): HostUiPermissionDeclaration {
    this.#assertActive()
    return this.pages.permissions()
  }

  subscribePages(listener: () => void): () => void {
    this.#assertActive()
    return this.pages.subscribe(listener)
  }

  entries<Name extends DynamicProductSlotName>(
    name: Name,
  ): readonly {
    readonly id: string
    readonly component: (props: DynamicProductSlotPropsMap[Name]) => ReactNode
  }[] {
    this.#assertActive()
    return this.slots.entriesOfSlot(name).map((entry, index) => ({
      id: entry.options.id ?? entry.registrant ?? `${name}:${index}`,
      component: requireProductSlotComponent<DynamicProductSlotPropsMap[Name]>(
        entry.component,
        `Dynamic Client slot ${name}`,
      ),
    }))
  }

  async reportRenderFailure(agentId: string, failure: unknown): Promise<void> {
    this.#assertActive()
    await Promise.all(
      this.#runner
        .getSnapshot()
        .filter((loaded) => this.#agentByPlugin.get(loaded.pluginId) === agentId)
        .map((loaded) => this.#host.reportRenderFailure(agentId, loaded.pluginId, loaded.pluginRunId, failure)),
    )
  }

  renderRoot(agentId: string, displayName: string): ReactNode {
    this.#assertActive()
    return this.slots.renderSlot('root', { agentId, displayName })
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

  async #rejectUnsupportedSlots(): Promise<void> {
    const allowed = new Set([
      'agent.workbench.sections',
      'extension.activation.panels',
      'extension.details.panels',
      'channel.inspector.agent.sections',
      'conversation.tool.card',
      'conversation.message.rich',
      'connection.adapter.setup',
      'connection.adapter.status',
      'connection.adapter.test',
      'channel.inspector.adapter.sections',
    ])
    for (const loaded of this.#runner.getSnapshot()) {
      const unsupported = loaded.slots.filter((slot) => !allowed.has(slot))
      if ((loaded.slots.length > 0 || this.pages.entries().length > 0) && unsupported.length === 0) continue
      const message =
        loaded.slots.length === 0 && this.pages.entries().length === 0
          ? 'Client half did not register a NekroNxt product Slot or page.'
          : `Client half registered unsupported Slots: ${unsupported.join(', ')}`
      const agentId = this.#agentByPlugin.get(loaded.pluginId)
      if (agentId) {
        await this.#host
          .reportGuardFailure(agentId, loaded.pluginId, loaded.pluginRunId, {
            phase: 'client-slot',
            message,
          })
          .catch(() => undefined)
      }
      const retracted = new Promise<void>((resolve) => {
        const unsubscribe = this.#runner.subscribe(() => {
          if (this.#runner.isLoaded(loaded.pluginId)) return
          unsubscribe()
          resolve()
        })
      })
      this.#runner.retract(loaded.pluginId, loaded.pluginRunId)
      await retracted
      throw new Error(message)
    }
  }
}

/** Backward-compatible name while callers migrate to the shared runtime terminology. */
export { DshClientRuntime as DshDynamicClientRuntime }
