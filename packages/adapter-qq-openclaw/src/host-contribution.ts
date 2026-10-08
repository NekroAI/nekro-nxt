import type {
  AdapterConnectionHostContext,
  AdapterHostContributionV2,
  AdapterRuntimeStateStore,
  AdapterTransportService,
} from '@nekro-nxt/adapter-sdk'
import type { ChannelId, ConnectionId } from '@nekro-nxt/contracts'
import {
  QQOpenClawConnectionConfigurationSchema,
  QQ_OPENCLAW_CONNECTION_DEFINITION,
  type QQIdentityDirectory,
  type QQInboundAttachment,
  type QQInboundBridge,
  type QQTarget,
} from './index.js'
import {
  createQQGatewayCheckpointStore,
  type QQGatewayClock,
  type QQGatewaySocket,
  type QQGatewaySocketFactory,
} from './gateway.js'
import { QQOpenClawHttpTransport } from './http.js'
import { QQOpenClawRuntime } from './runtime.js'

const platformChannelId = (target: QQTarget): string => `${target.kind}:${target.openId}`

const targetFromPlatformChannelId = (value: string): QQTarget | undefined => {
  const separator = value.indexOf(':')
  const kind = value.slice(0, separator)
  const openId = value.slice(separator + 1)
  return (kind === 'c2c' || kind === 'group') && openId ? { kind, openId } : undefined
}

const createDirectory = (context: AdapterConnectionHostContext): QQIdentityDirectory & QQInboundBridge => ({
  ensureTarget: (input) =>
    context.channels.ensure({
      platformChannelId: platformChannelId(input.target),
      kind: input.target.kind === 'c2c' ? 'direct' : 'group',
      ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
      observedAt: input.observedAt,
    }),
  ensureMember: (input) =>
    context.members.ensure({
      channelId: input.channelId,
      platformUserId: input.openId,
      ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
      observedAt: input.observedAt,
      ...(input.self === true ? { self: true } : {}),
    }),
  isSelfMember: (channelId, memberId) => context.members.isSelf(channelId, memberId),
  importAttachment: async (
    input: QQInboundAttachment & {
      readonly connectionId: ConnectionId
      readonly channelId: ChannelId
      readonly platformMessageId: string
      readonly receivedAt: number
      readonly attachmentIndex: number
      readonly signal: AbortSignal
    },
  ) => {
    const fetched = await context.assets.fetchRemoteBytes({ url: input.url, maxBytes: 20 * 1024 * 1024 })
    const imported = await context.assets.importBytes({
      bytes: fetched.bytes,
      ...((input.mediaType ?? fetched.declaredMediaType) === undefined
        ? {}
        : { declaredMediaType: input.mediaType ?? fetched.declaredMediaType }),
    })
    return {
      assetId: imported.assetId,
      mediaType: imported.mediaType,
      ...((input.fileName ?? fetched.filename) === undefined ? {} : { fileName: input.fileName ?? fetched.filename }),
    }
  },
  resolveQuote: async (input) => {
    const channelId = await context.channels
      .ensure({
        platformChannelId: platformChannelId(input.target),
        kind: input.target.kind === 'c2c' ? 'direct' : 'group',
        observedAt: context.now(),
      })
      .catch(() => undefined)
    if (!channelId) return undefined
    const resolved = await context.messages.resolvePlatformMessage(channelId, input.platformReference)
    return resolved ? { messageId: resolved.logicalMessageId, authoredByAgent: resolved.authoredByAgent } : undefined
  },
  resolveTarget: async (_connectionId, channelId) => {
    const value = await context.channels.resolvePlatformChannelId(channelId)
    return value === undefined ? undefined : targetFromPlatformChannelId(value)
  },
  resolveMemberOpenId: (_connectionId, channelId, memberId) =>
    context.members.resolvePlatformUserId(channelId, memberId),
  resolvePlatformMessageId: (_connectionId, channelId, logicalMessageId) =>
    context.messages.resolvePlatformMessageId(channelId, logicalMessageId),
})

const adapterFetch =
  (transport: AdapterTransportService): typeof fetch =>
  async (input, init) => {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    const body = init?.body
    if (body !== undefined && typeof body !== 'string' && !(body instanceof Uint8Array)) {
      throw new TypeError('Adapter transport only accepts string or byte request bodies.')
    }
    const response = await transport.request({
      url,
      method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
      headers: Object.fromEntries(headers.entries()),
      ...(body === undefined ? {} : { body }),
      ...(init?.signal == null ? {} : { signal: init.signal }),
    })
    return new Response(Uint8Array.from(response.body).buffer, {
      status: response.status,
      headers: response.headers,
    })
  }

