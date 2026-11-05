import type { SubConversation } from '@nekro-nxt/contracts'
import { ChevronRight, ListChecks, MessagesSquare } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useProductStore } from '../../product-runtime.js'
import { Pressable } from '../../ui-kit/index.js'
import { relativeTime } from './timeline-model.js'
import styles from './sub-conversations.module.css'

const EMPTY: readonly SubConversation[] = []

/** How a sub-conversation ended, as the list and its page say it. */
export const subConversationStatus = (conversation: SubConversation): string => {
  if (conversation.status === 'open') return '进行中'
  switch (conversation.closeReason) {
    case 'completed':
      return '已完成'
    case 'closed-by-admin':
      return '管理员已结束'
    case 'failed':
      return '未完成'
    case 'conversation-ended':
      return '随频道对话结束'
    case 'closed-by-agent':
    case undefined:
      return '已结束'
  }
}

/** An open sub-conversation counts as quiet once nothing has happened in it for this long. */
const QUIET_AFTER_MS = 5 * 60_000

/** How long an open sub-conversation has been quiet, or undefined while it is not. */
export const subConversationQuiet = (conversation: SubConversation, now: number): string | undefined => {
  if (conversation.status !== 'open') return undefined
  const quietMs = now - (conversation.lastActivityAt ?? conversation.createdAt)
  if (quietMs < QUIET_AFTER_MS) return undefined
  const minutes = Math.floor(quietMs / 60_000)
  if (minutes < 60) return `${minutes} 分钟无动静`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours} 小时无动静` : `${Math.floor(hours / 24)} 天无动静`
}

export const subConversationHref = (conversation: Pick<SubConversation, 'channelId' | 'id'>): string =>
  `/channels/${conversation.channelId}/conversations/${conversation.id}`

function SubConversationRow({
  conversation,
  selected,
  now,
}: {
  readonly conversation: SubConversation
  readonly selected: boolean
  readonly now: number
}) {
  const Icon = conversation.driver === 'script' ? ListChecks : MessagesSquare
  return (
    <Link
      to={subConversationHref(conversation)}
      className={styles.row}
      data-selected={selected}
      data-status={conversation.status}
      aria-current={selected ? 'page' : undefined}
    >
      <Icon className={styles.icon} aria-hidden="true" />
      <span className={styles.title}>{conversation.title}</span>
      <span className={styles.meta}>
        {conversation.status === 'open'
          ? (subConversationQuiet(conversation, now) ?? subConversationStatus(conversation))
          : relativeTime(conversation.closedAt ?? conversation.createdAt)}
      </span>
    </Link>
  )
}

/**
 * The sub-conversations under one channel row: open ones always, ended ones folded behind a count. Renders nothing
 * for a channel without any.
 */
export function SubConversationRows({
  channelId,
  selectedConversationId,
}: {
  readonly channelId: string
  readonly selectedConversationId: string | undefined
}) {
  const all = useProductStore((state) => state.subConversations ?? EMPTY)
  const conversations = all.filter((conversation) => conversation.channelId === channelId)
  const open = conversations.filter((conversation) => conversation.status === 'open')
  const closed = conversations.filter((conversation) => conversation.status === 'closed')
  const holdsSelection = closed.some((conversation) => conversation.id === selectedConversationId)
  const [expanded, setExpanded] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const hasOpen = open.length > 0
  useEffect(() => {
    if (!hasOpen) return
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [hasOpen])
  if (conversations.length === 0) return null
  const showClosed = expanded || holdsSelection
  return (
    <div className={styles.rows} role="group" aria-label="子对话">
      {open.map((conversation) => (
        <SubConversationRow
          key={conversation.id}
          conversation={conversation}
          selected={conversation.id === selectedConversationId}
          now={now}
        />
      ))}
      {closed.length > 0 ? (
        <Pressable
          type="button"
          className={styles.fold}
          aria-expanded={showClosed}
          onClick={() => setExpanded(!showClosed)}
        >
          <ChevronRight className={styles.foldIcon} aria-hidden="true" />
          已结束 {closed.length}
        </Pressable>
      ) : null}
      {showClosed
        ? closed.map((conversation) => (
            <SubConversationRow
              key={conversation.id}
              conversation={conversation}
              selected={conversation.id === selectedConversationId}
              now={now}
            />
          ))
        : null}
    </div>
  )
}
