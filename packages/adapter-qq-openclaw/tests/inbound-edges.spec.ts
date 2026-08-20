import { describe, expect, it } from 'vitest'
import { decodeQQInboundMessage, splitQQContentAtoms } from '../src/inbound.ts'

const c2c = (value: Record<string, unknown>) => decodeQQInboundMessage('C2C_MESSAGE_CREATE', value, { now: () => 999 })

describe('QQ inbound malformed and media boundaries', () => {
  it('normalizes every supported attachment suffix and keeps mention tokens in content', () => {
    const decoded = decodeQQInboundMessage(
      'GROUP_MESSAGE_CREATE',
      {
        id: 'group-edge',
        group_id: 'group-fallback',
        group_title: '测试群',
        author: { id: 'sender', nick: '发送者' },
        content: '<@!bot-openid> @成员甲 请看',
        mentions: [
          null,
          { id: 'bot-openid', username: 'NekroNxt', bot: true },
          { user_openid: 'member-openid', username: '成员甲', bot: false },
        ],
        message_scene: { ext: ['malformed', 'msg_idx=message-from-ext&ref_idx=scene-ref'] },
        message_type: '103',
        msg_elements: [{ msg_idx: 'quote-ref' }],
        attachments: [
          { url: 'https://cdn.test/a.jpg?size=1' },
          { url: 'https://cdn.test/b.jpeg' },
          { url: 'https://cdn.test/c.png' },
          { url: 'https://cdn.test/d.gif' },
          { url: 'https://cdn.test/e.webp' },
          { url: 'https://cdn.test/f.mp4' },
          { url: 'https://cdn.test/g.webm' },
          { url: 'https://cdn.test/h.mp3' },
          { url: 'https://cdn.test/i.wav' },
          { url: 'https://cdn.test/no-extension', content_type: 'IMAGE/PNG', filename: 'explicit.png' },
          { url: 'https://cdn.test/unknown.bin' },
          { voice_wav_url: 'https://cdn.test/voice', filename: 'voice.wav' },
          {},
          null,
        ],
        timestamp: '1786852800',
      },
      { now: () => 999 },
    )
    expect(decoded).toMatchObject({
      eventType: 'GROUP_MESSAGE_CREATE',
      platformMessageId: 'group-edge',
      target: { kind: 'group', openId: 'group-fallback' },
      targetDisplayName: '测试群',
      senderOpenId: 'sender',
      senderDisplayName: '发送者',
      content: '<@!bot-openid> @成员甲 请看',
      mentions: [
        { openId: 'bot-openid', displayName: 'NekroNxt', bot: true },
        { openId: 'member-openid', displayName: '成员甲' },
      ],
      platformReference: 'quote-ref',
      platformTimestamp: 1_786_852_800_000,
    })
    expect(decoded?.attachments).toEqual([
      { url: 'https://cdn.test/a.jpg?size=1', mediaType: 'image/jpeg' },
      { url: 'https://cdn.test/b.jpeg', mediaType: 'image/jpeg' },
      { url: 'https://cdn.test/c.png', mediaType: 'image/png' },
      { url: 'https://cdn.test/d.gif', mediaType: 'image/gif' },
      { url: 'https://cdn.test/e.webp', mediaType: 'image/webp' },
      { url: 'https://cdn.test/f.mp4', mediaType: 'video/mp4' },
      { url: 'https://cdn.test/g.webm', mediaType: 'video/webm' },
      { url: 'https://cdn.test/h.mp3', mediaType: 'audio/mpeg' },
      { url: 'https://cdn.test/i.wav', mediaType: 'audio/wav' },
      { url: 'https://cdn.test/no-extension', fileName: 'explicit.png', mediaType: 'image/png' },
      { url: 'https://cdn.test/unknown.bin' },
      { url: 'https://cdn.test/voice', fileName: 'voice.wav', mediaType: 'audio/wav' },
    ])
  })

  it('uses alternate identities, timestamps, references, and deterministic fallback times', () => {
    expect(
      c2c({
        author: { union_openid: 'union-user' },
        message_scene: { ext: { msgIdx: 'scene-message', refMsgIdx: 'scene-quote' } },
        timestamp: '2026-08-16T04:00:00.000Z',
      }),
    ).toMatchObject({
      platformMessageId: 'scene-message',
      target: { kind: 'c2c', openId: 'union-user' },
      senderOpenId: 'union-user',
      platformReference: 'scene-quote',
      platformTimestamp: Date.parse('2026-08-16T04:00:00.000Z'),
    })
    expect(c2c({ id: 'milliseconds', author: { id: 'user' }, timestamp: '1786852800000' })).toMatchObject({
      platformTimestamp: 1_786_852_800_000,
    })
    expect(c2c({ id: 'fallback', author: { id: 'user' }, timestamp: 'not-a-time' })).toMatchObject({
      platformTimestamp: 999,
    })
    expect(
      decodeQQInboundMessage('C2C_MESSAGE_CREATE', {
        author: { id: 'user' },
        msg_elements: [{ msg_idx: 'from-element' }],
      }),
    ).toMatchObject({ platformMessageId: 'from-element' })
  })

  it('rejects malformed supported events at the first missing identity boundary', () => {
    expect(() => decodeQQInboundMessage('C2C_MESSAGE_CREATE', { author: { id: 'user' } })).toThrow(
      'message ID is required',
    )
    expect(() => decodeQQInboundMessage('C2C_MESSAGE_CREATE', { id: 'message', author: {} })).toThrow(
      'C2C sender OpenID is required',
    )
    expect(() => decodeQQInboundMessage('GROUP_MESSAGE_CREATE', { id: 'message', author: { id: 'sender' } })).toThrow(
      'group OpenID is required',
    )
    expect(
      decodeQQInboundMessage('GROUP_MESSAGE_CREATE', {
        id: 'message',
        group_openid: 'group',
        author: { member_openid: 'sender' },
        mentions: [{}, null],
        attachments: 'not-an-array',
      }),
    ).toMatchObject({ mentions: [], attachments: [] })
  })
})

