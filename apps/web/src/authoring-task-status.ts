import type { StatusTone } from './ui-kit/index.js'

export interface AuthoringTaskPresentation {
  readonly label: string
  readonly tone: StatusTone
  /**
   * What the user must do next when the task waits on a browser rather than on the agent: `channel` points to the
   * task page, `creator` is shown on the task page itself.
   */
  readonly nextStep?: { readonly channel: string; readonly creator: string }
}

/**
 * Candidates with an interface finish only after a browser confirms the run and renders it, so those waiting states
 * name the creator page as the next step instead of looking like ongoing agent work.
 */
export const authoringTaskPresentation = (task: {
  readonly status: string
  readonly candidateAttempt?: { readonly state: string; readonly client: { readonly status: string } } | undefined
}): AuthoringTaskPresentation => {
  const candidate = task.candidateAttempt
  if (task.status === 'awaiting-approval') {
    return {
      label: '等待确认运行',
      tone: 'warning',
      nextStep: {
        channel: '打开任务确认运行，候选界面需要在浏览器中加载并完成验证。',
        creator: '在本页确认运行；确认后浏览器会加载候选界面并完成验证。',
      },
    }
  }
  if (
    task.status === 'running' &&
    candidate !== undefined &&
    candidate.client.status !== 'absent' &&
    (candidate.state === 'loading-client' || candidate.state === 'starting-host')
  ) {
    return {
      label: '等待界面验证',
      tone: 'warning',
      nextStep: {
        channel: '打开任务，浏览器加载候选界面后会自动完成验证。',
        creator: '保持本页打开，候选界面加载后会自动完成验证。',
      },
    }
  }
  if (task.status === 'ready') return { label: '可以预览', tone: 'success' }
  if (task.status === 'failed' || task.status === 'interrupted') return { label: '需要处理', tone: 'error' }
  if (task.status === 'stopped' || task.status === 'completed') return { label: '已结束', tone: 'neutral' }
  if (task.status === 'repairing') return { label: '正在修复', tone: 'info' }
  return { label: '正在开发', tone: 'info' }
}
