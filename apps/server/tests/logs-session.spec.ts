/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Synthetic event fixtures supply only the public fields consumed by the observer; no runtime Agent or Session is started. */
import { Context } from '@deepseek-ai/cordis'
import type { Agent, AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, SessionSeq, type SessionEvent, type SessionEventMap } from '@deepseek-ai/dsh-session'
import { ToolCallId, MessageId, LlmAttemptId } from '@deepseek-ai/dsh-llm/brand'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachSessionLogs } from '../src/logs/session.js'
import type { HostLogSink } from '../src/logs/service.js'

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.fiber.dispose()))
  vi.useRealTimers()
})
function fixture() {
  vi.useFakeTimers()
  vi.setSystemTime(10000)
  const context = new Context()
  contexts.push(context)
  const write = vi.fn<HostLogSink['write']>()
  attachSessionLogs(
    context,
    { write, logger: vi.fn() },
    {
      sessionId: 'session-demo',
      agentId: 'agent-demo',
      channelId: 'channel-demo',
    },
    { agentName: '示例智能体', channelName: '示例频道', provider: 'demo', model: 'demo-model' },
  )
  let seq = 0
  const emit = <K extends keyof SessionEventMap>(
    type: K,
    data: SessionEventMap[K],
    time = 10000,
    id = 'session-demo',
  ) => {
    context.emit('session/event', Session.create(SessionId(id)), {
      type,
      data,
      time,
      seq: SessionSeq(++seq),
    } as SessionEvent)
  }
  const stream = (frame: AssistantStreamFrame) =>
    context.emit('agent/assistant-stream', {
      agent: { id: SessionId('session-demo') } as Agent,
      frame,
    })
  const call = (id = 'call-demo') =>
    emit('tool/call', {
      callId: ToolCallId(id),
      name: 'demo_tool',
      arguments: 'PRIVATE_ARGUMENTS',
      turn: 1,
      step: 1,
    })
  const result = (error?: { name: string; code: string; reason?: string }, id = 'call-demo') =>
    emit(
      'tool/result',
      {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          toolCallId: ToolCallId(id),
          id: MessageId(`result-${id}`),
          source: { kind: 'tool', callId: ToolCallId(id) },
          isError: !!error,
          content: [{ type: 'text', text: 'PRIVATE_RESULT' }],
        },
        ...(error ? { error } : {}),
      },
      10250,
    )
  return { context, write, emit, stream, call, result }
}