describe('QQ inbound mention splitting', () => {
  it('keeps Mention atoms at the original offsets and prepends unused bot mentions', () => {
    expect(
      splitQQContentAtoms('@NekroNxt 你好 @成员乙', [
        { openId: 'bot-openid', displayName: 'NekroNxt', bot: true },
        { openId: 'member-openid', displayName: '成员乙' },
      ]),
    ).toEqual([
      { kind: 'mention', openId: 'bot-openid', displayName: 'NekroNxt', bot: true },
      { kind: 'text', value: ' 你好 ' },
      { kind: 'mention', openId: 'member-openid', displayName: '成员乙' },
    ])
    expect(
      splitQQContentAtoms('<@!bot-openid> @成员甲 请看', [
        { openId: 'bot-openid', displayName: 'NekroNxt', bot: true },
        { openId: 'member-openid', displayName: '成员甲' },
      ]),
    ).toEqual([
      { kind: 'mention', openId: 'bot-openid', displayName: 'NekroNxt', bot: true },
      { kind: 'text', value: ' ' },
      { kind: 'mention', openId: 'member-openid', displayName: '成员甲' },
      { kind: 'text', value: ' 请看' },
    ])
    expect(
      splitQQContentAtoms('请看', [
        { openId: 'bot-openid', bot: true },
        { openId: 'member-openid', displayName: '成员乙' },
      ]),
    ).toEqual([
      { kind: 'mention', openId: 'bot-openid', displayName: '机器人账号', bot: true },
      { kind: 'text', value: '请看' },
      { kind: 'mention', openId: 'member-openid', displayName: '成员乙' },
    ])
    expect(splitQQContentAtoms(undefined, [{ openId: 'bot-openid', bot: true }])).toEqual([
      { kind: 'mention', openId: 'bot-openid', displayName: '机器人账号', bot: true },
    ])
  })
})
