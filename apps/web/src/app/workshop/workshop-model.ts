import type { HostApiResponse } from '@nekro-nxt/contracts'
import type { Tone } from '../../ui-kit/index.js'
import type { LocalExtensionSummary } from '../../product-runtime.js'

export type AuthoringTask = HostApiResponse<'snapshot'>['authoringTasks'][number]
export type AuthoringAttempt = NonNullable<AuthoringTask['candidateAttempt']>
type AttemptError = NonNullable<AuthoringAttempt['error']>

/** Lifecycle shown above every task: candidate run phases, then the two independent user actions. */
export const LIFECYCLE = ['生成候选', '确认运行', '启动', '界面验证', '保存', '启用'] as const

const PHASE_STEP: Record<AttemptError['phase'], number> = {
  preflight: 0,
  approval: 1,
  'host-load': 2,
  'host-apply': 2,
  restore: 2,
  'client-load': 3,
  'client-apply': 3,
  'client-render': 3,
  verification: 3,
  settlement: 3,
}

const STATE_STEP: Record<AuthoringAttempt['state'], number> = {
  drafting: 0,
  'preflight-failed': 0,
  'awaiting-approval': 1,
  rejected: 1,
  'starting-host': 2,
  'loading-client': 3,
  verifying: 3,
  active: 4,
  failed: 3,
  stopped: 0,
}

export interface LifecyclePosition {
  readonly current: number
  readonly failed: boolean
}

/**
 * Where the task stands on {@link LIFECYCLE}. A completed task has been saved; it is fully done once the
 * originating agent uses the saved extension.
 */
export interface LifecycleInput {
  readonly status: AuthoringTask['status']
  readonly candidateAttempt?: Pick<AuthoringAttempt, 'state' | 'error'> | undefined
}

export const lifecyclePosition = (task: LifecycleInput, enabledForAgent: boolean): LifecyclePosition => {
  if (task.status === 'completed') return { current: enabledForAgent ? LIFECYCLE.length : 5, failed: false }
  const candidate = task.candidateAttempt
  if (!candidate) return { current: 0, failed: false }
  if (candidate.error) return { current: PHASE_STEP[candidate.error.phase], failed: true }
  if (candidate.state === 'preflight-failed' || candidate.state === 'rejected' || candidate.state === 'failed') {
    return { current: STATE_STEP[candidate.state], failed: true }
  }
  if (task.status === 'ready' && candidate.state === 'active') return { current: 4, failed: false }
  const halted = task.status === 'failed' || task.status === 'interrupted'
  return { current: Math.min(STATE_STEP[candidate.state], 3), failed: halted }
}

export const isTaskOpen = (task: Pick<AuthoringTask, 'status'>): boolean =>
  !['completed', 'stopped', 'interrupted'].includes(task.status)

export const taskStatus = (task: Pick<AuthoringTask, 'status'>): { readonly label: string; readonly tone: Tone } => {
  switch (task.status) {
    case 'awaiting-approval':
      return { label: '等待确认', tone: 'warn' }
    case 'ready':
      return { label: '可以保存', tone: 'ok' }
    case 'completed':
      return { label: '已保存', tone: 'neutral' }
    case 'failed':
    case 'interrupted':
      return { label: '需要处理', tone: 'bad' }
    case 'stopped':
      return { label: '已停止', tone: 'neutral' }
    case 'repairing':
      return { label: '正在修复', tone: 'accent' }
    case 'running':
      return { label: '正在验证', tone: 'accent' }
    case 'working':
      return { label: '正在开发', tone: 'accent' }
  }
}

export const attemptStateLabel: Record<AuthoringAttempt['state'], string> = {
  drafting: '正在生成',
  'preflight-failed': '预检失败',
  'awaiting-approval': '等待确认',
  'starting-host': '正在启动',
  'loading-client': '正在加载界面',
  verifying: '正在验证',
  active: '已通过验证',
  failed: '运行失败',
  rejected: '已拒绝',
  stopped: '已停止',
}

