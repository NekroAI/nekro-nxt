import { ArrowDown, ArrowRight, Eye, PanelRight, Plug } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useStickToBottom } from '../../pages/channel-scroll.js'
import {
  connectionDisplayName,
  useProductStore,
  type AgentSummary,
  type ChannelSummary,
  type ConnectionSummary,
  type ConversationMessage,
} from '../../product-runtime.js'
import { AgentAvatar, Button, Chip, StatusDot, toast } from '../../ui-kit/next/index.js'
import { agentHue, agentPhase, connectionTone, triggerLabel } from '../model/identity.js'
import { useProductApi } from '../model/store.js'
import styles from './channels.module.css'
import { MessageRow, TurnRow } from './timeline.js'
import { buildTimeline } from './timeline-model.js'

const EMPTY: readonly ConversationMessage[] = []
const XRAY_KEY = 'nekro-nxt.channel-xray'
const readXray = (): boolean => {
  try {
    return window.localStorage.getItem(XRAY_KEY) === 'true'
  } catch {
    return false
  }
}

function Composer({ channel, agent, connection }: { readonly channel: ChannelSummary; readonly agent: AgentSummary | undefined; readonly connection: ConnectionSummary | undefined }) {
  const api = useProductApi()
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const composing = useRef(false)
  const input = useRef<HTMLTextAreaElement>(null)
  const external = channel.kind !== 'internal'
  const blocked = !agent
    ? '还没有智能体响应这个频道'
    : connection && connectionTone(connection.state) === 'bad'
      ? `${connectionDisplayName(connection)} 当前${connection.state}`
      : external && connection && !connection.proactiveSend
        ? `${connectionDisplayName(connection)} 不支持主动发送`
        : ''

  useEffect(() => setDraft(''), [channel.id])
  useLayoutEffect(() => {
    const element = input.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 180)}px`
  }, [draft])

  const send = async () => {
    const body = draft.trim()
    if (!body || sending || blocked) return
    setSending(true)
    try {
      await api.getState().sendMessage(channel.id, body)
      setDraft('')
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), { tone: 'bad' })
    } finally {
      setSending(false)
      input.current?.focus()
    }
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !composing.current && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void send()
    }
  }

  return (
    <form
      className={styles.composer}
      onSubmit={(event) => {
        event.preventDefault()
        void send()
      }}
    >
      {blocked ? (
        <span className={styles.blocked}>{blocked}</span>
      ) : (
        <>
          {external && connection ? (
            <span className={styles.as} title="以这个机器人账号发出，群成员可见">
              <Plug aria-hidden="true" />
              {connectionDisplayName(connection)}
            </span>
          ) : null}
          <textarea
            ref={input}
            className={styles.input}
            rows={1}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            onCompositionStart={() => (composing.current = true)}
            onCompositionEnd={() => (composing.current = false)}
            placeholder={external ? `发到 ${channel.name}` : `给 ${agent?.name ?? '智能体'} 发消息`}
            aria-label="消息"
          />
        </>
      )}
      <button type="submit" className={styles.send} disabled={Boolean(blocked) || !draft.trim() || sending} aria-label="发送">
        <ArrowRight aria-hidden="true" />
      </button>
    </form>
  )
}

function Queue({ count }: { readonly count: number }) {
  if (count <= 0) return null
  return (
    <div className={styles.queue}>
      <div className={styles.queueBar}>
        <span>
          <b>{count} 条新消息</b>排队中
        </span>
      </div>
    </div>
  )
}

export function Conversation({
  channel,
  agent,
  connection,
  inspectorOpen,
  onToggleInspector,
  onStop,
}: {
  readonly channel: ChannelSummary
  readonly agent: AgentSummary | undefined
  readonly connection: ConnectionSummary | undefined
  readonly inspectorOpen: boolean
  readonly onToggleInspector: () => void
  readonly onStop?: (() => void) | undefined
}) {
  const api = useProductApi()
  const messages = useProductStore((state) => state.messagesByChannel[channel.id] ?? EMPTY)
  const history = useProductStore((state) => state.channelHistory[channel.id])
  const runtime = useProductStore((state) => state.channelRuntimes[channel.id])
  const [xray, setXrayState] = useState(readXray)
  const [xrayAnimated, setXrayAnimated] = useState(false)
  const scroll = useStickToBottom(`${channel.id}:next`, true)
  const known = useRef(new Set<string>())
  const knownChannel = useRef('')

  useEffect(() => {
    void api.getState().loadChannelMessages(channel.id).catch(() => undefined)
    void api.getState().loadChannelRuntime(channel.id).catch(() => undefined)
  }, [channel.id])

  // Messages already present when a channel opens are history; only later arrivals animate in.
  if (knownChannel.current !== channel.id) {
    knownChannel.current = channel.id
    known.current = new Set(messages.map((message) => message.id))
  }
  const fresh = useMemo(() => new Set(messages.filter((message) => !known.current.has(message.id)).map((message) => message.id)), [messages])
  useEffect(() => {
    for (const message of messages) known.current.add(message.id)
  }, [messages])

  useLayoutEffect(() => {
    if (history?.loadingMore === false) scroll.clearPrepend()
  }, [history?.loadingMore, messages[0]?.id, scroll.clearPrepend])

  const items = useMemo(() => buildTimeline(messages, runtime?.turns ?? []), [messages, runtime?.turns])
  const phase = agent ? agentPhase[runtime?.phase ?? channel.runtimePhase ?? agent.state] : undefined
  const trigger = channel.bindings[0] ? triggerLabel[channel.bindings[0].triggerPolicy] : undefined

  const setXray = (next: boolean) => {
    setXrayState(next)
    setXrayAnimated(next)
    try {
      window.localStorage.setItem(XRAY_KEY, String(next))
    } catch {
      // Preference only.
    }
  }
  const loadOlder = () => {
    if (!history?.loaded || history.loading || history.loadingMore || history.hasMore === false) return
    scroll.markPrepend()
    void api.getState().loadChannelMessages(channel.id, 'older').catch(() => undefined)
  }

  return (
    <section className={styles.chan} aria-label={channel.name}>
      <header className={styles.head}>
        <div className={styles.title} key={channel.id}>
          <h1 className={styles.titleLine}>
            <span>{channel.name}</span>
            {phase ? (
              <Chip tone={phase.tone} dot>
                {phase.label}
              </Chip>
            ) : (
              <Chip>未接线</Chip>
            )}
          </h1>
          <div className={styles.subline}>
            {connection ? <StatusDot tone={connectionTone(connection.state)} /> : null}
            <span>{connection ? (connection.alias ? `${connection.alias} · ${connection.adapter}` : connection.adapter) : channel.connectionName}</span>
            {agent ? (
              <span className={styles.responder}>
                <AgentAvatar name={agent.name} hue={agentHue(agent)} size="xs" />
                {agent.name}
                {trigger ? ` · ${trigger}` : ''}
              </span>
            ) : null}
          </div>
        </div>
        <button type="button" className={styles.toggle} aria-pressed={xray} onClick={() => setXray(!xray)} title="显示思考过程与工具细节">
          <Eye aria-hidden="true" />
          <span className={styles.toggleLabel}>透视</span>
          <span className={styles.knob} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={[styles.toggle, styles.iconToggle].join(' ')}
          aria-pressed={inspectorOpen}
          aria-label="频道信息"
          onClick={onToggleInspector}
        >
          <PanelRight aria-hidden="true" />
        </button>
      </header>
      <div ref={scroll.ref} className={styles.conv} onScroll={scroll.onScroll}>
        <div className={[styles.convInner, styles.swap].join(' ')} key={channel.id}>
          {history?.hasMore ? (
            <Button size="small" variant="ghost" className={styles.older} onClick={loadOlder} busy={history.loadingMore}>
              加载更早的消息
            </Button>
          ) : null}
          {items.map((item) =>
            item.kind === 'day' ? (
              <div key={item.key} className={styles.day}>
                {item.label}
              </div>
            ) : item.kind === 'message' ? (
              <MessageRow
                key={item.key}
                message={item.message}
                channelKind={channel.kind}
                agent={agent}
                continued={item.continued}
                fresh={fresh.has(item.message.id)}
              />
            ) : (
              <TurnRow
                key={item.key}
                turn={item.turn}
                agent={agent}
                xray={xray}
                animateXray={xrayAnimated}
                onStop={item.latest ? onStop : undefined}
              />
            ),
          )}
        </div>
      </div>
      <div className={styles.dock}>
        {scroll.away ? (
          <Button size="small" className={styles.jump} icon={<ArrowDown />} onClick={scroll.jumpToBottom}>
            回到最新
          </Button>
        ) : null}
        <Queue count={runtime?.pendingInjectCount ?? 0} />
        <Composer channel={channel} agent={agent} connection={connection} />
      </div>
    </section>
  )
}
