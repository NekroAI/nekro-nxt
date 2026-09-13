import type {
  AdapterConnectionDiagnostic,
  AdapterConnectionHostContext,
  AdapterChannelInboundEvent,
} from '@nekro-nxt/adapter-sdk'
import {
  AssetIdSchema,
  ChannelEventIdSchema,
  ChannelIdSchema,
  ChannelMemberIdSchema,
  ConnectionIdSchema,
  ConnectionEventIdSchema,
  PlatformIdentityIdSchema,
  type JsonValue,
} from '@nekro-nxt/contracts'
import { FakeAdapterTransport } from '@nekro-nxt/test-harness'
import type {
  WechatIlinkDownloadedMedia,
  WechatIlinkMessage,
  WechatIlinkMessageItem,
  WechatIlinkTransport,
  WechatIlinkTransportConfig,
  WechatIlinkTransportStartInput,
} from '../src/index.ts'

export const waitFor = async (predicate: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition.')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

export const createFakeContext = () => {
  const events: AdapterChannelInboundEvent[] = []
  const diagnostics: AdapterConnectionDiagnostic[] = []
  const importedAssets: Array<{ readonly bytes: Uint8Array; readonly declaredMediaType?: string }> = []
  const remoteFetches: Array<{ readonly url: string; readonly maxBytes: number }> = []
  const states = new Map<string, JsonValue>()
  const channels = new Map<string, ReturnType<typeof ChannelIdSchema.parse>>()
  const members = new Map<string, ReturnType<typeof ChannelMemberIdSchema.parse>>()
  let channelSequence = 0
  let memberSequence = 0
  const context: AdapterConnectionHostContext = {
    connectionId: ConnectionIdSchema.parse('con_WECHAT'),
    now: () => 10_000,
    acceptChannelInbound: (event) => {
      events.push(event)
      return Promise.resolve({ channelEventId: ChannelEventIdSchema.parse('evt_' + events.length), inserted: true })
    },
    acceptConnectionInbound: () =>
      Promise.resolve({ connectionEventId: ConnectionEventIdSchema.parse('cev_WECHAT1'), inserted: true }),
    channels: {
      ensure: (input) => {
        const existing = channels.get(input.platformChannelId)
        if (existing) return Promise.resolve(existing)
        const id = ChannelIdSchema.parse('chn_' + ++channelSequence)
        channels.set(input.platformChannelId, id)
        return Promise.resolve(id)
      },
      updateDisplayName: () => Promise.resolve(),
      resolvePlatformChannelId: (channelId) =>
        Promise.resolve([...channels].find(([, candidate]) => candidate === channelId)?.[0]),
      resolveKind: (channelId) => {
        const platform = [...channels].find(([, candidate]) => candidate === channelId)?.[0]
        return Promise.resolve(platform?.startsWith('direct:') ? 'direct' : undefined)
      },
    },
    identities: {
      ensure: () => Promise.resolve(PlatformIdentityIdSchema.parse('pid_WECHAT1')),
    },
    members: {
      ensure: (input) => {
        const key = input.channelId + ':' + input.platformUserId
        const existing = members.get(key)
        if (existing) return Promise.resolve(existing)
        const id = ChannelMemberIdSchema.parse('mbr_' + ++memberSequence)
        members.set(key, id)
        return Promise.resolve(id)
      },
      resolvePlatformUserId: (channelId, memberId) =>
        Promise.resolve(
          [...members]
            .find(([key, candidate]) => key.startsWith(channelId + ':') && candidate === memberId)?.[0]
            .split(':')
            .at(-1),
        ),
    },
    messages: {
      resolvePlatformMessage: () => Promise.resolve(undefined),
      resolvePlatformMessageId: () => Promise.resolve(undefined),
      resolveLogicalMessage: () => Promise.resolve(undefined),
    },
    assets: {
      importBytes: (input) => {
        importedAssets.push(input)
        return Promise.resolve({
          assetId: AssetIdSchema.parse('ast_WECHATIMAGE' + importedAssets.length),
          mediaType: input.declaredMediaType ?? 'application/octet-stream',
          byteSize: input.bytes.byteLength,
        })
      },
      read: () => Promise.resolve({ bytes: new Uint8Array([1, 2, 3]), mediaType: 'text/plain', byteSize: 3 }),
      fetchRemoteBytes: (input) => {
        remoteFetches.push({ url: input.url, maxBytes: input.maxBytes })
        const linkLocalAddress = [169, 254, 169, 254].join('.')
        if (input.url.includes('127.0.0.1') || input.url.includes(linkLocalAddress)) {
          return Promise.reject(new Error('远程资源地址解析到了不允许的网络。'))
        }
        return Promise.resolve({
          bytes: new Uint8Array([137, 80, 78, 71]),
          declaredMediaType: 'image/png',
          filename: 'pixel.png',
        })
      },
    },
    credentials: { resolve: () => Promise.resolve('token-secret') },
    state: {
      load: (key) => Promise.resolve(states.get(key)),
      save: (key, value) => {
        states.set(key, value)
        return Promise.resolve()
      },
      clear: (key) => {
        states.delete(key)
        return Promise.resolve()
      },
    },
    diagnostics: {
      publish: (diagnostic) => {
        diagnostics.push(diagnostic)
      },
    },
    transport: new FakeAdapterTransport(),
  }
  return { context, events, diagnostics, importedAssets, remoteFetches, states, channels, members }
}

export class FakeWechatIlinkTransport implements WechatIlinkTransport {
  readonly sent: Array<{ readonly toUserId: string; readonly text: string; readonly contextToken: string }> = []
  readonly downloadMediaCalls: WechatIlinkMessageItem[] = []
  downloadedMedia: WechatIlinkDownloadedMedia | null = null
  config: WechatIlinkTransportConfig | undefined
  startInput: WechatIlinkTransportStartInput | undefined
  stopped = false
  sendTextResult: { readonly platformMessageId?: string; readonly clientId?: string } = { clientId: 'wechat-client-1' }

  start(input: WechatIlinkTransportStartInput): Promise<void> {
    this.startInput = input
    return Promise.resolve()
  }

  stop(): Promise<void> {
    this.stopped = true
    return Promise.resolve()
  }

  downloadMedia(item: WechatIlinkMessageItem, signal: AbortSignal) {
    if (signal.aborted) throw signal.reason
    this.downloadMediaCalls.push(item)
    return Promise.resolve(this.downloadedMedia)
  }

  sendText(input: {
    readonly toUserId: string
    readonly text: string
    readonly contextToken: string
    readonly signal: AbortSignal
  }) {
    this.sent.push({ toUserId: input.toUserId, text: input.text, contextToken: input.contextToken })
    return Promise.resolve(this.sendTextResult)
  }

  emitMessage(message: WechatIlinkMessage): void {
    void this.startInput?.onMessage(message)
  }
}
