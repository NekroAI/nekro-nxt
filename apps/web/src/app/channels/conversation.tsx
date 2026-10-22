import { ArrowDown, ChevronDown, Eye, MessageSquareDashed, PanelRight } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Composer } from './composer.js'
import { workspaceApi } from '../../host-api-client.js'
import { useStickToBottom } from './channel-scroll.js'
import {
  useProductStore,
  type AgentSummary,
  type ChannelSummary,
  type ConnectionSummary,
  type ChannelRuntimeView,
  type ConversationMessage,
  type ModelSummary,
} from '../../product-runtime.js'
import {
  AgentAvatar,
  Button,
  Chip,
  ConfirmDialog,
  Disclosure,
  EmptyState,
  ShimmerText,
  MemberAvatar,
  StatusDot,
  toast,
  Tooltip,
  Pressable,
} from '../../ui-kit/index.js'
import { connectionStatus } from '../model/connection-status.js'
import { agentHue, agentPhase, triggerLabel } from '../model/identity.js'
import { useProductApi } from '../model/store.js'
import { useGo } from '../model/nav.js'
import { Link } from 'react-router-dom'
import type { HostApiResponse } from '@nekro-nxt/contracts'
import styles from './channels.module.css'
import { subConversationStatus } from './sub-conversation-rows.js'
import subStyles from './sub-conversations.module.css'
import { CompactionRow, MessageRow, TurnRow } from './timeline.js'
import { buildTimeline, relativeTime } from './timeline-model.js'

const EMPTY: readonly ConversationMessage[] = []
const XRAY_KEY = 'nekro-nxt.channel-xray'
const readXray = (): boolean => {
  try {
    return window.localStorage.getItem(XRAY_KEY) === 'true'
  } catch {
    return false
  }
}

type Pending = Awaited<ReturnType<typeof workspaceApi.getChannelPending>>

function Queue({ channelId, count }: { readonly channelId: string; readonly count: number }) {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState<Pending | null>(null)
  useEffect(() => {
    setOpen(false)
    setPending(null)
  }, [channelId])
  useEffect(() => {
    if (!open) return
    let current = true
    void workspaceApi
      .getChannelPending(channelId)
      .then((next) => current && setPending(next))
      .catch(() => undefined)
    return () => {
      current = false
    }
  }, [open, channelId, count])
  if (count <= 0) return null
  const events = pending?.items.flatMap((item) => item.events) ?? []
  const authors = [...new Set(events.map((event) => event.author))].slice(0, 3)
  return (
    <div className={[styles.queue, open ? styles.queueOpen : ''].join(' ')}>
      <Pressable type="button" className={styles.queueBar} aria-expanded={open} onClick={() => setOpen(!open)}>
        {authors.length ? (
          <span className={styles.stack}>
            {authors.map((author) => (
              <MemberAvatar key={author} name={author} size="sm" />
            ))}
          </span>
        ) : null}
        <span>
          <b>{count} 条新消息</b>排队中
        </span>
        <ChevronDown className={styles.chevron} aria-hidden="true" />
      </Pressable>
      <Disclosure open={open}>
        <div className={styles.queueList}>
          {events.map((event) => (
            <div key={event.eventId}>
              <span className={styles.time}>
                {new Date(event.receivedAt).toLocaleTimeString('zh-CN', {
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: false,
                })}
              </span>
              <span>
                <b>{event.author}</b>：{event.preview}
              </span>
            </div>
          ))}
        </div>
      </Disclosure>
    </div>
  )
}

