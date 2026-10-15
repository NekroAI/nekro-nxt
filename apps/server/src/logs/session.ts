import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import type { HostLogScope } from '@nekro-nxt/contracts'
import type { HostLogSink } from './service.js'

interface SessionLogLabels {
  agentName?: string
  channelName?: string
  provider?: string
  model?: string
}

/** Read only diagnostic fields, never messages, arguments, tool results or replay metadata. */
export function attachSessionLogs(
  context: Context,
  logs: HostLogSink,
  scope: HostLogScope,
  labels: SessionLogLabels = {},
): void {
  const starts = new Map<string, { time: number; tool?: string; turn?: number }>()
  const attachedAt = Date.now()
  const modelName = [labels.provider, labels.model].filter(Boolean).join('/')
  const modelLabel = modelName ? `模型 ${modelName}` : '模型'
  const failureSummary = (failure: { code: string; message: string; status?: number }) =>
    [failure.code, ...(failure.status === undefined ? [] : [`HTTP ${failure.status}`]), failure.message]
      .filter(Boolean)
      .join(' · ')
  const remember = (key: string, time: number, tool?: string, turn?: number) => {
    if (starts.size >= 1000) starts.delete(starts.keys().next().value!)
    starts.set(key, { time, ...(tool === undefined ? {} : { tool }), ...(turn === undefined ? {} : { turn }) })
  }
  const finish = (key: string, time: number) => {
    const start = starts.get(key)
    starts.delete(key)
    return {
      ...(start?.tool === undefined ? {} : { tool: start.tool }),
      ...(start === undefined ? {} : { durationMs: Math.max(0, time - start.time) }),
    }
  }
  context.on('agent/assistant-stream', ({ agent, frame }) => {
    if (String(agent.id) !== scope.sessionId || frame.type !== 'start') return
    remember(`model:${frame.turn}:${frame.step}`, Date.now(), undefined, frame.turn)
  })
  context.on('session/event', (session, event) => {
    if (String(session.id) !== scope.sessionId) return
    const timestamp = new Date(event.time).getTime()
    if (!Number.isFinite(timestamp) || timestamp < attachedAt) return
    if (
      event.type !== 'turn/start' &&
      event.type !== 'turn/end' &&
      event.type !== 'tool/call' &&
      event.type !== 'tool/result' &&
      event.type !== 'tool/ptc-dispatch-start' &&
      event.type !== 'tool/ptc-dispatch' &&
      event.type !== 'assistant/message' &&
      event.type !== 'assistant/attempt'
    )
      return
    const source = { kind: 'system' as const, id: 'agent-runtime', name: '智能体运行' }
    switch (event.type) {
      case 'turn/start':
        remember(`turn:${event.data.turn}`, timestamp, undefined, event.data.turn)
        return
      case 'tool/call':
        remember(`tool:${event.data.callId}`, timestamp, event.data.name, event.data.turn)
        return
      case 'tool/ptc-dispatch-start':
        remember(`ptc:${event.data.subCallId}`, timestamp, event.data.name)
        return
      case 'tool/result':
      case 'tool/ptc-dispatch': {
        const nested = event.type === 'tool/ptc-dispatch'
        const key =
          event.type === 'tool/result' ? `tool:${event.data.message.toolCallId}` : `ptc:${event.data.subCallId}`
        const timing = finish(key, timestamp)
        const error = event.data.error
        const failed = event.type === 'tool/result' ? event.data.message.isError === true : event.data.isError
        if (!failed && !error) return
        const cancelled = error?.code === 'ABORTED' || error?.code === 'ABORTED_BEFORE_DISPATCH'
        if (cancelled) return
        const tool = event.type === 'tool/ptc-dispatch' ? event.data.name : timing.tool
        const diagnostic = [error?.code, error?.reason].filter(Boolean).join(' · ') || '未提供独立错误详情'
        logs.write({
          level: 'error',
          message: `${tool ? `工具 ${tool}` : '工具'} 执行失败：${diagnostic}`,
          source,
          scope: { ...scope, operationId: `${scope.sessionId}:${key}` },
          ...(error ? { code: error.code } : {}),
          details: {
            ...labels,
            ...timing,
            ...(event.type === 'tool/ptc-dispatch'
              ? { tool: event.data.name, rootCallId: event.data.rootCallId, parentCallId: event.data.parentCallId }
              : { turn: event.data.turn, step: event.data.step }),
            nested,
            ...(error ? { errorName: error.name } : {}),
            reason: error?.reason ?? (error ? error.code : '工具报告失败，未提供独立错误详情。'),
          },
        })
        return
      }
      case 'assistant/message':
      case 'assistant/attempt': {
        const key = `model:${event.data.turn}:${event.data.step}`
        const timing = finish(key, timestamp)
        for (const record of event.data.stream) {
          if (record.type !== 'chunk' || record.chunk.type !== 'finish') continue
          const reason = record.chunk.reason
          if (reason.kind !== 'error' && reason.kind !== 'max-tokens') continue
          const failure = reason.kind === 'error' ? reason.failure : undefined
          logs.write({
            level: failure ? 'error' : 'warn',
            message: failure ? `${modelLabel} 调用失败：${failureSummary(failure)}` : `${modelLabel} 响应达到输出上限`,
            source: { kind: 'system', id: 'model-runtime', name: '模型调用' },
            scope: { ...scope, operationId: `${scope.sessionId}:model-event:${event.seq}` },
            ...(failure ? { code: failure.code } : {}),
            details: {
              ...labels,
              ...timing,
              turn: event.data.turn,
              step: event.data.step,
              outcome: reason.kind,
              ...(failure
                ? {
                    reason: failure.message,
                    status: failure.status,
                    requestId: failure.requestId,
                    providerRetryAfterMs: failure.providerRetryAfterMs,
                  }
                : {}),
            },
          })
        }
        return
      }
      case 'turn/end': {
        const { turn, reason } = event.data
        const timing = finish(`turn:${turn}`, timestamp)
        // PTC has no turn field; all outstanding calls belong to the closing active turn.
        for (const [key, start] of starts) if (start.turn === turn || key.startsWith('ptc:')) starts.delete(key)
        if (reason.kind === 'completed' || reason.kind === 'forked') return
        const failure = reason.kind === 'error' ? reason.error : undefined
        logs.write({
          level: reason.kind === 'aborted' ? 'info' : failure ? 'error' : 'warn',
          message:
            reason.kind === 'aborted'
              ? '智能体本轮运行已取消。'
              : failure
                ? `智能体本轮运行失败（${modelLabel}）：${failureSummary(failure)}`
                : '智能体本轮运行未正常完成。',
          source,
          scope,
          ...(failure ? { code: failure.code } : {}),
          details: {
            ...labels,
            ...timing,
            turn,
            outcome: reason.kind,
            ...(failure
              ? {
                  reason: failure.message,
                  status: failure.status,
                  requestId: failure.requestId,
                  providerRetryAfterMs: failure.providerRetryAfterMs,
                }
              : {}),
            ...(reason.kind === 'aborted'
              ? {
                  cancelCause: reason.reason.kind,
                  ...(reason.reason.kind === 'hook' ? { reason: reason.reason.reason } : {}),
                }
              : {}),
          },
        })
        return
      }
    }
  })
}
