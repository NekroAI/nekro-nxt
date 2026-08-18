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
import * as SlotModule from '@deepseek-ai/dsh-client-ui-slots'
import { createSlotRenderer } from '@deepseek-ai/dsh-client-web-react'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import * as React from 'react'
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
  register(options: { readonly name: 'root'; readonly priority: number }, component: () => ReactNode): () => void
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
      '@deepseek-ai/cordis': Cordis,
      '@deepseek-ai/dsh-client-ui-slots': SlotModule,
    },
    loadBundle: () => Promise.reject(new Error('Unexpected external DSH Client bundle load.')),
  })
  evaluateClientBundle(clientRuntimeBundle, moduleWindow, documentValue)
  evaluateClientBundle(clientRunnerBundle, moduleWindow, documentValue)
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

/** Browser owner for DSH dynamic Client approval, loading, Slot contribution and retraction. */
export class DshDynamicClientRuntime {
  readonly slots: SlotRegistryFace
  readonly #context: Context
  readonly #runner: DynamicPackageRunnerFace
  readonly #orchestrator: RunOrchestratorFace
  #disposed = false

  private constructor(
    context: Context,
    slots: SlotRegistryFace,
    runner: DynamicPackageRunnerFace,
    orchestrator: RunOrchestratorFace,
  ) {
    this.#context = context
    this.slots = slots
    this.#runner = runner
    this.#orchestrator = orchestrator
  }

  static async create(
    host: DynamicClientHostPort,
    documentValue: unknown = document,
  ): Promise<DshDynamicClientRuntime> {
    const { modules, moduleSystem } = await loadDynamicClientModules(documentValue)
    const context = new Context()
    try {
      const loader = new BrowserDynamicLoader(context, moduleSystem)
      installSlotRendererShellFeeds(context)
      await context.plugin(modules.SlotRegistry)
      const slots = context.get('slots') as unknown as SlotRegistryFace | undefined
      if (!slots) throw new Error('DSH SlotRegistry did not publish its Service.')
      slots.install(createSlotRenderer())
      // The official renderer requires a stable shell-owned root registration.
      // Dynamic root entries receive negative priorities and temporarily win;
      // this null shell entry prevents a transient empty-root crash while a
      // retraction notification propagates through React.
      slots.register({ name: 'root', priority: 0 }, () => null)
      const runner = new modules.DynamicCordisPackageRunner({
        ctx: context,
        loader,
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
      return new DshDynamicClientRuntime(context, slots, runner, orchestrator)
    } catch (error) {
      await context.fiber.dispose()
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

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    await this.#runner.dispose()
    await this.#context.fiber.dispose()
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error('DSH Dynamic Client Runtime is disposed.')
  }
}
