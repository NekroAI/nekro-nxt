import { Bot, CheckCircle2, ChevronRight, MessageCircle, Plug, TriangleAlert, Wrench, X } from 'lucide-react'
import { useMemo } from 'react'
import { useProductRuntime } from '../../product-runtime.js'
import { Button, IconButton, Pressable } from '../../ui-kit/index.js'
import { attentionSource, useAttention, type AttentionItem } from '../model/attention.js'
import { useGo } from '../model/nav.js'
import { openBell } from './bell.js'
import styles from './attention-list.module.css'

/** One row of the list: a single item, or several items of one cause shown together. */
export interface AttentionGroup extends AttentionItem {
  /** Stable key of the row; opening the bell on it shows its items one by one. */
  readonly key: string
  readonly ids: readonly string[]
}

/** How several items of one kind from the same place read in one row. */
const SOURCE_NOUN: Partial<Record<AttentionItem['kind'], string>> = {
  'delivery-failed': '条消息发送失败',
  'delivery-unconfirmed': '条消息未确认送达',
  'turn-failed': '次回复失败',
  'authoring-approval': '个请求等待确认',
  'connection-unhealthy': '个连接问题',
  'agent-model-unavailable': '个模型不可用',
  'agent-vision-unavailable': '个识图问题',
}

/**
 * Collapses repeats so a single cause does not drown the rest: items sharing a cause (a connection's outage and the
 * deliveries it failed, an agent's problems) become one row; otherwise three or more agent-level items of one kind
 * become one row, and two or more items of one kind from the same place (one channel's failed deliveries) become one.
 */
export function groupAttention(items: readonly AttentionItem[]): readonly AttentionGroup[] {
  const causeCount = new Map<string, number>()
  for (const item of items) {
    if (item.cause) causeCount.set(item.cause.key, (causeCount.get(item.cause.key) ?? 0) + 1)
  }
  const agentLevel = new Set<AttentionItem['kind']>([
    'agent-model-unavailable',
    'agent-vision-unavailable',
    'delivery-unconfirmed',
  ])
  const keyOf = (item: AttentionItem) => {
    if (item.cause && (causeCount.get(item.cause.key) ?? 0) >= 2) return `cause:${item.cause.key}`
    const kindCount = items.filter((other) => other.kind === item.kind).length
    if (agentLevel.has(item.kind) && kindCount >= 3) return `kind:${item.kind}`
    const placeCount = items.filter((other) => other.kind === item.kind && other.href === item.href).length
    return placeCount >= 2 ? `place:${item.kind}:${item.href}` : `item:${item.id}`
  }
  const groups = new Map<string, AttentionItem[]>()
  for (const item of items) {
    const key = keyOf(item)
    groups.set(key, [...(groups.get(key) ?? []), item])
  }
  return [...groups.entries()].map(([key, members]) => {
    const first = members[0]!
    const ids = members.map((item) => item.id)
    if (members.length === 1) return { ...first, key, ids }
    const count = members.length
    if (key.startsWith('cause:')) {
      // The outage itself leads the row, so its action opens the connection rather than one channel.
      const lead =
        members.find((item) => item.kind === 'connection-unhealthy') ??
        [...members].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])[0]!
      const kinds = new Map<AttentionItem['kind'], number>()
      for (const item of members) kinds.set(item.kind, (kinds.get(item.kind) ?? 0) + 1)
      return {
        ...lead,
        key,
        ids,
        severity: [...members].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])[0]!.severity,
        title: first.cause?.label ?? lead.title,
        detail: [...kinds].map(([kind, number]) => `${number} ${SOURCE_NOUN[kind] ?? '项需要处理'}`).join('，'),
      }
    }
    if (key.startsWith('kind:'))
      return {
        ...first,
        key,
        ids,
        ...(first.kind === 'agent-model-unavailable'
          ? {
              title: `${count} 个智能体无法回复`,
              detail: '它们的主模型当前不可用',
              actionLabel: '查看智能体',
              href: '/agents',
            }
          : first.kind === 'agent-vision-unavailable'
            ? {
                title: `${count} 个智能体看不懂图片`,
                detail: '群里的图片会被跳过',
                actionLabel: '查看智能体',
                href: '/agents',
              }
            : { title: `${count} 条消息未确认送达`, detail: '可以在对应频道里重发或确认', actionLabel: '查看' }),
      }
    return { ...first, key, ids, detail: `${count} ${SOURCE_NOUN[first.kind] ?? '项需要处理'}` }
  })
}

