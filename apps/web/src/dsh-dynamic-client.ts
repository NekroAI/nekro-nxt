import * as Cordis from '@deepseek-ai/cordis'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import clientRunnerBundle from '@deepseek-ai/dsh-cordis-client-runner/client?raw'
import type {
  ApprovalRequestId,
  CordisRunHostSeam,
  DynamicCordisLivePackage,
} from '@deepseek-ai/dsh-cordis-client-runner/client'
import clientModulesBundle from '@deepseek-ai/dsh-client-modules/client?raw'
import clientRuntimeBundle from '@deepseek-ai/dsh-client-runtime/client?raw'
import * as SlotModule from '@deepseek-ai/dsh-client-ui-slots'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import * as React from 'react'

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

interface ClientModuleSystemConstructor {
  new (options: {
    readonly modules: readonly unknown[]
    readonly staticModules: Readonly<Record<string, unknown>>
    readonly loadBundle: (url: string) => Promise<void>
  }): ClientModuleSystemFace
}

interface SlotRegistryFace {
  entriesOfSlot(key: string): readonly StoredEntry[]
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
    readonly loader: Loader
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
      await context.plugin(Loader, {})
      context.loader.internal = moduleSystem as never
      await context.plugin(modules.SlotRegistry)
      const slots = context.get('slots') as unknown as SlotRegistryFace | undefined
      if (!slots) throw new Error('DSH SlotRegistry did not publish its Service.')
      const runner = new modules.DynamicCordisPackageRunner({
        ctx: context,
        loader: context.loader,
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
