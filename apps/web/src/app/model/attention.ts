import { useMemo } from 'react'
import { useProductStore, type ProductState } from '../../product-runtime.js'
import { connectionLabel, connectionTone } from './identity.js'

export type AttentionSeverity = 'bad' | 'warn' | 'info'

export interface AttentionItem {
  /** Stable fingerprint: the same underlying problem keeps the same id. */
  readonly id: string
  readonly severity: AttentionSeverity
  readonly title: string
  readonly detail: string
  readonly actionLabel: string
  readonly href: string
}

const severityRank: Record<AttentionSeverity, number> = { bad: 0, warn: 1, info: 2 }

/**
 * Things that need the operator, derived from the Host state the client already holds.
 * Decision §7 moves this aggregation to `GET /api/attention`; consumers only depend on this hook.
 */
export function deriveAttention(state: Pick<ProductState, 'connections' | 'agents' | 'authoringTasks' | 'channels' | 'messagesByChannel' | 'models'>): readonly AttentionItem[] {
  const items: AttentionItem[] = []
  const channelName = new Map(state.channels.map((channel) => [channel.id, channel.name]))

  for (const [channelId, messages] of Object.entries(state.messagesByChannel)) {
    const unconfirmed = messages.filter((message) => message.delivery === '结果未知' || message.delivery === '失败')
    const last = unconfirmed.at(-1)
    if (!last) continue
    items.push({
      id: `delivery:${last.id}`,
      severity: 'bad',
      title: channelName.get(channelId) ?? '频道',
      detail: unconfirmed.length > 1 ? `${unconfirmed.length} 条消息未确认送达` : `${last.author}的一条消息未确认送达`,
      actionLabel: '查看',
      href: `/channels/${channelId}`,
    })
  }

  for (const task of state.authoringTasks) {
    if (task.status !== 'awaiting-approval' && task.status !== 'ready') continue
    items.push({
      id: `authoring:${task.id}:${task.status}`,
      severity: task.status === 'awaiting-approval' ? 'warn' : 'info',
      title: task.title || '创造任务',
      detail: task.status === 'awaiting-approval' ? '新版本等你试运行' : '已验证，可以保存',
      actionLabel: task.status === 'awaiting-approval' ? '去试运行' : '去保存',
      href: `/workshop/tasks/${task.id}`,
    })
  }

  for (const connection of state.connections) {
    const tone = connectionTone(connection.state)
    if (tone === 'ok' || connection.state === '已配置') continue
    items.push({
      id: `connection:${connection.id}:${connection.state}`,
      severity: tone === 'bad' ? 'bad' : 'warn',
      title: connectionLabel(connection),
      detail: connection.lastError ? `${connection.adapter}：${connection.lastError}` : `${connection.adapter} ${connection.state}`,
      actionLabel: '查看连接',
      href: `/wiring/connections/${connection.id}`,
    })
  }

  for (const agent of state.agents) {
    if (!agent.modelRef) {
      items.push({
        id: `agent-model:${agent.id}`,
        severity: 'bad',
        title: agent.name,
        detail: '没有可用模型，无法回复',
        actionLabel: '选择模型',
        href: `/agents/${agent.id}`,
      })
      continue
    }
    if (agent.imageDiagnostics.route.mode === 'unavailable' && agent.channels.length > 0) {
      items.push({
        id: `agent-vision:${agent.id}`,
        severity: 'info',
        title: agent.name,
        detail: '主模型看不懂图片',
        actionLabel: '添加视觉模型',
        href: `/agents/${agent.id}`,
      })
    }
  }

  return items.sort((left, right) => severityRank[left.severity] - severityRank[right.severity])
}

export function useAttention(): readonly AttentionItem[] {
  const connections = useProductStore((state) => state.connections)
  const agents = useProductStore((state) => state.agents)
  const authoringTasks = useProductStore((state) => state.authoringTasks)
  const channels = useProductStore((state) => state.channels)
  const messagesByChannel = useProductStore((state) => state.messagesByChannel)
  const models = useProductStore((state) => state.models)
  return useMemo(
    () => deriveAttention({ connections, agents, authoringTasks, channels, messagesByChannel, models }),
    [connections, agents, authoringTasks, channels, messagesByChannel, models],
  )
}
