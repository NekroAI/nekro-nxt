import { Bot, CheckCircle2, Plug, TriangleAlert, Wrench, X } from 'lucide-react'
import { useMemo } from 'react'
import { useProductRuntime } from '../../product-runtime.js'
import { Button, IconButton } from '../../ui-kit/index.js'
import { attentionSource, useAttention, type AttentionItem } from '../model/attention.js'
import { useGo } from '../model/nav.js'
import styles from './attention-list.module.css'

/** Three or more items of the same agent-level kind collapse into one row so a single cause does not drown the rest. */
function groupAttention(items: readonly AttentionItem[]): readonly AttentionItem[] {
  const groupable = new Set<AttentionItem['kind']>([
    'agent-model-unavailable',
    'agent-vision-unavailable',
    'delivery-unconfirmed',
  ])
  const counts = new Map<AttentionItem['kind'], number>()
  for (const item of items) if (groupable.has(item.kind)) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1)
  const emitted = new Set<AttentionItem['kind']>()
  const result: AttentionItem[] = []
  for (const item of items) {
    const count = counts.get(item.kind) ?? 0
    if (count < 3) {
      result.push(item)
      continue
    }
    if (emitted.has(item.kind)) continue
    emitted.add(item.kind)
    const summary =
      item.kind === 'agent-model-unavailable'
        ? {
            title: `${count} 个智能体无法回复`,
            detail: '它们的主模型当前不可用',
            actionLabel: '查看智能体',
            href: '/agents',
          }
        : item.kind === 'agent-vision-unavailable'
          ? {
              title: `${count} 个智能体看不懂图片`,
              detail: '群里的图片会被跳过',
              actionLabel: '查看智能体',
              href: '/agents',
            }
          : {
              title: `${count} 条消息未确认送达`,
              detail: '可以在对应频道里重发或确认',
              actionLabel: '查看',
              href: item.href,
            }
    result.push({ ...item, id: `group:${item.kind}`, ...summary })
  }
  return result
}

const SEVERITY_RANK: Record<AttentionItem['severity'], number> = { bad: 0, warn: 1, info: 2 }

const attentionIcon = (item: AttentionItem) => {
  if (item.kind === 'connection-unhealthy') return <Plug />
  if (item.kind === 'authoring-approval') return <Wrench />
  if (item.kind === 'agent-model-unavailable' || item.kind === 'agent-vision-unavailable') return <Bot />
  return <TriangleAlert />
}

/** Attention items ranked by severity, with their action and dismissal. Shared by the overview and the bell. */
export function AttentionList({
  compact = false,
  onAction,
}: {
  /** Popover density: the action stays, detail text wraps under the title. */
  readonly compact?: boolean
  /** Called after an item's action navigates, e.g. to close the surrounding popover. */
  readonly onAction?: () => void
}) {
  const navigate = useGo()
  const runtime = useProductRuntime()
  const rawAttention = useAttention()
  const attention = useMemo(
    () => [...groupAttention(rawAttention)].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]),
    [rawAttention],
  )
  if (attention.length === 0)
    return (
      <div className={styles.calm}>
        <CheckCircle2 aria-hidden="true" />
        现在没有需要处理的事情
      </div>
    )
  return (
    <div className={[styles.list, compact ? styles.compact : ''].join(' ')}>
      {attention.map((item) => (
        <div key={item.id} className={[styles.row, styles[item.severity]].join(' ')}>
          <span className={styles.bar} />
          <span className={styles.icon}>{attentionIcon(item)}</span>
          <div className={styles.text}>
            <div className={styles.what}>{item.title}</div>
            <div className={styles.why}>{item.detail}</div>
          </div>
          <Button
            size="small"
            variant={item.severity === 'bad' ? 'primary' : 'default'}
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
            onClick={() => {
              const ids = item.id.startsWith('group:')
                ? rawAttention.filter((entry) => entry.kind === item.kind).map((entry) => entry.id)
                : [item.id]
              for (const id of ids) void attentionSource(runtime).dismiss(id)
            }}
          >
            <X size={14} />
          </IconButton>
        </div>
      ))}
    </div>
  )
}
