import { useGo } from '../model/nav.js'
import { ArrowUpRight, Check, CircleStop, MoreHorizontal, Package, RotateCcw, Save, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { HostApiContracts, type HostApiResponse } from '@nekro-nxt/contracts'
import { DynamicClientSlots } from '../../dynamic-client-coordinator.js'
import { callHostApi } from '../../host-api-client.js'
import { useProductStore } from '../../product-runtime.js'
import {
  AgentAvatar,
  Banner,
  Button,
  Chip,
  ConfirmDialog,
  MainContent,
  Menu,
  ObjectHeader,
  PropertyGroup,
  Spinner,
  toast,
} from '../../ui-kit/next/index.js'
import { relativeTime } from '../channels/timeline-model.js'
import { agentHue } from '../model/identity.js'
import { useExtensionActivation } from '../../extension-ui/index.js'
import { useProductApi } from '../model/store.js'
import { SaveDialog } from './save-dialog.js'
import {
  LIFECYCLE,
  attemptPhaseLabel,
  attemptStateLabel,
  isTaskOpen,
  lifecyclePosition,
  taskStatus,
  type AuthoringAttempt,
  type AuthoringTask,
} from './workshop-model.js'
import styles from './workshop.module.css'

type TaskDetail = HostApiResponse<'getAuthoringTask'>

const failure = (error: unknown) => toast(error instanceof Error ? error.message : String(error), { tone: 'bad' })

/** Full attempt history and the saved extension; refetched whenever the task advances. */
function useTaskDetail(task: AuthoringTask): TaskDetail | undefined {
  const [detail, setDetail] = useState<TaskDetail>()
  useEffect(() => {
    let live = true
    callHostApi(HostApiContracts.getAuthoringTask, { taskId: task.id }, undefined)
      .then((next) => live && setDetail(next))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [task.id, task.revision])
  return detail?.task.id === task.id ? detail : undefined
}

const savedExtensionId = (detail: TaskDetail | undefined): string | undefined => {
  const event = detail?.events.findLast((item) => item.kind === 'task-completed')
  const payload = event?.payload
  return payload && typeof payload === 'object' && !Array.isArray(payload) && typeof payload['extensionId'] === 'string'
    ? payload['extensionId']
    : undefined
}

export function TaskView({ task }: { readonly task: AuthoringTask }) {
  const api = useProductApi()
  const activation = useExtensionActivation()
  const navigate = useGo()
  const agent = useProductStore((state) => state.agents.find((item) => item.id === task.agentId))
  const channel = useProductStore((state) => state.channels.find((item) => item.id === task.channelId))
  const dynamicItem = useProductStore((state) =>
    state.dynamic.find((item) => item.agentId === task.agentId && item.episodeId === task.episodeId),
  )
  const extensions = useProductStore((state) => state.extensions)
  const detail = useTaskDetail(task)
  const extensionId = savedExtensionId(detail)
  const saved = extensions.find((item) => item.id === extensionId)
  const enabledForAgent = saved?.activations.some((item) => item.agentId === task.agentId) ?? false
  const position = lifecyclePosition(task, enabledForAgent)
  const status = taskStatus(task)
  const open = isTaskOpen(task)
  const candidate = task.candidateAttempt
  const settling = agent !== undefined && agent.state !== 'idle'
  const restorable =
    open && task.verifiedAttempt && task.verifiedAttempt.id !== candidate?.id ? task.verifiedAttempt : undefined

  const [busy, setBusy] = useState<'' | 'approve' | 'decline' | 'restore' | 'enable'>('')
  const [saveOpen, setSaveOpen] = useState(false)
  const [stopOpen, setStopOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)

  const run = async (kind: Exclude<typeof busy, ''>, action: () => Promise<unknown>, done?: string) => {
    if (busy) return
    setBusy(kind)
    try {
      await action()
      if (done) toast(done)
    } catch (error) {
      failure(error)
    } finally {
      setBusy('')
    }
  }

  const decide = (approved: boolean) => {
    const requestId = dynamicItem?.approvalRequestId
    if (!requestId) return
    void run(approved ? 'approve' : 'decline', () =>
      api.getState().resolveApproval({ requestId, agentId: task.agentId, approved }),
    )
  }

  const attempts = useMemo(() => [...(detail?.attempts ?? [])].reverse(), [detail])

  return (
    <MainContent>
      {activation.dialog}
      <ObjectHeader
        visual={agent ? <AgentAvatar name={agent.name} hue={agentHue(agent)} size="md" /> : undefined}
        title={task.title}
        status={
          <Chip tone={status.tone} dot>
            {status.label}
          </Chip>
        }
        meta={
          <>
            {agent ? (
              <Link to={`/agents/${agent.id}`} className={styles.metaLink}>
                {agent.name}
              </Link>
            ) : null}
            <span>{relativeTime(task.createdAt)}开始</span>
          </>
        }
        actions={
          <>
            {channel ? (
              <Button
                size="small"
                icon={<ArrowUpRight size={14} />}
                onClick={() => navigate(`/channels/${channel.id}`)}
              >
                打开频道
              </Button>
            ) : null}
            <Menu
              label="任务操作"
              align="end"
              trigger={
                <Button size="small" variant="ghost" icon={<MoreHorizontal size={14} />}>
                  更多
                </Button>
              }
              items={[
                open
                  ? {
                      key: 'stop',
                      label: '停止任务',
                      icon: <CircleStop size={14} />,
                      onSelect: () => setStopOpen(true),
                    }
                  : {
                      key: 'delete',
                      label: '删除任务记录',
                      icon: <Trash2 size={14} />,
                      danger: true,
                      onSelect: () => setDeleteOpen(true),
                    },
              ]}
            />
          </>
        }
      />
      {task.requirementSummary ? <p className={styles.lead}>{task.requirementSummary}</p> : null}
      <PhaseBar current={position.current} failed={position.failed} />

      <div className={styles.taskGrid} data-single={!open}>
        {open ? (
          <PropertyGroup title="预览">
            <div className={styles.preview}>
              {candidate === undefined ? (
                <p className={styles.quiet}>
                  <Spinner /> 等待第一个候选
                </p>
              ) : candidate.client.status === 'absent' ? (
                <p className={styles.quiet}>这个候选只有服务端能力，没有界面。</p>
              ) : (
                <DynamicClientSlots agentId={task.agentId} episodeId={task.episodeId} />
              )}
            </div>
          </PropertyGroup>
        ) : null}

        <div className={styles.taskSide}>
          <PropertyGroup title="当前要处理的事">
            <NextAction
              task={task}
              busy={busy}
              settling={settling}
              approvable={dynamicItem?.approvalRequestId !== undefined}
              savedName={saved?.name}
              enabledForAgent={enabledForAgent}
              agentName={agent?.name ?? '智能体'}
              restorable={restorable}
              onDecide={decide}
              onSave={() => setSaveOpen(true)}
              onRestore={() =>
                restorable &&
                void run(
                  'restore',
                  () => api.getState().restoreAuthoringAttempt(task.id, restorable.id, task.revision),
                  `已回到第 ${restorable.ordinal} 次候选，正在重新验证`,
                )
              }
              onEnable={() =>
                saved &&
                void run(
                  'enable',
                  () => activation.setActive({ extensionId: saved.id, agentId: task.agentId, enabled: true }),
                  `${agent?.name ?? '智能体'}已开始使用「${saved.name}」`,
                )
              }
              onOpenExtension={() => saved && navigate(`/workshop/extensions/${saved.id}`)}
            />
          </PropertyGroup>

          <PropertyGroup title="尝试记录">
            <ol className={styles.attempts}>
              {attempts.length === 0 && candidate ? <AttemptRow attempt={candidate} current /> : null}
              {attempts.map((attempt) => (
                <AttemptRow key={attempt.id} attempt={attempt} current={attempt.id === candidate?.id} />
              ))}
            </ol>
          </PropertyGroup>
        </div>
      </div>

      <SaveDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        task={task}
        agentName={agent?.name ?? '智能体'}
        pluginId={dynamicItem?.pluginId ?? ''}
        packageId={dynamicItem?.packageId ?? ''}
      />
      <ConfirmDialog
        open={stopOpen}
        onOpenChange={setStopOpen}
        title="停止这个创造任务？"
        confirmLabel="停止任务"
        danger
        onConfirm={() => api.getState().stopAuthoringTask(task.id, task.revision)}
      >
        正在运行的候选会停止；已经保存的扩展不受影响。
      </ConfirmDialog>
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`删除「${task.title}」的任务记录？`}
        confirmLabel="删除记录"
        danger
        onConfirm={async () => {
          await api.getState().deleteAuthoringTask(task.id)
          navigate('/workshop', { replace: true })
        }}
      >
        任务记录与全部候选源码会被删除，已保存的扩展保留。
      </ConfirmDialog>
    </MainContent>
  )
}

/** Compact lifecycle: done, current (or stopped here) and upcoming phases on one line. */
function PhaseBar({ current, failed }: { readonly current: number; readonly failed: boolean }) {
  return (
    <ol className={styles.phases} aria-label="进度">
      {LIFECYCLE.map((phase, index) => {
        const state = index < current ? 'done' : index === current ? (failed ? 'failed' : 'now') : 'todo'
        return (
          <li
            key={phase}
            className={styles.phase}
            data-state={state}
            aria-current={state === 'now' ? 'step' : undefined}
          >
            <span className={styles.phaseDot} aria-hidden="true">
              {state === 'done' ? <Check size={11} /> : state === 'failed' ? '!' : null}
            </span>
            {phase}
          </li>
        )
      })}
    </ol>
  )
}

function NextAction(props: {
  readonly task: AuthoringTask
  readonly busy: string
  readonly settling: boolean
  readonly approvable: boolean
  readonly savedName: string | undefined
  readonly enabledForAgent: boolean
  readonly agentName: string
  readonly restorable: AuthoringAttempt | undefined
  readonly onDecide: (approved: boolean) => void
  readonly onSave: () => void
  readonly onRestore: () => void
  readonly onEnable: () => void
  readonly onOpenExtension: () => void
}) {
  const { task, busy } = props
  const candidate = task.candidateAttempt
  const restore = props.restorable ? (
    <Button
      icon={<RotateCcw size={14} />}
      busy={busy === 'restore'}
      disabled={props.settling}
      onClick={props.onRestore}
    >
      回到第 {props.restorable.ordinal} 次
    </Button>
  ) : null

  if (task.status === 'completed') {
    return (
      <div className={styles.action} data-tone="ok">
        <Package size={18} />
        <div className={styles.actionText}>
          <b>已保存为「{props.savedName ?? '本地扩展'}」</b>
          <span>{props.enabledForAgent ? `${props.agentName}正在使用` : `${props.agentName}还没有使用它`}</span>
        </div>
        <Button onClick={props.onOpenExtension} disabled={!props.savedName}>
          查看扩展
        </Button>
        {!props.enabledForAgent && props.savedName ? (
          <Button variant="primary" busy={busy === 'enable'} onClick={props.onEnable}>
            给{props.agentName}启用
          </Button>
        ) : null}
      </div>
    )
  }
  if (candidate?.error || task.status === 'failed' || task.status === 'interrupted') {
    return (
      <div className={styles.action} data-tone="bad">
        <div className={styles.actionText}>
          <b>
            {candidate?.error
              ? `${attemptPhaseLabel[candidate.error.phase]}未通过`
              : task.status === 'interrupted'
                ? '任务中断'
                : '候选运行失败'}
          </b>
          <span>{candidate?.error?.message ?? '在频道里让智能体继续修复，或停止任务。'}</span>
        </div>
        {restore}
      </div>
    )
  }
  if (task.status === 'awaiting-approval' && props.approvable) {
    return (
      <div className={styles.action} data-tone="warn">
        <div className={styles.actionText}>
          <b>运行第 {candidate?.ordinal ?? 1} 次候选？</b>
          <span>{candidate?.purpose || candidate?.name}</span>
        </div>
        <Button busy={busy === 'decline'} disabled={busy === 'approve'} onClick={() => props.onDecide(false)}>
          拒绝
        </Button>
        <Button
          variant="primary"
          busy={busy === 'approve'}
          disabled={busy === 'decline'}
          onClick={() => props.onDecide(true)}
        >
          允许运行
        </Button>
      </div>
    )
  }
  if (task.status === 'ready') {
    return (
      <div className={styles.action} data-tone="ok">
        <div className={styles.actionText}>
          <b>第 {candidate?.ordinal ?? 1} 次候选已通过验证</b>
          <span>{props.settling ? `${props.agentName}正在收尾，完成后即可保存` : '确认预览效果后保存为本地扩展'}</span>
        </div>
        <Button variant="primary" icon={<Save size={14} />} disabled={props.settling} onClick={props.onSave}>
          保存为扩展
        </Button>
      </div>
    )
  }
  if (task.status === 'stopped') {
    return (
      <div className={styles.action}>
        <div className={styles.actionText}>
          <b>任务已停止</b>
        </div>
      </div>
    )
  }
  return (
    <div className={styles.action}>
      <Spinner />
      <div className={styles.actionText}>
        <b>
          {candidate ? `第 ${candidate.ordinal} 次候选${attemptStateLabel[candidate.state]}` : '智能体正在编写候选'}
        </b>
        {candidate && candidate.client.status !== 'absent' && candidate.state === 'loading-client' ? (
          <span>保持本页打开，界面加载后自动完成验证</span>
        ) : null}
      </div>
      {restore}
    </div>
  )
}

function AttemptRow({ attempt, current }: { readonly attempt: AuthoringAttempt; readonly current: boolean }) {
  const tone =
    attempt.state === 'active'
      ? 'ok'
      : attempt.error || attempt.state === 'failed' || attempt.state === 'preflight-failed'
        ? 'bad'
        : 'neutral'
  return (
    <li className={styles.attempt} data-current={current}>
      <span className={styles.attemptKey}>{attempt.ordinal}</span>
      <div className={styles.attemptBody}>
        <div className={styles.attemptHead}>
          <b>{attempt.name}</b>
          <Chip tone={tone}>{attemptStateLabel[attempt.state]}</Chip>
        </div>
        {attempt.purpose ? <p>{attempt.purpose}</p> : null}
        {attempt.error ? (
          <Banner tone="bad">
            {attemptPhaseLabel[attempt.error.phase]}：{attempt.error.message}
          </Banner>
        ) : null}
        <span className={styles.attemptMeta}>{relativeTime(attempt.createdAt)}</span>
      </div>
    </li>
  )
}
