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

/** Model-call failures and their underlying causes share this source, so they group together. */
export const MODEL_RUNTIME_LOG_SOURCE = { kind: 'system', id: 'model-runtime', name: '模型调用' } as const

interface TurnProgress {
  steps: number
  lastPhase?: 'preparing' | 'model' | 'tool' | undefined
  phaseStartedAt?: number | undefined
  phaseDurationMs?: number | undefined
  activeTools: Map<string, { name: string; time: number }>
  abortedTools: Set<string>
}

const DELIVERY_STATE_LABELS: Readonly<Record<string, string>> = {
  'partially-sent': '消息只发出了一部分',
  failed: '消息发送失败',
  unknown: '平台没有确认消息已送达',
  cancelled: '消息被扩展取消，没有发出',
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Argument violations name schema paths and rules only, never the values the model wrote. */
const argumentViolations = (content: readonly { readonly type: string }[]): string | undefined => {
  for (const block of content) {
    if (block.type !== 'text' || !('text' in block) || typeof block.text !== 'string') continue
    const match = /invalid arguments: (.+)/u.exec(block.text)
    if (match?.[1] !== undefined) return match[1].slice(0, 500)
  }
  return undefined
}

/**
 * Read only diagnostic fields, never messages, arguments, tool results or replay metadata. The exceptions are
 * diagnostics written for the log: delivery issues in the send tool's metadata and argument violations.
 */
export function attachSessionLogs(
  context: Context,
  logs: HostLogSink,
  scope: HostLogScope,
  labels: SessionLogLabels = {},
): void {
  const starts = new Map<string, { time: number; tool?: string; turn?: number }>()
  const turns = new Map<number, TurnProgress>()
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
  const turnProgress = (turn: number): TurnProgress => {
    let progress = turns.get(turn)
    if (progress === undefined) {
      if (turns.size >= 128) turns.delete(turns.keys().next().value!)
      progress = { steps: 0, activeTools: new Map(), abortedTools: new Set() }
      turns.set(turn, progress)
    }
    return progress
  }
  const modelAttempts = new Map<string, { turn: number; step: number; startedAt: number }>()
  context.on('agent/assistant-stream', ({ agent, frame }) => {
    if (String(agent.id) !== scope.sessionId) return
    if (frame.type === 'start') {
      const now = Date.now()
      remember(`model:${frame.turn}:${frame.step}`, now, undefined, frame.turn)
      if (modelAttempts.size >= 256) modelAttempts.delete(modelAttempts.keys().next().value!)
      modelAttempts.set(String(frame.attemptId), { turn: frame.turn, step: frame.step, startedAt: now })
      const progress = turnProgress(frame.turn)
      progress.steps = Math.max(progress.steps, frame.step)
      progress.lastPhase = 'model'
      progress.phaseStartedAt = now
      progress.phaseDurationMs = undefined
      return
    }
    if (frame.type === 'end') {
      const attempt = modelAttempts.get(String(frame.attemptId))
      modelAttempts.delete(String(frame.attemptId))
      if (attempt !== undefined && frame.outcome.kind === 'abandoned') {
        const progress = turns.get(attempt.turn)
        if (progress?.lastPhase === 'model') {
          progress.phaseDurationMs = Math.max(0, Date.now() - attempt.startedAt)
        }
      }
    }
  })
  context.on('session/event', (session, event) => {
    if (String(session.id) !== scope.sessionId) return
    const timestamp = new Date(event.time).getTime()
    if (!Number.isFinite(timestamp) || timestamp < attachedAt) return
    if (
      event.type !== 'turn/start' &&
      event.type !== 'turn/end' &&
      event.type !== 'step/start' &&
      event.type !== 'tool/call' &&
      event.type !== 'tool/result' &&
      event.type !== 'tool/ptc-dispatch-start' &&
      event.type !== 'tool/ptc-dispatch' &&
      event.type !== 'assistant/message' &&
      event.type !== 'assistant/attempt' &&
      event.type !== 'user/message'
    )
      return
    const source = { kind: 'system' as const, id: 'agent-runtime', name: '智能体运行' }
    switch (event.type) {
      case 'user/message': {
        const origin = event.data.source
        if (origin.kind !== 'nekro-nxt-channel-reply-guard' && origin.kind !== 'nekro-nxt-channel-processing-reminder')
          return
        logs.write({
          level: 'info',
          message:
            origin.kind === 'nekro-nxt-channel-reply-guard'
              ? '提醒智能体：最新的消息还没回复'
              : '提醒智能体：处理超过 60 秒还没有回复',
          source,
          scope: { ...scope, operationId: `${scope.sessionId}:reminder:${event.seq}` },
          details: {
            ...labels,
            turn: origin.turn,
            reminder: origin.kind === 'nekro-nxt-channel-reply-guard' ? 'reply' : 'processing',
          },
        })
        return
      }
      case 'turn/start':
        remember(`turn:${event.data.turn}`, timestamp, undefined, event.data.turn)
        turns.set(event.data.turn, {
          steps: 0,
          lastPhase: 'preparing',
          phaseStartedAt: timestamp,
          activeTools: new Map(),
          abortedTools: new Set(),
        })
        return
      case 'step/start': {
        const progress = turnProgress(event.data.turn)
        progress.steps = Math.max(progress.steps, event.data.step)
        progress.lastPhase = 'preparing'
        progress.phaseStartedAt = timestamp
        progress.phaseDurationMs = undefined
        progress.activeTools.clear()
        progress.abortedTools.clear()
        return
      }
      case 'tool/call': {
        remember(`tool:${event.data.callId}`, timestamp, event.data.name, event.data.turn)
        const progress = turnProgress(event.data.turn)
        progress.steps = Math.max(progress.steps, event.data.step)
        if (progress.lastPhase !== 'tool' || progress.activeTools.size === 0) {
          progress.lastPhase = 'tool'
          progress.phaseStartedAt = timestamp
          progress.phaseDurationMs = undefined
        }
        progress.activeTools.set(String(event.data.callId), { name: event.data.name, time: timestamp })
        return
      }
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
        const cancelled = error?.code === 'ABORTED' || error?.code === 'ABORTED_BEFORE_DISPATCH'
        if (event.type === 'tool/result') {
          const progress = turns.get(event.data.turn)
          if (progress !== undefined) {
            progress.steps = Math.max(progress.steps, event.data.step)
            const callId = String(event.data.message.toolCallId)
            const active = progress.activeTools.get(callId)
            progress.activeTools.delete(callId)
            if (cancelled) {
              const abortedName = active?.name ?? timing.tool
              if (abortedName !== undefined) progress.abortedTools.add(abortedName)
              if (progress.phaseStartedAt !== undefined) {
                progress.phaseDurationMs = Math.max(0, timestamp - progress.phaseStartedAt)
              }
            }
          }
        }
        const tool = event.type === 'tool/ptc-dispatch' ? event.data.name : timing.tool
        const placement =
          event.type === 'tool/ptc-dispatch'
            ? { tool: event.data.name, rootCallId: event.data.rootCallId, parentCallId: event.data.parentCallId }
            : { turn: event.data.turn, step: event.data.step }
        if (!failed && !error) {
          const meta = isRecord(event.data.meta) ? event.data.meta : undefined
          const deliveryState = meta?.['deliveryState']
          if (tool !== 'send_channel_message' || typeof deliveryState !== 'string' || deliveryState === 'sent') return
          logs.write({
            level: 'warn',
            message: DELIVERY_STATE_LABELS[deliveryState] ?? `消息没有确认发出（${deliveryState}）`,
            source,
            scope: { ...scope, operationId: `${scope.sessionId}:${key}` },
            details: {
              ...labels,
              ...timing,
              ...placement,
              nested,
              deliveryState,
              ...(meta?.['deliveryIssue'] === undefined ? {} : { deliveryIssue: meta['deliveryIssue'] }),
            },
          })
          return
        }
        if (cancelled) return
        const violations =
          error?.code === 'INVALID_ARGS'
            ? argumentViolations(event.type === 'tool/result' ? event.data.message.content : event.data.content)
            : undefined
        const diagnostic =
          [error?.code, error?.reason ?? violations].filter(Boolean).join(' · ') || '未提供独立错误详情'
        logs.write({
          level: 'error',
          message: `${tool ? `工具 ${tool}` : '工具'} 执行失败：${diagnostic}`,
          source,
          scope: { ...scope, operationId: `${scope.sessionId}:${key}` },
          ...(error ? { code: error.code } : {}),
          details: {
            ...labels,
            ...timing,
            ...placement,
            nested,
            ...(error ? { errorName: error.name } : {}),
            reason: error?.reason ?? violations ?? (error ? error.code : '工具报告失败，未提供独立错误详情。'),
          },
        })
        return
      }
      case 'assistant/message':
      case 'assistant/attempt': {
        const key = `model:${event.data.turn}:${event.data.step}`
        const timing = finish(key, timestamp)
        const progress = turns.get(event.data.turn)
        if (progress !== undefined) {
          progress.steps = Math.max(progress.steps, event.data.step)
          if (progress.lastPhase === 'model' && timing.durationMs !== undefined) {
            progress.phaseDurationMs = timing.durationMs
          }
        }
        for (const record of event.data.stream) {
          if (record.type !== 'chunk' || record.chunk.type !== 'finish') continue
          const reason = record.chunk.reason
          if (reason.kind !== 'error' && reason.kind !== 'max-tokens') continue
          const failure = reason.kind === 'error' ? reason.failure : undefined
          logs.write({
            level: failure ? 'error' : 'warn',
            message: failure ? `${modelLabel} 调用失败：${failureSummary(failure)}` : `${modelLabel} 响应达到输出上限`,
            source: MODEL_RUNTIME_LOG_SOURCE,
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
        const progress = turns.get(turn)
        turns.delete(turn)
        for (const [attemptId, attempt] of modelAttempts) if (attempt.turn === turn) modelAttempts.delete(attemptId)
        // PTC has no turn field; all outstanding calls belong to the closing active turn.
        for (const [key, start] of starts) if (start.turn === turn || key.startsWith('ptc:')) starts.delete(key)
        if (reason.kind === 'completed' || reason.kind === 'forked') return
        const failure = reason.kind === 'error' ? reason.error : undefined
        const pendingTools =
          progress === undefined
            ? []
            : [...new Set([...[...progress.activeTools.values()].map((item) => item.name), ...progress.abortedTools])]
        const phaseDurationMs =
          progress === undefined
            ? undefined
            : (progress.phaseDurationMs ??
              (progress.phaseStartedAt === undefined ? undefined : Math.max(0, timestamp - progress.phaseStartedAt)))
        const interruptedOrAborted = reason.kind === 'aborted' || reason.kind === 'interrupted'
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
            ...(progress !== undefined && progress.steps > 0 ? { steps: progress.steps } : {}),
            outcome: reason.kind,
            ...(interruptedOrAborted && progress?.lastPhase !== undefined ? { lastPhase: progress.lastPhase } : {}),
            ...(interruptedOrAborted && phaseDurationMs !== undefined ? { phaseDurationMs } : {}),
            ...(interruptedOrAborted && progress?.lastPhase === 'tool' && pendingTools.length > 0
              ? { activeTools: pendingTools }
              : {}),
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
