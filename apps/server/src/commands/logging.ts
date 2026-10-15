import type { ChannelId, CommandExecutionRecord } from '@nekro-nxt/contracts'
import type { HostLogSink } from '../logs/service.js'
import type { CommandObserver } from './types.js'

const SOURCE = { kind: 'system', id: 'commands', name: '聊天命令' } as const

const OUTCOME: Record<CommandExecutionRecord['status'], string> = {
  pending: '等待执行',
  running: '执行中',
  succeeded: '执行成功',
  failed: '执行失败',
  uncertain: '结果不确定',
}

/**
 * Operational log lines for commands. Arguments, command text and results are never written: they are chat
 * content. Only the command name (a Host or extension identifier), outcome, timing and counts are.
 */
export const commandLogObserver = (
  logs: HostLogSink,
  channelName: (channelId: ChannelId) => string | undefined,
): CommandObserver => ({
  settled(record) {
    const name = record.commandName === undefined ? '未识别命令' : `/${record.commandName}`
    logs.write({
      level: record.status === 'succeeded' ? 'info' : 'warn',
      message: `${channelName(record.channelId) ?? '频道'} · ${name} ${OUTCOME[record.status]}`,
      source: SOURCE,
      scope: {
        channelId: record.channelId,
        ...(record.agentId === undefined ? {} : { agentId: record.agentId }),
        operationId: record.id,
      },
      details: {
        origin: record.source,
        status: record.status,
        replies: record.replies.length,
        durationMs: record.completedAt === undefined ? undefined : record.completedAt - record.createdAt,
        suppressed: record.replySuppressed === true,
      },
    })
  },
  replyNotDelivered(record, ordinal) {
    logs.write({
      level: 'warn',
      message: `${channelName(record.channelId) ?? '频道'} · 命令回复未能投递`,
      source: SOURCE,
      scope: { channelId: record.channelId, operationId: record.id },
      details: { ordinal, command: record.commandName },
    })
  },
  rateLimited(report) {
    logs.write({
      level: 'warn',
      message: `${channelName(report.channelId) ?? '频道'} · 平台命令过于频繁，已丢弃 ${report.dropped} 条`,
      source: SOURCE,
      scope: { channelId: report.channelId },
      details: { dropped: report.dropped, reason: report.reason },
    })
  },
})
