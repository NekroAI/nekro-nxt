import { Check, CircleAlert, Square, X } from 'lucide-react'
import { Fragment, memo, useEffect, useState } from 'react'
import { MessageContent, resolveMessageSide } from '../../pages/message-content.js'
import type { AgentSummary, ChannelSummary, ConversationMessage } from '../../product-runtime.js'
import { AgentAvatar, Button, Chip, Spinner, cssVars } from '../../ui-kit/next/index.js'
import { MemberAvatar } from '../../ui-kit/next/avatar.js'
import { agentAccent, agentHue } from '../model/identity.js'
import styles from './channels.module.css'
import {
  formatDuration,
  formatTokens,
  isTurnRunning,
  isUnconfirmed,
  presentToolInput,
  type RuntimeTurn,
} from './timeline-model.js'

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

function ToolChip({ tool }: { readonly tool: RuntimeTool }) {
  const state = toolState(tool)
  const view = presentToolInput(tool.inputPreview, tool.wroteToChannel === true || /send|message/i.test(tool.name))
  const chipArg = view?.message ?? view?.fields?.map(([, value]) => value).join(' · ') ?? view?.raw
  return (
    <span className={[styles.step, state.className].join(' ')}>
      {state.icon}
      <b>{tool.displayName}</b>
      {chipArg ? <span className={styles.stepArg}>{chipArg}</span> : null}
      {tool.durationMs !== undefined ? (
        <span className={styles.stepTime}>{formatDuration(tool.durationMs)}</span>
      ) : null}
    </span>
  )
}

function ToolCard({ tool, index }: { readonly tool: RuntimeTool; readonly index: number }) {
  const input = presentToolInput(tool.inputPreview, tool.wroteToChannel === true || /send|message/i.test(tool.name))
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
      <dl className={styles.kv}>
        {input?.message !== undefined ? (
          <>
            <dt>内容</dt>
            <dd>{input.message}</dd>
          </>
        ) : null}
        {input?.fields?.map(([key, value]) => (
          <Fragment key={key}>
            <dt>{key}</dt>
            <dd>{value}</dd>
          </Fragment>
        ))}
        {input?.raw !== undefined ? (
          <>
            <dt>输入</dt>
            <dd>{input.raw}</dd>
          </>
        ) : null}
        {tool.resultPreview ? (
          <>
            <dt>结果</dt>
            <dd>{tool.resultPreview}</dd>
          </>
        ) : null}
        {tool.wroteToChannel ? (
          <>
            <dt>频道</dt>
            <dd>
              {tool.deliveryState === 'sent'
                ? '已发出消息'
                : tool.deliveryState === 'unknown'
                  ? '发出结果未确认'
                  : '写入频道'}
            </dd>
          </>
        ) : null}
      </dl>
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
  xray,
  animateXray,
  startedAt,
  onStop,
}: {
  readonly turn: RuntimeTurn
  readonly agent: AgentSummary | undefined
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
            for (const tool of step.tools) nodes.push(<ToolCard key={tool.callId} tool={tool} index={cardIndex++} />)
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
            <ToolChip key={tool.callId} tool={tool} />
          ))}
        </div>
      ) : null}
    </div>
  )
}
