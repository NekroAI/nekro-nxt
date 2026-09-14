import { ChannelComposer } from './channel-composer.js'
import { EMPTY_CHANNEL_MESSAGES } from '../channel-messages.js'
import { runtimeStateLabel } from '../product-model.js'
import { useProductRuntime } from '../product-runtime.js'
import {
  Activity,
  ArrowDown,
  FileUp,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
} from '../product-runtime.js'
import {
  Button,
  ConfirmDialog,
  DropdownMenu,
  Enter,
  MessageEnter,
  IconButton,
  Presence,
  ResizeHandle,
  SidePane,
  Spinner,
  StageCrossfade,
  StatusBadge,
  Tabs,
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
  createTrajectoryProjector,
  readChannelCanvasView,
  writeChannelCanvasView,
  type ChannelCanvasView,
} from './channel-trajectory.js'
import styles from './product-pages.module.css'

const deliveryTone = (state: DeliveryState): StatusTone => {
  if (state === '发送中') return 'info'
  if (state === '部分发送') return 'warning'
  if (state === '失败') return 'error'
  return 'unknown'
}

const authoringTaskPresentation = (status: string): { readonly label: string; readonly tone: StatusTone } => {
  if (status === 'awaiting-approval') return { label: '等待确认', tone: 'warning' }
  if (status === 'ready') return { label: '可以预览', tone: 'success' }
  if (status === 'failed' || status === 'interrupted') return { label: '需要处理', tone: 'error' }
  if (status === 'stopped' || status === 'completed') return { label: '已结束', tone: 'neutral' }
  if (status === 'repairing') return { label: '正在修复', tone: 'info' }
  return { label: '正在开发', tone: 'info' }
}

export const isBubblelessMessage = (message: Pick<ConversationMessage, 'parts'>): boolean => {
  if (message.parts.length !== 1) return false
  const [part] = message.parts
  return part?.type !== 'text' && part?.type !== 'mention'
}

const agentTone = (state: AgentRuntimeState): StatusTone => {
  if (state === 'thinking' || state === 'using-tool' || state === 'waiting-input') return 'info'
  if (state === 'unavailable') return 'error'
  return 'neutral'
}

const runtimeDescription = (state: AgentRuntimeState): string => {
  if (state === 'thinking') return '智能体正在处理当前消息。'
  if (state === 'using-tool') return '智能体正在使用工具。'
  if (state === 'waiting-input') return '智能体正在等待输入。'
  if (state === 'unavailable') return '智能体当前不可用，请检查模型和连接设置。'
  return '智能体当前空闲。'
}

const systemEventIcon = (icon: string | undefined): LucideIcon => {
  if (icon === 'file-text') return FileUp
  if (icon === 'wrench') return Wrench
  return Activity
}

function SystemEventRow({ message }: { readonly message: ConversationMessage }) {
  const icon = useProductStore((state) => {
    const channel = state.channels.find((candidate) => candidate.id === message.channelId)
    const connection = state.connections.find((candidate) => candidate.id === channel?.connectionId)
    const descriptor = state.connectionAdapters.find((candidate) => candidate.key === connection?.adapterKey)
    return descriptor?.activities.find((activity) => activity.key === message.activityKey)?.icon
  })
  const Icon = systemEventIcon(icon)
  return (
    <div className={styles.systemEvent} data-side="system" data-activity-type={message.activityKey}>
      <span className={styles.systemEventRule} aria-hidden="true" />
      <div className={styles.systemEventMain}>
        <Icon className={styles.systemEventIcon} size={14} strokeWidth={1.8} aria-hidden="true" />
        <MessageContent message={message} variant="system-event" />
      </div>
      <span className={styles.systemEventRule} aria-hidden="true" />
    </div>
  )
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
      <SystemEventRow message={message} />
    ) : (
      <article
        className={styles.message}
        data-side={side}
        data-bubbleless={isBubblelessMessage(message) ? '' : undefined}
      >
        <div className={styles.messageAvatar}>{message.author.slice(0, 1)}</div>
        <div className={styles.messageContent}>
          <div className={styles.messageHeader}>
            <strong>{message.author}</strong>
            <time>{message.time}</time>
            {message.origin === 'admin-console' ? <StatusBadge tone="warning">管理员从客户端发出</StatusBadge> : null}
            {message.delivery && message.delivery !== '已发送' ? (
              <StatusBadge tone={deliveryTone(message.delivery)}>{message.delivery}</StatusBadge>
            ) : null}
          </div>
          <MessageContent message={message} />
        </div>
      </article>
    )
  return <MessageEnter incoming={incoming}>{body}</MessageEnter>
}

export const MessageRow = memo(MessageRowBase)

