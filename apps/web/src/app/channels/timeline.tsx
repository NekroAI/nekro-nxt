import { AlarmClock, Check, ChevronRight, CircleAlert, Square, X } from 'lucide-react'
import { ToolView } from '../../extension-ui/index.js'
import { memo, useEffect, useState } from 'react'
import { MessageContent, resolveMessageSide } from './message-content.js'
import type { AgentSummary, ChannelSummary, ConversationMessage } from '../../product-runtime.js'
import { AgentAvatar, Button, Chip, Pressable, Spinner, cssVars } from '../../ui-kit/index.js'
import { MemberAvatar } from '../../ui-kit/avatar.js'
import { agentAccent, agentHue } from '../model/identity.js'
import styles from './channels.module.css'
import { ToolDetail } from './tool-detail.js'
import { toolSummary } from './tool-presenter.js'
import { formatDuration, formatTokens, isTurnRunning, isUnconfirmed, type RuntimeTurn } from './timeline-model.js'

type RuntimeStep = RuntimeTurn['steps'][number]
type RuntimeTool = RuntimeStep['tools'][number]

export const MessageRow = memo(function MessageRow({
  message,
  channelKind,
  agent,
  continued,
  fresh,
  onResolve,
}: {
  readonly message: ConversationMessage
  readonly channelKind: ChannelSummary['kind']
  readonly agent: AgentSummary | undefined
  readonly continued: boolean
  readonly fresh: boolean
  readonly onResolve?: ((messageId: string, action: 'retry' | 'confirm-delivered') => void) | undefined
}) {
  const side = resolveMessageSide({
    channelKind,
    role: message.role,
    ...(message.origin ? { origin: message.origin } : {}),
  })
  if (message.scheduledTask !== undefined) {
    const task = message.scheduledTask
    return (
      <div className={styles.scheduledNotice} data-message-id={message.id}>
        <AlarmClock size={14} aria-hidden="true" />
        <span className={styles.scheduledNoticeText}>
          <span className={styles.scheduledNoticeTitle}>
            {task.extensionName === undefined ? '定时任务' : `${task.extensionName} 定时任务`}
          </span>
          <span>{task.label}</span>
          {task.note === undefined ? null : <span className={styles.scheduledNoticeNote}>{task.note}</span>}
        </span>
        <span className={styles.time}>{message.time}</span>
      </div>
    )
  }
  if (side === 'system') {
    return (
      <div className={styles.systemLine}>
        <MessageContent message={message} variant="system-event" />
      </div>
    )
  }
  const fromAgent = message.role === 'agent' && message.origin !== 'admin-console'
  const unconfirmed = isUnconfirmed(message)
  const accent = fromAgent && agent ? agentAccent(agent) : undefined
  return (
    <div
      className={[
        styles.msg,
        side === 'right' ? styles.mine : '',
        continued ? styles.msgCont : '',
        unconfirmed ? styles.unsent : '',
        fresh ? styles.fresh : '',
      ].join(' ')}
      style={accent ? cssVars({ '--bubble-accent': accent }) : undefined}
      data-message-id={message.id}
    >
      {fromAgent && agent ? (
        <AgentAvatar name={agent.name} hue={agentHue(agent)} />
      ) : (
        <MemberAvatar name={message.author} />
      )}
      {continued ? null : (
        <div className={styles.meta}>
          <b>{message.author}</b>
          {message.origin === 'admin-console' ? <span className={styles.adminTag}>管理员</span> : null}
          <span className={styles.time}>{message.time}</span>
          {message.delivery === '已发送' ? (
            <span className={styles.delivered} title="已送达">
              <Check />
            </span>
          ) : null}
        </div>
      )}
      <div className={styles.bubble}>
        <MessageContent message={message} />
      </div>
      {unconfirmed ? (
        <div className={styles.unsentBar} role="status">
          <CircleAlert aria-hidden="true" />
          {message.delivery === '部分发送' ? '部分送达' : message.delivery === '失败' ? '发送失败' : '未确认送达'}
          {onResolve && message.id.startsWith('out_') && message.deliveryResolution !== 'retry' ? (
            <>
              <Button size="small" variant="ghost" onClick={() => onResolve(message.id, 'retry')}>
                重发
              </Button>
              {message.delivery !== '失败' ? (
                <Button size="small" variant="ghost" onClick={() => onResolve(message.id, 'confirm-delivered')}>
                  已送达
                </Button>
              ) : null}
            </>
          ) : message.deliveryResolution === 'retry' ? (
            <span>已重新发送</span>
          ) : null}
        </div>
      ) : message.delivery === '发送中' ? (
        <div className={styles.notice}>发送中…</div>
      ) : null}
    </div>
  )
})

