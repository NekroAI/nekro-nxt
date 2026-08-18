import * as Cordis from '@deepseek-ai/cordis'
import { Context, type Fiber, type Plugin } from '@deepseek-ai/cordis'
import clientRunnerBundle from '@deepseek-ai/dsh-cordis-client-runner/client?raw'
import type {
  ApprovalRequestId,
  CordisRunHostSeam,
  DynamicCordisLivePackage,
} from '@deepseek-ai/dsh-cordis-client-runner/client'
import clientModulesBundle from '@deepseek-ai/dsh-client-modules/client?raw'
import clientRuntimeBundle from '@deepseek-ai/dsh-client-runtime/client?raw'
import clientLocaleBundle from '@deepseek-ai/dsh-client-locale/client?raw'
import clientSettingsBundle from '@deepseek-ai/dsh-client-ui-settings/client?raw'
import clientSettingsPluginsBundle from '@deepseek-ai/dsh-client-ui-settings-plugins/client?raw'
import * as SchemaFormModule from '@deepseek-ai/dsh-client-schema-form'
import * as SlotModule from '@deepseek-ai/dsh-client-ui-slots'
import { createSlotRenderer } from '@deepseek-ai/dsh-client-web-react'
import type { PropsRenderSlots, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import * as React from 'react'
import * as ReactJsxRuntime from 'react/jsx-runtime'
import type { ReactNode } from 'react'

interface ClientPluginHandoff {
  readonly id: string
  readonly factory: (requireModule: (specifier: string) => unknown) => Record<string, unknown>
}

interface ModuleWindow {
  __ModuleLoader__?: { load(handoff: ClientPluginHandoff): void }
}

interface ClientModuleSystemFace {
  import(specifier: string): Promise<unknown>
  registerStatic(id: string, module: unknown): void
  invalidate(id: string): void
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
      typeof exported === 'object' && exported !== null && 'default' in exported
        ? (exported as { readonly default: unknown }).default
        : exported
    const id = `dynamic-client-entry-${++this.#sequence}`
    const fiber = this.#context.plugin(plugin as Plugin)
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
    readonly modules: readonly unknown[]
    readonly staticModules: Readonly<Record<string, unknown>>
    readonly loadBundle: (url: string) => Promise<void>
  }): ClientModuleSystemFace
}

interface SlotRegistryFace {
  entriesOfSlot(key: string): readonly StoredEntry[]
  register<Props extends object>(
    options: Readonly<Record<string, unknown>>,
    component: (props: Props) => ReactNode,
  ): () => void
  install(renderer: ReturnType<typeof createSlotRenderer>): void
  renderSlot(key: 'root', owner: object): ReactNode
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

interface SlotRegistryConstructor {
  new (context: Context): SlotRegistryFace
}

const staticObservable = <T>(snapshot: T) => ({
  getSnapshot: (): T => snapshot,
  subscribe: (): (() => void) => () => undefined,
})

/** Minimal object-layer feeds required by the official Slot renderer host. */
const installSlotRendererShellFeeds = (context: Context): void => {
  context.reflect.provide('sessions', {
    list: staticObservable({ phase: 'ready', ids: [], byId: {}, current: undefined }),
    currentProvideInfo: staticObservable({ sessionId: undefined, hooks: {}, props: {} }),
  })
  context.reflect.provide('workspaces', {
    list: staticObservable({
      items: [],
      archivedSessionIds: [],
      state: 'idle',
      phase: 'ready',
      error: null,
      baselinesReady: true,
      recentWorkspaceId: undefined,
    }),
  })
}

type NativeSettingsRootProps = PropsRenderSlots<'settings.section'>

/**
 * Public Slot composition only permits the Host to render `root`. This small
 * product shell owns the settings child declaration and delegates the actual
 * section through the renderer-injected `renderSlot` face.
 */
const NativeSettingsRoot = ({ renderSlot }: NativeSettingsRootProps): ReactNode =>
  renderSlot('settings.section', { close: () => undefined }, { only: 'plugins' })

interface RemoteBridgeFace {
  $on(event: string, listener: (...args: never[]) => void): () => void
}

class DshRemoteBridge implements RemoteBridgeFace {
  readonly #listeners = new Map<string, Set<(...args: never[]) => void>>()

  $on(event: string, listener: (...args: never[]) => void): () => void {
    const listeners = this.#listeners.get(event) ?? new Set()
    listeners.add(listener)
    this.#listeners.set(event, listeners)
    return () => listeners.delete(listener)
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.#listeners.get(event) ?? []) listener(...(args as never[]))
  }
}

const rpcOk = <T>(value: T) => ({ rpcId: 'nekro-nxt-dsh-bridge', result: { ok: true as const, value } })

const apiJson = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  const body = (await response.json()) as { readonly error?: { readonly message?: unknown } }
  if (!response.ok) {
    throw new Error(typeof body.error?.message === 'string' ? body.error.message : `DSH Bridge HTTP ${response.status}`)
  }
  return body as T
}