export const attemptPhaseLabel: Record<AttemptError['phase'], string> = {
  preflight: '预检',
  approval: '确认运行',
  'host-load': '服务端加载',
  'host-apply': '服务端启动',
  'client-load': '界面加载',
  'client-apply': '界面启动',
  'client-render': '界面渲染',
  verification: '结果验证',
  settlement: '收尾',
  restore: '恢复',
}

/** Open work first (needs the user, then in progress), then finished tasks; newest first within a group. */
export const sortTasks = <Task extends Pick<AuthoringTask, 'status' | 'updatedAt'>>(tasks: readonly Task[]): Task[] => {
  const rank = (task: Task): number =>
    task.status === 'awaiting-approval' || task.status === 'ready' || task.status === 'failed'
      ? 0
      : isTaskOpen(task)
        ? 1
        : 2
  return [...tasks].sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt)
}

const PROVIDE_LABEL: Readonly<Record<string, string>> = {
  agent: '智能体能力',
  page: '页面',
  adapter: '平台适配',
  mcp: 'MCP 服务',
}

/** What an extension provides, as one short line: 「智能体能力 · 页面」; labels this build does not know are skipped. */
export const providesLabel = (provides: readonly string[]): string => {
  const labels = provides.flatMap((item) => (PROVIDE_LABEL[item] === undefined ? [] : [PROVIDE_LABEL[item]]))
  return labels.length === 0 ? '扩展' : labels.join(' · ')
}

/** The parts of an extension that decide whether it has agent abilities and who uses it. */
export interface ExtensionUsageInput {
  readonly provides: LocalExtensionSummary['provides']
  readonly revisions: readonly Pick<LocalExtensionSummary['revisions'][number], 'id' | 'format' | 'agentLayer'>[]
  readonly installation?: Pick<NonNullable<LocalExtensionSummary['installation']>, 'revisionId' | 'runtime'> | undefined
  readonly activations: readonly Pick<LocalExtensionSummary['activations'][number], 'runtime'>[]
}

/** Whether the installed (or else the latest usable) record can be enabled for agents. */
export const hasAgentLayer = (extension: Pick<ExtensionUsageInput, 'revisions' | 'installation'>): boolean => {
  const installed = extension.revisions.find((revision) => revision.id === extension.installation?.revisionId)
  return (
    (installed ?? extension.revisions.findLast((revision) => revision.format !== 'unavailable'))?.agentLayer === true
  )
}

/** One short line describing who uses an extension right now. */
export const extensionUsage = (extension: ExtensionUsageInput): { readonly label: string; readonly tone: Tone } => {
  const broken =
    (extension.installation?.runtime !== undefined && extension.installation.runtime.status !== 'active') ||
    extension.activations.some((item) => item.runtime && item.runtime.status !== 'active')
  if (broken) return { label: '运行异常', tone: 'bad' }
  if (extension.activations.length > 0) {
    return { label: `${extension.activations.length} 个智能体使用`, tone: 'ok' }
  }
  if (hasAgentLayer(extension) && !extension.provides.some((item) => item === 'page' || item === 'adapter')) {
    // Installing an agent-only extension (e.g. to fill in its shared API key) does not enable it for any agent yet.
    return { label: extension.installation ? '已安装 · 未启用' : '未启用', tone: 'neutral' }
  }
  return extension.installation ? { label: '已安装', tone: 'ok' } : { label: '未安装', tone: 'neutral' }
}

// Longest prefix first: `工具视图` must not be read as `工具`.
const CONTRIBUTION = /^(工具视图|工具|RPC|面板|富消息|页面|适配器)[：:]\s*(.+)$/u

/** Splits the Host's `类型：名称` contribution strings into a kind label and a name. */
export const contributionParts = (value: string): { readonly kind: string; readonly name: string } => {
  const match = CONTRIBUTION.exec(value)
  if (!match) return { kind: '内容', name: value }
  const [, kind = '', name = ''] = match
  return { kind: kind === 'RPC' ? '数据接口' : kind, name }
}

