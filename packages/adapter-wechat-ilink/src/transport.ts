import type {
  WechatIlinkLoginClient,
  WechatIlinkLoginClientFactory,
  WechatIlinkDownloadedMedia,
  WechatIlinkMessage,
  WechatIlinkMessageItem,
  WechatIlinkTransport,
  WechatIlinkTransportConfig,
  WechatIlinkTransportFactory,
  WechatIlinkTransportReceipt,
  WechatIlinkTransportStartInput,
} from './types.js'

interface WechatIlinkSdkClient {
  on(event: 'message', handler: (message: WechatIlinkMessage) => void | Promise<void>): void
  on(event: 'error', handler: (error: unknown) => void): void
  on(event: 'sessionExpired', handler: () => void): void
  start(input: {
    readonly longPollTimeoutMs: number
    readonly signal: AbortSignal
    readonly loadSyncBuf: () => Promise<string | undefined>
    readonly saveSyncBuf: (syncBuf: string) => Promise<void>
  }): Promise<void>
  stop?(): Promise<void> | void
  downloadMedia?(
    item: WechatIlinkMessageItem,
    signal?: AbortSignal,
    options?: { readonly maxBytes?: number },
  ): Promise<WechatIlinkDownloadedMedia | null>
  sendText(toUserId: string, text: string, contextToken: string, signal?: AbortSignal): Promise<unknown>
}

const WECHAT_ILINK_MAX_INBOUND_MEDIA_BYTES = 20 * 1024 * 1024
const WECHAT_ILINK_MEDIA_DOWNLOAD_TIMEOUT_MS = 30_000

const abortReason = (signal: AbortSignal): Error =>
  signal.reason instanceof Error ? signal.reason : new Error('Operation was aborted.')

const waitForPromiseOrAbort = async (promise: Promise<void>, signal: AbortSignal): Promise<void> => {
  if (signal.aborted) throw signal.reason
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortReason(signal))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    await Promise.race([promise, aborted])
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

type WechatIlinkSdkModule = {
  readonly WeChatClient: new (config: WechatIlinkTransportConfig) => WechatIlinkSdkClient
}

type WechatIlinkSdkLoginModule = {
  readonly WeChatClient: new () => WechatIlinkLoginClient
}

const isReceipt = (value: unknown): value is WechatIlinkTransportReceipt =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const receiptFromSdk = (value: unknown): WechatIlinkTransportReceipt => {
  if (typeof value === 'string' && value.trim()) return { clientId: value }
  if (!isReceipt(value)) return {}
  const platformMessageId =
    typeof value.platformMessageId === 'string' && value.platformMessageId.trim() ? value.platformMessageId : undefined
  const clientId = typeof value.clientId === 'string' && value.clientId.trim() ? value.clientId : undefined
  return {
    ...(platformMessageId === undefined ? {} : { platformMessageId }),
    ...(clientId === undefined ? {} : { clientId }),
  }
}

export class WechatIlinkSdkTransport implements WechatIlinkTransport {
  readonly #client: WechatIlinkSdkClient
  readonly #inflightInboundTasks = new Set<Promise<void>>()
  #startTask: Promise<void> | undefined
  #downloadQueue: Promise<void> = Promise.resolve()

  constructor(client: WechatIlinkSdkClient) {
    this.#client = client
  }

  async start(input: WechatIlinkTransportStartInput): Promise<void> {
    this.#client.on('message', (message) => {
      const task = Promise.resolve(input.onMessage(message))
      this.#inflightInboundTasks.add(task)
      void task.then(
        () => this.#inflightInboundTasks.delete(task),
        () => this.#inflightInboundTasks.delete(task),
      )
      return task
    })
    this.#client.on('error', input.onError)
    this.#client.on('sessionExpired', input.onSessionExpired)
    this.#startTask = this.#client
      .start({
        longPollTimeoutMs: input.longPollTimeoutMs,
        signal: input.signal,
        loadSyncBuf: input.loadSyncBuf,
        saveSyncBuf: input.saveSyncBuf,
      })
      .catch((error: unknown) => {
        if (!input.signal.aborted) input.onError(error)
      })
    await Promise.resolve()
  }

  async stop(): Promise<void> {
    let stopFailure: unknown
    try {
      await this.#client.stop?.()
    } catch (error) {
      stopFailure = error
    }
    if (this.#startTask) await Promise.allSettled([this.#startTask])
    while (this.#inflightInboundTasks.size > 0) {
      await Promise.allSettled([...this.#inflightInboundTasks])
    }
    if (stopFailure !== undefined) {
      throw stopFailure instanceof Error ? stopFailure : new Error('微信 iLink SDK 停止失败。')
    }
  }

  async downloadMedia(item: WechatIlinkMessageItem, signal: AbortSignal): Promise<WechatIlinkDownloadedMedia | null> {
    let releaseDownloadSlot: (() => void) | undefined
    const downloadSlot = new Promise<void>((resolve) => {
      releaseDownloadSlot = resolve
    })
    const precedingDownloads = this.#downloadQueue.catch(() => undefined)
    this.#downloadQueue = precedingDownloads.then(() => downloadSlot)

    try {
      await waitForPromiseOrAbort(precedingDownloads, signal)
    } catch (error) {
      releaseDownloadSlot?.()
      throw error
    }

    const timeoutController = new AbortController()
    const timeout = setTimeout(
      () => timeoutController.abort(new Error('微信 iLink 媒体下载超时。')),
      WECHAT_ILINK_MEDIA_DOWNLOAD_TIMEOUT_MS,
    )
    timeout.unref?.()
    const downloadSignal = AbortSignal.any([signal, timeoutController.signal])
    try {
      if (downloadSignal.aborted) throw downloadSignal.reason
      const media = await this.#client.downloadMedia?.(item, downloadSignal, {
        maxBytes: WECHAT_ILINK_MAX_INBOUND_MEDIA_BYTES,
      })
      if (downloadSignal.aborted) throw downloadSignal.reason
      return media ?? null
    } finally {
      clearTimeout(timeout)
      releaseDownloadSlot?.()
    }
  }

  async sendText(input: {
    readonly toUserId: string
    readonly text: string
    readonly contextToken: string
    readonly signal: AbortSignal
  }): Promise<WechatIlinkTransportReceipt> {
    if (input.signal.aborted) throw input.signal.reason
    const receipt = await this.#client.sendText(input.toUserId, input.text, input.contextToken, input.signal)
    if (input.signal.aborted) throw input.signal.reason
    return receiptFromSdk(receipt)
  }
}

export const createWechatIlinkSdkTransportFactory = (): WechatIlinkTransportFactory => (config) => {
  let transport: WechatIlinkTransport | undefined
  return {
    async start(input) {
      const module = (await import('wechat-ilink-client')) as WechatIlinkSdkModule
      transport = new WechatIlinkSdkTransport(new module.WeChatClient(config))
      await transport.start(input)
    },
    async stop() {
      await transport?.stop()
    },
    async sendText(input) {
      if (!transport) throw new Error('微信 iLink 连接尚未启动。')
      return transport.sendText(input)
    },
    async downloadMedia(item, signal) {
      if (!transport) throw new Error('微信 iLink 连接尚未启动。')
      return (await transport.downloadMedia?.(item, signal)) ?? null
    },
  }
}

export const createWechatIlinkSdkLoginClientFactory = (): WechatIlinkLoginClientFactory => () => ({
  async login(options) {
    const module = (await import('wechat-ilink-client')) as WechatIlinkSdkLoginModule
    const client = new module.WeChatClient()
    return await client.login(options)
  },
})
