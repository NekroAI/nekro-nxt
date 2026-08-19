import { describe, expect, it } from 'vitest'
import { flattenRuntimeRecords, plotTurnStarts, recordLane } from '../src/pages/channel-trajectory.js'
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
  })

  it('marks plot turn boundaries on visible turn changes, skipping the first row', () => {
    expect(plotTurnStarts([{ turn: 1 }, { turn: 1 }, { turn: 2 }, { turn: 2 }, { turn: 4 }])).toEqual([2, 4])
    expect(plotTurnStarts([{ turn: 3 }])).toEqual([])
  })
})
