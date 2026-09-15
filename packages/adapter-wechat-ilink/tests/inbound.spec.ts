import { describe, expect, it } from 'vitest'
import {
  contextTokenStateKey,
  decodeWechatId,
  encodeWechatId,
  normalizeWechatIlinkInboundMessage,
  platformChannelIdFromUserId,
  wechatMessageFileAttachments,
  wechatMessageImageAttachments,
  wechatMessageTextParts,
} from '../src/index.ts'

describe('WeChat iLink inbound normalization', () => {
  it('preserves ordered text items and stores only low-sensitive facts', () => {
    const normalized = normalizeWechatIlinkInboundMessage(
      {
        seq: 7,
        message_id: 42,
        from_user_id: 'wechat-user-1',
        create_time_ms: 1_800,
        session_id: 'session-1',
        group_id: 'ignored-group-1',
        message_state: 1,
        context_token: 'context-token-secret',
        item_list: [
          { item_type: 1, text_item: { text: '你好' } },
          { item_type: 99 },
          { type: 1, text_item: { text: '，NekroNXT' } },
        ],
      },
      { now: () => 2_000 },
    )

    expect(normalized).toMatchObject({
      platformChannelId: platformChannelIdFromUserId('wechat-user-1'),
      platformUserId: 'wechat-user-1',
      platformMessageId: '42',
      platformEventId: 'wechat-ilink:42',
      platformSequence: 7,
      platformTimestamp: 1_800,
      receivedAt: 2_000,
      parts: [
        { type: 'text', text: '你好' },
        { type: 'text', text: '，NekroNXT' },
      ],
      contextToken: 'context-token-secret',
      facts: {
        sessionId: 'session-1',
        messageState: 1,
        hasContextToken: true,
        itemTypes: [1, 99, 1],
        hasGroupId: true,
      },
    })
    expect(JSON.stringify(normalized?.facts)).not.toContain('context-token-secret')
  })

  it('keeps image items in order without storing media URLs in facts', () => {
    const message = {
      message_id: 'image-message-1',
      from_user_id: 'wechat-user-image',
      message_type: 1,
      create_time_ms: 5_000,
      item_list: [
        { item_type: 1, text_item: { text: '看图' } },
        {
          item_type: 2,
          image_item: {
            download_url: 'https://media.example.invalid/pixel.png',
            file_name: 'pixel.png',
            mime_type: 'image/png',
            size: '4',
          },
        },
        { item_type: 1, text_item: { text: '喵' } },
      ],
    }

    expect(wechatMessageImageAttachments(message)).toMatchObject([
      { url: 'https://media.example.invalid/pixel.png', fileName: 'pixel.png', mediaType: 'image/png', byteSize: 4 },
    ])
    const normalized = normalizeWechatIlinkInboundMessage(message, { now: () => 6_000 })

    expect(normalized).toMatchObject({
      parts: [
        { type: 'text', text: '看图' },
        {
          type: 'rich',
          adapterKey: 'wechat-ilink',
          kind: 'image',
          summary: '微信 iLink 图片等待导入。',
          title: 'pixel.png',
        },
        { type: 'text', text: '喵' },
      ],
      imageAttachments: [
        {
          partIndex: 1,
          attachment: {
            url: 'https://media.example.invalid/pixel.png',
            fileName: 'pixel.png',
            mediaType: 'image/png',
            byteSize: 4,
          },
        },
      ],
      facts: { imageItemCount: 1, downloadableImageItemCount: 1, itemTypes: [1, 2, 1] },
    })
    expect(JSON.stringify(normalized?.facts)).not.toContain('media.example.invalid')
  })

  it('treats SDK encrypted image media as downloadable without storing CDN secrets in facts', () => {
    const message = {
      message_id: 'encrypted-image-message-1',
      from_user_id: 'wechat-user-image',
      create_time_ms: 5_500,
      item_list: [
        {
          type: 2,
          image_item: {
            media: { encrypt_query_param: 'encrypted-query-fixture', aes_key: 'base64-key-fixture' },
            aeskey: '00112233445566778899aabbccddeeff',
            mid_size: 4,
          },
        },
      ],
    }

    expect(wechatMessageImageAttachments(message)).toMatchObject([{ byteSize: 4 }])
    const normalized = normalizeWechatIlinkInboundMessage(message, { now: () => 6_500 })

    expect(normalized).toMatchObject({
      parts: [
        {
          type: 'rich',
          adapterKey: 'wechat-ilink',
          kind: 'image',
          summary: '微信 iLink 图片等待导入。',
        },
      ],
      imageAttachments: [{ partIndex: 0, attachment: { byteSize: 4 } }],
      facts: { imageItemCount: 1, downloadableImageItemCount: 1, itemTypes: [2] },
    })
    const serializedFacts = JSON.stringify(normalized?.facts)
    expect(serializedFacts).not.toContain('encrypted-query-fixture')
    expect(serializedFacts).not.toContain('base64-key-fixture')
    expect(serializedFacts).not.toContain('00112233445566778899aabbccddeeff')
  })

  it('keeps file items in order without storing media secrets in facts', () => {
    const message = {
      message_id: 'file-message-1',
      from_user_id: 'wechat-user-file',
      create_time_ms: 5_800,
      item_list: [
        { item_type: 1, text_item: { text: '看文件' } },
        {
          item_type: 4,
          file_item: {
            media: { encrypt_query_param: 'encrypted-file-query-fixture', aes_key: 'base64-file-key-fixture' },
            file_name: '说明.pdf',
            len: '1024',
          },
        },
        { item_type: 1, text_item: { text: '喵' } },
      ],
    }

    expect(wechatMessageFileAttachments(message)).toMatchObject([
      { kind: 'file', fileName: '说明.pdf', byteSize: 1024 },
    ])
    const normalized = normalizeWechatIlinkInboundMessage(message, { now: () => 6_800 })

    expect(normalized).toMatchObject({
      parts: [
        { type: 'text', text: '看文件' },
        {
          type: 'rich',
          adapterKey: 'wechat-ilink',
          kind: 'file',
          summary: '微信 iLink 文件等待导入。',
          title: '说明.pdf',
        },
        { type: 'text', text: '喵' },
      ],
      mediaAttachments: [{ partIndex: 1, attachment: { kind: 'file', fileName: '说明.pdf', byteSize: 1024 } }],
      imageAttachments: [],
      facts: { fileItemCount: 1, downloadableFileItemCount: 1, itemTypes: [1, 4, 1] },
    })
    const serializedFacts = JSON.stringify(normalized?.facts)
    expect(serializedFacts).not.toContain('encrypted-file-query-fixture')
    expect(serializedFacts).not.toContain('base64-file-key-fixture')
  })

  it('treats flat SDK file media as downloadable without storing CDN secrets in facts', () => {
    const message = {
      message_id: 'flat-file-message-1',
      from_user_id: 'wechat-user-file',
      create_time_ms: 5_900,
      item_list: [
        {
          type: 4,
          media: { encrypt_query_param: 'flat-file-query-fixture', aes_key: 'flat-file-key-fixture' },
          file_name: '扁平文件.txt',
          len: '12',
        },
      ],
    }

    expect(wechatMessageFileAttachments(message)).toMatchObject([
      { kind: 'file', fileName: '扁平文件.txt', byteSize: 12 },
    ])
    const normalized = normalizeWechatIlinkInboundMessage(message, { now: () => 6_900 })

    expect(normalized).toMatchObject({
      parts: [
        {
          type: 'rich',
          adapterKey: 'wechat-ilink',
          kind: 'file',
          summary: '微信 iLink 文件等待导入。',
          title: '扁平文件.txt',
        },
      ],
      mediaAttachments: [{ partIndex: 0, attachment: { kind: 'file', fileName: '扁平文件.txt', byteSize: 12 } }],
      facts: { fileItemCount: 1, downloadableFileItemCount: 1, itemTypes: [4] },
    })
    const serializedFacts = JSON.stringify(normalized?.facts)
    expect(serializedFacts).not.toContain('flat-file-query-fixture')
    expect(serializedFacts).not.toContain('flat-file-key-fixture')
  })

  it('uses deterministic ID fallbacks and reversible direct channel IDs', () => {
    const encoded = encodeWechatId('用户-虚构-1')
    expect(decodeWechatId(encoded)).toBe('用户-虚构-1')
    expect(platformChannelIdFromUserId('用户-虚构-1')).toBe('direct:' + encoded)
    expect(contextTokenStateKey('用户-虚构-1')).toBe('context-token:direct:' + encoded)

    expect(
      normalizeWechatIlinkInboundMessage(
        {
          from_user_id: 'wechat-user-2',
          client_id: 'client-2',
          item_list: [{ item_type: 1, text_item: { text: 'hi' } }],
        },
        { now: () => 3_000 },
      )?.platformMessageId,
    ).toBe('client:client-2')
    expect(
      normalizeWechatIlinkInboundMessage(
        {
          from_user_id: 'wechat-user-3',
          seq: 9,
          create_time_ms: 4_000,
          item_list: [{ item_type: 1, text_item: { text: 'hi' } }],
        },
        { now: () => 3_000 },
      )?.platformMessageId,
    ).toBe('seq:9:4000')
  })

  it('ignores messages without sender, ID or supported content', () => {
    expect(
      wechatMessageTextParts({ item_list: [{ item_type: 1, text_item: { text: 'a' } }, { item_type: 1 }] }),
    ).toEqual(['a'])
    expect(
      normalizeWechatIlinkInboundMessage(
        { message_id: 1, item_list: [{ item_type: 1, text_item: { text: 'hi' } }] },
        { now: () => 1 },
      ),
    ).toBeUndefined()
    expect(
      normalizeWechatIlinkInboundMessage(
        { from_user_id: 'u', item_list: [{ item_type: 1, text_item: { text: 'hi' } }] },
        { now: () => 1 },
      ),
    ).toBeUndefined()
    expect(
      normalizeWechatIlinkInboundMessage(
        { from_user_id: 'u', message_id: 1, item_list: [{ item_type: 99 }] },
        { now: () => 1 },
      ),
    ).toBeUndefined()
  })

  it('ignores bot echoes, exact self messages and deleted messages without conflating normalized IDs', () => {
    const userText = {
      from_user_id: 'wechat-user-1',
      message_id: 1,
      item_list: [{ item_type: 1, text_item: { text: 'hi' } }],
    }
    expect(
      normalizeWechatIlinkInboundMessage(
        { ...userText, message_type: 2 },
        { now: () => 1, accountId: 'wx_account_fixture' },
      ),
    ).toBeUndefined()
    expect(
      normalizeWechatIlinkInboundMessage(
        { ...userText, from_user_id: 'hex@im.bot' },
        { now: () => 1, accountId: 'hex@im.bot' },
      ),
    ).toBeUndefined()
    expect(
      normalizeWechatIlinkInboundMessage(
        { ...userText, from_user_id: 'hex@im.bot' },
        { now: () => 1, accountId: 'hex-im-bot' },
      ),
    ).toMatchObject({ platformUserId: 'hex@im.bot' })
    expect(
      normalizeWechatIlinkInboundMessage(
        { ...userText, delete_time_ms: 9_000 },
        { now: () => 1, accountId: 'wx_account_fixture' },
      ),
    ).toBeUndefined()
    expect(
      normalizeWechatIlinkInboundMessage(userText, { now: () => 1, accountId: 'wx_account_fixture' }),
    ).toMatchObject({
      platformUserId: 'wechat-user-1',
    })
  })
})
