import type { HostApiResponse } from '@nekro-nxt/contracts'

export type ScheduledTaskView = HostApiResponse<'snapshot'>['scheduledTasks'][number]
export type ScheduledTaskAction = 'pause' | 'resume' | 'run' | 'delete'

const pad = (value: number) => String(value).padStart(2, '0')
const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'] as const

const localZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone

const startOfDay = (epoch: number) => {
  const date = new Date(epoch)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** `今天 08:00`, `明天 08:00`, `10月12日 08:00`, or with the year when it is not this year. */
export const formatWhen = (epoch: number, now: number = Date.now()): string => {
  const date = new Date(epoch)
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const days = Math.round((startOfDay(epoch) - startOfDay(now)) / 86_400_000)
  if (days === 0) return `今天 ${time}`
  if (days === 1) return `明天 ${time}`
  if (days === -1) return `昨天 ${time}`
  const day = `${date.getMonth() + 1}月${date.getDate()}日`
  return date.getFullYear() === new Date(now).getFullYear() ? `${day} ${time}` : `${date.getFullYear()}年${day} ${time}`
}

const weekdays = (field: string): string | undefined => {
  if (field === '1-5') return '工作日'
  if (field === '0,6' || field === '6,0') return '周末'
  const days = field.split(',')
  if (!days.every((day) => /^[0-7]$/u.test(day))) return undefined
  return `每周${days.map((day) => WEEKDAY[Number(day) % 7]).join('、')}`
}

/** Common five-field cron shapes in words; anything else stays as the expression. */
export const describeCron = (cron: string): string => {
  const [minute = '', hour = '', dayOfMonth = '', month = '', dayOfWeek = ''] = cron.trim().split(/\s+/u)
  const every = /^\*\/(\d+)$/u
  const fixed = /^\d+$/u
  if (dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    if (every.test(minute) && hour === '*') return `每 ${every.exec(minute)?.[1]} 分钟`
    if (fixed.test(minute) && every.test(hour)) return `每 ${every.exec(hour)?.[1]} 小时`
    if (fixed.test(minute) && hour === '*') return `每小时第 ${minute} 分`
  }
  if (fixed.test(minute) && fixed.test(hour) && month === '*') {
    const time = `${pad(Number(hour))}:${pad(Number(minute))}`
    if (dayOfMonth === '*' && dayOfWeek === '*') return `每天 ${time}`
    if (dayOfMonth === '*') {
      const days = weekdays(dayOfWeek)
      if (days !== undefined) return `${days} ${time}`
    }
    if (fixed.test(dayOfMonth) && dayOfWeek === '*') return `每月 ${dayOfMonth} 日 ${time}`
  }
  return `cron ${cron}`
}

export const describeSchedule = (task: ScheduledTaskView, now?: number): string => {
  if (task.schedule.kind === 'once') return `${formatWhen(task.schedule.at, now)} 一次`
  const zone = task.schedule.timezone === localZone() ? '' : `（${task.schedule.timezone}）`
  return `${describeCron(task.schedule.cron)}${zone}`
}

export const stateLabel: Record<ScheduledTaskView['state'], string> = {
  scheduled: '等待触发',
  paused: '已暂停',
  finished: '已完成',
  inactive: '扩展已停用',
}

export const sourceLabel = (task: ScheduledTaskView): string =>
  task.source === 'chat' ? '对话创建' : `${task.extensionName ?? '扩展'}${task.source === 'declared' ? '固定计划' : ''}`

/** What an administrator may do from the client; mirrors the server's source rules (Decision 定时任务 §2). */
export const allowedActions = (task: ScheduledTaskView): readonly ScheduledTaskAction[] => {
  if (task.state === 'finished') return task.source === 'declared' ? [] : ['delete']
  const toggle: ScheduledTaskAction = task.state === 'paused' ? 'resume' : 'pause'
  const run: readonly ScheduledTaskAction[] = task.state === 'inactive' ? [] : ['run']
  return task.source === 'declared' ? [toggle, ...run] : [toggle, ...run, 'delete']
}

/** Live and paused tasks first by next run; finished ones last. */
export const sortTasks = (tasks: readonly ScheduledTaskView[]): ScheduledTaskView[] =>
  [...tasks].sort(
    (left, right) =>
      Number(left.state === 'finished') - Number(right.state === 'finished') ||
      (left.nextRunAt ?? Number.MAX_SAFE_INTEGER) - (right.nextRunAt ?? Number.MAX_SAFE_INTEGER) ||
      left.createdAt - right.createdAt,
  )