export const appendedMessageIds = (
  messages: readonly Pick<ConversationMessage, 'id'>[],
  knownIds: ReadonlySet<string>,
  emptyHistoryLoaded = false,
): ReadonlySet<string> => {
  let lastKnownIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (!knownIds.has(messages[index]!.id)) continue
    lastKnownIndex = index
    break
  }
  if (lastKnownIndex < 0)
    return new Set(emptyHistoryLoaded && knownIds.size === 0 ? messages.map((message) => message.id) : [])
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
  const known = useRef<{ channelId: string; ids: ReadonlySet<string>; loaded: boolean }>({
    channelId,
    ids: new Set(messages.map((message) => message.id)),
    loaded: false,
  })
  const arriving =
    known.current.channelId === channelId
      ? appendedMessageIds(
          messages,
          known.current.ids,
          known.current.loaded && !history?.loading && !history?.loadingMore,
        )
      : new Set<string>()
  useLayoutEffect(() => {
    known.current = { channelId, ids: new Set(messages.map((message) => message.id)), loaded: Boolean(history?.loaded) }
  }, [channelId, messages, history])

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
  const useProductRuntimeUi = useProductRuntime().uiStore

  const useProductStore = useProductRuntime().store

  const { channelId } = useParams()
  const navigate = useNxtNavigate()
  const host = useProductStore((state) => state.host)
  const channels = useProductStore((state) => state.channels)
  const agents = useProductStore((state) => state.agents)
  const connections = useProductStore((state) => state.connections)
  const dynamic = useProductStore((state) => state.dynamic)
  const authoringTasks = useProductStore((state) => state.authoringTasks)
  const channel = useProductStore((state) =>
    channelId ? state.channels.find((item) => item.id === channelId) : state.channels[0],
  )
  const agent = channel ? agents.find((item) => item.id === channel.agentId) : undefined
  const pendingDynamicApproval = dynamic.find(
    (item) => item.agentId === agent?.id && item.status === 'awaiting-approval' && item.approvalRequestId,
  )
  const pendingExtensionName = pendingDynamicApproval?.packages.find(
    (item) => item.packageId === (pendingDynamicApproval.packageId ?? pendingDynamicApproval.nextPackageId),
  )?.name
  const authoringTask = authoringTasks.find((item) => item.channelId === channel?.id)
  const runtime = useProductStore((state) => (channel ? state.channelRuntimes[channel.id] : undefined))
  const livePhase = runtime?.phase ?? channel?.runtimePhase ?? agent?.state ?? 'idle'
  const activeChannelId = channel?.id
  const messages = useProductStore((state) =>
    activeChannelId ? (state.messagesByChannel[activeChannelId] ?? EMPTY_CHANNEL_MESSAGES) : EMPTY_CHANNEL_MESSAGES,
  )
  const history = useProductStore((state) => (activeChannelId ? state.channelHistory[activeChannelId] : undefined))
  const [bindingOpen, setBindingOpen] = useState(false)
  const [contextResetMode, setContextResetMode] = useState<'clear' | 'compact' | null>(null)
  const [channelDeleteOpen, setChannelDeleteOpen] = useState(false)
  const inspectorPaneRef = useRef<HTMLDivElement>(null)
  const [canvasView, setCanvasView] = useState<ChannelCanvasView>(readChannelCanvasView)
  const [trajectorySearch, setTrajectorySearch] = useState('')
  const [selectedRecordId, setSelectedRecordId] = useState('')
  const savedInspectorWidth = useUiPreferences((state) => state.layout.inspectorWidth)
  const inspectorCollapsed = useUiPreferences((state) => state.layout.inspectorCollapsed)
  const inspectorWidth = savedInspectorWidth
  const inspectorResizeRef = useRef<HTMLDivElement>(null)
  const [inspectorHidden, setInspectorHidden] = useState(inspectorCollapsed)
  useEffect(() => {
    if (!inspectorCollapsed) setInspectorHidden(false)
  }, [inspectorCollapsed])
  const chatScroll = useStickToBottom(`${channel?.id ?? ''}:chat`, Boolean(channel) && canvasView === 'chat')
  const trajScroll = useStickToBottom(
    `${channel?.id ?? ''}:trajectory`,
    Boolean(channel) && canvasView === 'trajectory',
  )

  const projectTrajectory = useMemo(createTrajectoryProjector, [])
  const records = useMemo(
    () => (canvasView === 'trajectory' ? projectTrajectory(runtime) : []),
    [runtime, canvasView, projectTrajectory],
  )
  const selectedRecord = records.find((record) => record.id === selectedRecordId) ?? records.at(-1)
  const scrollAway = canvasView === 'chat' ? chatScroll.away : trajScroll.away
  const webChannel = agent ? channels.find((item) => item.kind === 'internal' && item.agentId === agent.id) : undefined
  const connection = channel ? connections.find((item) => item.id === channel.connectionId) : undefined
  const toggleInspector = (): void => {
    useProductRuntimeUi.getState().setInspectorCollapsed(!inspectorCollapsed)
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

  useEffect(() => {
    const pane = inspectorPaneRef.current
    if (!pane) return
    if (inspectorCollapsed) pane.setAttribute('inert', '')
    else pane.removeAttribute('inert')
  }, [inspectorCollapsed])

  useLayoutEffect(() => {
    if (history?.loadingMore === false) chatScroll.clearPrepend()
  }, [history?.loadingMore, messages[0]?.id, chatScroll.clearPrepend])

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

  const resetContext = async (mode: 'clear' | 'compact'): Promise<boolean> => {
    if (!channel || !runtime?.episodeId) return false
    try {
      await useProductStore.getState().resetChannelContext(channel.id, runtime.episodeId, mode)
      notify(
        mode === 'clear' ? '当前上下文已清空；下一条消息会从干净上下文开始。' : '当前上下文已压缩并完成交接。',
        'success',
        `channel-context-reset:${channel.id}`,
      )
      return true
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error', `channel-context-reset:${channel.id}`)
      return false
    }
  }
  const deleteChannel = async (): Promise<boolean> => {
    if (!channel) return false
    try {
      await useProductStore.getState().deleteChannel(channel.id, channel.agentId || null)
      notify(
        channel.kind === 'internal' ? '内置频道已删除；历史记录可在审计中查询。' : '频道已从 NekroNXT 移除。',
        'success',
        `channel-delete:${channel.id}`,
      )
      void navigate('/work')
      return true
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error', `channel-delete:${channel.id}`)
      return false
    }
  }

  return (
    <>
      <div className={styles.conversationPage}>
        {!channel ? (
          <div className={styles.conversationEmpty}>
            <EmptyState
              loading={host.status === 'initializing'}
              illustration={
                host.status === 'error'
                  ? { src: '/brand/illustrations/host-unreachable.svg' }
                  : agents.length === 0
                    ? { src: '/brand/illustrations/welcome.png', alt: '水月荧邀请创建第一个智能体' }
                    : { src: '/brand/illustrations/no-connections.svg' }
              }
              title={host.status === 'initializing' ? '正在读取频道' : '还没有频道'}
              description={
                host.status === 'error'
                  ? '当前无法读取频道，请重新连接后再试。'
                  : '创建智能体会自动建立内置频道；外部平台频道会在收到消息后出现。'
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
                    <div className={styles.conversationTitleRow} data-conversation-title>
                      {agent ? (
                        <StatusBadge tone={agentTone(livePhase)}>{runtimeStateLabel(livePhase)}</StatusBadge>
                      ) : null}
                      <h1>{channel.name}</h1>
                    </div>
                    <p>{agent ? `由“${agent.name}”响应 · ${channel.trigger}` : '尚未绑定智能体'}</p>
                  </div>
                </StageCrossfade>
                <div className={styles.conversationHeaderActions} data-conversation-header-actions>
                  {agent && runtime?.episodeId ? (
                    <DropdownMenu.Root>
                      <DropdownMenu.Trigger asChild>
                        <IconButton label="上下文操作">
                          <MoreHorizontal size={15} aria-hidden="true" />
                        </IconButton>
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Content align="end">
                        <DropdownMenu.Label>上下文操作</DropdownMenu.Label>
                        <DropdownMenu.Item onSelect={() => setContextResetMode('compact')}>
                          压缩上下文
                        </DropdownMenu.Item>
                        <DropdownMenu.Item onSelect={() => setContextResetMode('clear')}>清空上下文</DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Root>
                  ) : null}
                  <ChannelViewSwitch />
                </div>
              </header>
              {inspectorCollapsed ? (
                <div className={styles.conversationInspectorDock}>
                  <IconButton label="展开频道检查器" onClick={toggleInspector}>
                    <PanelRightOpen size={14} aria-hidden="true" />
                  </IconButton>
                </div>
              ) : null}
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
                          {authoringTask ? (
                            <div className={styles.approvalNotice} role="status">
                              <span>
                                扩展开发“{authoringTask.title}”：{authoringTaskPresentation(authoringTask.status).label}
                                。
                              </span>
                              <StatusBadge tone={authoringTaskPresentation(authoringTask.status).tone}>
                                {authoringTaskPresentation(authoringTask.status).label}
                              </StatusBadge>
                              <Button
                                size="small"
                                variant="secondary"
                                onClick={() => void navigate(`/work/creator/${authoringTask.id}`)}
                              >
                                打开任务
                              </Button>
                            </div>
                          ) : pendingDynamicApproval ? (
                            <div className={styles.approvalNotice} role="status">
                              <span>扩展「{pendingExtensionName ?? '未命名扩展'}」正在等待界面预览确认。</span>
                              <Button
                                size="small"
                                variant="secondary"
                                onClick={() => void navigate(`/work/creator?agent=${pendingDynamicApproval.agentId}`)}
                              >
                                前往确认
                              </Button>
                            </div>
                          ) : null}
                          <ChannelWorkStream runtime={runtime} />
                          {agent && livePhase !== 'idle' ? (
                            <Enter kind="fade" className={styles.runtimeTail} key={livePhase}>
                              {livePhase === 'using-tool' ? (
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
                    <ChannelComposer channel={channel} agent={agent} connection={connection} webChannel={webChannel} />
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
              previewTarget={{ ref: inspectorResizeRef, property: '--nxt-inspector-width' }}
              onCommit={(value) => useProductRuntimeUi.getState().setInspectorWidth(value)}
            />
            <SidePane
              collapsed={inspectorCollapsed}
              width={inspectorWidth}
              widthVariable="--nxt-inspector-width"
              rootRef={inspectorResizeRef}
              onSettled={setInspectorHidden}
              className={styles.inspectorPane}
            >
              <div ref={inspectorPaneRef} className={styles.inspectorChrome}>
                <header className={styles.inspectorChromeHeader}>
                  <div>
                    <span>频道检查器</span>
                    <strong>{canvasView === 'trajectory' ? '工作轨迹' : channel.name}</strong>
                  </div>
                  <IconButton label="收起频道检查器" onClick={toggleInspector}>
                    <PanelRightClose size={14} aria-hidden="true" />
                  </IconButton>
                </header>
                <div className={styles.inspectorChromeBody}>
                  <Presence initial={false}>
                    <Enter kind="fade" key={`${channel.id}:${canvasView}`} style={{ height: '100%', minHeight: 0 }}>
                      {canvasView === 'trajectory' ? (
                        <ChannelTrajectoryInspector
                          record={selectedRecord}
                          {...(agent === undefined ? {} : { agentId: agent.id })}
                          channelId={channel.id}
                        />
                      ) : (
                        <ChannelSessionInspector
                          channel={channel}
                          agent={agent}
                          runtime={runtime}
                          metricsVisible={!inspectorCollapsed || !inspectorHidden}
                          onBind={() => setBindingOpen(true)}
                          onReassign={() => setBindingOpen(true)}
                          onDelete={() => setChannelDeleteOpen(true)}
                        />
                      )}
                    </Enter>
                  </Presence>
                </div>
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
      <ConfirmDialog
        open={contextResetMode !== null}
        onOpenChange={(open) => {
          if (!open) setContextResetMode(null)
        }}
        title={contextResetMode === 'clear' ? '清空当前上下文？' : '压缩当前上下文？'}
        description={
          contextResetMode === 'clear'
            ? '当前生成或工具调用会立即中止，并开始空白上下文。频道消息可通过历史查询工具查找；已完成的外部操作保留既有结果。'
            : '当前生成或工具调用会立即中止，系统会把有效历史整理成交接摘要，并以摘要开始新上下文。已完成的外部操作保留既有结果。'
        }
        confirmLabel={contextResetMode === 'clear' ? '清空上下文' : '压缩上下文'}
        confirmVariant={contextResetMode === 'clear' ? 'danger' : 'primary'}
        confirmLoadingLabel={contextResetMode === 'clear' ? '正在清空…' : '正在压缩…'}
        confirmDisabled={!runtime?.episodeId}
        onConfirm={() => (contextResetMode === null ? false : resetContext(contextResetMode))}
      />
      <ConfirmDialog
        open={channelDeleteOpen}
        onOpenChange={setChannelDeleteOpen}
        title={channel?.kind === 'internal' ? '删除内置频道？' : '从 NekroNXT 移除此频道？'}
        description={
          channel?.kind === 'internal'
            ? '当前生成或工具调用会立即中止，频道会解除绑定并从列表中移除。历史消息、资源和审计事实可在记录中查询。'
            : '当前生成或工具调用会立即中止，频道会解除绑定并从列表中移除。再次收到消息时，频道会重新出现在列表中。'
        }
        confirmLabel={channel?.kind === 'internal' ? '删除内置频道' : '从 NekroNXT 移除'}
        confirmVariant="danger"
        confirmLoadingLabel="正在移除…"
        confirmDisabled={!channel}
        onConfirm={deleteChannel}
      />
    </>
  )
}
