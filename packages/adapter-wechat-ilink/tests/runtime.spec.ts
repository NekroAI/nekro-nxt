import type { PhysicalDeliveryRequest } from '@nekro-nxt/adapter-sdk'
import { AssetIdSchema, ChannelIdSchema, LogicalMessageIdSchema, PhysicalDeliveryIdSchema } from '@nekro-nxt/contracts'
import { ApiClient, MessageItemType, WeChatClient } from 'wechat-ilink-client'
import { describe, expect, it, vi } from 'vitest'
import {
  WECHAT_ILINK_SYNC_BUF_STATE_KEY,
  WechatIlinkSdkTransport,
  WechatIlinkRuntime,
  classifyWechatIlinkError,
  contextTokenStateKey,
  createWechatIlinkSdkLoginClientFactory,
  createWechatIlinkSdkTransportFactory,
  platformChannelIdFromUserId,
  type WechatIlinkTransportConfig,
  type WechatIlinkTransportFactory,
} from '../src/index.ts'
import { FakeWechatIlinkTransport, createFakeContext, waitFor } from './helpers.ts'

const runtimeConfig = {
  accountId: 'wechat-account-1',
  botTokenCredentialRef: 'credential:local:test',
  baseUrl: 'https://ilink-api.test',
  cdnBaseUrl: 'https://ilink-cdn.test/c2c',
  botType: '3',
  longPollTimeoutMs: 1_234,
  enableInboundMedia: true,
  enableOutboundMedia: false,
  maxTextLength: 4000,
}

const deliveryRequest = (
  input: Pick<PhysicalDeliveryRequest, 'connectionId' | 'channelId' | 'parts'>,
): PhysicalDeliveryRequest => ({
  deliveryId: PhysicalDeliveryIdSchema.parse('phy_WECHATRUNTIME'),
  logicalMessageId: LogicalMessageIdSchema.parse('msg_WECHATRUNTIME'),
  ...input,
})