describe('session operational logs', () => {
  it('writes nothing for successful tools, PTC dispatches and model attempts', () => {
    const f = fixture()
    f.call()
    f.result()
    const ptc = {
      subCallId: ToolCallId('nested'),
      parentCallId: ToolCallId('parent'),
      rootCallId: ToolCallId('root'),
      name: 'nested_tool',
      arguments: 'PRIVATE_ARGUMENTS',
    }
    f.emit('tool/ptc-dispatch-start', ptc)
    f.emit('tool/ptc-dispatch', { ...ptc, isError: false, content: [] })
    f.stream({ type: 'start', turn: 1, step: 1, attemptId: LlmAttemptId('attempt'), revision: 1 })
    f.emit('assistant/attempt', {
      turn: 1,
      step: 1,
      stream: [{ type: 'chunk', time: 10100, chunk: { type: 'finish', reason: { kind: 'stop' } } }],
    })
    f.stream({
      type: 'end',
      attemptId: LlmAttemptId('attempt'),
      revision: 1,
      index: 1,
      outcome: { kind: 'committed', eventType: 'assistant/message', seq: SessionSeq(1) },
    })
    f.emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(f.write).not.toHaveBeenCalled()
  })
  it('retains tool name, duration and structured failure without copying payloads', () => {
    const f = fixture()
    f.call()
    f.result({ name: 'ToolTimeoutError', code: 'TIMEOUT', reason: '执行超过期限' })
    expect(f.write).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        level: 'error',
        code: 'TIMEOUT',
        message: '工具 demo_tool 执行失败：TIMEOUT · 执行超过期限',
        scope: {
          sessionId: 'session-demo',
          agentId: 'agent-demo',
          channelId: 'channel-demo',
          operationId: 'session-demo:tool:call-demo',
        },
      }),
    )
    expect(f.write.mock.calls[0]![0].details).toMatchObject({
      tool: 'demo_tool',
      reason: '执行超过期限',
      durationMs: 250,
      model: 'demo-model',
      agentName: '示例智能体',
      channelName: '示例频道',
    })
    expect(JSON.stringify(f.write.mock.calls)).not.toContain('PRIVATE_')
  })
  it('retains nested failures even without a start and never invents duration', () => {
    const f = fixture()
    f.emit('tool/ptc-dispatch', {
      subCallId: ToolCallId('nested'),
      parentCallId: ToolCallId('parent'),
      rootCallId: ToolCallId('root'),
      name: 'nested_tool',
      arguments: 'PRIVATE_ARGUMENTS',
      content: [{ type: 'text', text: 'PRIVATE_RESULT' }],
      isError: true,
      error: { name: 'ToolError', code: 'DENIED', reason: '访问被拒绝' },
    })
    const entry = f.write.mock.calls[0]![0]
    expect(entry).toMatchObject({
      code: 'DENIED',
      message: '工具 nested_tool 执行失败：DENIED · 访问被拒绝',
      details: { tool: 'nested_tool', parentCallId: ToolCallId('parent'), reason: '访问被拒绝' },
    })
    expect(entry.details).not.toHaveProperty('durationMs')
    expect(JSON.stringify(entry)).not.toContain('PRIVATE_')
  })
  it.each(['ABORTED', 'ABORTED_BEFORE_DISPATCH'])(
    'records %s and explicit turn cancellation without warning',
    (code) => {
      const f = fixture()
      for (let i = 0; i < 30; i++) {
        f.call(`cancel-${i}`)
        f.result({ name: 'AbortError', code }, `cancel-${i}`)
      }
      f.emit('tool/ptc-dispatch', {
        subCallId: ToolCallId('nested'),
        parentCallId: ToolCallId('parent'),
        rootCallId: ToolCallId('root'),
        name: 'nested_tool',
        arguments: {},
        content: [],
        isError: true,
        error: { name: 'AbortError', code },
      })
      expect(f.write).not.toHaveBeenCalled()
      f.stream({
        type: 'end',
        attemptId: LlmAttemptId('attempt'),
        revision: 1,
        index: 0,
        outcome: { kind: 'abandoned' },
      })
      f.emit('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
      expect(f.write.mock.calls.map(([entry]) => entry.level)).toEqual(['info'])
      expect(f.write.mock.calls[0]![0].details).toMatchObject({ cancelCause: 'user' })
    },
  )
  it('records model finish failures and turn errors using public failure metadata', () => {
    const f = fixture()
    f.emit('turn/start', { turn: 1 })
    f.stream({ type: 'start', turn: 1, step: 1, attemptId: LlmAttemptId('attempt'), revision: 1 })
    const failure = { code: 'RATE_LIMIT', message: '请求过于频繁', status: 429, providerRetryAfterMs: 500 }
    f.emit(
      'assistant/attempt',
      {
        turn: 1,
        step: 1,
        stream: [
          { type: 'text-chunks', time0: 10000, index: 0, dt: [0], texts: ['PRIVATE_MESSAGE'] },
          { type: 'chunk', time: 10200, chunk: { type: 'finish', reason: { kind: 'error', failure } } },
        ],
      },
      10200,
    )
    f.emit('turn/end', { turn: 1, reason: { kind: 'error', error: failure } }, 10300)
    expect(f.write.mock.calls[0]![0]).toMatchObject({
      level: 'error',
      code: 'RATE_LIMIT',
      message: '模型 demo/demo-model 调用失败：RATE_LIMIT · HTTP 429 · 请求过于频繁',
      details: { durationMs: 200, status: 429, reason: '请求过于频繁', providerRetryAfterMs: 500 },
    })
    expect(f.write.mock.calls[1]![0]).toMatchObject({
      level: 'error',
      message: '智能体本轮运行失败（模型 demo/demo-model）：RATE_LIMIT · HTTP 429 · 请求过于频繁',
      details: { durationMs: 300 },
    })
    expect(JSON.stringify(f.write.mock.calls)).not.toContain('PRIVATE_')
  })
  it.each(['aborted', 'max-tokens'] as const)('retains model %s with appropriate severity', (kind) => {
    const f = fixture()
    f.emit('assistant/attempt', {
      turn: 1,
      step: 1,
      stream: [
        {
          type: 'chunk',
          time: 10000,
          chunk: {
            type: 'finish',
            reason: kind === 'aborted' ? { kind, failure: { code: 'ABORTED', message: '已取消' } } : { kind },
          },
        },
      ],
    })
    if (kind === 'aborted') expect(f.write).not.toHaveBeenCalled()
    else
      expect(f.write.mock.calls[0]![0]).toMatchObject({
        level: 'warn',
        message: '模型 demo/demo-model 响应达到输出上限',
      })
  })
  it('does not extract error text from a tool result lacking structured diagnostics', () => {
    const f = fixture()
    f.call()
    f.emit(
      'tool/result',
      {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          toolCallId: ToolCallId('call-demo'),
          id: MessageId('result-call-demo'),
          source: { kind: 'tool', callId: ToolCallId('call-demo') },
          isError: true,
          content: [{ type: 'text', text: 'PRIVATE_RESULT' }],
        },
      },
      10100,
    )
    expect(f.write.mock.calls[0]![0]).toMatchObject({
      level: 'error',
      message: '工具 demo_tool 执行失败：未提供独立错误详情',
      details: { tool: 'demo_tool', durationMs: 100, reason: '工具报告失败，未提供独立错误详情。' },
    })
    expect(f.write.mock.calls[0]![0]).not.toHaveProperty('code')
    expect(JSON.stringify(f.write.mock.calls)).not.toContain('PRIVATE_RESULT')
  })
  it('pairs concurrent tool failures by call ID and clears stale timing at turn end', () => {
    const f = fixture()
    f.call('first')
    f.emit('tool/call', { callId: ToolCallId('second'), name: 'second_tool', arguments: '{}', turn: 1, step: 1 }, 10100)
    f.result({ name: 'ToolError', code: 'FAILED' }, 'second')
    f.result({ name: 'ToolError', code: 'FAILED' }, 'first')
    expect(f.write.mock.calls[0]![0]).toMatchObject({
      message: '工具 second_tool 执行失败：FAILED',
      details: { tool: 'second_tool', durationMs: 150 },
    })
    expect(f.write.mock.calls[1]![0].details).toMatchObject({ tool: 'demo_tool', durationMs: 250 })
    f.call('unfinished')
    f.emit('turn/end', { turn: 1, reason: { kind: 'interrupted' } }, 10200)
    expect(f.write.mock.calls[2]![0]).toMatchObject({ level: 'warn', details: { outcome: 'interrupted' } })
    f.result({ name: 'ToolError', code: 'FAILED' }, 'unfinished')
    expect(f.write.mock.calls[3]![0].details).not.toHaveProperty('durationMs')
  })
  it('ignores historical and foreign events and detaches on disposal', async () => {
    const f = fixture()
    const data = { turn: 1, reason: { kind: 'error', error: { code: 'UNKNOWN', message: '失败' } } } as const
    f.emit('turn/end', data, 9999)
    f.emit('turn/end', data, 10000, 'other-session')
    await f.context.fiber.dispose()
    f.emit('turn/end', data)
    expect(f.write).not.toHaveBeenCalled()
  })
})
