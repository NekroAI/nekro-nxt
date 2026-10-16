import type { AgentId, ExtensionId } from '@nekro-nxt/contracts'
import type { LocalExtension } from '@nekro-nxt/extension-runtime'
import type { NekroRuntime } from '../bootstrap.js'
import type { CommandGovernanceContext, CommandGovernancePort } from '../commands/types.js'
import type { ExtensionAction } from './actions.js'
import { extensionVersions } from './versions.js'

const ADMIN_ONLY = '只有 NekroNXT 管理员可以这样做。管理员在设置的「管理员」里配置。'

const SUBCOMMANDS = new Set([
  'list',
  'info',
  'approve',
  'reject',
  'run',
  'enable',
  'disable',
  'revert',
  'use',
  'save',
  'continue',
  'update',
  'publish',
])

/**
 * `/ext` and `/admin`: chat-side management of the agent's extensions and of administrator accounts. Reading is open
 * to everyone in the channel; anything that changes an extension needs an instance administrator, and actions that
 * grant high-risk permissions still go to the console.
 */
export class ExtensionCommandPort implements CommandGovernancePort {
  readonly #runtime: NekroRuntime

  constructor(runtime: NekroRuntime) {
    this.#runtime = runtime
  }

  async ext(
    input: { readonly subcommand?: string; readonly target?: string; readonly value?: string },
    context: CommandGovernanceContext,
  ): Promise<string> {
    const subcommand = (input.subcommand ?? 'list').toLowerCase()
    if (!SUBCOMMANDS.has(subcommand)) return `不认识的操作：${input.subcommand ?? ''}。输入 /help ext 查看用法。`
    if (subcommand === 'list') return this.#overview(context)
    if (subcommand === 'info') return this.#info(this.#extension(input.target, context.agentId))
    if (!context.administrator) throw new Error(ADMIN_ONLY)
    const decider = { kind: 'administrator' as const, label: context.identity.displayName }
    const actor = context.identity.source === 'web' ? ({ kind: 'console' } as const) : decider
    // A task name after approve, reject or run means the candidate that task is waiting to run.
    if (
      subcommand === 'run' ||
      ((subcommand === 'approve' || subcommand === 'reject') && !this.#isNumber(input.target))
    ) {
      const task = this.#waitingTask(input.target, context.agentId)
      if (subcommand === 'reject') {
        await this.#runtime.host.rejectWaitingAuthoringCandidate(task.id)
        return `已拒绝运行「${task.title}」的候选，${this.#agentName(task.agentId)}会收到通知。`
      }
      this.#runtime.host.approveWaitingAuthoringCandidate(task.id)
      return `已允许运行「${task.title}」的候选。打开着的 NekroNXT 页面或后台浏览器会接着加载界面并完成验证，结果会发给${this.#agentName(task.agentId)}。`
    }
    switch (subcommand) {
      case 'approve': {
        const number = this.#number(input.target)
        // The outcome of the request itself is the reply, not a command failure: no usage hint after it.
        try {
          const result = await this.#runtime.extensionRequests.approve(
            number,
            actor.kind === 'console' ? actor : decider,
            context.channelId,
          )
          return `已同意请求 #${number}：${result.message}`
        } catch (error) {
          if (this.#runtime.extensionRequests.get(number)?.status !== 'failed') throw error
          return `已同意请求 #${number}，但没有完成：${error instanceof Error ? error.message : String(error)}`
        }
      }
      case 'reject': {
        const number = this.#number(input.target)
        this.#runtime.extensionRequests.reject(
          number,
          actor.kind === 'console' ? actor : decider,
          input.value,
          context.channelId,
        )
        return `已拒绝请求 #${number}。`
      }
      case 'save': {
        const task = this.#task(input.target, context.agentId)
        return this.#act({ kind: 'save', taskId: task.id }, actor)
      }
      case 'continue': {
        const task = this.#task(input.target, context.agentId, true)
        const told = this.#runtime.host.notifyAgent({
          agentId: task.agentId,
          channelId: context.channelId,
          identity: `ext-continue:${task.id}:${Date.now()}`,
          text: `〔系统通知〕管理员请你继续创造任务「${task.title}」（${task.id}）。用 nekro_nxt_extension_continue 把它接到这次对话里，接着把它做完。`,
        })
        return told
          ? `已请${this.#agentName(task.agentId)}继续「${task.title}」。`
          : '智能体现在不在线，等它下次回应时再试。'
      }
      default: {
        const extension = this.#extension(input.target, context.agentId)
        const agentId = context.agentId
        const action: ExtensionAction | undefined =
          subcommand === 'enable' || subcommand === 'disable'
            ? agentId === undefined
              ? undefined
              : { kind: subcommand, extensionId: extension.id, agentId }
            : subcommand === 'revert'
              ? { kind: 'revert', extensionId: extension.id }
              : subcommand === 'use'
                ? {
                    kind: 'switch',
                    extensionId: extension.id,
                    revisionId: this.#revisionByLabel(extension.id, input.value),
                  }
                : subcommand === 'update'
                  ? { kind: 'community-update', extensionId: extension.id }
                  : { kind: 'community-publish', extensionId: extension.id, notes: input.value ?? '' }
        if (!action) throw new Error('这个频道还没有绑定智能体。')
        return this.#act(action, actor)
      }
    }
  }

  admin(
    input: { readonly action?: string; readonly value?: string },
    context: CommandGovernanceContext,
  ): Promise<string> {
    return Promise.resolve().then(() => this.#admin(input, context))
  }

  #admin(input: { readonly action?: string; readonly value?: string }, context: CommandGovernanceContext): string {
    const action = (input.action ?? 'list').toLowerCase()
    if (action === 'claim') {
      if (context.identity.source === 'web') return '控制台登录者本来就是管理员，不需要认领。'
      const { connectionId, platformUserId } = context.identity
      if (connectionId === undefined || platformUserId === undefined) throw new Error('无法识别你的平台账号。')
      const connection = this.#runtime.repository.getConnection(connectionId)
      const view = this.#runtime.administrators.claim({
        code: input.value ?? '',
        connectionId,
        platformUserId,
        displayName: context.identity.displayName,
        self: connection?.accountKey === platformUserId,
      })
      return `${view.displayName}（${view.connectionName}）已成为 NekroNXT 管理员。`
    }
    if (action === 'list') {
      if (!context.administrator) throw new Error(ADMIN_ONLY)
      const list = this.#runtime.administrators.list()
      return list.length === 0
        ? '还没有平台账号管理员；控制台登录者始终是管理员。'
        : [
            '管理员：',
            ...list.map((entry, index) => `${index + 1}. ${entry.displayName}（${entry.connectionName}）`),
          ].join('\n')
    }
    return `不认识的操作：${input.action ?? ''}。可用：claim、list。`
  }

  async #act(
    action: ExtensionAction,
    actor: { readonly kind: 'console' } | { readonly kind: 'administrator'; readonly label: string },
  ) {
    const assessment = this.#runtime.extensionActions.assess(action, actor)
    if (assessment.decision === 'console') throw new Error(assessment.reason ?? '这件事需要在 NekroNXT 后台处理。')
    const result = await this.#runtime.extensionActions.perform(action, actor)
    return result.message
  }

  #overview(context: CommandGovernanceContext): string {
    const agentId = context.agentId
    if (agentId === undefined) return '这个频道还没有绑定智能体。'
    const runtime = this.#runtime
    const extensions = this.#agentExtensions(agentId)
    const lines: string[] = [`${this.#agentName(agentId)}的扩展：`]
    if (extensions.length === 0) lines.push('（还没有）')
    for (const extension of extensions) {
      const current = runtime.repository.getHostInstallation(extension.id)?.extensionRevisionId
      const label =
        current === undefined
          ? ''
          : (extensionVersions(runtime.repository, runtime.extensionService, extension.id).get(current)?.label ?? '')
      const enabled = runtime.repository.getActivation(agentId, extension.id) !== undefined
      lines.push(`· ${extension.displayName} ${label}${enabled ? '（已启用）' : '（未启用）'}`)
    }
    const tasks = runtime.repository
      .listAuthoringTasks(agentId)
      .filter((task) => !['completed', 'stopped', 'interrupted'].includes(task.status))
    if (tasks.length > 0) {
      lines.push('进行中的创造任务：')
      for (const task of tasks) lines.push(`· ${task.title}（${TASK_STATUS[task.status] ?? task.status}）`)
      if (tasks.some((task) => task.status === 'awaiting-approval'))
        lines.push('管理员发送 /ext run 任务名称 允许候选运行，/ext reject 任务名称 拒绝。')
    }
    const pending = runtime.extensionRequests.list('pending').filter((request) => request.agentId === agentId)
    if (pending.length > 0) {
      lines.push('待管理员确认：')
      for (const request of pending) lines.push(`#${request.number} ${request.summary}`)
    }
    return lines.join('\n')
  }

  #info(extension: LocalExtension): string {
    const runtime = this.#runtime
    const versions = extensionVersions(runtime.repository, runtime.extensionService, extension.id)
    const current = runtime.repository.getHostInstallation(extension.id)?.extensionRevisionId
    const sync = runtime.communitySync.cachedItem(extension.id)
    const lines = [
      `${extension.displayName}`,
      `当前版本：${current === undefined ? '未安装' : (versions.get(current)?.label ?? '')}`,
      `全部版本：${[...versions.values()].map((version) => version.label).join('、')}`,
      `数据格式：第 ${runtime.extensionData.dataVersion(extension.id)} 版`,
    ]
    if (extension.branchOf !== undefined) {
      lines.push(
        `分支自：${runtime.repository.getExtension(extension.branchOf.extensionId)?.displayName ?? '另一个扩展'}`,
      )
    }
    if (sync) lines.push(`社区：${SYNC_STATUS[sync.status]}`)
    return lines.join('\n')
  }

  #agentExtensions(agentId: AgentId): readonly LocalExtension[] {
    const runtime = this.#runtime
    return runtime.repository
      .listExtensions()
      .filter(
        (extension) =>
          extension.createdByAgentId === agentId ||
          runtime.repository.getActivation(agentId, extension.id) !== undefined,
      )
  }

  #extension(name: string | undefined, agentId: AgentId | undefined): LocalExtension {
    if (name === undefined || name.trim() === '') throw new Error('请写上扩展名称。')
    const query = name.trim()
    const pool = agentId === undefined ? this.#runtime.repository.listExtensions() : this.#agentExtensions(agentId)
    const all = this.#runtime.repository.listExtensions()
    const match = (list: readonly LocalExtension[]) =>
      list.find((extension) => extension.displayName === query || extension.slug === query) ??
      list.find((extension) => extension.displayName.includes(query))
    const found = match(pool) ?? match(all)
    if (!found) throw new Error(`找不到扩展「${query}」。`)
    return found
  }

  #revisionByLabel(extensionId: ExtensionId, label: string | undefined) {
    if (label === undefined) throw new Error('请写上要切换到的版本，例如 v2。')
    const normalized = label
      .trim()
      .toLowerCase()
      .replace(/^(?!v)/u, 'v')
    for (const version of extensionVersions(
      this.#runtime.repository,
      this.#runtime.extensionService,
      extensionId,
    ).values()) {
      if (version.label.toLowerCase() === normalized) return version.revisionId
    }
    throw new Error(`没有版本 ${label}。`)
  }

  #task(name: string | undefined, agentId: AgentId | undefined, allowPaused = false) {
    const tasks = this.#runtime.repository
      .listAuthoringTasks(agentId)
      .filter((task) =>
        allowPaused
          ? !['completed', 'stopped'].includes(task.status)
          : task.status === 'ready' || task.status === 'paused',
      )
    const query = name?.trim()
    const found =
      query === undefined || query === ''
        ? tasks.length === 1
          ? tasks[0]
          : undefined
        : (tasks.find((task) => task.title === query || task.id === query) ??
          tasks.find((task) => task.title.includes(query)))
    if (!found) throw new Error(query ? `找不到任务「${query}」。` : '有多个任务，请写上任务名称。')
    return found
  }

  #isNumber(value: string | undefined): boolean {
    return /^#?\d+$/u.test((value ?? '').trim())
  }

  /** The task whose candidate waits for someone to allow it to run; with one waiting, the name may be left out. */
  #waitingTask(name: string | undefined, agentId: AgentId | undefined) {
    const tasks = this.#runtime.repository
      .listAuthoringTasks(agentId)
      .filter((task) => task.status === 'awaiting-approval')
    const query = name?.trim()
    const found =
      query === undefined || query === ''
        ? tasks.length === 1
          ? tasks[0]
          : undefined
        : (tasks.find((task) => task.title === query || task.id === query) ??
          tasks.find((task) => task.title.includes(query)))
    if (found) return found
    if (tasks.length === 0) throw new Error('现在没有等待确认运行的候选。')
    throw new Error(
      query
        ? `找不到等待确认的任务「${query}」。等待中的有：${tasks.map((task) => task.title).join('、')}。`
        : `有多个任务在等待确认，请写上任务名称：${tasks.map((task) => task.title).join('、')}。`,
    )
  }

  #number(value: string | undefined): number {
    const number = Number((value ?? '').replace(/^#/u, ''))
    if (!Number.isSafeInteger(number) || number <= 0) throw new Error('请写上请求编号，例如 /ext approve 12。')
    return number
  }

  #agentName(agentId: AgentId): string {
    return this.#runtime.repository.getAgent(agentId)?.revision.displayName ?? '智能体'
  }
}

const TASK_STATUS: Readonly<Record<string, string>> = {
  working: '正在开发',
  'awaiting-approval': '等待确认',
  running: '正在验证',
  ready: '可以保存',
  repairing: '正在修复',
  failed: '需要处理',
  paused: '已暂停',
}

const SYNC_STATUS: Readonly<Record<string, string>> = {
  same: '与社区最新发布一致',
  'remote-ahead': '社区有更新',
  'local-ahead': '本机有未发布的修改',
  diverged: '本机与社区各自有修改',
  unrelated: '与社区发布没有共同版本',
  unknown: '社区上没有找到',
}
