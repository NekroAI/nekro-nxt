import type { SubConversation } from '@nekro-nxt/contracts'
import { ChevronRight, ListChecks, MessagesSquare } from 'lucide-react'
import { useState } from 'react'
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

export const subConversationHref = (conversation: Pick<SubConversation, 'channelId' | 'id'>): string =>
  `/channels/${conversation.channelId}/conversations/${conversation.id}`

function SubConversationRow({
  conversation,
  selected,
}: {
  readonly conversation: SubConversation
  readonly selected: boolean
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
          ? subConversationStatus(conversation)
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
  if (conversations.length === 0) return null
  const showClosed = expanded || holdsSelection
  return (
    <div className={styles.rows} role="group" aria-label="子对话">
      {open.map((conversation) => (
        <SubConversationRow
          key={conversation.id}
          conversation={conversation}
          selected={conversation.id === selectedConversationId}
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
            />
          ))
        : null}
    </div>
  )
}
