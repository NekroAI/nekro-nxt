import { File, MessageSquare, Send, UsersRound } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { EmptyState, InlineFeedback } from '../components/product-feedback.js'
import { useProductStore, type AgentRuntimeState, type DeliveryState } from '../product-store.js'
import { Button, StatusBadge, Textarea, type StatusTone } from '../ui-kit/index.js'
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
  const host = useProductStore((state) => state.host)
  const channels = useProductStore((state) => state.channels)
  const agents = useProductStore((state) => state.agents)
  const allMessages = useProductStore((state) => state.messages)
  const channel = channels.find((item) => item.id === channelId) ?? (channelId ? undefined : channels[0])
  const agent = channel ? agents.find((item) => item.id === channel.agentId) : undefined
  const messages = useMemo(
    () => (channel ? allMessages.filter((message) => message.channelId === channel.id) : []),
    [allMessages, channel],
  )
  const [draft, setDraft] = useState('')
  const [sendPending, setSendPending] = useState(false)
  const [sendError, setSendError] = useState('')
  const [hasNewMessages, setHasNewMessages] = useState(false)
  const messageListRef = useRef<HTMLDivElement | null>(null)
  const followLatestRef = useRef(true)
  const previousCountRef = useRef(0)
  const previousChannelRef = useRef('')

  useEffect(() => {
    const list = messageListRef.current
    if (!list || !channel) return
    const changedChannel = previousChannelRef.current !== channel.id
    const added = messages.length > previousCountRef.current
    if (changedChannel) {
      followLatestRef.current = true
      setHasNewMessages(false)
      list.scrollTop = list.scrollHeight
    } else if (added && followLatestRef.current) {
      list.scrollTop = list.scrollHeight
      setHasNewMessages(false)
    } else if (added) {
      setHasNewMessages(true)
    }
    previousChannelRef.current = channel.id
    previousCountRef.current = messages.length
  }, [channel, messages.length])

  const jumpToLatest = (): void => {
    const list = messageListRef.current
    if (!list) return
    list.scrollTop = list.scrollHeight
    followLatestRef.current = true
    setHasNewMessages(false)
  }

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const value = draft.trim()
    if (!channel || !value || sendPending) return
    setSendPending(true)
    setSendError('')
    try {
      await useProductStore.getState().sendMessage(channel.id, value)
      setDraft('')
    } catch (error) {
      setSendError(error instanceof Error ? error.message : String(error))
    } finally {
      setSendPending(false)
    }
  }

  return (
    <div className={styles.conversationPage}>
      <aside className={styles.channelDirectory}>
        <div className={styles.railHeading}>频道</div>
        {channels.length === 0 ? (
          <div className={styles.railEmpty}>{host.status === 'initializing' ? '正在读取…' : '还没有频道'}</div>
        ) : (
          channels.map((item) => (
            <Link
              to={`/channels/${item.id}`}
              className={[styles.channelLink, item.id === channel?.id ? styles.channelLinkActive : '']
                .filter(Boolean)
                .join(' ')}
              key={item.id}
            >
              {item.kind === 'web' ? (
                <MessageSquare size={15} aria-hidden="true" />
              ) : (
                <UsersRound size={15} aria-hidden="true" />
              )}
              <span>{item.name}</span>
              {item.unread > 0 ? <span className={styles.unread}>{item.unread}</span> : null}
            </Link>
          ))
        )}
      </aside>

      {!channel ? (
        <main className={styles.conversationEmpty}>
          <EmptyState
            loading={host.status === 'initializing'}
            title={host.status === 'initializing' ? '正在读取频道' : '还没有频道'}
            description={
              host.status === 'error'
                ? '当前无法读取频道，请重新连接后再试。'
                : '创建智能体会自动建立网页聊天频道；外部平台频道会在收到消息后出现。'
            }
          />
        </main>
      ) : (
        <>
          <main className={styles.conversationMain}>
            <header className={styles.conversationHeader}>
              <div>
                <h1>{channel.name}</h1>
                <p>{agent ? `由“${agent.name}”响应 · ${channel.trigger}` : '尚未绑定智能体'}</p>
              </div>
              {agent ? <StatusBadge tone={agentTone(agent.state)}>{agent.state}</StatusBadge> : null}
            </header>

            <div
              className={styles.messageList}
              ref={messageListRef}
              onScroll={(event) => {
                const element = event.currentTarget
                const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight <= 32
                followLatestRef.current = atBottom
                if (atBottom) setHasNewMessages(false)
              }}
            >
              {messages.length === 0 ? (
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
                        <div className={styles.messageBody}>{message.body}</div>
                        {message.attachment ? (
                          <div className={styles.attachment}>
                            <File size={15} aria-hidden="true" /> {message.attachment.name}
                          </div>
                        ) : null}
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
                    if (sendError) setSendError('')
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
              {sendError ? <InlineFeedback tone="error">发送失败：{sendError}。草稿已保留。</InlineFeedback> : null}
            </form>
          </main>

          <aside className={styles.inspector}>
            <section>
              <h2>频道信息</h2>
              <dl className={styles.facts}>
                <dt>智能体</dt>
                <dd>{agent?.name ?? '未绑定'}</dd>
                <dt>响应方式</dt>
                <dd>{channel.trigger}</dd>
                <dt>来源</dt>
                <dd>{channel.kind === 'web' ? '网页聊天' : 'QQ 机器人账号'}</dd>
              </dl>
            </section>
            <section>
              <h2>当前状态</h2>
              {agent ? (
                <InlineFeedback tone={agent.state === '不可用' ? 'error' : 'info'}>
                  {runtimeDescription(agent.state)}
                </InlineFeedback>
              ) : (
                <InlineFeedback tone="warning">绑定智能体后才能自动响应消息。</InlineFeedback>
              )}
            </section>
          </aside>
        </>
      )}
    </div>
  )
}
