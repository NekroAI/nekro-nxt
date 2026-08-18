import {
  Activity,
  Download,
  File,
  Headphones,
  Image as ImageIcon,
  MessageSquare,
  Send,
  Settings2,
  UsersRound,
  Wrench,
} from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { notify } from '../components/notifications.js'
import { EmptyState, InlineFeedback } from '../components/product-feedback.js'
import { useProductStore, type AgentRuntimeState, type ChannelSummary, type DeliveryState } from '../product-store.js'
import { Button, Field, Input, StatusBadge, Textarea, type StatusTone } from '../ui-kit/index.js'
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

function ChannelLink({ item, active }: { readonly item: ChannelSummary; readonly active: boolean }) {
  return (
    <Link
      to={`/channels/${item.id}`}
      className={[styles.channelLink, active ? styles.channelLinkActive : ''].filter(Boolean).join(' ')}
    >
      {item.kind === 'web' ? (
        <MessageSquare size={15} aria-hidden="true" />
      ) : (
        <UsersRound size={15} aria-hidden="true" />
      )}
      <span>
        <strong>{item.name}</strong>
        <small>{item.connectionName}</small>
      </span>
      {item.unread > 0 ? <span className={styles.unread}>{item.unread}</span> : null}
    </Link>
  )
}

export function ChannelConversationPage() {
  const { channelId } = useParams()
  const navigate = useNavigate()
  const host = useProductStore((state) => state.host)
  const channels = useProductStore((state) => state.channels)
  const agents = useProductStore((state) => state.agents)
  const allMessages = useProductStore((state) => state.messages)
  const channelHistory = useProductStore((state) => state.channelHistory)
  const channel = channels.find((item) => item.id === channelId) ?? (channelId ? undefined : channels[0])
  const agent = channel ? agents.find((item) => item.id === channel.agentId) : undefined
  const messages = useMemo(
    () => (channel ? allMessages.filter((message) => message.channelId === channel.id) : []),
    [allMessages, channel],
  )
  const history = channel ? channelHistory[channel.id] : undefined
  const channelGroups = useMemo(() => {
    const boundIds = new Set<string>()
    const groups = agents.flatMap((candidate) => {
      const items = channels.filter((item) => item.bindings.some((binding) => binding.agentId === candidate.id))
      for (const item of items) boundIds.add(item.id)
      return items.length > 0 ? [{ agent: candidate, channels: items }] : []
    })
    const unbound = channels.filter((item) => !boundIds.has(item.id))
    return { groups, unbound }
  }, [agents, channels])
  const [draft, setDraft] = useState('')
  const [sendPending, setSendPending] = useState(false)
  const [channelName, setChannelName] = useState(channel?.name ?? '')
  const [renamePending, setRenamePending] = useState(false)
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
    void useProductStore
      .getState()
      .loadChannelMessages(channel.id)
      .catch(() => undefined)
  }, [channel?.id])

  useEffect(() => {
    setChannelName(channel?.name ?? '')
  }, [channel?.id, channel?.name])

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

  const rename = async (): Promise<void> => {
    if (!channel || !channelName.trim() || channelName.trim() === channel.name || renamePending) return
    setRenamePending(true)
    try {
      await useProductStore.getState().renameChannel(channel.id, channelName)
      notify('频道名称已保存。', 'success', `channel-rename:${channel.id}`)
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error', `channel-rename:${channel.id}`)
    } finally {
      setRenamePending(false)
    }
  }

  return (
    <div className={styles.conversationPage}>
      <aside className={styles.channelDirectory}>
        <div className={styles.railHeading}>按智能体查看</div>
        {channels.length === 0 ? (
          <div className={styles.railEmpty}>{host.status === 'initializing' ? '正在读取…' : '还没有频道'}</div>
        ) : (
          <div className={styles.channelGroups}>
            {channelGroups.groups.map((group) => (
              <section className={styles.channelGroup} key={group.agent.id}>
                <div className={styles.channelGroupHeader}>
                  <span className={styles.agentAvatar}>{group.agent.name.slice(0, 1)}</span>
                  <span>
                    <strong>{group.agent.name}</strong>
                    <small>{group.channels.length} 个频道</small>
                  </span>
                  <StatusBadge tone={agentTone(group.agent.state)}>{group.agent.state}</StatusBadge>
                </div>
                {group.channels.map((item) => (
                  <ChannelLink key={`${group.agent.id}-${item.id}`} item={item} active={item.id === channel?.id} />
                ))}
              </section>
            ))}
            {channelGroups.unbound.length > 0 ? (
              <section className={styles.channelGroup}>
                <div className={styles.channelGroupHeader}>
                  <span className={styles.agentAvatar}>?</span>
                  <span>
                    <strong>未绑定频道</strong>
                    <small>{channelGroups.unbound.length} 个频道</small>
                  </span>
                </div>
                {channelGroups.unbound.map((item) => (
                  <ChannelLink key={item.id} item={item} active={item.id === channel?.id} />
                ))}
              </section>
            ) : null}
          </div>
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
              <div className={styles.conversationHeaderActions}>
                {agent ? <StatusBadge tone={agentTone(agent.state)}>{agent.state}</StatusBadge> : null}
                {agent ? (
                  <Button
                    size="small"
                    variant="ghost"
                    onClick={() => void navigate(`/agents/${agent.id}?tab=channels`)}
                  >
                    <Settings2 size={14} aria-hidden="true" /> 管理绑定
                  </Button>
                ) : null}
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
              {agent && agent.state !== '空闲' ? (
                <div className={styles.runtimeCard}>
                  <div className={styles.runtimeCardIcon}>
                    {agent.state === '使用工具' ? (
                      <Wrench size={17} aria-hidden="true" />
                    ) : (
                      <Activity size={17} aria-hidden="true" />
                    )}
                  </div>
                  <span>
                    <strong>{runtimeDescription(agent.state)}</strong>
                    <small>新消息会可靠入库，并在安全间隙进入后续处理。</small>
                  </span>
                  <StatusBadge tone={agentTone(agent.state)}>{agent.state}</StatusBadge>
                </div>
              ) : null}
              {history?.loading ? <div className={styles.historyNotice}>正在读取最近消息…</div> : null}
              {history?.loadingMore ? <div className={styles.historyNotice}>正在加载更早消息…</div> : null}
              {history?.error ? <InlineFeedback tone="error">历史消息加载失败：{history.error}</InlineFeedback> : null}
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
                <dt>消息</dt>
                <dd>{messages.length} 条</dd>
                <dt>最近活动</dt>
                <dd>{messages.at(-1)?.time ?? '暂无'}</dd>
              </dl>
              <div className={styles.channelRename}>
                <Field
                  label="频道名称"
                  hint={channel.kind === 'web' ? '用于消息列表显示。' : 'QQ 不提供群名称时，可在此设置本地名称。'}
                >
                  <Input value={channelName} onChange={(event) => setChannelName(event.target.value)} maxLength={120} />
                </Field>
                <Button
                  size="small"
                  loading={renamePending}
                  loadingLabel="保存中…"
                  disabled={!channelName.trim() || channelName.trim() === channel.name}
                  onClick={() => void rename()}
                >
                  保存名称
                </Button>
              </div>
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
            {agent ? (
              <section>
                <h2>继续操作</h2>
                <div className={styles.inspectorActions}>
                  <Button size="small" onClick={() => void navigate(`/agents/${agent.id}?tab=channels`)}>
                    编辑频道绑定
                  </Button>
                  <Button size="small" variant="ghost" onClick={() => void navigate(`/agents/${agent.id}`)}>
                    管理智能体
                  </Button>
                </div>
              </section>
            ) : null}
          </aside>
        </>
      )}
    </div>
  )
}
