import type { HostApiResponse } from '@nekro-nxt/contracts'
import type { Tone } from '../../ui-kit/next/index.js'
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
export const lifecyclePosition = (task: AuthoringTask, enabledForAgent: boolean): LifecyclePosition => {
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
export const sortTasks = (tasks: readonly AuthoringTask[]): AuthoringTask[] => {
  const rank = (task: AuthoringTask): number =>
    task.status === 'awaiting-approval' || task.status === 'ready' || task.status === 'failed'
      ? 0
      : isTaskOpen(task)
        ? 1
        : 2
  return [...tasks].sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt)
}

export const scopeLabel: Record<LocalExtensionSummary['scope'], string> = {
  agent: '智能体扩展',
  'host-adapter': '平台适配器',
  'host-ui': '页面扩展',
}

/** One short line describing who uses an extension right now. */
export const extensionUsage = (extension: LocalExtensionSummary): { readonly label: string; readonly tone: Tone } => {
  if (extension.scope !== 'agent') {
    if (!extension.installation) return { label: '未安装', tone: 'neutral' }
    return extension.installation.runtime && extension.installation.runtime.status !== 'active'
      ? { label: '运行异常', tone: 'bad' }
      : { label: '已安装', tone: 'ok' }
  }
  if (extension.activations.some((item) => item.runtime && item.runtime.status !== 'active')) {
    return { label: '运行异常', tone: 'bad' }
  }
  return extension.activations.length > 0
    ? { label: `${extension.activations.length} 个智能体使用`, tone: 'ok' }
    : { label: '未启用', tone: 'neutral' }
}

const CONTRIBUTION = /^(工具|RPC|界面|页面|适配器)[：:]\s*(.+)$/u

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
