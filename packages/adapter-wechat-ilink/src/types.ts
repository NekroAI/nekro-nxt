import type { JsonValue } from '@nekro-nxt/contracts'

export const WECHAT_ILINK_ADAPTER_KEY = 'wechat-ilink'
export const WECHAT_ILINK_SYNC_BUF_STATE_KEY = 'syncBuf'
export const WECHAT_ILINK_CONTEXT_TOKEN_STATE_PREFIX = 'context-token:'

export interface WechatIlinkTextItem {
  readonly text?: string
}

export interface WechatIlinkCdnMedia {
  readonly encrypt_query_param?: string
  readonly aes_key?: string
  readonly encrypt_type?: number
}

export interface WechatIlinkImageItem {
  readonly media?: WechatIlinkCdnMedia
  readonly thumb_media?: WechatIlinkCdnMedia
  readonly aeskey?: string
  readonly url?: string
  readonly cdn_url?: string
  readonly download_url?: string
  readonly file_url?: string
  readonly thumb_url?: string
  readonly file_name?: string
  readonly name?: string
  readonly mime_type?: string
  readonly media_type?: string
  readonly content_type?: string
  readonly size?: number | string
  readonly mid_size?: number
  readonly thumb_size?: number
  readonly hd_size?: number
}

export interface WechatIlinkFileItem {
  readonly media?: WechatIlinkCdnMedia
  readonly file_name?: string
  readonly name?: string
  readonly md5?: string
  readonly len?: string
  readonly mime_type?: string
  readonly media_type?: string
  readonly content_type?: string
  readonly size?: number | string
  readonly url?: string
  readonly cdn_url?: string
  readonly download_url?: string
  readonly file_url?: string
}

export interface WechatIlinkMessageItem {
  readonly item_type?: number
  readonly type?: number
  readonly media?: WechatIlinkCdnMedia
  readonly text_item?: WechatIlinkTextItem
  readonly image_item?: WechatIlinkImageItem
  readonly file_item?: WechatIlinkFileItem
  readonly aeskey?: string
  readonly url?: string
  readonly cdn_url?: string
  readonly download_url?: string
  readonly file_url?: string
  readonly thumb_url?: string
  readonly file_name?: string
  readonly name?: string
  readonly md5?: string
  readonly len?: string
  readonly mime_type?: string
  readonly media_type?: string
  readonly content_type?: string
  readonly size?: number | string
}

export interface WechatIlinkMessage {
  readonly seq?: number
  readonly message_id?: string | number
  readonly from_user_id?: string
  readonly to_user_id?: string
  readonly client_id?: string
  readonly create_time_ms?: number
  readonly update_time_ms?: number
  readonly delete_time_ms?: number
  readonly session_id?: string
  readonly group_id?: string
  readonly message_type?: number
  readonly message_state?: number
  readonly item_list?: readonly WechatIlinkMessageItem[]
  readonly context_token?: string
}

export interface WechatIlinkTransportStartInput {
  readonly signal: AbortSignal
  readonly longPollTimeoutMs: number
  readonly loadSyncBuf: () => Promise<string | undefined>
  readonly saveSyncBuf: (syncBuf: string) => Promise<void>
  readonly onMessage: (message: WechatIlinkMessage) => Promise<void> | void
  readonly onError: (error: unknown) => void
  readonly onSessionExpired: () => void
}

export interface WechatIlinkTransportReceipt {
  readonly platformMessageId?: string
  readonly clientId?: string
}

export interface WechatIlinkDownloadedMedia {
  readonly data: Uint8Array
  readonly kind: 'image' | 'voice' | 'file' | 'video'
  readonly fileName?: string
}

export interface WechatIlinkTransport {
  start(input: WechatIlinkTransportStartInput): Promise<void>
  stop(): Promise<void>
  downloadMedia?(item: WechatIlinkMessageItem, signal: AbortSignal): Promise<WechatIlinkDownloadedMedia | null>
  sendText(input: {
    readonly toUserId: string
    readonly text: string
    readonly contextToken: string
    readonly signal: AbortSignal
  }): Promise<WechatIlinkTransportReceipt>
}

export interface WechatIlinkTransportConfig {
  readonly accountId: string
  readonly token: string
  readonly baseUrl: string
  readonly cdnBaseUrl: string
  readonly channelVersion?: string
  readonly routeTag?: string
}

export type WechatIlinkTransportFactory = (config: WechatIlinkTransportConfig) => WechatIlinkTransport

export type WechatIlinkQrCodeStatus = 'wait' | 'scaned' | 'confirmed' | 'expired'

export interface WechatIlinkLoginOptions {
  readonly timeoutMs?: number
  readonly botType?: string
  readonly maxRefreshes?: number
  readonly onQRCode?: (qrcodeUrl: string) => void | Promise<void>
  readonly onStatus?: (status: WechatIlinkQrCodeStatus) => void
  readonly signal?: AbortSignal
}

export interface WechatIlinkLoginResult {
  readonly connected: boolean
  readonly botToken?: string
  readonly accountId?: string
  readonly baseUrl?: string
  readonly userId?: string
  readonly message: string
}

export interface WechatIlinkLoginClient {
  login(options?: WechatIlinkLoginOptions): Promise<WechatIlinkLoginResult>
}

export type WechatIlinkLoginClientFactory = () => WechatIlinkLoginClient

export type WechatIlinkFailureKind = 'transient' | 'permanent' | 'rate-limited' | 'authentication' | 'invalid'

export interface WechatIlinkClassifiedError {
  readonly kind: WechatIlinkFailureKind
  readonly message: string
  readonly retryAfterMs?: number
  readonly details?: Readonly<Record<string, JsonValue>>
}
