import {
  type AgentId,
  type AuthoringTaskId,
  type ChannelId,
  type CommunityPermissionItem,
  type ExtensionId,
  type ExtensionRevisionId,
  type JsonValue,
} from '@nekro-nxt/contracts'
import {
  ExtensionDataDowngradeError,
  addedPermissionItems,
  highestPermissionLevel,
  parseExtensionImport,
  summarizePermissions,
  type ExtensionDataMigrationMode,
  type PermissionItem,
  type PermissionLevel,
  type Revision,
} from '@nekro-nxt/extension-runtime'
import type { NekroRuntime } from '../bootstrap.js'
import { DEEPSEEK_HARNESS_VERSION } from '../dsh-version.js'
import { createExtensionRevisionExport } from '../host-route-support.js'
import { ExtensionConfigMigration } from './config-migration.js'
import { extensionVersions } from './versions.js'

/** Who asks for an extension action. Console and administrators act for themselves; agents are bound by autonomy. */
export type ExtensionActor =
  | { readonly kind: 'console' }
  | { readonly kind: 'administrator'; readonly label: string }
  | { readonly kind: 'agent'; readonly agentId: AgentId; readonly channelId?: ChannelId }

/** Every lifecycle step an agent, a chat command or the console can ask for; one implementation serves all three. */
export type ExtensionAction =
  | {
      readonly kind: 'save'
      readonly taskId: AuthoringTaskId
      readonly name?: string
      readonly slug?: string
      readonly description?: string
    }
  | { readonly kind: 'enable'; readonly extensionId: ExtensionId; readonly agentId: AgentId }
  | { readonly kind: 'disable'; readonly extensionId: ExtensionId; readonly agentId: AgentId }
  | { readonly kind: 'switch'; readonly extensionId: ExtensionId; readonly revisionId: ExtensionRevisionId }
  | { readonly kind: 'rollback'; readonly extensionId: ExtensionId }
  | {
      readonly kind: 'branch'
      readonly revisionId: ExtensionRevisionId
      readonly name: string
      readonly slug?: string
      readonly copyData: boolean
    }
  | {
      readonly kind: 'migrate-data'
      readonly targetExtensionId: ExtensionId
      readonly source:
        | { readonly kind: 'extension'; readonly extensionId: ExtensionId }
        | { readonly kind: 'snapshot'; readonly snapshotId: string }
      readonly mode: ExtensionDataMigrationMode
      /** Also move the host and agent configuration; credentials never move. */
      readonly includeConfig?: boolean
    }
  | {
      readonly kind: 'community-publish'
      readonly extensionId: ExtensionId
      readonly revisionId?: ExtensionRevisionId
      readonly notes: string
    }
  | { readonly kind: 'community-update'; readonly extensionId: ExtensionId }
  | { readonly kind: 'community-install'; readonly communityExtensionId: string; readonly agentId?: AgentId }
  | { readonly kind: 'community-withdraw'; readonly releaseId: string }

/**
 * What an actor may do about an action right now: `run` it, `request` an administrator's confirmation, or do it in
 * the `console` only.
 */
export interface ExtensionActionAssessment {
  readonly decision: 'run' | 'request' | 'console'
  /** Why it is not `run`; shown to the agent and in the request. */
  readonly reason?: string
  /** One line naming what will happen, used in requests and receipts. */
  readonly summary: string
  readonly level: PermissionLevel
  /** Permission items the action grants that are not granted yet. */
  readonly added: readonly (PermissionItem | CommunityPermissionItem)[]
}

export interface ExtensionActionResult {
  readonly message: string
  readonly extensionId?: ExtensionId
  readonly revisionId?: ExtensionRevisionId
  /** Community release a publish created; its review result is reported back to the channel later. */
  readonly releaseId?: string
}

const OUTWARD: readonly ExtensionAction['kind'][] = ['community-publish', 'community-withdraw']

const slugFrom = (name: string, fallback: string): string => {
  const ascii = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replaceAll(/^-+|-+$/gu, '')
  return ascii.length >= 3 ? ascii.slice(0, 48) : `${fallback}-${Date.now().toString(36)}`
}