export function Conversation({
  channel,
  agent,
  connection,
  inspectorOpen,
  onToggleInspector,
}: {
  readonly channel: ChannelSummary
  readonly agent: AgentSummary | undefined
  readonly connection: ConnectionSummary | undefined
  readonly inspectorOpen: boolean
  readonly onToggleInspector: () => void
}) {
  const api = useProductApi()
  const messages = useProductStore((state) => state.messagesByChannel[channel.id] ?? EMPTY)
  const history = useProductStore((state) => state.channelHistory[channel.id])
  const runtime = useProductStore((state) => state.channelRuntimes[channel.id])
  const agents = useProductStore((state) => state.agents)
  const [xray, setXrayState] = useState(readXray)
  const [stopping, setStopping] = useState(false)
  const [xrayAnimated, setXrayAnimated] = useState(false)
  const scroll = useStickToBottom(`${channel.id}:next`, true)
  const known = useRef(new Set<string>())
  const knownChannel = useRef('')

  useEffect(() => {
    void api
      .getState()
      .loadChannelMessages(channel.id)
      .catch(() => undefined)
    void api
      .getState()
      .loadChannelRuntime(channel.id)
      .catch(() => undefined)
  }, [channel.id])

  // Messages already present when a channel opens are history; only later arrivals animate in.
  if (knownChannel.current !== channel.id) {
    knownChannel.current = channel.id
    known.current = new Set(messages.map((message) => message.id))
  }
  const fresh = useMemo(
    () => new Set(messages.filter((message) => !known.current.has(message.id)).map((message) => message.id)),
    [messages],
  )
  useEffect(() => {
    for (const message of messages) known.current.add(message.id)
  }, [messages])

  useLayoutEffect(() => {
    if (history?.loadingMore === false) scroll.clearPrepend()
  }, [history?.loadingMore, messages[0]?.id, scroll.clearPrepend])

  const latest = messages.at(-1)
  useEffect(() => {
    if (!latest || latest.occurredAt === undefined || channel.unread === 0) return
    const timer = window.setTimeout(() => {
      void workspaceApi
        .markChannelRead(channel.id, { occurredAt: latest.occurredAt ?? 0, sourceId: latest.id })
        .catch(() => undefined)
    }, 400)
    return () => window.clearTimeout(timer)
  }, [channel.id, channel.unread, latest])

  const resolve = async (messageId: string, action: 'retry' | 'confirm-delivered') => {
    try {
      await workspaceApi.resolveOutbound(messageId, action)
      toast(action === 'retry' ? '已重新发送' : '已标记为送达')
      void api
        .getState()
        .loadChannelMessages(channel.id, 'latest')
        .catch(() => undefined)
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), { tone: 'bad' })
    }
  }

  const items = useMemo(() => buildTimeline(messages, runtime?.turns ?? []), [messages, runtime?.turns])
  const messageById = useMemo(() => new Map(messages.map((message) => [message.id, message])), [messages])
  const phaseKey = agent ? (runtime?.phase ?? channel.runtimePhase ?? agent.state) : undefined
  const phase = phaseKey ? agentPhase[phaseKey] : undefined
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
    void api
      .getState()
      .loadChannelMessages(channel.id, 'older')
      .catch(() => undefined)
  }

  return (
    <section className={styles.chan} aria-label={channel.name}>
      <header className={styles.head}>
        <div className={styles.title} key={channel.id}>
          <h1 className={styles.titleLine}>
            <span>{channel.name}</span>
            {phase ? (
              <Chip tone={phase.tone} dot>
                {phaseKey === 'thinking' || phaseKey === 'using-tool' ? (
                  <ShimmerText>{phase.label}</ShimmerText>
                ) : (
                  phase.label
                )}
              </Chip>
            ) : (
              <Chip>未接线</Chip>
            )}
            {channel.bindings[0]?.paused ? <Chip tone="warn">已暂停</Chip> : null}
            {runtime?.modelFallback ? <ModelFallbackChip fallback={runtime.modelFallback} /> : null}
          </h1>
          <div className={styles.subline}>
            {connection ? <StatusDot tone={connectionStatus(connection).tone} /> : null}
            <span>
              {connection
                ? connection.alias
                  ? `${connection.alias} · ${connection.adapter}`
                  : connection.adapter
                : channel.connectionName}
            </span>
            {agent ? (
              <span className={styles.responder}>
                <AgentAvatar name={agent.name} hue={agentHue(agent)} size="xs" />
                {agent.name}
                {trigger ? ` · ${trigger}` : ''}
              </span>
            ) : null}
          </div>
        </div>
        <Pressable
          type="button"
          className={styles.toggle}
          aria-pressed={xray}
          onClick={() => setXray(!xray)}
          title="显示思考过程与工具细节"
        >
          <Eye aria-hidden="true" />
          <span className={styles.toggleLabel}>透视</span>
        </Pressable>
        <Pressable
          type="button"
          className={[styles.toggle, styles.iconToggle].join(' ')}
          aria-pressed={inspectorOpen}
          aria-label="频道信息"
          onClick={onToggleInspector}
        >
          <PanelRight aria-hidden="true" />
        </Pressable>
      </header>
      <div ref={scroll.ref} className={styles.conv} onScroll={scroll.onScroll} role="log" aria-label="消息记录">
        <div className={[styles.convInner, styles.swap].join(' ')} key={channel.id}>
          {history?.hasMore ? (
            <Button
              size="small"
              variant="ghost"
              className={styles.older}
              onClick={loadOlder}
              busy={history.loadingMore}
            >
              加载更早的消息
            </Button>
          ) : null}
          {history?.loaded && items.length === 0 ? (
            <div className={styles.emptyTimeline}>
              <EmptyState icon={<MessageSquareDashed />} title="还没有消息">
                {!agent
                  ? '接上智能体后，它会在这里回复。'
                  : channel.kind === 'internal'
                    ? `在下方给${agent.name}发第一条消息。`
                    : '群里有新消息时会出现在这里。'}
              </EmptyState>
            </div>
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
                localAgentName={
                  item.message.localAgentId === undefined
                    ? undefined
                    : (agents.find((candidate) => candidate.id === item.message.localAgentId)?.name ?? '智能体')
                }
                continued={item.continued}
                fresh={fresh.has(item.message.id)}
                onResolve={(messageId, action) => void resolve(messageId, action)}
              />
            ) : (
              <TurnRow
                key={item.key}
                turn={item.turn}
                agent={agent}
                trigger={item.turn.triggerEventId === undefined ? undefined : messageById.get(item.turn.triggerEventId)}
                channelId={channel.id}
                xray={xray}
                animateXray={xrayAnimated}
                startedAt={item.turn.startedAt}
                onStop={item.latest ? () => setStopping(true) : undefined}
              />
            ),
          )}
          {runtime?.compaction ? (
            <CompactionRow agent={agent} kind={runtime.compaction.kind} startedAt={runtime.compaction.startedAt} />
          ) : null}
        </div>
      </div>
      <div className={styles.dock}>
        {scroll.away ? (
          <Button size="small" className={styles.jump} icon={<ArrowDown />} onClick={scroll.jumpToBottom}>
            回到最新
          </Button>
        ) : null}
        <Queue channelId={channel.id} count={runtime?.pendingInjectCount ?? 0} />
        <Composer key={channel.id} channel={channel} agent={agent} connection={connection} />
      </div>
      <ConfirmDialog
        open={stopping}
        onOpenChange={setStopping}
        title={`停止${agent?.name ?? '智能体'}当前的任务？`}
        confirmLabel="停止"
        danger
        onConfirm={async () => {
          const result = await workspaceApi.stopChannelTask(channel.id, runtime?.episodeId)
          toast(result.result === 'stopped' ? '已停止' : '当前没有进行中的任务')
          void api
            .getState()
            .loadChannelRuntime(channel.id)
            .catch(() => undefined)
        }}
      >
        <p>已完成的步骤不会撤回，排队的消息会保留。</p>
      </ConfirmDialog>
    </section>
  )
}