const SEVERITY_RANK: Record<AttentionItem['severity'], number> = { bad: 0, warn: 1, info: 2 }

const attentionIcon = (item: AttentionItem) => {
  if (item.kind === 'community-feedback') return <MessageCircle />
  if (item.kind === 'connection-unhealthy') return <Plug />
  if (item.kind === 'authoring-approval') return <Wrench />
  if (item.kind === 'agent-model-unavailable' || item.kind === 'agent-vision-unavailable') return <Bot />
  return <TriangleAlert />
}

/** Attention items ranked by severity, with their action and dismissal. Lives in the bell (05 §7.2). */
export function AttentionList({
  compact = false,
  focus,
  onClearFocus,
  onAction,
}: {
  /** Popover density: the action stays, detail text wraps under the title. */
  readonly compact?: boolean
  /** Key of one group to show item by item. */
  readonly focus?: string | undefined
  readonly onClearFocus?: () => void
  /** Called after an item's action navigates, e.g. to close the surrounding popover. */
  readonly onAction?: () => void
}) {
  const navigate = useGo()
  const runtime = useProductRuntime()
  const rawAttention = useAttention()
  const groups = useMemo(
    () => [...groupAttention(rawAttention)].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]),
    [rawAttention],
  )
  const focused = focus === undefined ? undefined : groups.find((group) => group.key === focus)
  // A focused group lists its own items; when it is gone (all handled) the full list comes back.
  const rows: readonly AttentionGroup[] = focused
    ? rawAttention
        .filter((item) => focused.ids.includes(item.id))
        .map((item) => ({ ...item, key: `item:${item.id}`, ids: [item.id] }))
    : groups
  if (rows.length === 0)
    return (
      <div className={styles.calm}>
        <CheckCircle2 aria-hidden="true" />
        现在没有需要处理的事情
      </div>
    )
  return (
    <div className={[styles.list, compact ? styles.compact : ''].join(' ')}>
      {!focused && rows.length >= 2 ? (
        <div className={styles.focusHead}>
          <span>忽略后，同一原因恢复前不再提醒</span>
          <Button
            size="small"
            variant="ghost"
            onClick={() => void attentionSource(runtime).dismissWithCauses(rawAttention.map((item) => item.id))}
          >
            全部忽略
          </Button>
        </div>
      ) : null}
      {focused ? (
        <div className={styles.focusHead}>
          <span>
            {focused.title} · {focused.detail}
          </span>
          <Button size="small" variant="ghost" onClick={onClearFocus}>
            显示全部
          </Button>
        </div>
      ) : null}
      {rows.map((item) => (
        <div key={item.key} className={[styles.row, styles[item.severity]].join(' ')}>
          <span className={styles.icon}>{attentionIcon(item)}</span>
          <div className={styles.text}>
            <div className={styles.what}>{item.title}</div>
            <div className={styles.why}>{item.detail}</div>
          </div>
          <Button
            size="small"
            onClick={() => {
              navigate(item.href)
              onAction?.()
            }}
          >
            {item.actionLabel}
          </Button>
          <IconButton
            label="忽略"
            size="small"
            onClick={() => void attentionSource(runtime).dismissWithCauses(item.ids)}
          >
            <X size={14} />
          </IconButton>
        </div>
      ))}
    </div>
  )
}

/**
 * The overview's read-only summary (interaction model §4): one row per cause; a row opens the bell on its items,
 * where they are handled.
 */
export function AttentionSummary() {
  const rawAttention = useAttention()
  const groups = useMemo(
    () => [...groupAttention(rawAttention)].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]),
    [rawAttention],
  )
  if (groups.length === 0)
    return (
      <div className={styles.calm}>
        <CheckCircle2 aria-hidden="true" />
        现在没有需要处理的事情
      </div>
    )
  return (
    <div className={styles.list}>
      {groups.map((group) => (
        <Pressable
          key={group.key}
          className={[styles.row, styles.summaryRow, styles[group.severity]].join(' ')}
          onClick={() => openBell(group.ids.length > 1 ? group.key : undefined)}
        >
          <span className={styles.icon}>{attentionIcon(group)}</span>
          <span className={styles.text}>
            <span className={styles.what}>{group.title}</span>
            <span className={styles.why}>{group.detail}</span>
          </span>
          <ChevronRight className={styles.chevron} aria-hidden="true" />
        </Pressable>
      ))}
    </div>
  )
}