function Elapsed({ since }: { readonly since: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return <>{Math.max(0, Math.round((now - since) / 1000))}s</>
}

const toolState = (tool: RuntimeTool) => {
  if (tool.state === 'running') return { className: styles.stepRun, icon: <Spinner /> }
  if (tool.state === 'succeeded') return { className: styles.stepOk, icon: <Check /> }
  return { className: styles.stepFail, icon: <X /> }
}

/** One step: a readable summary that opens to what the tool was asked and what it returned. */
function ToolStep({
  tool,
  channelId,
  agentId,
}: {
  readonly tool: RuntimeTool
  readonly channelId: string | undefined
  readonly agentId: string | undefined
}) {
  const [open, setOpen] = useState(false)
  const state = toolState(tool)
  const summary = toolSummary(tool.name, tool.inputPreview, tool.wroteToChannel === true)
  return (
    <div className={styles.toolStep} data-open={open || undefined}>
      <Pressable
        className={[styles.step, state.className].join(' ')}
        aria-expanded={open}
        aria-label={`${tool.displayName}${summary ? `：${summary}` : ''}，${open ? '收起详情' : '查看详情'}`}
        onClick={() => setOpen(!open)}
      >
        {state.icon}
        <b>{tool.displayName}</b>
        {summary ? <span className={styles.stepArg}>{summary}</span> : null}
        {tool.durationMs !== undefined ? (
          <span className={styles.stepTime}>{formatDuration(tool.durationMs)}</span>
        ) : null}
        <ChevronRight className={styles.stepChevron} aria-hidden="true" />
      </Pressable>
      <ToolView call={toolCall(tool, false)} density="chip" {...(agentId ? { agentId } : {})} />
      {open ? (
        <>
          <ToolDetail tool={tool} channelId={channelId} />
          <ToolView call={toolCall(tool, true)} density="card" {...(agentId ? { agentId } : {})} />
        </>
      ) : null}
    </div>
  )
}

/** The tool call as extension tool views receive it. */
const toolCall = (tool: RuntimeTool, detailed: boolean) => ({
  callId: tool.callId,
  toolName: tool.name,
  state: tool.state,
  ...(detailed && tool.inputPreview !== undefined ? { input: tool.inputPreview } : {}),
  ...(detailed && tool.resultPreview !== undefined ? { result: tool.resultPreview } : {}),
  ...(tool.durationMs === undefined ? {} : { durationMs: tool.durationMs }),
})

function ToolCard({
  tool,
  index,
  agentId,
  channelId,
}: {
  readonly tool: RuntimeTool
  readonly index: number
  readonly agentId: string | undefined
  readonly channelId: string | undefined
}) {
  return (
    <div className={styles.card} style={cssVars({ '--i': index })}>
      <div className={styles.cardHead}>
        <span className={styles.cardIndex}>{index + 1}</span>
        <b>{tool.displayName}</b>
        {tool.durationMs !== undefined ? (
          <span className={styles.stepTime}>{formatDuration(tool.durationMs)}</span>
        ) : null}
        <span className={styles.cardState}>
          {tool.state === 'running' ? (
            <Chip tone="accent" dot>
              运行中
            </Chip>
          ) : tool.state === 'succeeded' ? (
            <Chip tone="ok" dot>
              成功
            </Chip>
          ) : (
            <Chip tone="bad" dot>
              失败
            </Chip>
          )}
        </span>
      </div>
      <ToolDetail tool={tool} channelId={channelId} bare />
      <ToolView call={toolCall(tool, true)} density="card" {...(agentId ? { agentId } : {})} />
    </div>
  )
}

function ThinkingCard({ text, index }: { readonly text: string; readonly index: number }) {
  return (
    <div className={[styles.card, styles.thinking].join(' ')} style={cssVars({ '--i': index })}>
      <div className={styles.cardHead}>
        <span className={styles.cardIndex}>{index + 1}</span>
        <b>思考</b>
      </div>
      <p className={styles.thinkingText}>{text}</p>
    </div>
  )
}

const stepThinking = (step: RuntimeStep): string =>
  [step.internalOutput?.reasoning, step.internalOutput?.text].filter(Boolean).join('\n').trim()

const turnSummary = (turn: RuntimeTurn): string => {
  if (turn.state === 'aborted') return '已停止'
  if (turn.state === 'error') return turn.error?.message ? `出错：${turn.error.message}` : '出错'
  if (turn.state === 'interrupted') return '被中断'
  if (turn.state === 'max-tokens') return '输出达到上限'
  const sent = turn.steps
    .flatMap((step) => step.tools)
    .filter((tool) => tool.wroteToChannel && tool.deliveryState === 'sent').length
  if (sent) return `回复了 ${sent} 条`
  if (turn.state === 'unreplied' || turn.responseState === 'finished') return '没有回复'
  return ''
}

export function TurnRow({
  turn,
  agent,
  channelId,
  xray,
  animateXray,
  startedAt,
  onStop,
}: {
  readonly turn: RuntimeTurn
  readonly agent: AgentSummary | undefined
  /** Lets an opened step load the call's full arguments and result. */
  readonly channelId?: string | undefined
  readonly xray: boolean
  readonly animateXray: boolean
  readonly startedAt?: number | undefined
  readonly onStop?: (() => void) | undefined
}) {
  const running = isTurnRunning(turn)
  const tools = turn.steps.flatMap((step) => step.tools)
  const summary = running ? '' : turnSummary(turn)
  const usage = turn.steps.reduce(
    (sum, step) => ({
      input: sum.input + (step.usage?.inputTokens ?? 0),
      output: sum.output + (step.usage?.outputTokens ?? 0),
    }),
    { input: 0, output: 0 },
  )
  const firstToken = turn.steps.find((step) => step.firstTokenMs !== undefined)?.firstTokenMs
  let cardIndex = 0
  return (
    <div
      className={[styles.turn, running ? styles.turnRunning : ''].join(' ')}
      style={cssVars({ '--turn-accent': agent ? agentAccent(agent) : 'var(--accent)' })}
    >
      <div className={styles.turnHead}>
        <b>{agent?.name ?? '智能体'}</b>
        {running ? (
          <Chip tone="accent" icon={<Spinner />}>
            {startedAt ? <Elapsed since={startedAt} /> : '进行中'}
          </Chip>
        ) : (
          <span>{[summary, formatDuration(turn.durationMs)].filter(Boolean).join(' · ')}</span>
        )}
        {running && onStop ? (
          <Button
            size="small"
            variant="danger"
            className={styles.turnStop}
            icon={<Square />}
            onClick={onStop}
            title="停止当前任务"
          >
            停止
          </Button>
        ) : null}
      </div>
      {xray ? (
        <div className={[styles.xray, animateXray ? styles.xrayIn : ''].join(' ')}>
          {turn.steps.flatMap((step) => {
            const nodes = []
            const thinking = stepThinking(step)
            if (thinking) nodes.push(<ThinkingCard key={`${step.step}:thinking`} text={thinking} index={cardIndex++} />)
            for (const tool of step.tools)
              nodes.push(
                <ToolCard
                  key={tool.callId}
                  tool={tool}
                  index={cardIndex++}
                  agentId={agent?.id}
                  channelId={channelId}
                />,
              )
            return nodes
          })}
          {usage.input || usage.output ? (
            <div className={styles.usage}>
              <span>输入 {formatTokens(usage.input)}</span>
              <span>输出 {formatTokens(usage.output)}</span>
              {firstToken !== undefined ? <span>首 Token {formatDuration(firstToken)}</span> : null}
            </div>
          ) : null}
        </div>
      ) : tools.length ? (
        <div className={styles.steps}>
          {tools.map((tool) => (
            <ToolStep key={tool.callId} tool={tool} channelId={channelId} agentId={agent?.id} />
          ))}
        </div>
      ) : null}
    </div>
  )
}