describe('WeChat iLink Runtime', () => {
  it('starts with resolved credentials, persists cursor state, admits text inbound and sends reply with context token', async () => {
    const transport = new FakeWechatIlinkTransport()
    const context = createFakeContext()
    let capturedConfig: WechatIlinkTransportConfig | undefined
    const factory: WechatIlinkTransportFactory = (config) => {
      capturedConfig = config
      transport.config = config
      return transport
    }
    const runtime = new WechatIlinkRuntime({
      context: context.context,
      config: runtimeConfig,
      transportFactory: factory,
    })

    await runtime.start()
    await transport.startInput?.saveSyncBuf('sync-buf-1')
    transport.emitMessage({
      message_id: 'wechat-message-1',
      from_user_id: 'wechat-user-1',
      create_time_ms: 9_000,
      context_token: 'context-token-1',
      group_id: 'ignored-group-1',
      item_list: [
        { item_type: 1, text_item: { text: '你好' } },
        { item_type: 1, text_item: { text: '，NekroNXT' } },
      ],
    })
    await waitFor(() => context.events.length === 1)

    const channelId = [...context.channels.values()][0]
    expect(channelId).toBeDefined()
    if (!channelId) throw new Error('Expected fake context to create a direct channel.')
    expect(capturedConfig).toEqual({
      accountId: 'wechat-account-1',
      token: 'token-secret',
      baseUrl: 'https://ilink-api.test',
      cdnBaseUrl: 'https://ilink-cdn.test/c2c',
    })
    expect(context.states.get(WECHAT_ILINK_SYNC_BUF_STATE_KEY)).toBe('sync-buf-1')
    expect(context.channels).toEqual(new Map([[platformChannelIdFromUserId('wechat-user-1'), channelId]]))
    expect(context.states.get(contextTokenStateKey('wechat-user-1'))).toBe('context-token-1')
    expect(context.events[0]).toMatchObject({
      adapterKey: 'wechat-ilink',
      platformMessageId: 'wechat-message-1',
      parts: [
        { type: 'text', text: '你好' },
        { type: 'text', text: '，NekroNXT' },
      ],
      facts: { hasContextToken: true, hasGroupId: true, itemTypes: [1, 1] },
    })
    expect(JSON.stringify(context.events[0]?.facts)).not.toContain('context-token-1')
    expect(context.diagnostics.map((diagnostic) => diagnostic.status)).toEqual(['connecting', 'connected', 'connected'])
    expect(context.diagnostics.at(-1)).toMatchObject({ details: { code: 'wechat-ilink/group-id-ignored' } })

    const receipt = await runtime.deliver(
      deliveryRequest({
        connectionId: context.context.connectionId,
        channelId,
        parts: [{ type: 'text', text: '收到喵' }],
      }),
      new AbortController().signal,
    )

    expect(receipt).toEqual({
      status: 'sent',
      platformMessageId: 'wechat-client-1',
      capabilityOutcomes: { idKind: 'client_id' },
    })
    expect(transport.sent).toEqual([{ toUserId: 'wechat-user-1', text: '收到喵', contextToken: 'context-token-1' }])

    transport.sendTextResult = { platformMessageId: 'wechat-platform-message-2' }
    await expect(
      runtime.deliver(
        deliveryRequest({
          connectionId: context.context.connectionId,
          channelId,
          parts: [{ type: 'text', text: '平台消息回执' }],
        }),
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      status: 'sent',
      platformMessageId: 'wechat-platform-message-2',
      capabilityOutcomes: { idKind: 'message_id' },
    })

    transport.sendTextResult = {}
    await expect(
      runtime.deliver(
        deliveryRequest({
          connectionId: context.context.connectionId,
          channelId,
          parts: [{ type: 'text', text: '本地投递回执' }],
        }),
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      status: 'sent',
      platformMessageId: 'phy_WECHATRUNTIME',
      capabilityOutcomes: { idKind: 'delivery_id' },
    })
    await expect(runtime.testSend(channelId)).resolves.toBe('phy_WECHATTEST')
  })

  it('forwards optional SDK routing configuration', async () => {
    const context = createFakeContext()
    let capturedConfig: WechatIlinkTransportConfig | undefined
    const runtime = new WechatIlinkRuntime({
      context: context.context,
      config: { ...runtimeConfig, channelVersion: 'channel-version-fixture', routeTag: 'route-tag-fixture' },
      transportFactory: (config) => {
        capturedConfig = config
        return new FakeWechatIlinkTransport()
      },
    })

    await runtime.start()
    expect(capturedConfig).toMatchObject({
      channelVersion: 'channel-version-fixture',
      routeTag: 'route-tag-fixture',
    })
    await runtime.stop()
  })

  it('rejects invalid outbound states and payloads before transport send', async () => {
    const transport = new FakeWechatIlinkTransport()
    const context = createFakeContext()
    const runtime = new WechatIlinkRuntime({
      context: context.context,
      config: runtimeConfig,
      transportFactory: () => transport,
    })
    const channelId = ChannelIdSchema.parse('chn_WECHATVALIDATION')
    const request = (parts: Parameters<typeof deliveryRequest>[0]['parts']) =>
      deliveryRequest({ connectionId: context.context.connectionId, channelId, parts })

    await expect(
      runtime.deliver(request([{ type: 'text', text: '尚未启动' }]), new AbortController().signal),
    ).resolves.toMatchObject({
      status: 'failed',
      failure: { kind: 'transient', message: '微信 iLink 连接尚未运行。' },
    })

    await runtime.start()
    await expect(runtime.start()).rejects.toThrow('已经在运行')
    await expect(
      runtime.deliver(
        request([{ type: 'file', assetId: AssetIdSchema.parse('ast_WECHATVALIDATION') }]),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ status: 'failed', failure: { message: '微信 iLink 当前只支持纯文本消息。' } })
    await expect(
      runtime.deliver(request([{ type: 'text', text: '   ' }]), new AbortController().signal),
    ).resolves.toMatchObject({
      status: 'failed',
      failure: { message: '微信 iLink 不能发送空文本。' },
    })
    await expect(
      runtime.deliver(request([{ type: 'text', text: 'x'.repeat(4_001) }]), new AbortController().signal),
    ).resolves.toMatchObject({ status: 'failed', failure: { message: '微信 iLink 文本超过单条字符上限。' } })
    await expect(
      runtime.deliver(request([{ type: 'text', text: '未知频道' }]), new AbortController().signal),
    ).resolves.toMatchObject({
      status: 'failed',
      failure: { message: '微信 iLink 当前只支持已发现的私聊频道。' },
    })

    context.channels.set('direct:%', channelId)
    await expect(
      runtime.deliver(request([{ type: 'text', text: '无效身份' }]), new AbortController().signal),
    ).resolves.toMatchObject({
      status: 'failed',
      failure: { message: '微信 iLink 私聊频道身份无法解析。' },
    })
    expect(transport.sent).toEqual([])
    await runtime.stop()
  })

  it('imports inbound image items as channel assets', async () => {
    const transport = new FakeWechatIlinkTransport()
    const context = createFakeContext()
    const imageBytes = new Uint8Array([137, 80, 78, 71])
    const runtime = new WechatIlinkRuntime({
      context: context.context,
      config: runtimeConfig,
      transportFactory: () => transport,
    })

    await runtime.start()
    transport.emitMessage({
      message_id: 'wechat-image-message-1',
      from_user_id: 'wechat-user-image',
      message_type: 1,
      create_time_ms: 9_100,
      context_token: 'context-token-image',
      item_list: [
        { item_type: 1, text_item: { text: '看图' } },
        {
          item_type: 2,
          image_item: {
            url: 'https://media.example.invalid/pixel.png',
            file_name: 'pixel.png',
            mime_type: 'image/png',
          },
        },
      ],
    })
    await waitFor(() => context.events.length === 1)

    expect(context.remoteFetches).toEqual([
      { url: 'https://media.example.invalid/pixel.png', maxBytes: 20 * 1024 * 1024 },
    ])
    expect(context.importedAssets).toEqual([{ bytes: imageBytes, declaredMediaType: 'image/png' }])
    expect(context.events[0]).toMatchObject({
      adapterKey: 'wechat-ilink',
      platformMessageId: 'wechat-image-message-1',
      parts: [
        { type: 'text', text: '看图' },
        { type: 'image', assetId: 'ast_WECHATIMAGE1', alt: 'pixel.png' },
      ],
      facts: {
        hasContextToken: true,
        hasGroupId: false,
        itemTypes: [1, 2],
        imageItemCount: 1,
        downloadableImageItemCount: 1,
      },
      assetOccurrences: [{ partIndex: 1, assetId: 'ast_WECHATIMAGE1' }],
    })
    expect(JSON.stringify(context.events[0]?.facts)).not.toContain('media.example.invalid')
  })

  it('imports inbound SDK encrypted image media as channel assets', async () => {
    const transport = new FakeWechatIlinkTransport()
    const context = createFakeContext()
    const imageBytes = new Uint8Array([255, 216, 255, 217])
    transport.downloadedMedia = { kind: 'image', data: imageBytes }
    const runtime = new WechatIlinkRuntime({
      context: context.context,
      config: runtimeConfig,
      transportFactory: () => transport,
    })

    await runtime.start()
    transport.emitMessage({
      message_id: 'wechat-sdk-image-message-1',
      from_user_id: 'wechat-user-sdk-image',
      create_time_ms: 9_200,
      context_token: 'context-token-sdk-image',
      item_list: [
        { item_type: 1, text_item: { text: '加密图' } },
        {
          item_type: 2,
          image_item: {
            media: { encrypt_query_param: 'encrypted-query-fixture', aes_key: 'base64-key-fixture' },
            aeskey: '00112233445566778899aabbccddeeff',
            mid_size: imageBytes.byteLength,
          },
        },
      ],
    })
    await waitFor(() => context.events.length === 1)

    expect(context.remoteFetches).toEqual([])
    expect(transport.downloadMediaCalls).toHaveLength(1)
    expect(transport.downloadMediaCalls[0]).toMatchObject({
      type: 2,
      image_item: { media: { encrypt_query_param: 'encrypted-query-fixture' } },
    })
    expect(context.importedAssets).toEqual([{ bytes: imageBytes }])
    expect(context.events[0]).toMatchObject({
      adapterKey: 'wechat-ilink',
      platformMessageId: 'wechat-sdk-image-message-1',
      parts: [
        { type: 'text', text: '加密图' },
        { type: 'image', assetId: 'ast_WECHATIMAGE1' },
      ],
      facts: {
        hasContextToken: true,
        hasGroupId: false,
        itemTypes: [1, 2],
        imageItemCount: 1,
        downloadableImageItemCount: 1,
      },
      assetOccurrences: [{ partIndex: 1, assetId: 'ast_WECHATIMAGE1' }],
    })
    expect(JSON.stringify(context.events[0]?.facts)).not.toContain('encrypted-query-fixture')
    expect(JSON.stringify(context.events[0]?.facts)).not.toContain('base64-key-fixture')
    expect(JSON.stringify(context.events[0]?.facts)).not.toContain('00112233445566778899aabbccddeeff')
  })

  it('imports inbound SDK encrypted file media as channel assets using the same inbound media switch', async () => {
    const transport = new FakeWechatIlinkTransport()
    const context = createFakeContext()
    const fileBytes = new Uint8Array([37, 80, 68, 70])
    transport.downloadedMedia = { kind: 'file', data: fileBytes, fileName: '说明.pdf' }
    const runtime = new WechatIlinkRuntime({
      context: context.context,
      config: runtimeConfig,
      transportFactory: () => transport,
    })

    await runtime.start()
    transport.emitMessage({
      message_id: 'wechat-sdk-file-message-1',
      from_user_id: 'wechat-user-sdk-file',
      create_time_ms: 9_300,
      context_token: 'context-token-sdk-file',
      item_list: [
        { item_type: 1, text_item: { text: '加密文件' } },
        {
          item_type: 4,
          file_item: {
            media: { encrypt_query_param: 'encrypted-file-query-fixture', aes_key: 'base64-file-key-fixture' },
            file_name: '说明.pdf',
            len: String(fileBytes.byteLength),
          },
        },
      ],
    })
    await waitFor(() => context.events.length === 1)

    expect(context.remoteFetches).toEqual([])
    expect(transport.downloadMediaCalls).toHaveLength(1)
    expect(transport.downloadMediaCalls[0]).toMatchObject({
      type: 4,
      file_item: { media: { encrypt_query_param: 'encrypted-file-query-fixture' }, file_name: '说明.pdf' },
    })
    expect(context.importedAssets).toEqual([{ bytes: fileBytes }])
    expect(context.events[0]).toMatchObject({
      adapterKey: 'wechat-ilink',
      platformMessageId: 'wechat-sdk-file-message-1',
      parts: [
        { type: 'text', text: '加密文件' },
        { type: 'file', assetId: 'ast_WECHATIMAGE1', name: '说明.pdf' },
      ],
      facts: {
        hasContextToken: true,
        hasGroupId: false,
        itemTypes: [1, 4],
        fileItemCount: 1,
        downloadableFileItemCount: 1,
      },
      assetOccurrences: [{ partIndex: 1, assetId: 'ast_WECHATIMAGE1' }],
    })
    expect(JSON.stringify(context.events[0]?.facts)).not.toContain('encrypted-file-query-fixture')
    expect(JSON.stringify(context.events[0]?.facts)).not.toContain('base64-file-key-fixture')
  })

  it('actively downloads flat inbound SDK file media before admitting the channel event', async () => {
    const transport = new FakeWechatIlinkTransport()
    const context = createFakeContext()
    const fileBytes = new Uint8Array([110, 120, 116])
    transport.downloadedMedia = { kind: 'file', data: fileBytes, fileName: '扁平文件.txt' }
    const runtime = new WechatIlinkRuntime({
      context: context.context,
      config: runtimeConfig,
      transportFactory: () => transport,
    })

    await runtime.start()
    transport.emitMessage({
      message_id: 'wechat-flat-file-message-1',
      from_user_id: 'wechat-user-flat-file',
      create_time_ms: 9_350,
      context_token: 'context-token-flat-file',
      item_list: [
        {
          type: 4,
          media: { encrypt_query_param: 'flat-file-query-fixture', aes_key: 'flat-file-key-fixture' },
          file_name: '扁平文件.txt',
          name: '扁平文件别名.txt',
          md5: 'flat-file-md5-fixture',
          len: String(fileBytes.byteLength),
          mime_type: 'text/plain',
          media_type: 'document',
          content_type: 'text/plain; charset=utf-8',
          size: fileBytes.byteLength,
        },
      ],
    })
    await waitFor(() => context.events.length === 1)

    expect(transport.downloadMediaCalls).toHaveLength(1)
    expect(transport.downloadMediaCalls[0]).toMatchObject({
      type: 4,
      file_item: {
        media: { encrypt_query_param: 'flat-file-query-fixture', aes_key: 'flat-file-key-fixture' },
        file_name: '扁平文件.txt',
        name: '扁平文件别名.txt',
        md5: 'flat-file-md5-fixture',
        len: String(fileBytes.byteLength),
        mime_type: 'text/plain',
        media_type: 'document',
        content_type: 'text/plain; charset=utf-8',
        size: fileBytes.byteLength,
      },
    })
    expect(context.importedAssets).toEqual([{ bytes: fileBytes, declaredMediaType: 'text/plain' }])
    expect(context.events[0]).toMatchObject({
      parts: [{ type: 'file', assetId: 'ast_WECHATIMAGE1', name: '扁平文件.txt' }],
      facts: { fileItemCount: 1, downloadableFileItemCount: 1, itemTypes: [4] },
      assetOccurrences: [{ partIndex: 0, assetId: 'ast_WECHATIMAGE1' }],
    })
    expect(JSON.stringify(context.events[0]?.facts)).not.toContain('flat-file-query-fixture')
    expect(JSON.stringify(context.events[0]?.facts)).not.toContain('flat-file-key-fixture')
  })

  it('normalizes flat inbound SDK image metadata before downloading', async () => {
    const transport = new FakeWechatIlinkTransport()
    const context = createFakeContext()
    const imageBytes = new Uint8Array([137, 80, 78, 71])
    transport.downloadedMedia = { kind: 'image', data: imageBytes, fileName: '平铺图片.png' }
    const runtime = new WechatIlinkRuntime({
      context: context.context,
      config: runtimeConfig,
      transportFactory: () => transport,
    })

    await runtime.start()
    transport.emitMessage({
      message_id: 'wechat-flat-image-message-1',
      from_user_id: 'wechat-user-flat-image',
      create_time_ms: 9_360,
      context_token: 'context-token-flat-image',
      item_list: [
        {
          type: 2,
          media: { encrypt_query_param: 'flat-image-query-fixture', aes_key: 'flat-image-key-fixture' },
          aeskey: 'flat-image-aes-fixture',
          file_name: '平铺图片.png',
          name: '平铺图片别名.png',
          mime_type: 'image/png',
          media_type: 'image',
          content_type: 'image/png',
          size: imageBytes.byteLength,
        },
      ],
    })
    await waitFor(() => context.events.length === 1)

    expect(transport.downloadMediaCalls).toHaveLength(1)
    expect(transport.downloadMediaCalls[0]).toMatchObject({
      type: 2,
      image_item: {
        media: { encrypt_query_param: 'flat-image-query-fixture', aes_key: 'flat-image-key-fixture' },
        aeskey: 'flat-image-aes-fixture',
        file_name: '平铺图片.png',
        name: '平铺图片别名.png',
        mime_type: 'image/png',
        media_type: 'image',
        content_type: 'image/png',
        size: imageBytes.byteLength,
      },
    })
    expect(context.events[0]).toMatchObject({
      parts: [{ type: 'image', assetId: 'ast_WECHATIMAGE1', alt: '平铺图片.png' }],
      assetOccurrences: [{ partIndex: 0, assetId: 'ast_WECHATIMAGE1' }],
    })
  })

  it('keeps media placeholders when inbound media is disabled', async () => {
    const transport = new FakeWechatIlinkTransport()
    const context = createFakeContext()
    const runtime = new WechatIlinkRuntime({
      context: context.context,
      config: { ...runtimeConfig, enableInboundMedia: false },
      transportFactory: () => transport,
    })

    await runtime.start()
    transport.emitMessage({
      message_id: 'wechat-disabled-file-message-1',
      from_user_id: 'wechat-user-disabled-file',
      create_time_ms: 9_400,
      context_token: 'context-token-disabled-file',
      item_list: [
        {
          item_type: 4,
          file_item: {
            media: { encrypt_query_param: 'encrypted-file-query-fixture', aes_key: 'base64-file-key-fixture' },
            file_name: '关闭开关.txt',
            len: '12',
          },
        },
      ],
    })
    await waitFor(() => context.events.length === 1)

    expect(transport.downloadMediaCalls).toEqual([])
    expect(context.importedAssets).toEqual([])
    expect(context.events[0]).toMatchObject({
      parts: [
        {
          type: 'rich',
          adapterKey: 'wechat-ilink',
          kind: 'file',
          summary: '微信 iLink 入站媒体接收未开启。',
        },
      ],
      facts: { fileItemCount: 1, downloadableFileItemCount: 1, itemTypes: [4] },
    })
  })

  it('rejects outbound before a context token is observed', async () => {
    const transport = new FakeWechatIlinkTransport()
    const context = createFakeContext()
    const runtime = new WechatIlinkRuntime({
      context: context.context,
      config: runtimeConfig,
      transportFactory: () => transport,
    })

    await runtime.start()
    const channelId = await context.context.channels.ensure({
      platformChannelId: platformChannelIdFromUserId('wechat-user-no-token'),
      kind: 'direct',
      observedAt: 10_000,
    })
    const receipt = await runtime.deliver(
      deliveryRequest({
        connectionId: context.context.connectionId,
        channelId,
        parts: [{ type: 'text', text: '需要上下文' }],
      }),
      new AbortController().signal,
    )

    expect(receipt.status).toBe('failed')
    if (receipt.status !== 'failed') throw new Error('Expected outbound delivery to fail without context token.')
    expect(receipt.failure.kind).toBe('invalid')
    expect(receipt.failure.message).toContain('context_token')
    expect(transport.sent).toEqual([])
    expect(context.diagnostics.at(-1)).toMatchObject({ details: { code: 'wechat-ilink/missing-context-token' } })
  })

  it('drops late inbound events after stop', async () => {
    const transport = new FakeWechatIlinkTransport()
    const context = createFakeContext()
    const runtime = new WechatIlinkRuntime({
      context: context.context,
      config: runtimeConfig,
      transportFactory: () => transport,
    })

    await runtime.start()
    await runtime.stop()
    transport.emitMessage({
      message_id: 'wechat-message-late',
      from_user_id: 'wechat-user-late',
      create_time_ms: 9_000,
      context_token: 'context-token-late',
      item_list: [{ item_type: 1, text_item: { text: 'late' } }],
    })

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(transport.stopped).toBe(true)
    expect(context.events).toEqual([])
    expect(context.states.get(contextTokenStateKey('wechat-user-late'))).toBeUndefined()
  })

  it('publishes session expiration and classifies transport errors', async () => {
    const transport = new FakeWechatIlinkTransport()
    const context = createFakeContext()
    const runtime = new WechatIlinkRuntime({
      context: context.context,
      config: runtimeConfig,
      transportFactory: () => transport,
    })

    await runtime.start()
    transport.startInput?.onSessionExpired()

    expect(context.diagnostics.at(-1)).toMatchObject({
      status: 'failed',
      message: '微信 iLink 会话已过期，请重新扫码登录。',
      details: { code: 'wechat-ilink/session-expired' },
    })
    expect(classifyWechatIlinkError({ status: 429, message: 'rate limit' })).toMatchObject({ kind: 'rate-limited' })
    expect(classifyWechatIlinkError({ errcode: -14, message: 'session expired' })).toMatchObject({
      kind: 'authentication',
    })
    expect(classifyWechatIlinkError({ status: 401, message: 'request rejected' })).toMatchObject({
      kind: 'authentication',
    })
    expect(classifyWechatIlinkError({ cause: { status: 403 }, message: 'request rejected' })).toMatchObject({
      kind: 'authentication',
    })
    expect(classifyWechatIlinkError(new Error('sendMessage failed: ret=-14 errmsg=credential stale'))).toMatchObject({
      kind: 'authentication',
    })
    expect(classifyWechatIlinkError(new Error('fetch failed'))).toMatchObject({ kind: 'transient' })
    expect(classifyWechatIlinkError(new Error('missing context_token'))).toMatchObject({ kind: 'transient' })
    expect(classifyWechatIlinkError('plain failure')).toMatchObject({ kind: 'transient', message: 'plain failure' })
  })

  it('rejects successful HTTP responses carrying protocol send errors', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ ret: -14, errcode: 0, errmsg: 'credential stale' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    try {
      const client = new ApiClient({ token: 'token-fixture', baseUrl: 'https://ilink-api.test' })
      await expect(
        client.sendMessage({
          msg: {
            to_user_id: 'wechat-user-1',
            message_type: 2,
            item_list: [{ type: MessageItemType.TEXT, text_item: { text: '测试' } }],
          },
        }),
      ).rejects.toThrow('ret=-14')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('preserves SDK HTTP status for authentication error classification', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('request rejected', { status: 401 })))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const client = new ApiClient({ token: 'token-fixture', baseUrl: 'https://ilink-api.test' })
      let thrown: unknown
      try {
        await client.sendMessage({ msg: { to_user_id: 'wechat-user-1', message_type: 2 } })
      } catch (error) {
        thrown = error
      }
      expect(classifyWechatIlinkError(thrown)).toMatchObject({ kind: 'authentication' })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('propagates abort signals into SDK media downloads', async () => {
    let requestSignal: AbortSignal | null = null
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      requestSignal = init?.signal ?? null
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener(
          'abort',
          () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'))
          },
          { once: true },
        )
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const controller = new AbortController()
      const client = new WeChatClient({
        accountId: 'wechat-account-1',
        token: 'token-fixture',
        cdnBaseUrl: 'https://ilink-cdn.test/c2c',
      })
      const downloading = client.downloadMedia(
        {
          type: MessageItemType.IMAGE,
          image_item: { media: { encrypt_query_param: 'encrypted-query-fixture' } },
        },
        controller.signal,
      )
      await vi.waitFor(() => expect(requestSignal).toBe(controller.signal))
      controller.abort(new Error('connection stopped'))
      await expect(downloading).rejects.toMatchObject({ name: 'AbortError' })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('drops bot echoes, self messages and deleted inbound events', async () => {
    const transport = new FakeWechatIlinkTransport()
    const context = createFakeContext()
    const runtime = new WechatIlinkRuntime({
      context: context.context,
      config: runtimeConfig,
      transportFactory: () => transport,
    })

    await runtime.start()
    transport.emitMessage({
      message_id: 'bot-echo-1',
      from_user_id: 'wechat-user-1',
      message_type: 2,
      context_token: 'context-token-echo',
      item_list: [{ item_type: 1, text_item: { text: '自己发的' } }],
    })
    transport.emitMessage({
      message_id: 'self-message-1',
      from_user_id: 'wechat-account-1',
      context_token: 'context-token-self',
      item_list: [{ item_type: 1, text_item: { text: '账号自己' } }],
    })
    transport.emitMessage({
      message_id: 'deleted-message-1',
      from_user_id: 'wechat-user-1',
      delete_time_ms: 9_000,
      context_token: 'context-token-deleted',
      item_list: [{ item_type: 1, text_item: { text: '已删除' } }],
    })

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(context.events).toEqual([])
    expect(context.channels.size).toBe(0)
  })

  it('does not import inbound media from private HTTPS URLs', async () => {
    const transport = new FakeWechatIlinkTransport()
    const context = createFakeContext()
    const runtime = new WechatIlinkRuntime({
      context: context.context,
      config: runtimeConfig,
      transportFactory: () => transport,
    })

    await runtime.start()
    transport.emitMessage({
      message_id: 'private-image-1',
      from_user_id: 'wechat-user-private',
      create_time_ms: 9_500,
      context_token: 'context-token-private',
      item_list: [
        {
          item_type: 2,
          image_item: {
            url: 'https://127.0.0.1/pixel.png',
            file_name: 'pixel.png',
            mime_type: 'image/png',
          },
        },
      ],
    })
    await waitFor(() => context.events.length === 1)

    expect(context.remoteFetches).toEqual([{ url: 'https://127.0.0.1/pixel.png', maxBytes: 20 * 1024 * 1024 }])
    expect(context.importedAssets).toEqual([])
    expect(context.events[0]).toMatchObject({
      parts: [{ type: 'rich', adapterKey: 'wechat-ilink', kind: 'image', summary: '微信 iLink 图片下载失败。' }],
    })
  })

  it('normalizes SDK send receipts and enforces send cancellation', async () => {
    const errors: unknown[] = []
    let sdkReceipt: unknown = 'wechat-ilink:123-abcd'
    const transport = new WechatIlinkSdkTransport({
      on: vi.fn(),
      start: vi.fn(() => Promise.resolve()),
      stop: vi.fn(),
      sendText: vi.fn(() => Promise.resolve(sdkReceipt)),
    })

    await transport.start({
      signal: new AbortController().signal,
      longPollTimeoutMs: 1_234,
      loadSyncBuf: () => Promise.resolve(undefined),
      saveSyncBuf: () => Promise.resolve(),
      onMessage: vi.fn(),
      onError: (error) => errors.push(error),
      onSessionExpired: vi.fn(),
    })
    await expect(
      transport.sendText({
        toUserId: 'wechat-user-1',
        text: '收到喵',
        contextToken: 'context-token-1',
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ clientId: 'wechat-ilink:123-abcd' })
    for (const [value, expected] of [
      ['', {}],
      [null, {}],
      [[], {}],
      [{ platformMessageId: 'wechat-message-1', clientId: '' }, { platformMessageId: 'wechat-message-1' }],
      [{ platformMessageId: '', clientId: 'wechat-client-2' }, { clientId: 'wechat-client-2' }],
      [{ platformMessageId: 1, clientId: 2 }, {}],
    ] as const) {
      sdkReceipt = value
      await expect(
        transport.sendText({
          toUserId: 'wechat-user-1',
          text: '收到喵',
          contextToken: 'context-token-1',
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual(expected)
    }

    const cancelledBeforeSend = new AbortController()
    const beforeReason = new Error('cancelled before send')
    cancelledBeforeSend.abort(beforeReason)
    await expect(
      transport.sendText({
        toUserId: 'wechat-user-1',
        text: '不会发送',
        contextToken: 'context-token-1',
        signal: cancelledBeforeSend.signal,
      }),
    ).rejects.toBe(beforeReason)

    const cancelledAfterSend = new AbortController()
    const afterReason = new Error('cancelled after send')
    const abortingTransport = new WechatIlinkSdkTransport({
      on: vi.fn(),
      start: vi.fn(() => Promise.resolve()),
      sendText: vi.fn(() => {
        cancelledAfterSend.abort(afterReason)
        return Promise.resolve({ clientId: 'ignored-client-id' })
      }),
    })
    await expect(
      abortingTransport.sendText({
        toUserId: 'wechat-user-1',
        text: '发送中取消',
        contextToken: 'context-token-1',
        signal: cancelledAfterSend.signal,
      }),
    ).rejects.toBe(afterReason)
    expect(errors).toEqual([])
  })

  it('normalizes optional SDK media downloads and enforces cancellation', async () => {
    const transportWithoutDownload = new WechatIlinkSdkTransport({
      on: vi.fn(),
      start: vi.fn(() => Promise.resolve()),
      sendText: vi.fn(),
    })
    await expect(transportWithoutDownload.downloadMedia({}, new AbortController().signal)).resolves.toBeNull()
    await transportWithoutDownload.stop()

    const media = { kind: 'file' as const, data: new Uint8Array([1, 2, 3]), fileName: 'fixture.txt' }
    const transport = new WechatIlinkSdkTransport({
      on: vi.fn(),
      start: vi.fn(() => Promise.resolve()),
      sendText: vi.fn(),
      downloadMedia: vi.fn(() => Promise.resolve(media)),
    })
    await expect(transport.downloadMedia({}, new AbortController().signal)).resolves.toEqual(media)

    const cancelledBeforeDownload = new AbortController()
    const beforeReason = new Error('cancelled before download')
    cancelledBeforeDownload.abort(beforeReason)
    await expect(transport.downloadMedia({}, cancelledBeforeDownload.signal)).rejects.toBe(beforeReason)

    const cancelledAfterDownload = new AbortController()
    const afterReason = new Error('cancelled after download')
    const abortingTransport = new WechatIlinkSdkTransport({
      on: vi.fn(),
      start: vi.fn(() => Promise.resolve()),
      sendText: vi.fn(),
      downloadMedia: vi.fn(() => {
        cancelledAfterDownload.abort(afterReason)
        return Promise.resolve(media)
      }),
    })
    await expect(abortingTransport.downloadMedia({}, cancelledAfterDownload.signal)).rejects.toBe(afterReason)
  })

  it('guards lazy SDK factories before startup', async () => {
    const transport = createWechatIlinkSdkTransportFactory()({
      accountId: 'wechat-account-1',
      token: 'token-fixture',
      baseUrl: 'https://ilink-api.test',
      cdnBaseUrl: 'https://ilink-cdn.test/c2c',
    })

    await transport.stop()
    await expect(
      transport.sendText({
        toUserId: 'wechat-user-1',
        text: '尚未启动',
        contextToken: 'context-token-1',
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('尚未启动')
    await expect(transport.downloadMedia?.({}, new AbortController().signal)).rejects.toThrow('尚未启动')
    expect(typeof createWechatIlinkSdkLoginClientFactory()().login).toBe('function')
  })

  it('reports SDK start loop failures after the transport has started', async () => {
    const errors: unknown[] = []
    let rejectStart: ((error: Error) => void) | undefined
    const startTask = new Promise<void>((_resolve, reject) => {
      rejectStart = reject
    })
    const transport = new WechatIlinkSdkTransport({
      on: vi.fn(),
      start: vi.fn(() => startTask),
      stop: vi.fn(),
      sendText: vi.fn(),
    })

    await transport.start({
      signal: new AbortController().signal,
      longPollTimeoutMs: 1_234,
      loadSyncBuf: () => Promise.resolve(undefined),
      saveSyncBuf: () => Promise.resolve(),
      onMessage: vi.fn(),
      onError: (error) => errors.push(error),
      onSessionExpired: vi.fn(),
    })
    const failure = new Error('long poll failed')
    rejectStart?.(failure)

    await waitFor(() => errors.includes(failure))
    await transport.stop()
  })
})