class GatewayMessageQueue implements AsyncIterable<string> {
  readonly #values: string[] = []
  readonly #waiters: Array<{
    readonly resolve: (value: IteratorResult<string>) => void
    readonly reject: (error: Error) => void
  }> = []
  #ended = false
  #error: Error | undefined

  push(value: string): void {
    const waiter = this.#waiters.shift()
    if (waiter) waiter.resolve({ done: false, value })
    else if (!this.#ended) this.#values.push(value)
  }

  end(): void {
    this.#ended = true
    for (const waiter of this.#waiters.splice(0)) waiter.resolve({ done: true, value: undefined })
  }

  fail(error: Error): void {
    this.#error = error
    this.#ended = true
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error)
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: () => {
        const value = this.#values.shift()
        if (value !== undefined) return Promise.resolve({ done: false, value })
        if (this.#error) return Promise.reject(this.#error)
        if (this.#ended) return Promise.resolve({ done: true, value: undefined })
        return new Promise<IteratorResult<string>>((resolve, reject) => this.#waiters.push({ resolve, reject }))
      },
    }
  }
}

const gatewaySocket = async (
  transport: AdapterTransportService,
  url: string,
  signal: AbortSignal,
): Promise<QQGatewaySocket> => {
  const socket = await transport.connectWebSocket({ url, signal })
  const queue = new GatewayMessageQueue()
  let unsubscribe = (): void => undefined
  await new Promise<void>((resolve, reject) => {
    unsubscribe = socket.subscribe((event) => {
      if (event.type === 'open') resolve()
      else if (event.type === 'message') {
        const value = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data)
        queue.push(value)
      } else if (event.type === 'close') queue.end()
      else {
        const error = new Error(event.message)
        queue.fail(error)
        reject(error)
      }
    })
  })
  return {
    messages: queue,
    send: (payload) => socket.send(payload),
    close: async (code, reason) => {
      unsubscribe()
      await socket.close(code, reason)
      queue.end()
    },
  }
}

const socketFactory = (transport: AdapterTransportService): QQGatewaySocketFactory => ({
  connect: (url, signal) => gatewaySocket(transport, url, signal),
})

const systemGatewayClock = (): QQGatewayClock => ({
  now: Date.now,
  sleep: (delayMs, signal) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, delayMs)
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          reject(signal.reason instanceof Error ? signal.reason : new Error('Gateway sleep aborted.'))
        },
        { once: true },
      )
    }),
  setInterval: (callback, intervalMs) => {
    const timer = setInterval(callback, intervalMs)
    return () => clearInterval(timer)
  },
})

const scopedRuntimeState = (context: AdapterConnectionHostContext): AdapterRuntimeStateStore => ({
  load: (_connectionId, key) => context.state.load(key),
  save: (_connectionId, key, value) => context.state.save(key, value),
  clear: (_connectionId, key) => context.state.clear(key),
})

/** Complete host contribution. All protocol knowledge remains inside the Adapter package. */
export const createQQOpenClawHostContribution = (): AdapterHostContributionV2 => ({
  apiVersion: 2,
  descriptor: QQ_OPENCLAW_CONNECTION_DEFINITION.descriptor,
  create: (context, stored) => {
    const configuration = QQOpenClawConnectionConfigurationSchema.parse(stored.configuration)
    const credentialReference = stored.credentialRefs['clientSecret']
    if (!credentialReference) throw new Error('这个连接的凭据不可用。')
    const fetchImpl = adapterFetch(context.transport)
    const transport = new QQOpenClawHttpTransport({
      appId: configuration.appId,
      clientSecretCredentialRef: credentialReference,
      credentials: context.credentials,
      fetch: fetchImpl,
      now: context.now,
    })
    const directory = createDirectory(context)
    return Promise.resolve(
      new QQOpenClawRuntime({
        context,
        config: { ...configuration, clientSecretCredentialRef: credentialReference },
        directory,
        inbound: directory,
        assets: {
          read: async (assetId, channelId) => {
            const asset = await context.assets.read({ assetId, channelId })
            return { bytes: asset.bytes, mediaType: asset.mediaType }
          },
        },
        transport,
        onQuoteDiagnostic: (diagnostic) =>
          context.diagnostics.publish({
            status: 'connected',
            message: `引用未解析：${diagnostic.reason}`,
            credentialConfigured: true,
            proactiveSend: configuration.proactiveSend,
          }),
        gateway: {
          access: transport,
          sockets: socketFactory(context.transport),
          checkpoints: createQQGatewayCheckpointStore(context.connectionId, scopedRuntimeState(context)),
          clock: systemGatewayClock(),
          onStatus: (status) =>
            context.diagnostics.publish({
              status: status.state,
              ...(status.lastError === undefined ? {} : { message: status.lastError }),
              credentialConfigured: true,
              proactiveSend: configuration.proactiveSend,
              accountReference: configuration.appId,
            }),
        },
      }),
    )
  },
})
