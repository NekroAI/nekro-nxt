import { Activity, ArrowDown, Info, PanelRightClose, PanelRightOpen, Send, Wrench } from 'lucide-react'
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import { Navigate, useParams } from 'react-router-dom'
import { useNxtNavigate } from '../shell/nxt-link.js'
import { notify } from '../components/notifications.js'
import { EmptyState, InlineFeedback } from '../components/product-feedback.js'
import { workHomePath, writeLastChannelId } from '../shell/last-channel.js'
import {
  useProductStore,
  type AgentRuntimeState,
  type ChannelHistoryState,
  type ConversationMessage,
  type DeliveryState,
  type ChannelSummary,
} from '../product-store.js'
import {
  AgentStateRing,
  Button,
  Enter,
  IconButton,
  Presence,
  ResizeHandle,
  SidePane,
  Spinner,
  StageCrossfade,
  StatusBadge,
  Tabs,
  Textarea,
  Tooltip,
  type StatusTone,
} from '../ui-kit/index.js'
import { INSPECTOR_WIDTH, useUiPreferences } from '../ui-preferences.js'
import { BindingTaskDialog } from './binding-task.js'
import { useStickToBottom } from './channel-scroll.js'
import { MessageContent, resolveMessageSide, type MessageSide } from './message-content.js'
import {
  ChannelSessionInspector,
  ChannelTrajectoryInspector,
  ChannelTrajectoryLedger,
  ChannelViewSwitch,
  ChannelWorkStream,
  flattenRuntimeRecords,
  readChannelCanvasView,
  writeChannelCanvasView,
  type ChannelCanvasView,
} from './channel-trajectory.js'
import styles from './product-pages.module.css'

const deliveryTone = (state: DeliveryState): StatusTone => {
  if (state === '已发送') return 'success'
  if (state === '发送中') return 'info'
  if (state === '部分发送') return 'warning'
  if (state === '失败') return 'error'
  return 'unknown'
}

const agentTone = (state: AgentRuntimeState): StatusTone => {
  if (state === '思考中' || state === '使用工具' || state === '等待输入') return 'info'
  if (state === '不可用') return 'error'
  return 'neutral'
}

const runtimeDescription = (state: AgentRuntimeState): string => {
  if (state === '思考中') return '智能体正在处理当前消息。'
  if (state === '使用工具') return '智能体正在使用工具。'
  if (state === '等待输入') return '智能体正在等待输入。'
  if (state === '已暂停') return '智能体已暂停响应新消息。'
  if (state === '不可用') return '智能体当前不可用，请检查模型和连接设置。'
  return '智能体当前空闲。'
}

/**
 * One rendered message row. Wrapped in React.memo so that when only a newer
 * message is appended (or a pure runtime frame refreshes phase/summary),
 * existing rows whose message/side/incoming props did not change are not
 * re-rendered — per-frame work stays proportional to changed messages.
 */
function MessageRowBase({
  message,
  side,
  incoming,
}: {
  readonly message: ConversationMessage
  readonly side: MessageSide
  readonly incoming: boolean
}) {
  const body =
    side === 'system' ? (
      <div className={styles.systemMessage}>
        <MessageContent message={message} />
      </div>
    ) : (
      <article className={styles.message} data-side={side}>
        <div className={styles.messageAvatar}>{message.author.slice(0, 1)}</div>
        <div className={styles.messageContent}>
          <div className={styles.messageHeader}>
            <strong>{message.author}</strong>
            <time>{message.time}</time>
            {message.origin === 'admin-console' ? <StatusBadge tone="warning">管理员从网页发出</StatusBadge> : null}
            {message.delivery ? (
              <StatusBadge tone={deliveryTone(message.delivery)}>{message.delivery}</StatusBadge>
            ) : null}
          </div>
          <MessageContent message={message} />
        </div>
      </article>
    )
  return incoming ? <Enter kind="object">{body}</Enter> : body
}

export const MessageRow = memo(MessageRowBase)

export const appendedMessageIds = (
  messages: readonly Pick<ConversationMessage, 'id'>[],
  knownIds: ReadonlySet<string>,
): ReadonlySet<string> => {
  let lastKnownIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (!knownIds.has(messages[index]!.id)) continue
    lastKnownIndex = index
    break
  }
  if (lastKnownIndex < 0) return new Set()
  return new Set(
    messages
      .slice(lastKnownIndex + 1)
      .filter((message) => !knownIds.has(message.id))
      .map((message) => message.id),
  )
}