/**
 * Extension lifecycle actions behind the workshop, the `/ext` commands and the agent's extension tools. It decides
 * whether the actor may act (agents follow their autonomy level and the permission risk), and performs the action
 * with the approvals the decision implies.
 */
export class ExtensionActionService {
  readonly #runtime: NekroRuntime

  constructor(runtime: NekroRuntime) {
    this.#runtime = runtime
  }

  // —— Assessment ——

  assess(action: ExtensionAction, actor: ExtensionActor): ExtensionActionAssessment {
    const { summary, level, added, affectsOthers } = this.#describe(action)
    const base = { summary, level, added }
    if (actor.kind === 'console') return { ...base, decision: 'run' }
    if (actor.kind === 'administrator') {
      return level === 'high'
        ? { ...base, decision: 'console', reason: '涉及高风险权限，需要在 NekroNXT 后台确认。' }
        : { ...base, decision: 'run' }
    }
    const agent = this.#runtime.repository.getAgent(actor.agentId)
    const autonomy = agent?.revision.capabilities.extensionAutonomy ?? 'manual'
    if (autonomy === 'manual') {
      return { ...base, decision: 'console', reason: '这个智能体的扩展自主权是「手动」，需要在工坊里操作。' }
    }
    const scope = this.#agentScope(action, actor.agentId)
    if (scope !== undefined) return { ...base, decision: 'console', reason: scope }
    if (level === 'high') {
      return { ...base, decision: 'console', reason: '涉及高风险权限，需要在 NekroNXT 后台确认。' }
    }
    if (OUTWARD.includes(action.kind)) {
      return { ...base, decision: 'request', reason: '会在社区公开，需要管理员确认。' }
    }
    if (action.kind === 'migrate-data') {
      return { ...base, decision: 'request', reason: '会改写已有数据，需要管理员确认。' }
    }
    if (affectsOthers) return { ...base, decision: 'request', reason: '会影响其他智能体，需要管理员确认。' }
    if (autonomy === 'confirm') return { ...base, decision: 'request', reason: '需要管理员确认。' }
    if (level === 'elevated') {
      return { ...base, decision: 'request', reason: '需要提升级权限，需要管理员确认。' }
    }
    return { ...base, decision: 'run' }
  }

  // —— Execution ——

