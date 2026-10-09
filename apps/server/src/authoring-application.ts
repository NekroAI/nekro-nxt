import type { HostApiContracts } from '@nekro-nxt/contracts'
import type { NekroRuntime } from './bootstrap.js'

type SaveInput = ReturnType<typeof HostApiContracts.saveExtensionFromDynamic.parseRequest>
type SaveResult = Awaited<ReturnType<NekroRuntime['extensionService']['saveDynamicPackage']>>

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
  async save(input: SaveInput): Promise<SaveResult> {
    if (this.#disposed) throw new Error('NekroNXT 正在关闭，请稍后再试。')
    const key =
      'taskId' in input ? input.taskId : `${input.agentId}:${input.episodeId}:${input.pluginId}:${input.packageId}`
    if (this.#saving.has(key)) throw new Error('这个候选正在保存，请稍候。')
    const saving = this.#save(input)
      .then(async (result) => {
        // The saved extension asks for its own credentials when enabled; task test credentials end here.
        if ('taskId' in input) await this.#runtime.authoringTestSecrets.clear(input.taskId)
        return result
      })
      .finally(() => this.#saving.delete(key))
    this.#saving.set(key, saving)
    return saving
  }
  async dispose(): Promise<void> {
    this.#disposed = true
    await Promise.allSettled([...this.#saving.values()])
  }
  async #save(input: SaveInput): Promise<SaveResult> {
    const runtime = this.#runtime
    if ('taskId' in input) {
      const initialTask = runtime.repository.getAuthoringTask(input.taskId)
      const initialEpisode = initialTask ? runtime.repository.getEpisode(initialTask.episodeId) : undefined
      if (
        initialTask &&
        initialEpisode?.agentId === initialTask.agentId &&
        initialEpisode.status === 'active' &&
        initialEpisode.dshSessionId
      ) {
        await runtime.host.whenAuthoringSettled(initialEpisode.dshSessionId)
      }
    }
    const authoringIdentity =
      'taskId' in input
        ? (() => {
            const task = runtime.repository.getAuthoringTask(input.taskId)
            const attempt = runtime.repository.getAuthoringAttempt(input.attemptId)
            const latestAttempt = task ? runtime.repository.listAuthoringAttempts(task.id).at(-1) : undefined
            if (!task || !attempt || attempt.taskId !== task.id || latestAttempt?.id !== attempt.id) {
              throw new Error('只能保存这个任务最新的候选。')
            }
            if (task.status !== 'ready' || attempt.state !== 'active' || !attempt.verification) {
              throw new Error('这个候选还没有试运行成功，暂时不能保存。')
            }
            if (!attempt.runnerPluginId || !attempt.runnerPackageId) {
              throw new Error('请重新试运行后再保存。')
            }
            return {
              task,
              attempt,
              agentId: task.agentId,
              episodeId: task.episodeId,
              pluginId: attempt.runnerPluginId,
              packageId: attempt.runnerPackageId,
            }
          })()
        : undefined
    const identity = authoringIdentity
      ? {
          agentId: authoringIdentity.agentId,
          episodeId: authoringIdentity.episodeId,
          pluginId: authoringIdentity.pluginId,
          packageId: authoringIdentity.packageId,
        }
      : 'agentId' in input
        ? {
            agentId: input.agentId,
            episodeId: input.episodeId,
            pluginId: input.pluginId,
            packageId: input.packageId,
          }
        : (() => {
            throw new Error('Authoring task identity cannot be resolved.')
          })()
    const episode = runtime.repository.getEpisode(identity.episodeId)
    if (!episode || episode.agentId !== identity.agentId || episode.status !== 'active' || !episode.dshSessionId) {
      throw new Error("Session is not the agent's active session.")
    }
    const inventory = runtime.host.dynamicInventory(episode.dshSessionId)
    const row = inventory.find((candidate) => candidate.pluginId === identity.pluginId)
    if (!row?.packages.some((candidate) => candidate.packageId === identity.packageId)) {
      throw new Error("Package does not belong to the agent's active session.")
    }
    const latestRun = row.latestRun
    if (
      row.currentPackageId !== identity.packageId ||
      row.activeRun?.packageId !== identity.packageId ||
      latestRun?.packageId !== identity.packageId ||
      latestRun.status !== 'running'
    ) {
      throw new Error('这个候选还没有试运行成功，或者还在等待批准，暂时不能保存。')
    }
    const inspection = runtime.host.inspectDynamicPackage(episode.dshSessionId, identity.pluginId, identity.packageId)
    const authoringSnapshot = await runtime.host.dynamicAuthoringSnapshot(
      episode.dshSessionId,
      identity.pluginId,
      identity.packageId,
    )
    const verified = await runtime.host.verifyDynamicPackage(
      episode.dshSessionId,
      identity.pluginId,
      identity.packageId,
    )
    if (verified.permissions.agent?.mcp !== undefined) {
      throw new Error('动态创造不能声明 MCP 服务；请在工坊用「添加 MCP 服务」连接。')
    }
    const hasHostPages = verified.renderedPages.length > 0
    const sourceCode = authoringSnapshot?.code ?? inspection.code
    const saved = await runtime.extensionService.saveDynamicPackage({
      snapshot: {
        name: inspection.name,
        purpose: inspection.purpose,
        ...(sourceCode.host === undefined ? {} : { hostCode: sourceCode.host }),
        ...(sourceCode.client === undefined ? {} : { clientCode: sourceCode.client }),
        permissions: verified.permissions,
        contributions: verified.contributions,
        ...(authoringSnapshot?.config === undefined ? {} : { config: authoringSnapshot.config }),
        ...(authoringSnapshot === undefined ? {} : { resources: authoringSnapshot.resources }),
        ...(authoringSnapshot?.clientCss === undefined ? {} : { clientCss: authoringSnapshot.clientCss }),
        ...(authoringSnapshot?.icon === undefined ? {} : { icon: authoringSnapshot.icon }),
      },
      slug: input.slug,
      displayName: input.displayName,
      description: input.description,
      ...(input.targetExtensionId === undefined ? {} : { extensionId: input.targetExtensionId }),
      createdByAgentId: identity.agentId,
      verification: {
        dshVersion: DSH_RUNTIME_RELEASE.dshVersion,
        contractVersion: 'nekro-nxt-extension-v5',
        ...(verified.adapter === undefined ? {} : { adapter: verified.adapter }),
        origin: {
          episodeId: identity.episodeId,
          pluginId: identity.pluginId,
          packageId: identity.packageId,
          pluginRunId: verified.pluginRunId,
        },
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
    })
    if (authoringIdentity) {
      const currentTask = runtime.repository.getAuthoringTask(authoringIdentity.task.id)
      const currentAttempt = currentTask ? runtime.repository.listAuthoringAttempts(currentTask.id).at(-1) : undefined
      if (currentTask?.status === 'ready' && currentAttempt?.id === authoringIdentity.attempt.id) {
        const now = Date.now()
        runtime.repository.updateAuthoringTask({
          task: {
            ...currentTask,
            status: 'completed',
            revision: currentTask.revision + 1,
            updatedAt: now,
            completedAt: now,
          },
          expectedRevision: currentTask.revision,
          event: {
            taskId: currentTask.id,
            sequence: currentTask.revision + 1,
            kind: 'task-completed',
            attemptId: currentAttempt.id,
            payload: { extensionId: saved.extension.id, revisionId: saved.revision.id },
            createdAt: now,
          },
        })
      }
    }
    return saved
  }
}
import { DSH_RUNTIME_RELEASE } from '@nekro-nxt/dsh-compat/release'
