import { describe, expect, it } from 'vitest'
import { MessageDeliverySummarySchema } from '@nekro-nxt/contracts'
import { renderChannelMessageResult } from '../src/channel-message-result.js'

describe('channel send tool output', () => {
  it('preserves partial delivery failures and protocol diagnostics in persisted tool text', () => {
    const text = renderChannelMessageResult({
      logicalMessageId: 'msg_fixture',
      status: 'partially-sent',
      receipts: [
        { receipt: { status: 'sent' } },
        {
          receipt: {
            status: 'failed',
            failure: { kind: 'authentication', message: 'token=fictional-secret refused https://example.test/private' },
            diagnostic: { action: 'send_group_msg', retcode: 1401 },
          },
        },
        { receipt: { status: 'unknown', message: '等待回执超时。', diagnostic: { action: 'send_private_msg' } } },
      ],
    })
    const result = MessageDeliverySummarySchema.parse(JSON.parse(text))
    expect(result.status).toBe('partially-sent')
    expect(result.issues).toHaveLength(2)
    expect(result.issues[0]).toMatchObject({ kind: 'authentication', action: 'send_group_msg', retcode: 1401 })
    expect(result.issues[1]).toMatchObject({ status: 'unknown', message: '等待回执超时。' })
    expect(text).not.toContain('fictional-secret')
    expect(text).not.toContain('https://example.test/private')
  })
  it('bounds repeated failures without hiding the number omitted', () => {
    const result = MessageDeliverySummarySchema.parse(
      JSON.parse(
        renderChannelMessageResult({
          logicalMessageId: 'msg_fixture',
          status: 'failed',
          receipts: Array.from({ length: 25 }, () => ({
            receipt: { status: 'failed', failure: { kind: 'invalid', message: 'x'.repeat(2000) } },
          })),
        }),
      ),
    )
    expect(result.issues).toHaveLength(20)
    expect(result.omittedIssues).toBe(5)
    expect(result.issues[0]?.message).toHaveLength(1000)
  })
})
