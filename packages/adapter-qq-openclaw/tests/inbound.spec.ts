import { describe, expect, it } from 'vitest'
import { decodeQQInboundMessage } from '../src/inbound.ts'

describe('QQ inbound event decoder', () => {
  it('normalizes C2C identity, attachments and message-scene references', () => {
    expect(
      decodeQQInboundMessage(
        'C2C_MESSAGE_CREATE',
        {
          id: 'qq-c2c-1',
          author: { user_openid: 'user-openid', nickname: '小青' },
          content: '你好',
          timestamp: '2026-08-16T04:00:00.000Z',
          message_scene: { ext: ['msg_idx=idx-1&ref_msg_idx=ref-1'] },
          attachments: [
            { url: 'https://cdn.test/photo.webp', filename: 'photo.webp' },
            { voice_wav_url: 'https://cdn.test/voice.wav', filename: 'voice.wav' },
          ],
        },
        { now: () => 1 },
      ),
    ).toEqual({
      eventType: 'C2C_MESSAGE_CREATE',
      platformMessageId: 'qq-c2c-1',
      target: { kind: 'c2c', openId: 'user-openid' },
      senderOpenId: 'user-openid',
      senderDisplayName: '小青',
      content: '你好',
      attachments: [
        { url: 'https://cdn.test/photo.webp', fileName: 'photo.webp', mediaType: 'image/webp' },
        { url: 'https://cdn.test/voice.wav', fileName: 'voice.wav', mediaType: 'audio/wav' },
      ],
      platformReference: 'ref-1',
      platformTimestamp: Date.parse('2026-08-16T04:00:00.000Z'),
    })
  })

  it('normalizes group OpenIDs and gives quote msg_elements precedence over scene ext', () => {
    expect(
      decodeQQInboundMessage(
        'GROUP_AT_MESSAGE_CREATE',
        {
          id: 'qq-group-1',
          group_openid: 'group-openid',
          group_name: '研发群',
          author: { member_openid: 'sender-openid', username: '成员甲' },
          content: '@NekroNxt 你好 @成员乙',
          mentions: [
            { member_openid: 'bot-openid', bot: true, username: 'NekroNxt' },
            { member_openid: 'member-openid', username: '成员乙' },
          ],
          message_scene: { ext: { ref_idx: 'scene-reference' } },
          message_type: 103,
          msg_elements: [{ msg_idx: 'quote-reference' }],
          attachments: [{ url: 'https://cdn.test/movie.mp4', content_type: 'video/mp4' }],
          timestamp: 1_786_852_800,
        },
        { now: () => 1 },
      ),
    ).toMatchObject({
      eventType: 'GROUP_AT_MESSAGE_CREATE',
      platformMessageId: 'qq-group-1',
      target: { kind: 'group', openId: 'group-openid' },
      targetDisplayName: '研发群',
      senderOpenId: 'sender-openid',
      senderDisplayName: '成员甲',
      content: '你好',
      mentions: [
        { openId: 'bot-openid', displayName: 'NekroNxt', bot: true },
        { openId: 'member-openid', displayName: '成员乙' },
      ],
      attachments: [{ url: 'https://cdn.test/movie.mp4', mediaType: 'video/mp4' }],
      platformReference: 'quote-reference',
      platformTimestamp: 1_786_852_800_000,
    })
  })

  it('ignores unrelated dispatches and rejects identity-less supported events', () => {
    expect(decodeQQInboundMessage('READY', { session_id: 'session' })).toBeUndefined()
    expect(() =>
      decodeQQInboundMessage('GROUP_MESSAGE_CREATE', { id: 'message', group_openid: 'group', author: {} }),
    ).toThrow('group sender OpenID is required')
  })
})