type SubConversationRead = HostApiResponse<'getSubConversationRuntime'>

/** How often an open sub-conversation's record is read again while its page is shown. */
const SUB_CONVERSATION_POLL_MS = 2000

/**
 * One sub-conversation under its channel (docs/NekroNxt界面交互模型.md §5.6): what it was opened for, how it ended and
 * everything that happened in it. It is read only; agents pass messages in and out of it.
 */
const FALLBACK_REASON: Readonly<Record<NonNullable<ChannelRuntimeView['modelFallback']>['reason'], string>> = {
  quota: '主模型额度用完',
  'rate-limit': '主模型持续限流',
  unavailable: '主模型暂时不可用',
}

/** The conversation runs on a fallback model: which, why, and when it tries the main model again. */
function ModelFallbackChip({ fallback }: { readonly fallback: NonNullable<ChannelRuntimeView['modelFallback']> }) {
  const models = useProductStore((state) => state.models)
  const known = models.find((item) => item.provider === fallback.model.provider && item.id === fallback.model.model)
  const retry =
    fallback.retryMainAt <= Date.now()
      ? '收到新消息时换回主模型'
      : `${new Date(fallback.retryMainAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 后收到新消息时换回主模型`
  return (
    <Tooltip
      content={`${FALLBACK_REASON[fallback.reason]}，正在用「${known?.name ?? fallback.model.model}」；${retry}`}
    >
      <span tabIndex={0} className={styles.fallbackChip}>
        <Chip tone="warn">备用模型</Chip>
      </span>
    </Tooltip>
  )
}

/** The model a sub-conversation talks in, by the catalog's names while it is still configured. */
const subConversationModelLabel = (
  model: NonNullable<SubConversationRead['conversation']['model']>,
  models: readonly ModelSummary[],
): string => {
  const known = models.find((item) => item.provider === model.provider && item.id === model.model)
  return known ? `${known.providerName} · ${known.name}` : model.model
}