  /** Performs an action the actor was cleared for; approvals of the permissions it grants are implied. */
  async perform(action: ExtensionAction, actor: ExtensionActor): Promise<ExtensionActionResult> {
    const runtime = this.#runtime
    switch (action.kind) {
      case 'save': {
        const saved = await runtime.authoring.saveTask({
          taskId: action.taskId,
          ...(action.name === undefined ? {} : { name: action.name }),
          ...(action.slug === undefined ? {} : { slug: action.slug }),
          ...(action.description === undefined ? {} : { description: action.description }),
        })
        const label = this.#label(saved.revision)
        return {
          message: `已保存「${saved.extension.displayName}」${label}。`,
          extensionId: saved.extension.id,
          revisionId: saved.revision.id,
        }
      }
      case 'enable': {
        const revision = this.#currentRevision(action.extensionId)
        const coordinator = runtime.extensions
        const host = coordinator.hostRequirement(action.extensionId, revision.id)
        const agent = coordinator.agentRequirement(action.agentId, action.extensionId, revision.id)
        await coordinator.activate({
          agentId: action.agentId,
          extensionId: action.extensionId,
          revisionId: revision.id,
          ...(agent.approvalRequired ? { permissionApproval: { permissionDigest: agent.permissionDigest } } : {}),
          ...(host.approvalRequired ? { hostPermissionApproval: { permissionDigest: host.permissionDigest } } : {}),
        })
        return {
          message: `已给${this.#agentName(action.agentId)}启用「${this.#extensionName(action.extensionId)}」。`,
          extensionId: action.extensionId,
          revisionId: revision.id,
        }
      }
      case 'disable': {
        await runtime.extensions.disable(action.agentId, action.extensionId)
        return {
          message: `已给${this.#agentName(action.agentId)}停用「${this.#extensionName(action.extensionId)}」。`,
          extensionId: action.extensionId,
        }
      }
      case 'switch':
        return this.#switch(action.extensionId, action.revisionId)
      case 'rollback': {
        const previous = runtime.extensionData.latestSwitch(action.extensionId)
        if (!previous) throw new Error('没有找到上一次切换的记录，请在扩展详情里选择要切回的版本。')
        const revision = runtime.repository.getExtensionRevision(previous.fromRevisionId as ExtensionRevisionId)
        if (!revision) throw new Error('上一个版本已经不在本机。')
        return this.#switch(action.extensionId, revision.id, previous.snapshotId)
      }
      case 'branch': {
        const source = runtime.repository.getExtensionRevision(action.revisionId)
        if (!source) throw new Error('要分支的版本不存在。')
        const branched = await runtime.extensionService.createBranch({
          source,
          slug: action.slug ?? slugFrom(action.name, 'branch'),
          displayName: action.name,
          description: runtime.repository.getExtension(source.extensionId)?.description ?? '',
          ...(actor.kind === 'agent' ? { createdByAgentId: actor.agentId } : {}),
          dshVersion: DEEPSEEK_HARNESS_VERSION,
        })
        if (action.copyData) runtime.extensionData.copyAll(source.extensionId, branched.extension.id)
        return {
          message: `已创建分支「${branched.extension.displayName}」${action.copyData ? '，并复制了现有数据' : ''}。`,
          extensionId: branched.extension.id,
          revisionId: branched.revision.id,
        }
      }
      case 'migrate-data': {
        const result = await runtime.extensions.withStopped(action.targetExtensionId, () =>
          runtime.extensionData.migrate({
            source: action.source,
            targetExtensionId: action.targetExtensionId,
            mode: action.mode,
            scope: { owners: 'all', index: true, library: true },
          }),
        )
        const config =
          action.includeConfig === true
            ? await new ExtensionConfigMigration(runtime).apply({
                source: action.source,
                targetExtensionId: action.targetExtensionId,
                mode: action.mode,
              })
            : undefined
        const { storage, index, library } = result.preview.diff
        const configNote =
          config === undefined
            ? ''
            : `；配置改了 ${config.hostFields.length + config.agents.reduce((sum, entry) => sum + entry.fields.length, 0)} 项（凭据不迁移）`
        return {
          message: `已把数据迁移到「${this.#extensionName(action.targetExtensionId)}」：记录新增 ${storage.added}、覆盖 ${storage.overwritten}、删除 ${storage.removed}；索引 ${index.added + index.overwritten} 条；素材 ${library.added} 个${configNote}。迁移前的数据已留快照，可以恢复。`,
          extensionId: action.targetExtensionId,
        }
      }
      case 'community-publish':
        return this.#publish(action.extensionId, action.revisionId, action.notes)
      case 'community-update':
        return this.#communityUpdate(action.extensionId)
      case 'community-install':
        return this.#communityInstall(action.communityExtensionId, action.agentId)
      case 'community-withdraw': {
        await runtime.community.withdraw(action.releaseId)
        return { message: '已撤回这次发布。' }
      }
    }
  }

  // —— Internals ——

