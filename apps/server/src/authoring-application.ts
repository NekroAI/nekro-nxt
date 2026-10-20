import type { AuthoringTaskId, ExtensionId, HostApiContracts } from '@nekro-nxt/contracts'
import type {
  DynamicAuthoringAttempt,
  DynamicAuthoringSnapshot,
  DynamicAuthoringTask,
  DynamicPackageSnapshot,
  ExtensionContribution,
  ExtensionRevisionVerification,
} from '@nekro-nxt/extension-runtime'
import { DSH_RUNTIME_RELEASE } from '@nekro-nxt/dsh-compat/release'
import { extensionManifestContributionSchema } from '@nekro-nxt/extension-format'
import { z } from 'zod'
import type { NekroRuntime } from './bootstrap.js'

type SaveInput = ReturnType<typeof HostApiContracts.saveExtensionFromDynamic.parseRequest>
type SaveResult = Awaited<ReturnType<NekroRuntime['extensionService']['saveDynamicPackage']>>
type VerificationInput = Omit<ExtensionRevisionVerification, 'revisionId' | 'verifiedAt' | 'hostBuild' | 'clientBuild'>

/** The adapter evidence a verified run recorded, read back from the ledger. */
const AdapterEvidenceSchema = z.object({
  apiVersion: z.literal(2),
  key: z.string(),
  descriptorDigest: z.string(),
  registered: z.boolean(),
  started: z.boolean(),
  stopped: z.boolean(),
  inboundCommitted: z.boolean(),
  outboundReceipt: z.enum(['sent', 'failed', 'unknown']),
})

/** What a saved Revision is built from: the candidate's code and the evidence of its verified run. */
interface SaveMaterial {
  readonly snapshot: DynamicPackageSnapshot
  readonly verification: VerificationInput
}

/** A readable slug from an English name, or a dated fallback when the name has no ASCII letters. */
const proposeSlug = (name: string): string => {
  const ascii = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replaceAll(/^-+|-+$/gu, '')
  return ascii.length >= 3 ? ascii.slice(0, 48) : `ext-${Date.now().toString(36)}`
}

