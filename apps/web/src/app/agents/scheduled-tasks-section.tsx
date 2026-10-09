import { Pause, Play, Trash2, Zap } from 'lucide-react'
import { useState } from 'react'
import { useProductStore, type AgentSummary } from '../../product-runtime.js'
import { Chip, ConfirmDialog, DataTable, IconButton, PropertyGroup, toast, type Tone } from '../../ui-kit/index.js'
import { useProductApi } from '../model/store.js'
import {
  allowedActions,
  describeSchedule,
  formatWhen,
  sortTasks,
  sourceLabel,
  stateLabel,
  type ScheduledTaskAction,
  type ScheduledTaskView,
} from './scheduled-task-model.js'
import styles from './agents.module.css'

const failure = (error: unknown) => toast(error instanceof Error ? error.message : String(error), { tone: 'bad' })

const stateTone: Record<ScheduledTaskView['state'], Tone> = {
  scheduled: 'neutral',
  paused: 'warn',
  finished: 'neutral',
  inactive: 'warn',
}

const DONE: Record<Exclude<ScheduledTaskAction, 'delete'>, string> = {
  pause: '已暂停',
  resume: '已恢复',
  run: '已触发，智能体正在处理',
}

/** Row actions shared by the agent page and the channel inspector; deleting asks first. */
export function useScheduledTaskActions() {
  const api = useProductApi()
  const [pendingDelete, setPendingDelete] = useState<ScheduledTaskView | null>(null)
  const act = async (task: ScheduledTaskView, action: ScheduledTaskAction) => {
    if (action === 'delete') {
      setPendingDelete(task)
      return
    }
    try {
      const woke = await api.getState().scheduledTaskAction(task.id, action)
      toast(action === 'run' && !woke ? '已执行，这次不需要智能体处理' : DONE[action])
    } catch (error) {
      failure(error)
    }
  }
  const dialog = (
    <ConfirmDialog
      open={pendingDelete !== null}
      onOpenChange={(open) => !open && setPendingDelete(null)}
      title={`删除「${pendingDelete?.label ?? ''}」？`}
      confirmLabel="删除"
      danger
      onConfirm={() => {
        const task = pendingDelete
        setPendingDelete(null)
        if (task === null) return
        api
          .getState()
          .scheduledTaskAction(task.id, 'delete')
          .then(() => toast('已删除'))
          .catch(failure)
      }}
    />
  )
  return { act, dialog }
}

export function TaskActions({
  task,
  act,
}: {
  readonly task: ScheduledTaskView
  readonly act: (task: ScheduledTaskView, action: ScheduledTaskAction) => Promise<void>
}) {
  const allowed = allowedActions(task)
  return (
    <>
      {allowed.includes('pause') ? (
        <IconButton label={`暂停「${task.label}」`} size="small" onClick={() => void act(task, 'pause')}>
          <Pause size={15} />
        </IconButton>
      ) : null}
      {allowed.includes('resume') ? (
        <IconButton label={`恢复「${task.label}」`} size="small" onClick={() => void act(task, 'resume')}>
          <Play size={15} />
        </IconButton>
      ) : null}
      {allowed.includes('run') ? (
        <IconButton label={`立即执行「${task.label}」`} size="small" onClick={() => void act(task, 'run')}>
          <Zap size={15} />
        </IconButton>
      ) : null}
      {allowed.includes('delete') ? (
        <IconButton label={`删除「${task.label}」`} size="small" onClick={() => void act(task, 'delete')}>
          <Trash2 size={15} />
        </IconButton>
      ) : null}
    </>
  )
}

export const nextRunText = (task: ScheduledTaskView): string =>
  task.state === 'scheduled' && task.nextRunAt !== undefined
    ? formatWhen(task.nextRunAt)
    : task.state === 'finished' && task.lastFiredAt !== undefined
      ? `${formatWhen(task.lastFiredAt)} 已触发`
      : stateLabel[task.state]

/** Every scheduled task of the agent across its channels; created and changed by talking to the agent. */
export function ScheduledTasksSection({ agent }: { readonly agent: AgentSummary }) {
  const allTasks = useProductStore((state) => state.scheduledTasks)
  const channels = useProductStore((state) => state.channels)
  const tasks = sortTasks(allTasks.filter((task) => task.agentId === agent.id))
  const { act, dialog } = useScheduledTaskActions()
  const channelName = (channelId: string) =>
    channels.find((channel) => channel.id === channelId)?.name ?? '已移除的频道'
  return (
    <PropertyGroup
      id="profile-schedules"
      title="定时任务"
      description={agent.capabilities.scheduledTasks ? undefined : '定时任务能力已关闭，已有任务仍按计划触发'}
    >
      <DataTable
        label={`${agent.name}的定时任务`}
        rows={tasks}
        rowKey={(task) => task.id}
        empty="还没有定时任务。在频道里请它设置提醒或定时任务。"
        columns={[
          {
            key: 'label',
            header: '任务',
            width: 'minmax(180px, 2fr)',
            render: (task) => (
              <span className={styles.cellStack}>
                <span className={styles.cellTitle}>{task.label}</span>
                <span className={styles.cellSub}>
                  {channelName(task.channelId)} · {sourceLabel(task)}
                </span>
              </span>
            ),
          },
          {
            key: 'schedule',
            header: '计划',
            width: 'minmax(140px, 1fr)',
            render: (task) => <span className={styles.cellSub}>{describeSchedule(task)}</span>,
          },
          {
            key: 'next',
            header: '下次',
            width: 'minmax(112px, 0.8fr)',
            priority: 2,
            render: (task) =>
              task.state === 'paused' || task.state === 'inactive' ? (
                <Chip tone={stateTone[task.state]}>{stateLabel[task.state]}</Chip>
              ) : (
                <span className={styles.cellSub}>{nextRunText(task)}</span>
              ),
          },
          {
            key: 'actions',
            header: <span className={styles.srOnly}>操作</span>,
            width: '104px',
            align: 'end',
            render: (task) => <TaskActions task={task} act={act} />,
          },
        ]}
      />
      {dialog}
    </PropertyGroup>
  )
}