const unsupportedRemoteError = (): Error & { code: 'unsupported-remote' } => {
  const error = new Error('DSH 原生界面请求了当前桥接未支持的 Remote。') as Error & {
    code: 'unsupported-remote'
  }
  error.code = 'unsupported-remote'
  return error
}

const createDshConnectionBridge = () => ({
  isLoopback: true,
  api: {
    settings: {
      describe: async () => {
        const response = await apiJson<{ readonly namespaces: readonly Record<string, unknown>[] }>('/api/dsh/settings')
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
        const value = await apiJson<Record<string, unknown>>(
          `/api/dsh/settings/${encodeURIComponent(payload.ns)}/mutate`,
          {
            method: 'POST',
            body: JSON.stringify({ expectedRevision: payload.expectedRevision ?? 0, ops: payload.ops }),
          },
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
        rpcOk(
          await apiJson<{ readonly credentials: Readonly<Record<string, unknown>> }>('/api/dsh/credentials/describe', {
            method: 'POST',
            body: JSON.stringify(payload),
          }),
        ),
      set: async (payload: { readonly ref: string; readonly value: string }) => {
        await apiJson(`/api/dsh/credentials/${encodeURIComponent(payload.ref)}`, {
          method: 'PUT',
          body: JSON.stringify({ value: payload.value }),
        })
        return rpcOk({})
      },
      unset: async (payload: { readonly ref: string }) => {
        await apiJson(`/api/dsh/credentials/${encodeURIComponent(payload.ref)}`, { method: 'DELETE' })
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
  readonly SlotRegistry: SlotRegistryConstructor
  readonly DynamicCordisPackageRunner: DynamicPackageRunnerConstructor
  readonly CordisRunOrchestrator: RunOrchestratorConstructor
}

export interface DynamicInventoryRow {
  readonly pluginId: string
  readonly agentId: string
  readonly packages: readonly {
    readonly packageId: string
    readonly name: string
    readonly purpose: string
    readonly hasHostHalf: boolean
    readonly hasClientHalf: boolean
  }[]
  readonly activeRun?: { readonly pluginRunId: string; readonly packageId: string }
  readonly latestRun?: {
    readonly pluginRunId: string
    readonly packageId: string
    readonly mode: 'run' | 'update'
    readonly status: string
    readonly approvalRequestId?: string
    readonly requiresApproval?: boolean
  }
}

export interface DynamicClientHostPort extends CordisRunHostSeam {
  invoke(pluginId: string, pluginRunId: string, method: string, args: unknown): Promise<unknown>
  reportRenderFailure(agentId: string, pluginId: string, pluginRunId: string, failure: unknown): Promise<void>
  reportGuardFailure(agentId: string, pluginId: string, pluginRunId: string, failure: unknown): Promise<void>
}

const evaluateClientBundle = (source: string, moduleWindow: ModuleWindow, documentValue: unknown): void => {
  // The published DSH Client export is a classic ModuleLoader registration bundle, not a normal ESM module.
  // Dynamic Cordis already requires closure evaluation; this executes only the exact lockfile-pinned trusted bundle.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- DSH publishes this exact Client entry as a classic registration bundle.
  const evaluate = new Function('window', 'document', source) as (window: ModuleWindow, document: unknown) => void
  evaluate(moduleWindow, documentValue)
}

const captureBootstrapModule = (
  source: string,
  moduleWindow: ModuleWindow,
  documentValue: unknown,
): Record<string, unknown> => {
  let captured: ClientPluginHandoff | undefined
  moduleWindow.__ModuleLoader__ = {
    load: (handoff) => {
      if (captured) throw new Error('DSH bootstrap bundle registered more than one module.')
      captured = handoff
    },
  }
  evaluateClientBundle(source, moduleWindow, documentValue)
  if (!captured) throw new Error('DSH bootstrap bundle did not register its module.')
  return captured.factory((specifier) => {
    throw new Error(`DSH bootstrap module unexpectedly required: ${specifier}`)
  })
}

const loadDynamicClientModules = async (
  documentValue: unknown,
): Promise<{
  readonly modules: DynamicClientModules
  readonly moduleSystem: ClientModuleSystemFace
}> => {
  const moduleWindow = globalThis as ModuleWindow
  if (moduleWindow.__ModuleLoader__) throw new Error('A DSH Client module loader is already installed in this page.')
  const bootstrap = captureBootstrapModule(clientModulesBundle, moduleWindow, documentValue)
  delete moduleWindow.__ModuleLoader__
  const ClientModuleSystem = bootstrap.ClientModuleSystem as ClientModuleSystemConstructor | undefined
  if (!ClientModuleSystem) throw new Error('DSH ClientModuleSystem export is unavailable.')
  const moduleSystem = new ClientModuleSystem({
    modules: [],
    staticModules: {
      react: React,
      'react/jsx-runtime': ReactJsxRuntime,
      '@deepseek-ai/cordis': Cordis,
      '@deepseek-ai/dsh-client-schema-form': SchemaFormModule,
      '@deepseek-ai/dsh-client-ui-slots': SlotModule,
    },
    loadBundle: () => Promise.reject(new Error('Unexpected external DSH Client bundle load.')),
  })
  evaluateClientBundle(clientRuntimeBundle, moduleWindow, documentValue)
  evaluateClientBundle(clientRunnerBundle, moduleWindow, documentValue)
  evaluateClientBundle(clientSettingsBundle, moduleWindow, documentValue)
  evaluateClientBundle(clientLocaleBundle, moduleWindow, documentValue)
  evaluateClientBundle(clientSettingsPluginsBundle, moduleWindow, documentValue)
  const runtime = (await moduleSystem.import('@deepseek-ai/dsh-client-runtime')) as Record<string, unknown>
  const runner = (await moduleSystem.import('@deepseek-ai/dsh-cordis-client-runner')) as Record<string, unknown>
  const SlotRegistry = runtime.SlotRegistry as SlotRegistryConstructor | undefined
  const DynamicCordisPackageRunner = runner.DynamicCordisPackageRunner as DynamicPackageRunnerConstructor | undefined
  const CordisRunOrchestrator = runner.CordisRunOrchestrator as RunOrchestratorConstructor | undefined
  if (!SlotRegistry || !DynamicCordisPackageRunner || !CordisRunOrchestrator) {
    throw new Error('DSH dynamic Client exports are incomplete.')
  }
  return {
    moduleSystem,
    modules: { ClientModuleSystem, SlotRegistry, DynamicCordisPackageRunner, CordisRunOrchestrator },
  }
}

/** Single browser owner for DSH dynamic Packages and compatible native Client settings. */
export class DshClientRuntime {
  readonly slots: SlotRegistryFace
  readonly #dynamicContext: Context
  readonly #nativeContext: Context
  readonly #nativeSlots: SlotRegistryFace
  readonly #runner: DynamicPackageRunnerFace
  readonly #orchestrator: RunOrchestratorFace
  readonly #nativeLoader: BrowserDynamicLoader
  readonly #moduleSystem: ClientModuleSystemFace
  readonly #eventSource: EventSource | undefined
  readonly #nativeEntries: string[] = []
  #nativeStaticReady = false
  #nativeSettingsReady = false
  #disposed = false

  private constructor(
    dynamicContext: Context,
    nativeContext: Context,
    slots: SlotRegistryFace,
    nativeSlots: SlotRegistryFace,
    runner: DynamicPackageRunnerFace,
    orchestrator: RunOrchestratorFace,
    nativeLoader: BrowserDynamicLoader,
    moduleSystem: ClientModuleSystemFace,
    eventSource: EventSource | undefined,
  ) {
    this.#dynamicContext = dynamicContext
    this.#nativeContext = nativeContext
    this.slots = slots
    this.#nativeSlots = nativeSlots
    this.#runner = runner
    this.#orchestrator = orchestrator
    this.#nativeLoader = nativeLoader
    this.#moduleSystem = moduleSystem
    this.#eventSource = eventSource
  }

  static async create(host: DynamicClientHostPort, documentValue: unknown = document): Promise<DshClientRuntime> {
    const { modules, moduleSystem } = await loadDynamicClientModules(documentValue)
    const dynamicContext = new Context()
    const nativeContext = new Context()
    try {
      const dynamicLoader = new BrowserDynamicLoader(dynamicContext, moduleSystem)
      const nativeLoader = new BrowserDynamicLoader(nativeContext, moduleSystem)
      installSlotRendererShellFeeds(dynamicContext)
      installSlotRendererShellFeeds(nativeContext)
      const remote = new DshRemoteBridge()
      const connection = createDshConnectionBridge()
      dynamicContext.reflect.provide('connection', connection)
      dynamicContext.reflect.provide('remote', remote)
      nativeContext.reflect.provide('connection', connection)
      nativeContext.reflect.provide('remote', remote)
      await Promise.all([dynamicContext.plugin(modules.SlotRegistry), nativeContext.plugin(modules.SlotRegistry)])
      const slots = dynamicContext.get('slots') as unknown as SlotRegistryFace | undefined
      const nativeSlots = nativeContext.get('slots') as unknown as SlotRegistryFace | undefined
      if (!slots || !nativeSlots) throw new Error('DSH SlotRegistry did not publish its Service.')
      slots.install(createSlotRenderer())
      // The official renderer requires a stable shell-owned root registration.
      // Dynamic root entries receive negative priorities and temporarily win;
      // this null shell entry prevents a transient empty-root crash while a
      // retraction notification propagates through React.
      slots.register({ name: 'root', priority: 0 }, () => null)
      nativeSlots.install(createSlotRenderer())
      nativeSlots.register(
        {
          name: 'root',
          priority: 0,
          children: { 'settings.section': { kind: 'list', scope: 'root' } },
        },
        NativeSettingsRoot,
      )
      const runner = new modules.DynamicCordisPackageRunner({
        ctx: dynamicContext,
        loader: dynamicLoader,
        modules: moduleSystem,
        slots,
        invoke: (pluginId, pluginRunId, method, args) => host.invoke(pluginId, pluginRunId, method, args),
        reportRenderFailure: (agentId, pluginId, pluginRunId, failure) => {
          void host.reportRenderFailure(agentId, pluginId, pluginRunId, failure)
        },
        reportGuardFailure: (agentId, pluginId, pluginRunId, failure) => {
          void host.reportGuardFailure(agentId, pluginId, pluginRunId, failure)
        },
      })
      const orchestrator = new modules.CordisRunOrchestrator({ runner, host })
      const eventSource = typeof EventSource === 'undefined' ? undefined : new EventSource('/api/events')
      eventSource?.addEventListener('dsh-settings-changed', (event) => {
        const value = JSON.parse((event as MessageEvent<string>).data) as { namespace?: unknown; revision?: unknown }
        if (typeof value.namespace === 'string' && typeof value.revision === 'number') {
          remote.emit('settings/document-updated', value.namespace, value.revision)
        }
      })
      eventSource?.addEventListener('dsh-credentials-changed', (event) => {
        const value = JSON.parse((event as MessageEvent<string>).data) as { ref?: unknown }
        if (typeof value.ref === 'string') remote.emit('credentials/updated', value.ref)
      })
      return new DshClientRuntime(
        dynamicContext,
        nativeContext,
        slots,
        nativeSlots,
        runner,
        orchestrator,
        nativeLoader,
        moduleSystem,
        eventSource,
      )
    } catch (error) {
      await Promise.all([dynamicContext.fiber.dispose(), nativeContext.fiber.dispose()])
      throw error
    }
  }

  async reconcile(rows: readonly DynamicInventoryRow[]): Promise<void> {
    this.#assertActive()
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
  }

  approve(requestId: string, approveFutureVersions = false): Promise<void> {
    this.#assertActive()
    return this.#orchestrator.approve(requestId as ApprovalRequestId, approveFutureVersions)
  }

  decline(requestId: string): Promise<void> {
    this.#assertActive()
    return this.#orchestrator.decline(requestId as ApprovalRequestId)
  }

  loaded(): readonly DynamicCordisLivePackage[] {
    this.#assertActive()
    return this.#runner.getSnapshot()
  }

  renderRoot(): ReactNode {
    this.#assertActive()
    return this.slots.renderSlot('root', {})
  }

  async loadNativeSettings(): Promise<void> {
    this.#assertActive()
    if (this.#nativeSettingsReady) return
    const created: string[] = []
    try {
      if (!this.#nativeStaticReady) {
        this.#moduleSystem.registerStatic(
          '@deepseek-ai/dsh-client-ui-primitives',
          await import('@deepseek-ai/dsh-client-ui-primitives'),
        )
        this.#nativeStaticReady = true
      }
      for (const name of [
        '@deepseek-ai/dsh-client-ui-settings',
        '@deepseek-ai/dsh-client-locale',
        '@deepseek-ai/dsh-client-ui-settings-plugins',
      ]) {
        const id = await this.#nativeLoader.create({ name })
        created.push(id)
      }
      this.#nativeEntries.push(...created)
      this.#nativeSettingsReady = true
    } catch (error) {
      for (const id of created.reverse()) await this.#nativeLoader.remove(id)
      throw error
    }
  }

  renderNativeSettings(): ReactNode {
    this.#assertActive()
    if (!this.#nativeSettingsReady) return null
    return this.#nativeSlots.renderSlot('root', {})
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    this.#eventSource?.close()
    for (const id of this.#nativeEntries.splice(0).reverse()) await this.#nativeLoader.remove(id)
    await this.#runner.dispose()
    await Promise.all([this.#dynamicContext.fiber.dispose(), this.#nativeContext.fiber.dispose()])
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error('DSH Client Runtime is disposed.')
  }
}

/** Backward-compatible name while callers migrate to the shared runtime terminology. */
export { DshClientRuntime as DshDynamicClientRuntime }