/** Coordinates authoring operations for HTTP and other host entrypoints. */
export class AuthoringApplicationService {
  readonly #runtime: NekroRuntime
  readonly #saving = new Map<string, Promise<SaveResult>>()
  #disposed = false
  constructor(runtime: NekroRuntime) {
    this.#runtime = runtime
  }
  decide(input: Parameters<NekroRuntime['host']['decideAuthoringAttempt']>[0]) {
    return this.#runtime.host.decideAuthoringAttempt(input)
  }
  stop(input: Parameters<NekroRuntime['host']['stopAuthoringTask']>[0]) {
    return this.#runtime.host.stopAuthoringTask(input)
  }
  async restore(input: Parameters<NekroRuntime['host']['restoreAuthoringAttempt']>[0]) {
    if (this.#disposed) throw new Error('NekroNXT 正在关闭，请稍后再试。')
    await this.#runtime.host.restoreAuthoringAttempt(input)
    const task = this.#runtime.repository.getAuthoringTask(input.taskId)
    if (!task) throw new Error('创造任务不存在。')
    return task
  }

  /** The workshop's save dialog. Revise tasks always save into their target extension. */
  save(input: SaveInput): Promise<SaveResult> {
    const latest = this.#runtime.repository.listAuthoringAttempts(input.taskId).at(-1)
    if (latest?.id !== input.attemptId) return Promise.reject(new Error('只能保存这个任务最新的候选。'))
    return this.saveTask({
      taskId: input.taskId,
      name: input.displayName,
      slug: input.slug,
      description: input.description,
      ...(input.targetExtensionId === undefined ? {} : { targetExtensionId: input.targetExtensionId }),
    })
  }

  /**
   * Saves the task's latest verified candidate as an immutable Revision. While its conversation is live the run is
   * re-verified as it stands; after the conversation ended the ledger's snapshot and evidence are used, and the
   * materialized Revision runs the same import verification either way.
   */
  saveTask(input: {
    readonly taskId: AuthoringTaskId
    readonly name?: string
    readonly slug?: string
    readonly description?: string
    readonly targetExtensionId?: ExtensionId
    /**
     * The agent saves its own candidate while its turn is still running: waiting for the turn to end would wait for
     * this save, so the verified record in the ledger is used instead.
     */
    readonly fromAgentTurn?: boolean
  }): Promise<SaveResult> {
    if (this.#disposed) throw new Error('NekroNXT 正在关闭，请稍后再试。')
    if (this.#saving.has(input.taskId)) throw new Error('这个候选正在保存，请稍候。')
    const saving = this.#saveTask(input)
      .then(async (result) => {
        // The saved extension is configured on its own; the task's test configuration ends here.
        await this.#runtime.authoringTestConfig.clear(input.taskId)
        return result
      })
      .finally(() => this.#saving.delete(input.taskId))
    this.#saving.set(input.taskId, saving)
    return saving
  }

  async dispose(): Promise<void> {
    this.#disposed = true
    await Promise.allSettled([...this.#saving.values()])
  }

  async #saveTask(input: Parameters<AuthoringApplicationService['saveTask']>[0]): Promise<SaveResult> {
    const runtime = this.#runtime
    const initial = runtime.repository.getAuthoringTask(input.taskId)
    if (!initial) throw new Error('创造任务不存在。')
    const live = input.fromAgentTurn === true ? undefined : this.#liveSession(initial)
    if (live !== undefined) await runtime.host.whenAuthoringSettled(live)
    const task = runtime.repository.getAuthoringTask(input.taskId)!
    const attempt = runtime.repository.listAuthoringAttempts(task.id).at(-1)
    if (!attempt || attempt.state !== 'active' || !attempt.verification) {
      throw new Error('这个候选还没有试运行成功，暂时不能保存。')
    }
    if (task.status !== 'ready' && task.status !== 'paused') {
      throw new Error('这个候选还没有试运行成功，或者还在等待批准，暂时不能保存。')
    }
    const targetId = task.kind === 'revise' ? task.targetExtensionId : input.targetExtensionId
    const target = targetId === undefined ? undefined : runtime.repository.getExtension(targetId)
    if (targetId !== undefined && !target) throw new Error('要保存到的扩展已经不在本机。')
    const material =
      live !== undefined && this.#runningInSession(live, attempt)
        ? await this.#liveMaterial(live, task, attempt)
        : await this.#ledgerMaterial(attempt)
    if (material.verification.permissions?.agent?.mcp !== undefined) {
      throw new Error('动态创造不能声明 MCP 服务；请在工坊用「添加 MCP 服务」连接。')
    }
    const name = target?.displayName ?? input.name?.trim() ?? attempt.name
    const saved = await runtime.extensionService.saveDynamicPackage({
      snapshot: material.snapshot,
      slug: target?.slug ?? input.slug ?? proposeSlug(name),
      displayName: name,
      description: target?.description ?? input.description?.trim() ?? attempt.purpose,
      ...(target === undefined ? {} : { extensionId: target.id }),
      ...(task.kind === 'revise' && task.baseRevisionId !== undefined ? { parentRevisionId: task.baseRevisionId } : {}),
      createdByAgentId: task.agentId,
      authoringTaskId: task.id,
      verification: material.verification,
    })
    this.#complete(task.id, attempt.id, saved)
    return saved
  }

  #liveSession(task: DynamicAuthoringTask): string | undefined {
    const episode = this.#runtime.repository.getEpisode(task.episodeId)
    return episode?.agentId === task.agentId && episode.status === 'active' && episode.dshSessionId
      ? episode.dshSessionId
      : undefined
  }

  #runningInSession(dshSessionId: string, attempt: DynamicAuthoringAttempt): boolean {
    if (!attempt.runnerPluginId || !attempt.runnerPackageId) return false
    const row = this.#runtime.host
      .dynamicInventory(dshSessionId)
      .find((candidate) => candidate.pluginId === attempt.runnerPluginId)
    return (
      row?.currentPackageId === attempt.runnerPackageId &&
      row.activeRun?.packageId === attempt.runnerPackageId &&
      row.latestRun?.packageId === attempt.runnerPackageId &&
      row.latestRun.status === 'running'
    )
  }

  /** Re-verifies the running candidate and reads its code from the ledger. */
  async #liveMaterial(
    dshSessionId: string,
    task: DynamicAuthoringTask,
    attempt: DynamicAuthoringAttempt,
  ): Promise<SaveMaterial> {
    const host = this.#runtime.host
    const pluginId = attempt.runnerPluginId!
    const packageId = attempt.runnerPackageId!
    const inspection = host.inspectDynamicPackage(dshSessionId, pluginId, packageId)
    const authored = await host.dynamicAuthoringSnapshot(dshSessionId, pluginId, packageId)
    const verified = await host.verifyDynamicPackage(dshSessionId, pluginId, packageId)
    const hasHostPages = verified.renderedPages.length > 0
    return {
      snapshot: this.#packageSnapshot(
        authored ?? {
          name: inspection.name,
          purpose: inspection.purpose,
          code: inspection.code,
          resources: {},
          permissions: verified.permissions,
          contributions: [],
        },
        verified.permissions,
        verified.contributions,
      ),
      verification: {
        dshVersion: DSH_RUNTIME_RELEASE.dshVersion,
        contractVersion: 'nekro-nxt-extension-v5',
        ...(verified.adapter === undefined ? {} : { adapter: verified.adapter }),
        origin: { episodeId: task.episodeId, pluginId, packageId, pluginRunId: verified.pluginRunId },
        toolInvocations: verified.toolInvocations,
        rpcMethods: verified.rpcMethods,
        renderedPanels: verified.renderedPanels.map((panel) => panel.id),
        renderedToolViews: verified.renderedToolViews,
        renderedMessageRenderers: verified.renderedMessageRenderers,
        permissions: verified.permissions,
        ...(hasHostPages
          ? {
              renderedPages: verified.renderedPages,
              usedUiComponents: verified.usedUiComponents,
              pageGeometry: verified.pageGeometry,
            }
          : {}),
      },
    }
  }

  /** The candidate as the ledger recorded it when its run passed verification. */
  async #ledgerMaterial(attempt: DynamicAuthoringAttempt): Promise<SaveMaterial> {
    const verification = attempt.verification!
    if (verification.contributions === undefined) {
      throw new Error('这个候选是在旧版本里试运行的，请在频道里让智能体继续这个任务，重新试运行后再保存。')
    }
    const authored = await this.#runtime.host.authoringSnapshotForAttempt(attempt)
    const contributions = z.array(extensionManifestContributionSchema).parse(verification.contributions)
    const hasHostPages = verification.renderedPages.length > 0
    return {
      snapshot: this.#packageSnapshot(authored, authored.permissions, contributions),
      verification: {
        dshVersion: DSH_RUNTIME_RELEASE.dshVersion,
        contractVersion: 'nekro-nxt-extension-v5',
        ...(verification.adapter === undefined ? {} : { adapter: AdapterEvidenceSchema.parse(verification.adapter) }),
        origin: {
          episodeId: '',
          pluginId: attempt.runnerPluginId ?? '',
          packageId: attempt.runnerPackageId ?? '',
          pluginRunId: verification.pluginRunId ?? '',
        },
        toolInvocations: verification.toolInvocations,
        rpcMethods: verification.rpcCalls,
        renderedPanels: verification.renderedPanels,
        renderedToolViews: verification.renderedToolViews,
        renderedMessageRenderers: verification.renderedMessageRenderers,
        permissions: authored.permissions,
        ...(hasHostPages
          ? {
              renderedPages: verification.renderedPages,
              usedUiComponents: verification.usedUiComponents,
              pageGeometry: verification.pageGeometry,
            }
          : {}),
      },
    }
  }