  async #switch(
    extensionId: ExtensionId,
    revisionId: ExtensionRevisionId,
    restoreSnapshotId?: string,
  ): Promise<ExtensionActionResult> {
    const coordinator = this.#runtime.extensions
    const host = coordinator.hostRequirement(extensionId, revisionId)
    const agents = coordinator.switchAgentRequirement(extensionId, revisionId)
    const revision = this.#runtime.repository.getExtensionRevision(revisionId)
    if (!revision) throw new Error('目标版本不存在。')
    const install = (restore?: string) =>
      coordinator.install({
        extensionId,
        revisionId,
        ...(host.approvalRequired ? { permissionApproval: { permissionDigest: host.permissionDigest } } : {}),
        ...(agents?.approvalRequired ? { agentPermissionApproval: { permissionDigest: agents.permissionDigest } } : {}),
        ...(restore === undefined ? {} : { restoreDataSnapshotId: restore }),
      })
    try {
      await install()
    } catch (error) {
      if (!(error instanceof ExtensionDataDowngradeError) || restoreSnapshotId === undefined) throw error
      await install(restoreSnapshotId)
    }
    return {
      message: `「${this.#extensionName(extensionId)}」已切换到 ${this.#label(revision)}。`,
      extensionId,
      revisionId,
    }
  }

  /**
   * Publishes one Revision with its lineage and records the release here, so this machine owns the line and knows
   * which public version its local one is.
   */
  async publishRevision(input: {
    readonly extensionId: ExtensionId
    readonly revisionId?: ExtensionRevisionId | undefined
    readonly notes: string
    readonly listing?: Parameters<NekroRuntime['community']['publish']>[0]['listing']
  }): Promise<Awaited<ReturnType<NekroRuntime['community']['publish']>> & { readonly revision: Revision }> {
    const runtime = this.#runtime
    const revision =
      input.revisionId === undefined
        ? this.#currentRevision(input.extensionId)
        : runtime.repository.getExtensionRevision(input.revisionId)
    if (!revision || revision.extensionId !== input.extensionId) throw new Error('要发布的版本不存在。')
    const status = await runtime.community.status()
    if (!status.account) throw new Error('这台 NekroNXT 还没有登录社区，请先在「社区 → 账号」登录。')
    const exported = await createExtensionRevisionExport(runtime, input.extensionId, revision.id)
    const published = await runtime.community.publish({
      filename: exported.filename,
      body: exported.body,
      notes: input.notes,
      ...(input.listing === undefined ? {} : { listing: input.listing }),
    })
    runtime.communitySync.recordPublish(revision, {
      releaseId: published.releaseId,
      number: published.releaseNumber,
      publisherHandle: status.account.handle,
    })
    return { ...published, revision }
  }

  async #publish(
    extensionId: ExtensionId,
    revisionId: ExtensionRevisionId | undefined,
    notes: string,
  ): Promise<ExtensionActionResult> {
    const { revision, releaseId } = await this.publishRevision({ extensionId, revisionId, notes })
    return {
      message: `已把「${this.#extensionName(extensionId)}」${this.#label(revision)} 发布到社区，审查结果出来后会再通知。`,
      extensionId,
      revisionId: revision.id,
      releaseId,
    }
  }

  async #importRelease(releaseId: string, publisherHandle: string, number: number | undefined): Promise<Revision> {
    const runtime = this.#runtime
    const bytes = await runtime.community.downloadRelease(releaseId)
    const parsed = parseExtensionImport(bytes)
    const slugTaken = runtime.repository.getExtensionBySlug(parsed.manifest.extension.slug)
    const result = await runtime.extensionService.importRevision({
      extension: parsed.manifest.extension,
      revision: parsed.manifest.revision,
      manifest: parsed.revisionManifest,
      sources: parsed.sources,
      resources: parsed.resources,
      dshVersion: DEEPSEEK_HARNESS_VERSION,
      origin: 'community',
      ...(slugTaken !== undefined && slugTaken.id !== parsed.manifest.extension.id
        ? { localSlug: `${parsed.manifest.extension.slug}-${Date.now().toString(36)}`.slice(0, 64) }
        : {}),
    })
    runtime.communitySync.recordInstall(result.revision, {
      releaseId,
      ...(number === undefined ? {} : { number }),
      publisherHandle,
    })
    return result.revision
  }

  async #communityUpdate(extensionId: ExtensionId): Promise<ExtensionActionResult> {
    const runtime = this.#runtime
    const item = runtime.communitySync.cachedItem(extensionId) ??
      (await runtime.communitySync.check()).items.find((entry) => entry.extensionId === extensionId)
    if (!item?.latest) throw new Error('社区上没有这个扩展可用的发布。')
    if (item.status === 'same') return { message: '已经是社区上的最新版本。', extensionId }
    const detail = await runtime.community.getExtension(extensionId)
    const revision = await this.#importRelease(item.latest.id, detail.publisher.handle, item.latest.number)
    const result = await this.#switch(extensionId, revision.id)
    await runtime.communitySync.check().catch(() => undefined)
    const number = item.latest.number === undefined ? '' : ` #${item.latest.number}`
    return { ...result, message: `已更新到社区最新发布${number}。${result.message}` }
  }

  async #communityInstall(communityExtensionId: string, agentId: AgentId | undefined): Promise<ExtensionActionResult> {
    const runtime = this.#runtime
    const detail = await runtime.community.getExtension(communityExtensionId)
    if (!detail.latest) throw new Error('这个扩展在社区上还没有可安装的发布。')
    const revision = await this.#importRelease(detail.latest.id, detail.publisher.handle, detail.latest.number)
    if (agentId !== undefined) {
      await this.perform({ kind: 'enable', extensionId: revision.extensionId, agentId }, { kind: 'console' })
    }
    return {
      message: `已从社区安装「${detail.displayName}」${agentId === undefined ? '' : `，并给${this.#agentName(agentId)}启用`}。`,
      extensionId: revision.extensionId,
      revisionId: revision.id,
    }
  }

  /** Summary, permission risk and reach of an action, computed from local facts only. */
  #describe(action: ExtensionAction): {
    readonly summary: string
    readonly level: PermissionLevel
    readonly added: readonly (PermissionItem | CommunityPermissionItem)[]
    readonly affectsOthers: boolean
  } {
    const runtime = this.#runtime
    const normal = { level: 'normal' as PermissionLevel, added: [], affectsOthers: false }
    const itemsOf = (revision: Revision | undefined): PermissionItem[] => {
      const manifest = revision === undefined ? undefined : runtime.extensionService.revisionManifest(revision)
      return manifest === undefined ? [] : summarizePermissions(manifest as unknown as Record<string, unknown>)
    }
    const otherAgents = (extensionId: ExtensionId, except?: AgentId) =>
      runtime.repository.listActivations().some((activation) => activation.extensionId === extensionId && activation.agentId !== except)
    switch (action.kind) {
      case 'save': {
        const task = runtime.repository.getAuthoringTask(action.taskId)
        const target = task?.targetExtensionId === undefined ? undefined : runtime.repository.getExtension(task.targetExtensionId)
        return {
          ...normal,
          summary: target ? `保存「${target.displayName}」的新版本` : `保存新扩展「${action.name ?? task?.title ?? ''}」`,
        }
      }
      case 'enable': {
        const revision = this.#currentRevision(action.extensionId)
        const installed = runtime.repository.getHostInstallation(action.extensionId) !== undefined
        const items = itemsOf(revision).filter((item) => item.layer === 'agent' || !installed)
        return {
          summary: `给${this.#agentName(action.agentId)}启用「${this.#extensionName(action.extensionId)}」`,
          level: highestPermissionLevel(items),
          added: items,
          affectsOthers: false,
        }
      }
      case 'disable':
        return {
          ...normal,
          summary: `给${this.#agentName(action.agentId)}停用「${this.#extensionName(action.extensionId)}」`,
        }
      case 'switch':
      case 'rollback': {
        const current = this.#maybeCurrent(action.extensionId)
        const targetId =
          action.kind === 'switch'
            ? action.revisionId
            : (runtime.extensionData.latestSwitch(action.extensionId)?.fromRevisionId as ExtensionRevisionId | undefined)
        const target = targetId === undefined ? undefined : runtime.repository.getExtensionRevision(targetId)
        const added = addedPermissionItems(itemsOf(current), itemsOf(target))
        return {
          summary:
            action.kind === 'rollback'
              ? `把「${this.#extensionName(action.extensionId)}」回退到上一个版本${target ? ` ${this.#label(target)}` : ''}`
              : `把「${this.#extensionName(action.extensionId)}」切换到 ${target ? this.#label(target) : '指定版本'}`,
          level: highestPermissionLevel(added),
          added,
          affectsOthers: runtime.repository.listActivations().filter((entry) => entry.extensionId === action.extensionId).length > 1,
        }
      }
      case 'branch': {
        const source = runtime.repository.getExtensionRevision(action.revisionId)
        return {
          ...normal,
          summary: `从「${source ? this.#extensionName(source.extensionId) : ''}」${source ? this.#label(source) : ''} 创建分支「${action.name}」${action.copyData ? '并复制数据' : ''}`,
        }
      }
      case 'migrate-data':
        return {
          ...normal,
          summary: `把${action.source.kind === 'snapshot' ? '数据快照' : `「${this.#extensionName(action.source.extensionId)}」的数据`}${action.mode === 'replace' ? '替换' : '覆盖'}到「${this.#extensionName(action.targetExtensionId)}」`,
          affectsOthers: otherAgents(action.targetExtensionId),
        }
      case 'community-publish': {
        const revision =
          action.revisionId === undefined ? this.#maybeCurrent(action.extensionId) : runtime.repository.getExtensionRevision(action.revisionId)
        return {
          ...normal,
          summary: `把「${this.#extensionName(action.extensionId)}」${revision ? this.#label(revision) : ''} 发布到社区`,
        }
      }
      case 'community-update': {
        const item = runtime.communitySync.cachedItem(action.extensionId)
        return {
          summary: `把「${this.#extensionName(action.extensionId)}」更新到社区最新发布`,
          level: highestPermissionLevel(item?.addedPermissions ?? []),
          added: item?.addedPermissions ?? [],
          affectsOthers: otherAgents(action.extensionId),
        }
      }
      case 'community-install':
        return { ...normal, summary: '从社区安装扩展' }
      case 'community-withdraw':
        return { ...normal, summary: '撤回一次社区发布' }
    }
  }

  /** Why an agent may not touch this target at all, or undefined when it may. */
  #agentScope(action: ExtensionAction, agentId: AgentId): string | undefined {
    const runtime = this.#runtime
    const ownsExtension = (extensionId: ExtensionId) => {
      const extension = runtime.repository.getExtension(extensionId)
      return (
        extension?.createdByAgentId === agentId ||
        runtime.repository.getActivation(agentId, extensionId) !== undefined ||
        runtime.repository.listAuthoringTasks(agentId).some((task) => task.targetExtensionId === extensionId)
      )
    }
    switch (action.kind) {
      case 'save': {
        const task = runtime.repository.getAuthoringTask(action.taskId)
        return task?.agentId === agentId ? undefined : '只能保存自己的创造任务。'
      }
      case 'enable':
      case 'disable':
        return action.agentId === agentId ? undefined : '只能给自己启用或停用扩展。'
      case 'switch':
      case 'rollback':
      case 'community-update':
      case 'community-publish':
        return ownsExtension(action.extensionId) ? undefined : '只能管理自己做的或自己在用的扩展。'
      case 'branch': {
        const source = runtime.repository.getExtensionRevision(action.revisionId)
        return source !== undefined && ownsExtension(source.extensionId) ? undefined : '只能从自己做的或自己在用的扩展创建分支。'
      }
      case 'migrate-data':
        return ownsExtension(action.targetExtensionId) ? undefined : '只能迁移自己做的或自己在用的扩展的数据。'
      case 'community-install':
        return action.agentId === undefined || action.agentId === agentId ? undefined : '只能给自己安装启用。'
      case 'community-withdraw':
        return undefined
    }
  }

  #maybeCurrent(extensionId: ExtensionId): Revision | undefined {
    const installed = this.#runtime.repository.getHostInstallation(extensionId)?.extensionRevisionId
    const revisions = this.#runtime.repository.listExtensionRevisions(extensionId)
    return revisions.find((revision) => revision.id === installed) ?? revisions.at(-1)
  }

  #currentRevision(extensionId: ExtensionId): Revision {
    const revision = this.#maybeCurrent(extensionId)
    if (!revision) throw new Error('这个扩展没有可用的版本。')
    return revision
  }

  #label(revision: Revision): string {
    return extensionVersions(this.#runtime.repository, this.#runtime.extensionService, revision.extensionId).get(revision.id)?.label ?? ''
  }

  #extensionName(extensionId: ExtensionId): string {
    return this.#runtime.repository.getExtension(extensionId)?.displayName ?? '扩展'
  }

  #agentName(agentId: AgentId): string {
    return this.#runtime.repository.getAgent(agentId)?.revision.displayName ?? '智能体'
  }
}

export type { JsonValue }
