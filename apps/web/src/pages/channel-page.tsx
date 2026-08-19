import {
  Activity,
  ArrowDown,
  Download,
  File,
  Headphones,
  Image as ImageIcon,
  Send,
  Settings2,
  Wrench,
} from 'lucide-react'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router-dom'
import { notify } from '../components/notifications.js'
import { EmptyState, InlineFeedback } from '../components/product-feedback.js'
import { workHomePath, writeLastChannelId } from '../shell/last-channel.js'
import { useProductStore, type AgentRuntimeState, type DeliveryState } from '../product-store.js'
import { Button, StatusBadge, Textarea, type StatusTone } from '../ui-kit/index.js'
import { BindingTaskDialog } from './binding-task.js'
import { useStickToBottom } from './channel-scroll.js'
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
  if (state === '思考中' || state === '使用工具') return 'info'
  if (state === '等待输入') return 'warning'
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

export function ChannelConversationPage() {
  const { channelId } = useParams()
  const navigate = useNavigate()
  const host = useProductStore((state) => state.host)
  const channels = useProductStore((state) => state.channels)
  const agents = useProductStore((state) => state.agents)
  const allMessages = useProductStore((state) => state.messages)
  const channelHistory = useProductStore((state) => state.channelHistory)
  const channelRuntimes = useProductStore((state) => state.channelRuntimes)
  const channel = channels.find((item) => item.id === channelId) ?? (channelId ? undefined : channels[0])
  const agent = channel ? agents.find((item) => item.id === channel.agentId) : undefined
  const runtime = channel ? channelRuntimes[channel.id] : undefined
  const livePhase = runtime?.phase ?? channel?.runtimePhase ?? agent?.state ?? '空闲'
  const messages = useMemo(
    () => (channel ? allMessages.filter((message) => message.channelId === channel.id) : []),
    [allMessages, channel],
  )
  const history = channel ? channelHistory[channel.id] : undefined
  const [draft, setDraft] = useState('')
  const [bindingOpen, setBindingOpen] = useState(false)
  const [sendPending, setSendPending] = useState(false)
  const [canvasView, setCanvasView] = useState<ChannelCanvasView>(readChannelCanvasView)
  const [trajectorySearch, setTrajectorySearch] = useState('')
  const [selectedRecordId, setSelectedRecordId] = useState('')
  const chatScroll = useStickToBottom(`${channel?.id ?? ''}:chat`, Boolean(channel) && canvasView === 'chat')
  const trajScroll = useStickToBottom(
    `${channel?.id ?? ''}:trajectory`,
    Boolean(channel) && canvasView === 'trajectory',
  )

  const records = useMemo(() => flattenRuntimeRecords(runtime), [runtime])
  const selectedRecord = records.find((record) => record.id === selectedRecordId) ?? records.at(-1)
  const scrollAway = canvasView === 'chat' ? chatScroll.away : trajScroll.away

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

  const loadOlder = (): void => {
    const list = chatScroll.ref.current
    if (!channel || !list || history?.loadingMore || history?.hasMore === false) return
    chatScroll.markPrepend()
    void useProductStore
      .getState()
      .loadChannelMessages(channel.id, 'older')
      .catch(() => {
        chatScroll.clearPrepend()
      })
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

  return (
    <>
      <div className={styles.conversationPage}>
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
            <div className={styles.conversationMain}>
              <header className={styles.conversationHeader}>
                <div>
                  <h1>{channel.name}</h1>
                  <p>{agent ? `由“${agent.name}”响应 · ${channel.trigger}` : '尚未绑定智能体'}</p>
                </div>
                <div className={styles.conversationHeaderActions}>
                  <ChannelViewSwitch
                    view={canvasView}
                    onViewChange={(view) => {
                      setCanvasView(view)
                      writeChannelCanvasView(view)
                    }}
                  />
                  {agent ? <StatusBadge tone={agentTone(livePhase)}>{livePhase}</StatusBadge> : null}
                  {agent ? (
                    <Button size="small" variant="ghost" onClick={() => void navigate(`/agents/${agent.id}`)}>
                      <Settings2 size={14} aria-hidden="true" /> 管理智能体
                    </Button>
                  ) : (
                    <Button size="small" variant="primary" onClick={() => setBindingOpen(true)}>
                      绑定智能体
                    </Button>
                  )}
                </div>
              </header>

              <div className={styles.canvasStage}>
                {canvasView === 'trajectory' ? (
                  <ChannelTrajectoryLedger
                    records={records}
                    selectedId={selectedRecord?.id ?? ''}
                    onSelect={setSelectedRecordId}
                    search={trajectorySearch}
                    onSearchChange={setTrajectorySearch}
                    scrollRef={trajScroll.ref}
                    onScroll={trajScroll.onScroll}
                  />
                ) : (
                  <div
                    className={styles.messageList}
                    ref={chatScroll.ref}
                    aria-label="频道消息"
                    onScroll={() => {
                      chatScroll.onScroll()
                      if ((chatScroll.ref.current?.scrollTop ?? 0) <= 80) loadOlder()
                    }}
                  >
                    <div className={styles.messageListInner}>
                      {history?.loading ? <div className={styles.historyNotice}>正在读取最近消息…</div> : null}
                      {history?.loadingMore ? <div className={styles.historyNotice}>正在加载更早消息…</div> : null}
                      {history?.error ? (
                        <InlineFeedback tone="error">历史消息加载失败：{history.error}</InlineFeedback>
                      ) : null}
                      {messages.length === 0 && !history?.loading ? (
                        <EmptyState title="还没有消息" description="从下方发送第一条消息，或等待平台频道收到新消息。" />
                      ) : (
                        messages.map((message) =>
                          message.role === 'system' ? (
                            <div className={styles.systemMessage} key={message.id}>
                              {message.body}
                            </div>
                          ) : (
                            <article className={styles.message} key={message.id}>
                              <div className={styles.messageAvatar}>{message.author.slice(0, 1)}</div>
                              <div className={styles.messageContent}>
                                <div className={styles.messageHeader}>
                                  <strong>{message.author}</strong>
                                  <time>{message.time}</time>
                                  {message.delivery ? (
                                    <StatusBadge tone={deliveryTone(message.delivery)}>{message.delivery}</StatusBadge>
                                  ) : null}
                                </div>
                                {message.body ? <div className={styles.messageBody}>{message.body}</div> : null}
                                {(message.resources ?? []).map((resource) =>
                                  resource.kind === 'image' ? (
                                    <a
                                      className={styles.messageImageLink}
                                      href={resource.url}
                                      target="_blank"
                                      rel="noreferrer"
                                      key={resource.assetId}
                                    >
                                      <img
                                        className={styles.messageImage}
                                        src={resource.url}
                                        alt={resource.name}
                                        loading="lazy"
                                      />
                                      <span>
                                        <ImageIcon size={14} aria-hidden="true" /> {resource.name}
                                      </span>
                                    </a>
                                  ) : resource.kind === 'audio' ? (
                                    <div className={styles.attachment} key={resource.assetId}>
                                      <Headphones size={15} aria-hidden="true" />
                                      <audio controls preload="none" src={resource.url}>
                                        你的浏览器不支持音频播放。
                                      </audio>
                                    </div>
                                  ) : (
                                    <a
                                      className={styles.attachment}
                                      href={resource.url}
                                      download={resource.name}
                                      key={resource.assetId}
                                    >
                                      <File size={15} aria-hidden="true" /> {resource.name}
                                      <Download size={14} aria-hidden="true" />
                                    </a>
                                  ),
                                )}
                              </div>
                            </article>
                          ),
                        )
                      )}
                      <ChannelWorkStream runtime={runtime} />
                      {agent && livePhase !== '空闲' ? (
                        <div className={styles.runtimeTail}>
                          {livePhase === '使用工具' ? (
                            <Wrench size={14} aria-hidden="true" />
                          ) : (
                            <Activity size={14} aria-hidden="true" />
                          )}
                          <span>{runtime?.summary ?? runtimeDescription(livePhase)}</span>
                        </div>
                      ) : null}
                    </div>
                  </div>
                )}
                {scrollAway ? (
                  <Button
                    size="small"
                    className={styles.jumpBottom}
                    onClick={() => (canvasView === 'chat' ? chatScroll : trajScroll).jumpToBottom()}
                  >
                    <ArrowDown size={14} aria-hidden="true" /> 回到底部
                  </Button>
                ) : null}
              </div>

              <form className={styles.composer} onSubmit={(event) => void submit(event)}>
                <div className={styles.composerTarget}>
                  {channel.kind === 'web'
                    ? agent
                      ? `发送给：${agent.name}`
                      : '当前频道尚未绑定智能体'
                    : `发送到：${channel.name}（通过 QQ 机器人账号）`}
                </div>
                <div className={styles.composerRow}>
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
                    placeholder={agent || channel.kind !== 'web' ? '输入消息' : '请先绑定智能体'}
                    disabled={sendPending || (!agent && channel.kind === 'web')}
                  />
                  <Button
                    variant="primary"
                    type="submit"
                    loading={sendPending}
                    loadingLabel="发送中…"
                    disabled={!draft.trim() || (!agent && channel.kind === 'web')}
                  >
                    <Send size={15} aria-hidden="true" /> 发送
                  </Button>
                </div>
              </form>
            </div>

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
