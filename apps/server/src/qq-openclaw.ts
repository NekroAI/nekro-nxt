import type {
  QQIdentityDirectory,
  QQInboundAttachment,
  QQInboundBridge,
  QQTarget,
} from '@nekro-nxt/adapter-qq-openclaw'
import type {
  AssetId,
  AssetOccurrenceId,
  ChannelEventId,
  ChannelId,
  ChannelMemberId,
  ConnectionId,
  LogicalMessageId,
} from '@nekro-nxt/contracts'
import type { AssetService, CoreService } from '@nekro-nxt/core'
import { createHash } from 'node:crypto'

export interface QQInboundAssetImporter {
  import(
    input: QQInboundAttachment & {
      readonly connectionId: ConnectionId
      readonly channelId: ChannelId
      readonly platformMessageId: string
      readonly receivedAt: number
      readonly attachmentIndex: number
      readonly signal: AbortSignal
    },
  ): Promise<{
    readonly assetId: AssetId
    readonly mediaType: string
    readonly fileName?: string
    readonly finalize?: (channelEventId: ChannelEventId) => Promise<void>
  }>
}

export interface QQRemoteAssetImporterOptions {
  readonly fetch?: typeof fetch
  readonly maxAssetBytes?: number
}

/** Downloads untrusted QQ media into a reserved content-addressed Asset, then links it after Event commit. */
export class QQRemoteAssetImporter implements QQInboundAssetImporter {
  readonly #assets: AssetService
  readonly #fetch: typeof fetch
  readonly #maxAssetBytes: number

  constructor(assets: AssetService, options: QQRemoteAssetImporterOptions = {}) {
    this.#assets = assets
    this.#fetch = options.fetch ?? fetch
    this.#maxAssetBytes = options.maxAssetBytes ?? 20 * 1024 * 1024
    if (!Number.isSafeInteger(this.#maxAssetBytes) || this.#maxAssetBytes <= 0) {
      throw new TypeError('QQ inbound Asset limit must be a positive integer.')
    }
  }

  async import(
    input: QQInboundAttachment & {
      readonly connectionId: ConnectionId
      readonly channelId: ChannelId
      readonly platformMessageId: string
      readonly receivedAt: number
      readonly attachmentIndex: number
      readonly signal: AbortSignal
    },
  ) {
    const url = new URL(input.url)
    if (url.protocol !== 'https:') throw new Error('QQ attachment URL must use HTTPS.')
    let response: Response
    try {
      response = await this.#fetch(url, { signal: input.signal, redirect: 'error' })
    } catch (error) {
      throw new Error('QQ attachment download failed.', { cause: error })
    }
    if (!response.ok) throw new Error(`QQ attachment download failed with status ${response.status}.`)
    const declaredLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredLength) && declaredLength > this.#maxAssetBytes) {
      throw new Error('QQ attachment exceeds the configured size limit.')
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > this.#maxAssetBytes) throw new Error('QQ attachment exceeds the configured size limit.')
    const declaredMediaType =
      input.mediaType ?? response.headers.get('content-type')?.split(';', 1)[0]?.trim() ?? undefined
    const prepared = await this.#assets.prepare({
      bytes,
      receivedAt: input.receivedAt,
      ...(declaredMediaType === undefined ? {} : { declaredMediaType }),
    })
    const occurrenceId = `aoc_${createHash('sha256')
      .update(`${input.connectionId}\0${input.platformMessageId}\0${input.attachmentIndex}`)
      .digest('hex')}` as AssetOccurrenceId
    return {
      assetId: prepared.asset.id,
      mediaType: prepared.asset.mediaType,
      ...(input.fileName === undefined ? {} : { fileName: input.fileName }),
      finalize: async (channelEventId: ChannelEventId) => {
        await prepared.commit({
          id: occurrenceId,
          channelEventId,
          channelId: input.channelId,
          connectionId: input.connectionId,
          platformMessageId: input.platformMessageId,
          receivedAt: input.receivedAt,
          ...(input.fileName === undefined ? {} : { filename: input.fileName }),
          ...(declaredMediaType === undefined ? {} : { declaredMediaType }),
        })
      },
    }
  }
}

const platformChannelId = (target: QQTarget): string => `${target.kind}:${target.openId}`

/** Product-owned implementation of QQ's identity, target and quote seams; it never exposes the Core database. */
export class QQCoreBridge implements QQIdentityDirectory, QQInboundBridge {
  readonly #core: CoreService
  readonly #assets: QQInboundAssetImporter

  constructor(core: CoreService, assets: QQInboundAssetImporter) {
    this.#core = core
    this.#assets = assets
  }

  ensureTarget(input: {
    readonly connectionId: ConnectionId
    readonly target: QQTarget
    readonly displayName?: string
    readonly observedAt: number
  }): Promise<ChannelId> {
    return Promise.resolve(
      this.#core.ensureChannel({
        connectionId: input.connectionId,
        platformChannelId: platformChannelId(input.target),
        kind: input.target.kind === 'c2c' ? 'direct' : 'group',
        ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
        observedAt: input.observedAt,
      }).id,
    )
  }

  ensureMember(input: {
    readonly connectionId: ConnectionId
    readonly channelId: ChannelId
    readonly openId: string
    readonly displayName?: string
    readonly observedAt: number
  }): Promise<ChannelMemberId> {
    return Promise.resolve(
      this.#core.observeChannelMember({
        connectionId: input.connectionId,
        channelId: input.channelId,
        platformUserId: input.openId,
        ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
        observedAt: input.observedAt,
      }).member.id,
    )
  }

  importAttachment(
    input: QQInboundAttachment & {
      readonly connectionId: ConnectionId
      readonly channelId: ChannelId
      readonly platformMessageId: string
      readonly receivedAt: number
      readonly attachmentIndex: number
      readonly signal: AbortSignal
    },
  ) {
    return this.#assets.import(input)
  }

  resolveQuote(input: {
    readonly connectionId: ConnectionId
    readonly target: QQTarget
    readonly platformReference: string
  }) {
    const channel = this.#core.getChannelByPlatformId(input.connectionId, platformChannelId(input.target))
    if (!channel) return Promise.resolve(undefined)
    const resolved = this.#core.resolvePlatformMessage(input.connectionId, channel.id, input.platformReference)
    return Promise.resolve(
      resolved ? { messageId: resolved.logicalMessageId, authoredByAgent: resolved.authoredByAgent } : undefined,
    )
  }

  resolveTarget(connectionId: ConnectionId, channelId: ChannelId): Promise<QQTarget | undefined> {
    const channel = this.#core.getChannel(channelId)
    if (!channel || channel.connectionId !== connectionId) return Promise.resolve(undefined)
    const separator = channel.platformChannelId.indexOf(':')
    const kind = channel.platformChannelId.slice(0, separator)
    const openId = channel.platformChannelId.slice(separator + 1)
    if ((kind !== 'c2c' && kind !== 'group') || !openId) return Promise.resolve(undefined)
    return Promise.resolve({ kind, openId })
  }

  resolveMemberOpenId(
    connectionId: ConnectionId,
    channelId: ChannelId,
    memberId: ChannelMemberId,
  ): Promise<string | undefined> {
    return Promise.resolve(this.#core.resolveChannelMemberIdentity(connectionId, channelId, memberId)?.platformUserId)
  }

  resolvePlatformMessageId(
    connectionId: ConnectionId,
    channelId: ChannelId,
    logicalMessageId: LogicalMessageId,
  ): Promise<string | undefined> {
    return Promise.resolve(this.#core.resolveLogicalMessagePlatformId(connectionId, channelId, logicalMessageId))
  }
}
