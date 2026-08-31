import { describe, expect, it } from 'vitest'
import {
  cacheInputTokens,
  cacheReadShare,
  flattenRuntimeRecords,
  formatDurationMs,
  formatTokenRate,
  formatTokenCount,
  plotTurnStarts,
  projectContextUsage,
  recordLane,
  responseStateNotice,
  sampleTokenRate,
  weightedCacheReadShare,
} from '../src/pages/channel-trajectory.js'
import type { ChannelRuntimeView } from '../src/product-store.js'

describe('flattenRuntimeRecords', () => {
  it('turns internal output and tools into ledger rows without treating send as a second bubble', () => {
    const runtime: ChannelRuntimeView = {
      channelId: 'chn_web',
      phase: '空闲',
      summary: '智能体当前空闲。',
      pendingInjectCount: 0,
      turns: [
        {
          turn: 2,
          state: 'completed',
          producedReply: true,
          responseState: 'sent',
          steps: [
            {
              step: 1,
              internalOutput: { kind: 'internal-output', text: '先核对公告。' },
              tools: [
                {
                  callId: 'call_read',
                  name: 'read_file',
                  displayName: '读取文件',
                  state: 'succeeded',
                  inputPreview: '活动公告-v3.docx',
                  resultPreview: '19:30',
                },
                {
                  callId: 'call_send',
                  name: 'send_channel_message',
                  displayName: '发送频道消息',
                  state: 'succeeded',
                  wroteToChannel: true,
                  deliveryState: 'sent',
                  resultPreview: 'sent',
                },
              ],
            },
          ],
        },
      ],
    }
    const rows = flattenRuntimeRecords(runtime)
    expect(rows.map((row) => row.kindLabel)).toEqual(['MESSAGE', 'TOOL', 'TOOL'])
    expect(rows.map((row) => recordLane(row))).toEqual(['internal', 'tool', 'send'])
    expect(rows[0]?.turnStart).toBe(true)
    expect(rows[1]?.turnStart).toBe(false)
    expect(rows[2]?.wroteToChannel).toBe(true)
    expect(rows[2]?.deliveryState).toBe('sent')
  })

  it('marks plot turn boundaries on visible turn changes, skipping the first row', () => {
    expect(plotTurnStarts([{ turn: 1 }, { turn: 1 }, { turn: 2 }, { turn: 2 }, { turn: 4 }])).toEqual([2, 4])
    expect(plotTurnStarts([{ turn: 3 }])).toEqual([])
  })

  it('describes pending, explicit finish and protocol failure without claiming a message was sent', () => {
    const turn = (responseState: ChannelRuntimeView['turns'][number]['responseState']) => ({
      turn: 1,
      state: 'completed' as const,
      producedReply: false,
      responseState,
      steps: [],
    })
    expect(responseStateNotice(turn('pending'))).toBe('智能体需要发送频道消息或明确结束本轮。')
    expect(responseStateNotice(turn('finished'))).toBe('智能体已明确结束本轮，未必发送频道消息。')
    expect(responseStateNotice(turn('protocol-failed'))).toBe('智能体未按频道回应协议完成本轮。')
    expect(responseStateNotice(turn('sent'))).toBeUndefined()
  })

  it('formats occupancy and duration for the inspector', () => {
    expect(formatTokenCount(420)).toBe('420')
    expect(formatTokenCount(3200)).toBe('3.2k')
    expect(formatTokenCount(32_000)).toBe('32k')
    expect(formatDurationMs(420)).toBe('420ms')
    expect(formatDurationMs(1200)).toBe('1.2s')
    expect(formatDurationMs(65_000)).toBe('1:05')
    expect(formatDurationMs(119_900)).toBe('2:00')
    expect(sampleTokenRate({ turn: 1, step: 1, decodeMs: 2000, outputTokens: 75 })).toBe(37.5)
    expect(formatTokenRate(37.5)).toBe('38')
    expect(formatTokenRate(undefined)).toBe('暂无')
  })

  it('projects bounded occupancy and a non-negative composition', () => {
    expect(
      projectContextUsage({
        projectedTokens: 150,
        contextWindow: 100,
        breakdown: { systemTokens: 20, toolsTokens: 30, messageTokens: 25 },
      }),
    ).toMatchObject({
      used: 100,
      remaining: 0,
      usedPercent: 100,
      estimated: false,
      composition: [
        { name: '系统', value: 20 },
        { name: '工具', value: 30 },
        { name: '对话', value: 25 },
        { name: '其他', value: 25 },
      ],
    })

    const estimated = projectContextUsage({
      projectedTokens: 50,
      contextWindow: 100,
      breakdown: { systemTokens: 30, toolsTokens: 30, messageTokens: 20 },
    })
    expect(estimated.estimated).toBe(true)
    expect(estimated.composition.every((item) => item.value >= 0)).toBe(true)
  })

  it('distinguishes missing cache telemetry from a reported miss and computes token-weighted coverage', () => {
    const hit = { turn: 1, step: 1, uncachedInputTokens: 200, cacheReadTokens: 800 }
    const miss = { turn: 2, step: 1, uncachedInputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 100 }
    const unknown = { turn: 3, step: 1, uncachedInputTokens: 900 }

    expect(cacheInputTokens(hit)).toBe(1000)
    expect(cacheReadShare(hit)).toBe(0.8)
    expect(cacheReadShare(miss)).toBe(0)
    expect(cacheReadShare(unknown)).toBeUndefined()
    expect(weightedCacheReadShare([hit, miss, unknown])).toBe(0.5)
  })
})
