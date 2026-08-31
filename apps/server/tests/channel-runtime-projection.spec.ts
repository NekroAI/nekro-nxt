import { AgentIdSchema, ChannelIdSchema, EpisodeIdSchema } from '@nekro-nxt/contracts'
import { describe, expect, it } from 'vitest'
import { normalizeSessionEvents, shouldBroadcastChannelRuntime } from '../src/channel-runtime-events.ts'
import {
  previewToolArguments,
  projectCacheUsage,
  projectChannelRuntime,
  projectGenerationPerformance,
  projectSessionOccupancy,
  worstChannelRuntimePhase,
} from '../src/channel-runtime-projection.ts'

const channelId = ChannelIdSchema.parse('chn_webmain')
const agentId = AgentIdSchema.parse('agt_observer')
const episodeId = EpisodeIdSchema.parse('eps_observer')

describe('channel runtime projection', () => {
  it('keeps an idle channel honest when no session is live', () => {
    const projection = projectChannelRuntime({
      channelId,
      agentId,
      episodeId,
      sessionStatus: 'missing',
      pendingInjectCount: 0,
      events: [],
    })
    expect(projection.phase).toBe('idle')
    expect(projection.summary).toBe('智能体当前空闲。')
    expect(projection.turns).toEqual([])
  })

  it('distinguishes thinking from using a tool on the same running session', () => {
    const thinking = projectChannelRuntime({
      channelId,
      agentId,
      sessionStatus: 'running',
      pendingInjectCount: 0,
      events: [
        { type: 'turn/start', turn: 1 },
        { type: 'step/start', turn: 1, step: 1 },
      ],
    })
    expect(thinking.phase).toBe('thinking')
    expect(thinking.summary).toBe('智能体正在处理当前消息。')

    const usingTool = projectChannelRuntime({
      channelId,
      agentId,
      sessionStatus: 'running',
      pendingInjectCount: 1,
      events: [
        { type: 'turn/start', turn: 1 },
        { type: 'step/start', turn: 1, step: 1 },
        { type: 'tool/call', turn: 1, step: 1, callId: 'call_1', name: 'web_search', arguments: '{"query":"天气"}' },
      ],
    })
    expect(usingTool.phase).toBe('using-tool')
    expect(usingTool.summary).toBe('智能体正在使用网页搜索。')
    expect(usingTool.pendingInjectCount).toBe(1)
    expect(usingTool.turns[0]?.steps[0]?.tools[0]).toMatchObject({
      displayName: '网页搜索',
      state: 'running',
      inputPreview: '{"query":"天气"}',
    })
  })

  it('marks a finished error turn unavailable and redacts secret tool arguments', () => {
    const projection = projectChannelRuntime({
      channelId,
      agentId,
      sessionStatus: 'idle',
      pendingInjectCount: 0,
      events: [
        { type: 'turn/start', turn: 3 },
        {
          type: 'tool/call',
          turn: 3,
          step: 1,
          callId: 'call_secret',
          name: 'web_search',
          arguments: '{"query":"x","api_key":"sk-live"}',
        },
        {
          type: 'tool/result',
          turn: 3,
          step: 1,
          callId: 'call_secret',
          failed: true,
          resultPreview: 'provider denied',
        },
        {
          type: 'turn/end',
          turn: 3,
          reasonKind: 'error',
          errorCode: 'AUTH',
          errorMessage: '模型请求被拒绝。',
        },
      ],
    })
    expect(projection.phase).toBe('unavailable')
    expect(projection.summary).toBe('智能体本轮失败：模型请求被拒绝。')
    expect(projection.turns[0]?.error).toEqual({ code: 'AUTH', message: '模型请求被拒绝。' })
    expect(projection.turns[0]?.steps[0]?.tools[0]?.inputPreview).toContain('***')
    expect(projection.turns[0]?.steps[0]?.tools[0]?.inputPreview).not.toContain('sk-live')
  })

  it('treats a successful communication tool as a channel reply, not internal output', () => {
    const projection = projectChannelRuntime({
      channelId,
      agentId,
      sessionStatus: 'idle',
      pendingInjectCount: 0,
      events: [
        { type: 'turn/start', turn: 2 },
        {
          type: 'assistant/message',
          turn: 2,
          step: 1,
          text: '这段内部输出不能出现在频道事实流。',
          reasoning: '供应商提供的推理。',
        },
        {
          type: 'tool/call',
          turn: 2,
          step: 1,
          callId: 'call_send',
          name: 'send_channel_message',
          arguments: '{"parts":[{"type":"text","text":"你好"}]}',
        },
        { type: 'tool/result', turn: 2, step: 1, callId: 'call_send', failed: false, resultPreview: 'sent' },
        { type: 'turn/end', turn: 2, reasonKind: 'completed' },
        { type: 'channel/response-state', turn: 2, responseState: 'sent', producedReply: true },
      ],
    })
    expect(projection.phase).toBe('idle')
    expect(projection.turns[0]?.producedReply).toBe(true)
    expect(projection.turns[0]?.steps[0]?.tools[0]?.wroteToChannel).toBe(true)
    expect(projection.turns[0]?.steps[0]?.internalOutput).toEqual({
      kind: 'internal-output',
      text: '这段内部输出不能出现在频道事实流。',
      reasoning: '供应商提供的推理。',
    })
  })

  it('keeps a missing channel reply distinct from a normally completed turn', () => {
    const projection = projectChannelRuntime({
      channelId,
      agentId,
      episodeId,
      sessionStatus: 'idle',
      pendingInjectCount: 0,
      events: [
        { type: 'turn/start', turn: 4, at: 1000 },
        { type: 'step/start', turn: 4, step: 1, at: 1010 },
        { type: 'assistant/message', turn: 4, step: 1, text: '这不是频道回复。', at: 1100 },
        { type: 'turn/end', turn: 4, reasonKind: 'completed', at: 1210 },
        { type: 'channel/response-state', turn: 4, responseState: 'protocol-failed', producedReply: false },
      ],
    })
    expect(projection.phase).toBe('idle')
    expect(projection.summary).toBe('智能体未按频道回应协议完成本轮。')
    expect(projection.turns[0]).toMatchObject({
      state: 'unreplied',
      responseState: 'protocol-failed',
      producedReply: false,
    })
  })

  it('does not broadcast runtime frames for streaming chunks', () => {
    expect(shouldBroadcastChannelRuntime('assistant/chunk')).toBe(false)
    expect(shouldBroadcastChannelRuntime(undefined)).toBe(false)
    expect(shouldBroadcastChannelRuntime('tool/call')).toBe(true)
    expect(shouldBroadcastChannelRuntime('turn/end')).toBe(true)
    expect(shouldBroadcastChannelRuntime('request/context')).toBe(true)
    expect(shouldBroadcastChannelRuntime('user/message')).toBe(true)
  })

  it('uses DSH token-delta semantics for the first-token boundary', () => {
    const events = normalizeSessionEvents([
      {
        type: 'assistant/chunk',
        seq: 0,
        time: 100,
        data: { turn: 1, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
      },
      {
        type: 'assistant/chunk',
        seq: 1,
        time: 110,
        data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '' } },
      },
      {
        type: 'assistant/chunk',
        seq: 2,
        time: 140,
        data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '好' } },
      },
    ])
    expect(events).toEqual([{ type: 'assistant/first-token', turn: 1, step: 1, at: 140 }])
  })

  it('omits occupancy until both projected tokens and a context window exist', () => {
    expect(projectSessionOccupancy({ projectedTokens: 800 })).toBeUndefined()
    expect(projectSessionOccupancy({ contextWindow: 128_000 })).toBeUndefined()
    expect(
      projectSessionOccupancy({
        projectedTokens: 3200,
        contextWindow: 128_000,
        systemTokens: 400,
        toolsTokens: 900,
        messageTokens: 1900,
      }),
    ).toEqual({
      projectedTokens: 3200,
      contextWindow: 128_000,
      breakdown: { systemTokens: 400, toolsTokens: 900, messageTokens: 1900 },
    })
  })

  it('separates cache telemetry coverage, weighted totals, per-request average and recent requests', () => {
    const cache = projectCacheUsage([
      {
        type: 'assistant/message',
        turn: 1,
        step: 1,
        at: 1000,
        usage: { inputTokens: 200, outputTokens: 20, cacheReadTokens: 800 },
      },
      {
        type: 'assistant/message',
        turn: 2,
        step: 1,
        at: 2000,
        usage: { inputTokens: 400, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 100 },
      },
      {
        type: 'assistant/message',
        turn: 3,
        step: 1,
        at: 3000,
        usage: { inputTokens: 600, outputTokens: 40 },
      },
    ])

    expect(cache).toMatchObject({
      scope: 'episode',
      aggregate: {
        usageRequestCount: 3,
        observedRequestCount: 2,
        shareRequestCount: 2,
        hitRequestCount: 1,
        uncachedInputTokens: 600,
        cacheReadTokens: 800,
        cacheWriteTokens: 100,
        averageRequestReadShare: 0.4,
      },
      recent: {
        windowSize: 12,
        samples: [
          { turn: 1, step: 1, uncachedInputTokens: 200, cacheReadTokens: 800 },
          { turn: 2, step: 1, uncachedInputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 100 },
          { turn: 3, step: 1, uncachedInputTokens: 600 },
        ],
      },
    })
  })

  it('combines DSH session totals with recent generation samples and retry waits', () => {
    const performance = projectGenerationPerformance(
      [
        { type: 'step/start', turn: 1, step: 1, at: 1000 },
        { type: 'assistant/first-token', turn: 1, step: 1, at: 1300 },
        {
          type: 'assistant/message',
          turn: 1,
          step: 1,
          at: 2300,
          usage: { inputTokens: 800, outputTokens: 50 },
        },
        { type: 'step/end', turn: 1, step: 1, at: 2310 },
        {
          type: 'llm/retry',
          retryId: 'retry-1',
          turn: 2,
          step: 1,
          retry: 1,
          delayMs: 500,
          at: 3000,
        },
        {
          type: 'llm/retry-started',
          retryId: 'retry-1',
          turn: 2,
          step: 1,
          retry: 1,
          at: 3500,
        },
      ],
      { steps: 4, llmMs: 8200, toolMs: 2100, ttftMs: 1800, ttftSteps: 3, decodeMs: 4000, decodeTokens: 200 },
    )

    expect(performance).toEqual({
      scope: 'episode',
      aggregate: {
        steps: 4,
        llmMs: 8200,
        toolMs: 2100,
        ttftMs: 1800,
        ttftSteps: 3,
        decodeMs: 4000,
        decodeTokens: 200,
        decodeSteps: 1,
        retryCount: 1,
        retryDelayMs: 500,
      },
      recent: {
        windowSize: 12,
        samples: [{ turn: 1, step: 1, at: 2300, firstTokenMs: 300, decodeMs: 1000, outputTokens: 50 }],
      },
    })
  })

  it('records closed-interval durations, first-token latency and step usage without emitting chunks', () => {
    const projection = projectChannelRuntime({
      channelId,
      agentId,
      sessionStatus: 'idle',
      pendingInjectCount: 0,
      occupancy: { projectedTokens: 3200, contextWindow: 128_000 },
      events: [
        { type: 'turn/start', turn: 1, at: 1000 },
        { type: 'step/start', turn: 1, step: 1, at: 1010 },
        { type: 'assistant/first-token', turn: 1, step: 1, at: 1430 },
        {
          type: 'assistant/message',
          turn: 1,
          step: 1,
          at: 1800,
          text: '先核对。',
          usage: { inputTokens: 800, outputTokens: 40, cacheReadTokens: 200 },
        },
        {
          type: 'tool/call',
          turn: 1,
          step: 1,
          callId: 'call_send',
          name: 'send_channel_message',
          arguments: '{"parts":[{"type":"text","text":"好"}]}',
          at: 1810,
        },
        {
          type: 'tool/result',
          turn: 1,
          step: 1,
          callId: 'call_send',
          failed: false,
          resultPreview: 'sent',
          at: 1900,
        },
        { type: 'step/end', turn: 1, step: 1, at: 1910 },
        { type: 'turn/end', turn: 1, reasonKind: 'completed', at: 1920 },
      ],
    })
    expect(projection.occupancy).toEqual({ projectedTokens: 3200, contextWindow: 128_000 })
    expect(projection.turns[0]?.durationMs).toBe(920)
    expect(projection.turns[0]?.steps[0]?.durationMs).toBe(900)
    expect(projection.turns[0]?.steps[0]?.firstTokenMs).toBe(420)
    expect(projection.turns[0]?.steps[0]?.usage).toEqual({
      inputTokens: 800,
      outputTokens: 40,
      cacheReadTokens: 200,
    })
    expect(projection.turns[0]?.steps[0]?.tools[0]?.durationMs).toBe(90)
  })

  it('ranks unavailable above using-tool when summarizing an intelligent-agent', () => {
    expect(worstChannelRuntimePhase(['idle', 'thinking', 'using-tool', 'unavailable'])).toBe('unavailable')
    expect(worstChannelRuntimePhase(['idle', 'thinking'])).toBe('thinking')
  })

  it('truncates long argument previews', () => {
    const preview = previewToolArguments(JSON.stringify({ query: 'x'.repeat(400) }))
    expect(preview?.endsWith('…')).toBe(true)
    expect(preview && preview.length <= 160).toBe(true)
  })

  it('keeps unknown tool names readable instead of collapsing them to 工具', () => {
    const projection = projectChannelRuntime({
      channelId,
      agentId,
      sessionStatus: 'running',
      pendingInjectCount: 0,
      events: [
        {
          type: 'tool/call',
          turn: 1,
          step: 1,
          callId: 'call_custom',
          name: 'asset_inspect',
          arguments: '{"assetId":"ast_1"}',
        },
      ],
    })
    expect(projection.turns[0]?.steps[0]?.tools[0]?.displayName).toBe('asset inspect')
  })
})