export function SubConversationView({
  channel,
  agent,
  conversationId,
}: {
  readonly channel: ChannelSummary
  readonly agent: AgentSummary | undefined
  readonly conversationId: string
}) {
  const summary = useProductStore((state) =>
    state.subConversations.find((conversation) => conversation.id === conversationId),
  )
  const models = useProductStore((state) => state.models)
  const [read, setRead] = useState<SubConversationRead>()
  const [missing, setMissing] = useState(false)
  const [confirm, setConfirm] = useState<'close' | 'delete' | null>(null)
  const go = useGo()
  const status = read?.conversation.status ?? summary?.status
  const changedAt = summary?.closedAt ?? summary?.status

  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = () => {
      workspaceApi
        .getSubConversationRuntime(conversationId, { signal: controller.signal })
        .then((next) => {
          setRead(next)
          setMissing(false)
          if (next.conversation.status === 'open') timer = setTimeout(load, SUB_CONVERSATION_POLL_MS)
        })
        .catch(() => {
          if (!controller.signal.aborted) setMissing(true)
        })
    }
    load()
    return () => {
      controller.abort()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [conversationId, changedAt])

  const conversation = read?.conversation ?? summary
  if (!conversation) {
    return (
      <div className={styles.emptyCanvas}>
        <EmptyState
          icon={<MessageSquareDashed />}
          title={missing ? '这个子对话已经不在了' : '正在读取子对话'}
          action={
            missing ? (
              <Button variant="primary" onClick={() => go(`/channels/${channel.id}`)}>
                回到频道
              </Button>
            ) : undefined
          }
        >
          {missing ? '结束后超过保留时间的子对话会连同记录一起清理。' : undefined}
        </EmptyState>
      </div>
    )
  }
  const turns = read?.runtime.turns ?? []
  return (
    <section className={styles.chan} aria-label={conversation.title}>
      <header className={styles.head}>
        <div className={styles.title} key={conversation.id}>
          <h1 className={styles.titleLine}>
            <span>{conversation.title}</span>
            <Chip tone={status === 'open' ? 'accent' : conversation.closeReason === 'failed' ? 'warn' : 'neutral'} dot>
              {subConversationStatus(conversation)}
            </Chip>
          </h1>
          <div className={styles.subline}>
            <Link to={`/channels/${channel.id}`} className={subStyles.channelLink}>
              {channel.name}
            </Link>
            <span>
              {conversation.openedBy === 'agent'
                ? `${agent?.name ?? '智能体'}开启`
                : conversation.authoringTaskId === undefined
                  ? 'NekroNXT 开启'
                  : 'NekroNXT 开启 · 验证扩展候选'}
              {` · ${relativeTime(conversation.createdAt)}`}
            </span>
            {conversation.model === undefined ? null : (
              <span>{subConversationModelLabel(conversation.model, models)}</span>
            )}
            {conversation.authoringTaskId === undefined ? null : (
              <Link to={`/workshop/tasks/${conversation.authoringTaskId}`} className={subStyles.channelLink}>
                查看创造任务
              </Link>
            )}
          </div>
        </div>
        {conversation.status === 'open' ? (
          <Button size="small" onClick={() => setConfirm('close')}>
            结束
          </Button>
        ) : (
          <Button size="small" variant="danger" onClick={() => setConfirm('delete')}>
            销毁
          </Button>
        )}
      </header>
      <div className={styles.conv} role="log" aria-label="子对话记录">
        <div className={styles.convInner}>
          {conversation.summary ? (
            <div className={subStyles.summary}>
              <b>{conversation.closeReason === 'failed' ? '没有完成' : '结论'}</b>
              <p>{conversation.summary}</p>
            </div>
          ) : null}
          {read && turns.length === 0 ? (
            <div className={styles.emptyTimeline}>
              <EmptyState icon={<MessageSquareDashed />} title="还没有记录">
                子对话开始处理后，过程会出现在这里。
              </EmptyState>
            </div>
          ) : null}
          {turns.map((turn) => (
            <TurnRow key={turn.turn} turn={turn} agent={agent} xray animateXray={false} startedAt={turn.startedAt} />
          ))}
        </div>
      </div>
      <p className={subStyles.readOnly}>子对话里的消息由智能体之间传递，这里只能查看。</p>
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={confirm === 'close' ? '结束这个子对话？' : '销毁这个子对话？'}
        confirmLabel={confirm === 'close' ? '结束' : '销毁'}
        danger={confirm === 'delete'}
        onConfirm={async () => {
          if (confirm === 'close') {
            await workspaceApi.closeSubConversation(conversation.id)
            toast('子对话已结束')
            return
          }
          await workspaceApi.deleteSubConversation(conversation.id)
          toast('子对话已销毁')
          go(`/channels/${channel.id}`)
        }}
      >
        <p>{confirm === 'close' ? '它正在做的事会停下，记录保留，可以继续查看。' : '它的记录会一起删除，无法恢复。'}</p>
      </ConfirmDialog>
    </section>
  )
}