  #packageSnapshot(
    authored: DynamicAuthoringSnapshot,
    permissions: DynamicPackageSnapshot['permissions'],
    contributions: readonly ExtensionContribution[],
  ): DynamicPackageSnapshot {
    return {
      name: authored.name,
      purpose: authored.purpose,
      ...(authored.code.host === undefined ? {} : { hostCode: authored.code.host }),
      ...(authored.code.client === undefined ? {} : { clientCode: authored.code.client }),
      ...(permissions === undefined ? {} : { permissions }),
      contributions,
      ...(authored.config === undefined ? {} : { config: authored.config }),
      resources: authored.resources,
      ...(authored.clientCss === undefined ? {} : { clientCss: authored.clientCss }),
      ...(authored.icon === undefined ? {} : { icon: authored.icon }),
      ...(authored.dataVersion === undefined ? {} : { dataVersion: authored.dataVersion }),
      ...(authored.codeFormat === undefined ? {} : { codeFormat: authored.codeFormat }),
    }
  }

  #complete(taskId: AuthoringTaskId, attemptId: DynamicAuthoringAttempt['id'], saved: SaveResult): void {
    const runtime = this.#runtime
    const currentTask = runtime.repository.getAuthoringTask(taskId)
    const currentAttempt = currentTask ? runtime.repository.listAuthoringAttempts(currentTask.id).at(-1) : undefined
    if (!currentTask || currentAttempt?.id !== attemptId || !['ready', 'paused'].includes(currentTask.status)) return
    const now = Date.now()
    const { pausedReason: _reason, ...rest } = currentTask
    void _reason
    runtime.repository.updateAuthoringTask({
      task: { ...rest, status: 'completed', revision: currentTask.revision + 1, updatedAt: now, completedAt: now },
      expectedRevision: currentTask.revision,
      event: {
        taskId: currentTask.id,
        sequence: currentTask.revision + 1,
        kind: 'task-completed',
        attemptId,
        payload: { extensionId: saved.extension.id, revisionId: saved.revision.id },
        createdAt: now,
      },
    })
  }
}
