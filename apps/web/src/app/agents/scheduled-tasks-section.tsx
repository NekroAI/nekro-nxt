import { MoreHorizontal, Pause, Play, Trash2, Zap } from 'lucide-react'
import { useState } from 'react'
import { useProductStore, type AgentSummary } from '../../product-runtime.js'
import {
  Chip,
  ConfirmDialog,
  DataTable,
  IconButton,
  Menu,
  PropertyGroup,
  toast,
  type Tone,
} from '../../ui-kit/index.js'
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
  const items = [
    ...(allowed.includes('run')
      ? [{ key: 'run', label: '立即执行', icon: <Zap size={14} />, onSelect: () => void act(task, 'run') }]
      : []),
    ...(allowed.includes('pause')
      ? [{ key: 'pause', label: '暂停', icon: <Pause size={14} />, onSelect: () => void act(task, 'pause') }]
      : []),
    ...(allowed.includes('resume')
      ? [{ key: 'resume', label: '恢复', icon: <Play size={14} />, onSelect: () => void act(task, 'resume') }]
      : []),
    ...(allowed.includes('delete')
      ? [
          {
            key: 'delete',
            label: '删除',
            icon: <Trash2 size={14} />,
            danger: true,
            onSelect: () => void act(task, 'delete'),
          },
        ]
      : []),
  ]
  if (items.length === 0) return null
  return (
    <Menu
      label={`「${task.label}」的操作`}
      trigger={
        <IconButton label={`「${task.label}」的更多操作`} size="small">
          <MoreHorizontal size={15} />
        </IconButton>
      }
      items={items}
    />
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
            width: '40px',
            align: 'end',
            render: (task) => <TaskActions task={task} act={act} />,
          },
        ]}
      />
      {dialog}
    </PropertyGroup>
  )
}
