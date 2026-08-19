import { Activity, Download, File, Headphones, Image as ImageIcon, Send, Settings2, Wrench } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router-dom'
import { notify } from '../components/notifications.js'
import { EmptyState, InlineFeedback } from '../components/product-feedback.js'
import { workHomePath, writeLastChannelId } from '../shell/last-channel.js'
import { useProductStore, type AgentRuntimeState, type DeliveryState } from '../product-store.js'
import { Button, StatusBadge, Textarea, type StatusTone } from '../ui-kit/index.js'
import { BindingTaskDialog } from './binding-task.js'
import { ChannelTrajectoryPane } from './channel-trajectory.js'
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
  const [hasNewMessages, setHasNewMessages] = useState(false)
  const messageListRef = useRef<HTMLDivElement | null>(null)
  const followLatestRef = useRef(true)
  const previousCountRef = useRef(0)
  const previousChannelRef = useRef('')
  const previousOldestRef = useRef('')
  const scrollMemoryRef = useRef(new Map<string, { top: number; atBottom: boolean }>())
  const prependAnchorRef = useRef<{ channelId: string; height: number; top: number } | null>(null)

  useEffect(() => {
    if (!channel) return
    writeLastChannelId(channel.id)
    void useProductStore
      .getState()
      .loadChannelMessages(channel.id)
      .catch(() => undefined)
  }, [channel?.id])

  useLayoutEffect(() => {
    const list = messageListRef.current
    if (!list || !channel) return
    const changedChannel = previousChannelRef.current !== channel.id
    const added = messages.length > previousCountRef.current
    const prepended = added && previousOldestRef.current !== '' && messages[0]?.id !== previousOldestRef.current
    const anchor = prependAnchorRef.current
    if (anchor?.channelId === channel.id) {
      list.scrollTop = anchor.top + (list.scrollHeight - anchor.height)
      prependAnchorRef.current = null
      previousChannelRef.current = channel.id
      previousCountRef.current = messages.length
      previousOldestRef.current = messages[0]?.id ?? ''
      return
    }
    if (changedChannel) {
      const remembered = scrollMemoryRef.current.get(channel.id)
      followLatestRef.current = remembered?.atBottom ?? true
      setHasNewMessages(false)
      list.scrollTop = remembered && !remembered.atBottom ? remembered.top : list.scrollHeight
    } else if (added && !prepended && followLatestRef.current) {
      list.scrollTop = list.scrollHeight
      setHasNewMessages(false)
    } else if (added && !prepended) {
      setHasNewMessages(true)
    }
    previousChannelRef.current = channel.id
    previousCountRef.current = messages.length
    previousOldestRef.current = messages[0]?.id ?? ''
  }, [channel?.id, history?.loaded, messages.length, messages[0]?.id])

  const loadOlder = (): void => {
    const list = messageListRef.current
    if (!channel || !list || history?.loadingMore || history?.hasMore === false) return
    prependAnchorRef.current = { channelId: channel.id, height: list.scrollHeight, top: list.scrollTop }
    void useProductStore
      .getState()
      .loadChannelMessages(channel.id, 'older')
      .catch(() => {
        prependAnchorRef.current = null
      })
  }

  const jumpToLatest = (): void => {
    const list = messageListRef.current
    if (!list) return
    list.scrollTop = list.scrollHeight
    followLatestRef.current = true
    setHasNewMessages(false)
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

              <div
                className={styles.messageList}
                ref={messageListRef}
                onScroll={(event) => {
                  const element = event.currentTarget
                  const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight <= 32
                  followLatestRef.current = atBottom
                  if (channel) scrollMemoryRef.current.set(channel.id, { top: element.scrollTop, atBottom })
                  if (atBottom) setHasNewMessages(false)
                  if (element.scrollTop <= 80) loadOlder()
                }}
              >
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
                {hasNewMessages ? (
                  <div className={styles.newMessageAction}>
                    <Button size="small" onClick={jumpToLatest}>
                      查看新消息
                    </Button>
                  </div>
                ) : null}
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

            <ChannelTrajectoryPane
              channel={channel}
              agent={agent}
              onBind={() => setBindingOpen(true)}
              onReassign={() => setBindingOpen(true)}
            />
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
