import { AlarmClock, BellOff, BellRing, Check, ChevronRight, CircleAlert, EyeOff, Info, Square, X } from 'lucide-react'
import { ToolView } from '../../extension-ui/index.js'
import { workspaceApi } from '../../host-api-client.js'
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
type RuntimeInput = NonNullable<RuntimeTurn['inputs']>[number]

export const MessageRow = memo(function MessageRow({
  message,
  channelKind,
  agent,
  localAgentName,
  continued,
  fresh,
  onResolve,
}: {
  readonly message: ConversationMessage
  readonly channelKind: ChannelSummary['kind']
  readonly agent: AgentSummary | undefined
  /** The sender is this other agent on the same host, speaking through its own account. */
  readonly localAgentName?: string | undefined
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
        message.inboundHook?.hidden === true ? styles.hiddenFromAgent : '',
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
          {localAgentName === undefined ? null : (
            <span className={styles.adminTag} title="本机的另一个智能体，用它自己的账号在这个群里发言">
              本机 · {localAgentName}
            </span>
          )}
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
      {message.inboundHook ? <HookNote hook={message.inboundHook} /> : null}
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

const HOOK_OUTCOME = {
  hidden: { icon: <EyeOff aria-hidden="true" />, label: '对智能体隐藏' },
  suppress: { icon: <BellOff aria-hidden="true" />, label: '未唤醒智能体' },
  force: { icon: <BellRing aria-hidden="true" />, label: '已唤醒智能体' },
  annotated: { icon: <Info aria-hidden="true" />, label: '附加了说明' },
  failed: { icon: <CircleAlert aria-hidden="true" />, label: '扩展处理出错' },
} as const

/** Which extension handled a member message before the agent saw it, and how. */
function HookNote({ hook }: { readonly hook: NonNullable<ConversationMessage['inboundHook']> }) {
  const outcome = hook.hidden
    ? HOOK_OUTCOME.hidden
    : hook.trigger === 'suppress'
      ? HOOK_OUTCOME.suppress
      : hook.trigger === 'force'
        ? HOOK_OUTCOME.force
        : hook.annotation !== undefined
          ? HOOK_OUTCOME.annotated
          : HOOK_OUTCOME.failed
  const details = [hook.annotation, ...(hook.problems ?? [])].filter((item) => item !== undefined)
  return (
    <div
      className={styles.hookNote}
      data-problem={hook.problems !== undefined || undefined}
      title={details.length > 0 ? details.join('\n') : undefined}
    >
      {outcome.icon}
      {outcome.label}
      {hook.extensions.length > 0 ? ` · ${hook.extensions.join('、')}` : ''}
    </div>
  )
}

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

/** Where a message the model received came from (DSH `user/message` source kinds the host writes). */
const INPUT_SOURCES: Readonly<Record<string, string>> = {
  'nekro-nxt-handoff': '交接摘要',
  'nekro-nxt-console-outbound': '管理员发送的消息',
  'nekro-nxt-memory-review': '安静时回顾笔记',
  'nekro-nxt-channel-reply-guard': '回应提醒',
  'nekro-nxt-visual-restore': '恢复历史图片',
  'nekro-nxt-authoring-event': '扩展开发进展',
}

const inputLabel = (input: RuntimeInput): string =>
  input.source === 'nekro-nxt-channel'
    ? `收到 ${input.eventCount ?? 1} 条频道消息`
    : (INPUT_SOURCES[input.source] ?? '注入的上下文')

/** What the model received as input: a preview at once, the full text on request (it is read from the live session). */
function InputCard({
  input,
  index,
  channelId,
}: {
  readonly input: RuntimeInput
  readonly index: number
  readonly channelId: string | undefined
}) {
  const [full, setFull] = useState<{ readonly text: string; readonly truncated: boolean } | 'missing' | undefined>()
  const [loading, setLoading] = useState(false)
  const load = () => {
    if (!channelId) return
    setLoading(true)
    workspaceApi
      .getChannelRuntimeInput(channelId, input.messageId)
      .then((detail) =>
        setFull(
          detail.available && detail.text !== undefined
            ? { text: detail.text, truncated: detail.truncated }
            : 'missing',
        ),
      )
      .catch(() => setFull('missing'))
      .finally(() => setLoading(false))
  }
  return (
    <div className={[styles.card, styles.thinking].join(' ')} style={cssVars({ '--i': index })}>
      <div className={styles.cardHead}>
        <span className={styles.cardIndex}>{index + 1}</span>
        <b>{inputLabel(input)}</b>
        {full === undefined && channelId ? (
          <Button size="small" variant="ghost" className={styles.cardState} disabled={loading} onClick={load}>
            {loading ? <Spinner /> : '查看全文'}
          </Button>
        ) : null}
      </div>
      {full !== undefined && full !== 'missing' ? (
        <pre className={styles.inputText}>
          {full.text}
          {full.truncated ? '\n…' : ''}
        </pre>
      ) : input.preview ? (
        <p className={styles.thinkingText}>
          {input.preview}
          {full === 'missing' ? '（会话已结束，只保留了预览）' : ''}
        </p>
      ) : null}
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
  trigger,
  channelId,
  xray,
  animateXray,
  startedAt,
  onStop,
}: {
  readonly turn: RuntimeTurn
  readonly agent: AgentSummary | undefined
  /** The channel message that opened this turn, when it is loaded. */
  readonly trigger?: ConversationMessage | undefined
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
        {trigger && trigger.role !== 'agent' ? <span className={styles.turnTrigger}>回应 {trigger.author}</span> : null}
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
          {(turn.inputs ?? []).map((input) => (
            <InputCard key={input.messageId} input={input} index={cardIndex++} channelId={channelId} />
          ))}
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
