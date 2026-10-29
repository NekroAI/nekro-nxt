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

describe('send tool output after outbound processing', () => {
  it('tells the agent the message was not sent, who cancelled it and why', () => {
    expect(
      renderChannelMessageResult({
        status: 'cancelled',
        receipts: [],
        cancel: { extension: '防泄密', reason: '含有示例密钥' },
      }),
    ).toBe('这条消息没有发出：「防泄密」取消了它，原因：含有示例密钥。可以按原因改一下再发。')
  })

  it('names the extensions that changed a sent message, with the final content and appended messages', () => {
    expect(
      renderChannelMessageResult({
        logicalMessageId: 'msg_fixture',
        status: 'sent',
        receipts: [],
        processing: {
          processedBy: ['翻译', '署名'],
          rewritten: true,
          parts: [{ type: 'text', text: 'hello' }],
          followUps: [
            { extension: '配音', logicalMessageId: 'msg_follow', status: 'sent' },
            { extension: '表情包', status: 'not-sent', message: '前一条没有发出，追加的消息也没有发。' },
          ],
        },
      }),
    ).toBe(
      [
        '消息 msg_fixture：sent，内容经「翻译」、「署名」处理。',
        '实际发出的内容：[{"type":"text","text":"hello"}]',
        '「配音」追加了一条，消息 msg_follow：sent',
        '「表情包」追加的一条没有发出：前一条没有发出，追加的消息也没有发。',
      ].join('\n'),
    )
  })

  it('keeps the delivery summary readable when a processed message did not go through', () => {
    const result = MessageDeliverySummarySchema.parse(
      JSON.parse(
        renderChannelMessageResult({
          logicalMessageId: 'msg_fixture',
          status: 'failed',
          receipts: [{ receipt: { status: 'failed', failure: { kind: 'transient', message: '示例失败' } } }],
          processing: {
            processedBy: ['署名'],
            rewritten: true,
            parts: [{ type: 'text', text: '改写' }],
            followUps: [],
          },
        }),
      ),
    )
    expect(result.processing).toEqual({ processedBy: ['署名'], parts: [{ type: 'text', text: '改写' }] })
  })
})