/** Lowercase slug proposal from a display name; falls back to a time-based id for non-Latin names. */
export const proposeSlug = (name: string, now = Date.now()): string => {
  const ascii = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  return ascii.length >= 3 ? ascii.slice(0, 48) : `ext-${now.toString(36)}`
}

export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/u

/** Where an open or finished task sits in the list: needs the user, in progress, or done. */
export type TaskGroup = 'attention' | 'active' | 'ended'

export const TASK_GROUP_LABEL: Record<TaskGroup, string> = {
  attention: '等你处理',
  active: '进行中',
  ended: '已结束',
}

export const taskGroup = (task: Pick<AuthoringTask, 'status'>): TaskGroup =>
  task.status === 'awaiting-approval' || task.status === 'ready' || task.status === 'failed'
    ? 'attention'
    : isTaskOpen(task)
      ? 'active'
      : 'ended'

const pad = (value: number): string => String(value).padStart(2, '0')

const minuteLabel = (time: number): string => {
  const date = new Date(time)
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Saved records are told apart by when they were saved, never by their internal number. Records saved within the
 * same minute also show seconds.
 */
export const recordLabels = (
  records: readonly { readonly id: string; readonly createdAt: number }[],
): ReadonlyMap<string, string> => {
  const counts = new Map<string, number>()
  for (const record of records)
    counts.set(minuteLabel(record.createdAt), (counts.get(minuteLabel(record.createdAt)) ?? 0) + 1)
  return new Map(
    records.map((record) => {
      const label = minuteLabel(record.createdAt)
      return [
        record.id,
        (counts.get(label) ?? 0) > 1 ? `${label}:${pad(new Date(record.createdAt).getSeconds())}` : label,
      ]
    }),
  )
}

/** What a contribution kind gives the user and where it appears. */
export const CONTRIBUTION_PLACE: Record<string, string> = {
  工具: '智能体在对话中调用',
  工具视图: '在频道时间线里展示工具调用',
  面板: '出现在智能体页或频道检查器',
  页面: '独立页面，安装后也可以从顶栏「搜索」（⌘K）打开',
  富消息: '在频道里渲染平台富消息',
  适配器: '在接线里添加这个平台的账号',
  数据接口: '供扩展界面读取数据',
  内容: '扩展提供的内容',
  'MCP 服务': '启用后它提供的工具出现在智能体的对话中',
}

/** One line for the MCP servers of an Activation, e.g. 「已连接 · 3 个工具」 or 「缺少凭据：Authorization」. */
export const mcpStatusText = (
  servers: readonly {
    readonly name: string
    readonly state: 'connecting' | 'connected' | 'unavailable' | 'missing-credentials'
    readonly toolCount?: number | undefined
    readonly missing?: readonly string[] | undefined
    readonly message?: string | undefined
  }[],
): string =>
  servers
    .map((server) => {
      const prefix = servers.length > 1 ? `${server.name} ` : ''
      switch (server.state) {
        case 'connected':
          return `${prefix}已连接 · ${server.toolCount ?? 0} 个工具`
        case 'connecting':
          return `${prefix}正在连接`
        case 'missing-credentials':
          return `${prefix}缺少凭据：${(server.missing ?? []).join('、')}`
        case 'unavailable':
          return `${prefix}未连接：${server.message ?? '原因未知'}`
      }
    })
    .join('；')

/** MCP servers a Revision connects, as Overview rows; they are capabilities, not contributions. */
export const mcpParts = (
  servers: readonly {
    readonly transport: string
    readonly name: string
    readonly url?: string
    readonly command?: string
  }[],
): readonly { readonly kind: string; readonly name: string; readonly detail: string }[] =>
  servers.map((server) => ({
    kind: 'MCP 服务',
    name: `mcp__${server.name}__`,
    detail: server.transport === 'stdio' ? `本机程序 ${server.command ?? ''}` : `远程 ${server.url ?? ''}`,
  }))