/**
 * The static message list for the active channel. Memoized so it only
 * re-renders when this channel's projection actually changes — a runtime frame
 * that refreshes phase/summary leaves messages and history references stable,
 * so the whole historical list (and the markdown messages inside it) is
 * skipped instead of being re-created on every stream tick.
 */
function ChannelMessageListBase({
  messages,
  channelId,
  channelKind,
  history,
}: {
  readonly messages: readonly ConversationMessage[]
  readonly channelId: string
  readonly channelKind: ChannelSummary['kind']
  readonly history: ChannelHistoryState | undefined
}) {
  const knownChannelRef = useRef<string | undefined>(undefined)
  const knownIdsRef = useRef<Set<string> | null>(null)
  if (knownChannelRef.current !== channelId) {
    knownChannelRef.current = channelId
    knownIdsRef.current = new Set(messages.map((message) => message.id))
  }
  const knownIds = knownIdsRef.current ?? new Set<string>()
  const arriving = appendedMessageIds(messages, knownIds)
  for (const message of messages) {
    knownIds.add(message.id)
  }
  knownIdsRef.current = knownIds

  return (
    <>
      {history?.loading ? (
        <Enter kind="fade" className={styles.historyNotice}>
          <Spinner size={14} /> 正在读取最近消息…
        </Enter>
      ) : null}
      {history?.loadingMore ? (
        <Enter kind="fade" className={styles.historyNotice}>
          <Spinner size={14} /> 正在加载更早消息…
        </Enter>
      ) : null}
      {history?.error ? <InlineFeedback tone="error">历史消息加载失败：{history.error}</InlineFeedback> : null}
      {messages.length === 0 && !history?.loading ? (
        <EmptyState title="还没有消息" description="从下方发送第一条消息，或等待平台频道收到新消息。" />
      ) : (
        messages.map((message) => {
          const side = resolveMessageSide({
            channelKind,
            role: message.role,
            ...(message.origin === undefined ? {} : { origin: message.origin }),
          })
          return <MessageRow key={message.id} message={message} side={side} incoming={arriving.has(message.id)} />
        })
      )}
    </>
  )
}

export const ChannelMessageList = memo(ChannelMessageListBase)

