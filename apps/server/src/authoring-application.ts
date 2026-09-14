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
  async save(input: SaveInput): Promise<SaveResult> {
    if (this.#disposed) throw new Error('创造服务正在关闭。')
    const key =
      'taskId' in input ? input.taskId : `${input.agentId}:${input.episodeId}:${input.pluginId}:${input.packageId}`
    if (this.#saving.has(key)) throw new Error('该候选正在保存，请等待当前操作完成。')
    const saving = this.#save(input).finally(() => this.#saving.delete(key))
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
              throw new Error('只能保存该创造任务当前的精确候选。')
            }
            if (task.status !== 'ready' || attempt.state !== 'active' || !attempt.verification) {
              throw new Error('候选尚未完成真实运行和验证，不能保存为本地扩展。')
            }
            if (!attempt.runnerPluginId || !attempt.runnerPackageId) {
              throw new Error('候选缺少当前运行时身份，请重新运行后再保存。')
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
            throw new Error('创造任务身份无法解析。')
          })()
    const episode = runtime.repository.getEpisode(identity.episodeId)
    if (!episode || episode.agentId !== identity.agentId || episode.status !== 'active' || !episode.dshSessionId) {
      throw new Error('指定会话不是该智能体当前可保存动态 Package 的活动会话。')
    }
    const inventory = runtime.host.dynamicInventory(episode.dshSessionId)
    const row = inventory.find((candidate) => candidate.pluginId === identity.pluginId)
    if (!row?.packages.some((candidate) => candidate.packageId === identity.packageId)) {
      throw new Error('指定动态 Package 不属于该智能体的活动会话。')
    }
    const latestRun = row.latestRun
    if (
      row.currentPackageId !== identity.packageId ||
      row.activeRun?.packageId !== identity.packageId ||
      latestRun?.packageId !== identity.packageId ||
      latestRun.status !== 'running'
    ) {
      throw new Error('只能保存当前已真实运行成功、且没有审批或版本切换中的精确 Package。')
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
    const adapterVerification = 'scope' in verified && verified.scope === 'host-adapter' ? verified : undefined
    const scopedVerification =
      'scope' in verified && (verified.scope === 'host-adapter' || verified.scope === 'host-ui') ? verified : undefined
    const hasHostPages = verified.renderedPages.length > 0
    const sourceCode = authoringSnapshot?.code ?? inspection.code
    const saved = await runtime.extensionService.saveDynamicPackage({
      snapshot: {
        name: inspection.name,
        purpose: inspection.purpose,
        ...(sourceCode.host === undefined ? {} : { hostCode: sourceCode.host }),
        ...(sourceCode.client === undefined ? {} : { clientCode: sourceCode.client }),
        ...(hasHostPages ? { permissions: verified.permissions } : {}),
        contributions: verified.contributions,
        ...(authoringSnapshot === undefined ? {} : { resources: authoringSnapshot.resources }),
        ...(authoringSnapshot?.clientCss === undefined ? {} : { clientCss: authoringSnapshot.clientCss }),
      },
      slug: input.slug,
      displayName: input.displayName,
      description: input.description,
      ...(input.targetExtensionId === undefined ? {} : { extensionId: input.targetExtensionId }),
      createdByAgentId: identity.agentId,
      verification: {
        dshVersion: '0.1.1-rc.2',
        contractVersion: hasHostPages
          ? 'nekro-nxt-extension-v3'
          : adapterVerification
            ? 'nekro-nxt-extension-v2'
            : 'nekro-nxt-extension-v1',
        ...(scopedVerification === undefined ? {} : { scope: scopedVerification.scope }),
        ...(adapterVerification === undefined ? {} : { adapter: adapterVerification.adapter }),
        origin: {
          episodeId: identity.episodeId,
          pluginId: identity.pluginId,
          packageId: identity.packageId,
          pluginRunId: verified.pluginRunId,
        },
        toolInvocations: verified.toolInvocations,
        rpcMethods: verified.rpcMethods,
        renderedSlots: verified.renderedSlots,
        ...(verified.renderedHostSlots.length === 0 ? {} : { renderedHostSlots: verified.renderedHostSlots }),
        ...(hasHostPages
          ? {
              renderedPages: verified.renderedPages,
              usedUiComponents: verified.usedUiComponents,
              pageGeometry: verified.pageGeometry,
              permissions: verified.permissions,
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