export function ChannelConversationPage() {
  const { channelId } = useParams()
  const navigate = useNxtNavigate()
  const host = useProductStore((state) => state.host)
  const channels = useProductStore((state) => state.channels)
  const agents = useProductStore((state) => state.agents)
  const allMessages = useProductStore((state) => state.messages)
  const channelHistory = useProductStore((state) => state.channelHistory)
  const connections = useProductStore((state) => state.connections)
  const channel = useProductStore((state) =>
    channelId ? state.channels.find((item) => item.id === channelId) : state.channels[0],
  )
  const agent = channel ? agents.find((item) => item.id === channel.agentId) : undefined
  const runtime = useProductStore((state) => (channel ? state.channelRuntimes[channel.id] : undefined))
  const livePhase = runtime?.phase ?? channel?.runtimePhase ?? agent?.state ?? '空闲'
  const activeChannelId = channel?.id
  const messages = useMemo(
    () => (activeChannelId ? allMessages.filter((message) => message.channelId === activeChannelId) : []),
    [allMessages, activeChannelId],
  )
  const history = activeChannelId ? channelHistory[activeChannelId] : undefined
  const [draft, setDraft] = useState('')
  const [bindingOpen, setBindingOpen] = useState(false)
  const [sendPending, setSendPending] = useState(false)
  const inspectorPaneRef = useRef<HTMLDivElement>(null)
  const [canvasView, setCanvasView] = useState<ChannelCanvasView>(readChannelCanvasView)
  const [trajectorySearch, setTrajectorySearch] = useState('')
  const [selectedRecordId, setSelectedRecordId] = useState('')
  const savedInspectorWidth = useUiPreferences((state) => state.layout.inspectorWidth)
  const inspectorCollapsed = useUiPreferences((state) => state.layout.inspectorCollapsed)
  const [inspectorWidth, setInspectorWidth] = useState(savedInspectorWidth)
  const chatScroll = useStickToBottom(`${channel?.id ?? ''}:chat`, Boolean(channel) && canvasView === 'chat')
  const trajScroll = useStickToBottom(
    `${channel?.id ?? ''}:trajectory`,
    Boolean(channel) && canvasView === 'trajectory',
  )

  const records = useMemo(() => flattenRuntimeRecords(runtime), [runtime])
  const selectedRecord = records.find((record) => record.id === selectedRecordId) ?? records.at(-1)
  const scrollAway = canvasView === 'chat' ? chatScroll.away : trajScroll.away
  const webChannel = agent ? channels.find((item) => item.kind === 'web' && item.agentId === agent.id) : undefined
  const connection = channel ? connections.find((item) => item.id === channel.connectionId) : undefined
  const canSendOnWeb = channel?.kind === 'web' && Boolean(agent)
  const canSendAsRobot = Boolean(channel && channel.kind !== 'web' && agent && connection?.proactiveSend)
  const toggleInspector = (): void => {
    useUiPreferences.getState().setInspectorCollapsed(!inspectorCollapsed)
  }

  useEffect(() => {
    if (!channel) return
    writeLastChannelId(channel.id)
    void useProductStore
      .getState()
      .loadChannelMessages(channel.id)
      .catch(() => undefined)
    void useProductStore
      .getState()
      .loadChannelRuntime(channel.id)
      .catch(() => undefined)
  }, [channel?.id])

  useEffect(() => {
    const lastId = records.at(-1)?.id ?? ''
    setSelectedRecordId((current) => (records.some((record) => record.id === current) ? current : lastId))
  }, [channel?.id, records])

  useEffect(() => setInspectorWidth(savedInspectorWidth), [savedInspectorWidth])

  useEffect(() => {
    const pane = inspectorPaneRef.current
    if (!pane) return
    if (inspectorCollapsed) pane.setAttribute('inert', '')
    else pane.removeAttribute('inert')
  }, [inspectorCollapsed])

  useLayoutEffect(() => {
    if (history?.loadingMore === false) chatScroll.clearPrepend()
  }, [history?.loadingMore, messages[0]?.id, chatScroll.clearPrepend])

  useLayoutEffect(() => {
    if (canvasView === 'chat') chatScroll.reconcileLayout()
  }, [canvasView, draft, chatScroll.reconcileLayout])

  const loadOlder = (): void => {
    const list = chatScroll.ref.current
    if (!channel || !list || !history?.loaded || history.loading || history.loadingMore || history.hasMore === false)
      return
    chatScroll.markPrepend()
    void useProductStore
      .getState()
      .loadChannelMessages(channel.id, 'older')
      .catch(() => undefined)
  }

  if (!channelId && (channels.length > 0 || agents.length > 0)) {
    return <Navigate to={workHomePath({ channels, agents })} replace />
  }

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const value = draft.trim()
    if (!channel || !value || sendPending) return
    setSendPending(true)
    try {
      await useProductStore.getState().sendMessage(channel.id, value)
      setDraft('')
    } catch (error) {
      notify(
        `发送失败：${error instanceof Error ? error.message : String(error)}。草稿已保留。`,
        'error',
        `channel-send:${channel.id}`,
      )
    } finally {
      setSendPending(false)
    }
  }
  const conversationStyle: CSSProperties & {
    '--nxt-inspector-width': string
  } = {
    '--nxt-inspector-width': `${inspectorWidth}px`,
  }
  const composerMode =
    channel?.kind === 'web'
      ? agent
        ? '发给智能体'
        : '请先绑定智能体'
      : !agent
        ? '请先绑定智能体'
        : connection?.proactiveSend
          ? '发到频道'
          : '连接未允许主动发送'
  const composerExplanation =
    channel?.kind === 'web'
      ? agent
        ? `内容会作为当前网页频道的入站消息交给“${agent.name}”。`
        : '绑定智能体后，输入才会作为当前网页频道的入站消息。'
      : !agent
        ? `此频道来自“${channel?.connectionName ?? '当前连接'}”；绑定智能体后才能以机器人账号发言。`
        : connection?.proactiveSend
          ? `“${channel?.connectionName ?? '当前连接'}”会向平台频道发出内容，并标记为管理员从网页发出。`
          : `“${channel?.connectionName ?? '当前连接'}”尚未允许主动发送。`

  return (
    <>
      <div className={styles.conversationPage} style={conversationStyle}>
        {!channel ? (
          <div className={styles.conversationEmpty}>
            <EmptyState
              loading={host.status === 'initializing'}
              title={host.status === 'initializing' ? '正在读取频道' : '还没有频道'}
              description={
                host.status === 'error'
                  ? '当前无法读取频道，请重新连接后再试。'
                  : '创建智能体会自动建立网页聊天频道；外部平台频道会在收到消息后出现。'
              }
            />
          </div>
        ) : (
          <>
            <Tabs.Root
              className={styles.conversationMain}
              value={canvasView}
              onValueChange={(value) => {
                if (value !== 'chat' && value !== 'trajectory') return
                setCanvasView(value)
                writeChannelCanvasView(value)
              }}
            >
              <header className={styles.conversationHeader}>
                <StageCrossfade swapKey={channel.id}>
                  <div>
                    <h1>{channel.name}</h1>
                    <p>{agent ? `由“${agent.name}”响应 · ${channel.trigger}` : '尚未绑定智能体'}</p>
                  </div>
                </StageCrossfade>
                <div className={styles.conversationHeaderActions} data-conversation-header-actions>
                  <ChannelViewSwitch />
                  {agent ? (
                    <>
                      {livePhase !== '空闲' ? <AgentStateRing state={livePhase} label={livePhase} /> : null}
                      <StatusBadge tone={agentTone(livePhase)}>{livePhase}</StatusBadge>
                    </>
                  ) : null}
                  <IconButton
                    label={inspectorCollapsed ? '展开检查器' : '收起检查器'}
                    className={styles.inspectorToggle}
                    onClick={toggleInspector}
                  >
                    {inspectorCollapsed ? (
                      <PanelRightOpen size={14} aria-hidden="true" />
                    ) : (
                      <PanelRightClose size={14} aria-hidden="true" />
                    )}
                  </IconButton>
                  {!agent ? (
                    <Button size="small" variant="primary" onClick={() => setBindingOpen(true)}>
                      绑定智能体
                    </Button>
                  ) : null}
                </div>
              </header>
              <StageCrossfade swapKey={canvasView} className={styles.canvasStage}>
                <div className={styles.canvasStageInner} data-channel-canvas-stage data-view={canvasView}>
                  {canvasView === 'trajectory' ? (
                    <Tabs.Content className={styles.canvasTab} value="trajectory">
                      <ChannelTrajectoryLedger
                        records={records}
                        selectedId={selectedRecord?.id ?? ''}
                        onSelect={setSelectedRecordId}
                        search={trajectorySearch}
                        onSearchChange={setTrajectorySearch}
                        scrollRef={trajScroll.ref}
                        onScroll={trajScroll.onScroll}
                      />
                    </Tabs.Content>
                  ) : (
                    <Tabs.Content className={styles.canvasTab} value="chat">
                      <div
                        className={styles.messageList}
                        data-channel-message-list
                        ref={chatScroll.ref}
                        aria-label="频道消息"
                        onScroll={() => {
                          chatScroll.onScroll()
                          if ((chatScroll.ref.current?.scrollTop ?? 0) <= 80) loadOlder()
                        }}
                      >
                        <div className={styles.messageListInner}>
                          <ChannelMessageList
                            messages={messages}
                            channelId={activeChannelId ?? ''}
                            channelKind={channel.kind}
                            history={history}
                          />
                          <ChannelWorkStream runtime={runtime} />
                          {agent && livePhase !== '空闲' ? (
                            <Enter kind="fade" className={styles.runtimeTail} key={livePhase}>
                              {livePhase === '使用工具' ? (
                                <Wrench size={14} aria-hidden="true" />
                              ) : (
                                <Activity size={14} aria-hidden="true" />
                              )}
                              <span>{runtime?.summary ?? runtimeDescription(livePhase)}</span>
                            </Enter>
                          ) : null}
                        </div>
                      </div>
                    </Tabs.Content>
                  )}
                  {scrollAway ? (
                    <div className={styles.jumpBottom}>
                      <Button
                        size="small"
                        onClick={() => (canvasView === 'chat' ? chatScroll : trajScroll).jumpToBottom()}
                      >
                        <ArrowDown size={14} aria-hidden="true" /> 回到底部
                      </Button>
                    </div>
                  ) : null}
                  {canvasView === 'chat' ? (
                    <div
                      className={styles.composer}
                      data-channel-composer
                      data-mode={channel.kind === 'web' ? 'web' : 'platform'}
                    >
                      <form onSubmit={(event) => void submit(event)}>
                        <Textarea
                          className={styles.composerInput}
                          value={draft}
                          onChange={(event) => {
                            setDraft(event.target.value)
                          }}
                          onKeyDown={(event) => {
                            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
                            event.preventDefault()
                            if (draft.trim() && !sendPending) event.currentTarget.form?.requestSubmit()
                          }}
                          aria-label="消息内容"
                          aria-describedby="channel-composer-mode"
                          rows={1}
                          placeholder={
                            channel.kind === 'web'
                              ? agent
                                ? '输入消息'
                                : '请先绑定智能体'
                              : canSendAsRobot
                                ? '输入消息'
                                : !agent
                                  ? '请先绑定智能体'
                                  : '当前连接不允许主动发言'
                          }
                          disabled={sendPending || (channel.kind === 'web' ? !canSendOnWeb : !canSendAsRobot)}
                        />
                        <div className={styles.composerModeRow}>
                          <Tooltip.Root>
                            <Tooltip.Trigger asChild>
                              <span className={styles.composerInfo} tabIndex={0} role="img" aria-label="发送方式说明">
                                <Info size={14} aria-hidden="true" />
                              </span>
                            </Tooltip.Trigger>
                            <Tooltip.Portal>
                              <Tooltip.Content side="top" align="start" sideOffset={8} collisionPadding={12}>
                                {composerExplanation}
                              </Tooltip.Content>
                            </Tooltip.Portal>
                          </Tooltip.Root>
                          <span className={styles.composerMode}>{composerMode}</span>
                          <span className={styles.composerModeSpacer} aria-hidden="true" />
                          {channel.kind !== 'web' && webChannel ? (
                            <Button
                              variant="ghost"
                              size="small"
                              className={styles.composerWebAction}
                              onClick={() => void navigate(`/work/channels/${webChannel.id}`)}
                            >
                              去网页频道
                            </Button>
                          ) : null}
                          <IconButton
                            label={channel.kind === 'web' ? '发送给智能体' : '发到频道'}
                            className={styles.composerSend}
                            type="submit"
                            loading={sendPending}
                            loadingLabel="发送中…"
                            disabled={!draft.trim() || (channel.kind === 'web' ? !canSendOnWeb : !canSendAsRobot)}
                          >
                            <Send size={14} aria-hidden="true" />
                          </IconButton>
                        </div>
                        <span className={styles.srOnly} id="channel-composer-mode">
                          {composerExplanation}
                        </span>
                      </form>
                    </div>
                  ) : null}
                </div>
              </StageCrossfade>
            </Tabs.Root>

            <ResizeHandle
              className={styles.inspectorSplitter}
              label="调整检查器宽度"
              value={inspectorWidth}
              min={INSPECTOR_WIDTH.min}
              max={INSPECTOR_WIDTH.max}
              defaultValue={INSPECTOR_WIDTH.default}
              side="after"
              disabled={inspectorCollapsed}
              onChange={setInspectorWidth}
              onCommit={(value) => useUiPreferences.getState().setInspectorWidth(value)}
            />
            <SidePane collapsed={inspectorCollapsed} width={inspectorWidth} className={styles.inspectorPane}>
              <div ref={inspectorPaneRef} style={{ height: '100%', minHeight: 0 }}>
                <Presence initial={false}>
                  <Enter kind="fade" key={`${channel.id}:${canvasView}`} style={{ height: '100%', minHeight: 0 }}>
                    {canvasView === 'trajectory' ? (
                      <ChannelTrajectoryInspector record={selectedRecord} />
                    ) : (
                      <ChannelSessionInspector
                        channel={channel}
                        agent={agent}
                        runtime={runtime}
                        onBind={() => setBindingOpen(true)}
                        onReassign={() => setBindingOpen(true)}
                      />
                    )}
                  </Enter>
                </Presence>
              </div>
            </SidePane>
          </>
        )}
      </div>
      {channel ? (
        <BindingTaskDialog
          open={bindingOpen}
          onOpenChange={setBindingOpen}
          channelId={channel.id}
          title={agent ? '更改响应智能体' : '绑定智能体'}
          description={
            agent
              ? '这个频道同一时间只由一个智能体响应。保存后，后续消息改由新的智能体处理。'
              : '选择响应这个频道的智能体和触发方式。'
          }
        />
      ) : null}
    </>
  )
}
