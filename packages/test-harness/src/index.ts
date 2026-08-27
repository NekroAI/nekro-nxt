import type {
  AdapterConnectionContext,
  AdapterConnectionDiagnostic,
  AdapterConnectionHostContext,
  AdapterConnectionRuntime,
  AdapterDeliveryReceipt,
  AdapterInboundEvent,
  AdapterOutboundCapabilities,
  AdapterHttpRequest,
  AdapterHttpResponse,
  AdapterTransportService,
  AdapterWebSocketConnection,
  AdapterWebSocketEvent,
  PhysicalDeliveryRequest,
} from '@nekro-nxt/adapter-sdk'
import {
  AssetIdSchema,
  ChannelEventIdSchema,
  ChannelIdSchema,
  ChannelMemberIdSchema,
  ConnectionIdSchema,
  type JsonValue,
} from '@nekro-nxt/contracts'

export class FakeAdapterWebSocket implements AdapterWebSocketConnection {
  readonly sent: Array<string | Uint8Array> = []
  readonly #listeners = new Set<(event: AdapterWebSocketEvent) => void>()
  closed = false

  send(data: string | Uint8Array): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Fake WebSocket is closed.'))
    this.sent.push(typeof data === 'string' ? data : new Uint8Array(data))
    return Promise.resolve()
  }

  close(code = 1000, reason = ''): Promise<void> {
    if (this.closed) return Promise.resolve()
    this.closed = true
    this.emit({ type: 'close', code, reason })
    return Promise.resolve()
  }

  subscribe(listener: (event: AdapterWebSocketEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  emit(event: AdapterWebSocketEvent): void {
    for (const listener of this.#listeners) listener(event)
  }

  listenerCount(): number {
    return this.#listeners.size
  }
}

/** No-network transport used by Adapter tests and generated-Revision validation. */
export class FakeAdapterTransport implements AdapterTransportService {
  readonly requests: AdapterHttpRequest[] = []
  readonly sockets: FakeAdapterWebSocket[] = []
  readonly #responses: AdapterHttpResponse[] = []

  queueResponse(response: AdapterHttpResponse): void {
    this.#responses.push(response)
  }

  request(input: AdapterHttpRequest): Promise<AdapterHttpResponse> {
    this.requests.push({
      ...input,
      ...(input.body instanceof Uint8Array ? { body: new Uint8Array(input.body) } : {}),
    })
    return Promise.resolve(this.#responses.shift() ?? { status: 200, headers: {}, body: new Uint8Array() })
  }

  connectWebSocket(): Promise<AdapterWebSocketConnection> {
    const socket = new FakeAdapterWebSocket()
    this.sockets.push(socket)
    return Promise.resolve(socket)
  }

  assertIdle(): void {
    const active = this.sockets.filter((socket) => !socket.closed || socket.listenerCount() > 0)
    if (active.length > 0) throw new Error(`Fake Adapter Transport still owns ${active.length} active socket(s).`)
  }
}

/** Complete in-memory Host context for generated Adapter lifecycle tests. */
export const createFakeAdapterHostContext = (clock = new VirtualClock(1)) => {
  const transport = new FakeAdapterTransport()
  const events: AdapterInboundEvent[] = []
  const diagnostics: AdapterConnectionDiagnostic[] = []
  const channels = new Map<string, ReturnType<typeof ChannelIdSchema.parse>>()
  const channelKinds = new Map<string, 'direct' | 'group'>()
  const members = new Map<string, ReturnType<typeof ChannelMemberIdSchema.parse>>()
  const states = new Map<string, JsonValue>()
  const credentials = new Map<string, string>()
  let channelSequence = 0
  let memberSequence = 0
  const context: AdapterConnectionHostContext = {
    connectionId: ConnectionIdSchema.parse('con_HARNESS'),
    now: () => clock.now(),
    acceptInbound: (event) => {
      events.push(structuredClone(event))
      return Promise.resolve({
        channelEventId: ChannelEventIdSchema.parse(`evt_HARNESS${events.length}`),
        inserted: true,
      })
    },
    channels: {
      ensure: (input) => {
        const existing = channels.get(input.platformChannelId)
        if (existing) return Promise.resolve(existing)
        const channelId = ChannelIdSchema.parse(`chn_HARNESS${++channelSequence}`)
        channels.set(input.platformChannelId, channelId)
        channelKinds.set(channelId, input.kind)
        return Promise.resolve(channelId)
      },
      updateDisplayName: () => Promise.resolve(),
      resolvePlatformChannelId: (channelId) =>
        Promise.resolve([...channels].find(([, candidate]) => candidate === channelId)?.[0]),
      resolveKind: (channelId) => Promise.resolve(channelKinds.get(channelId)),
    },
    members: {
      ensure: (input) => {
        const key = `${input.channelId}:${input.platformUserId}`
        const existing = members.get(key)
        if (existing) return Promise.resolve(existing)
        const memberId = ChannelMemberIdSchema.parse(`mbr_HARNESS${++memberSequence}`)
        members.set(key, memberId)
        return Promise.resolve(memberId)
      },
      resolvePlatformUserId: (channelId, memberId) =>
        Promise.resolve(
          [...members]
            .find(([key, candidate]) => key.startsWith(`${channelId}:`) && candidate === memberId)?.[0]
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
      importBytes: ({ bytes, declaredMediaType }) =>
        Promise.resolve({
          assetId: AssetIdSchema.parse('ast_HARNESS'),
          mediaType: declaredMediaType ?? 'application/octet-stream',
          byteSize: bytes.byteLength,
        }),
      read: () => Promise.resolve({ bytes: new Uint8Array([1]), mediaType: 'application/octet-stream', byteSize: 1 }),
      fetchRemoteBytes: () =>
        Promise.resolve({ bytes: new Uint8Array([1]), declaredMediaType: 'application/octet-stream' }),
    },
    credentials: {
      resolve: (reference) => {
        const value = credentials.get(reference)
        if (value === undefined) return Promise.reject(new Error(`Unknown Fake credential reference: ${reference}`))
        return Promise.resolve(value)
      },
    },
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
    diagnostics: { publish: (diagnostic) => diagnostics.push(structuredClone(diagnostic)) },
    transport,
  }
  return {
    context,
    clock,
    transport,
    events,
    diagnostics,
    channels,
    members,
    credentials,
    states,
    assertIdle: () => {
      transport.assertIdle()
      if (clock.pendingCount() > 0) throw new Error(`Fake Adapter Host still owns ${clock.pendingCount()} timer(s).`)
    },
  }
}

interface ScheduledTask {
  readonly id: number
  readonly at: number
  readonly callback: () => void
  cancelled: boolean
}

/** A deterministic clock that runs scheduled callbacks in time and registration order. */
export class VirtualClock {
  #now: number
  #nextId = 1
  readonly #tasks: ScheduledTask[] = []

  constructor(start = 0) {
    if (!Number.isFinite(start)) throw new TypeError('Virtual clock start must be finite.')
    this.#now = start
  }

  now(): number {
    return this.#now
  }

  setTimeout(callback: () => void, delay: number): () => void {
    if (!Number.isFinite(delay) || delay < 0) throw new TypeError('Virtual clock delay must be non-negative.')
    const task: ScheduledTask = { id: this.#nextId, at: this.#now + delay, callback, cancelled: false }
    this.#nextId += 1
    this.#tasks.push(task)
    return () => {
      task.cancelled = true
    }
  }

  advanceBy(duration: number): void {
    if (!Number.isFinite(duration) || duration < 0) throw new TypeError('Advance duration must be non-negative.')
    const target = this.#now + duration
    while (true) {
      const next = this.#tasks
        .filter((task) => !task.cancelled && task.at <= target)
        .sort((left, right) => left.at - right.at || left.id - right.id)[0]
      if (!next) break
      next.cancelled = true
      this.#now = next.at
      next.callback()
    }
    this.#now = target
  }

  pendingCount(): number {
    return this.#tasks.filter((task) => !task.cancelled).length
  }
}

export const FAKE_ADAPTER_CAPABILITIES: AdapterOutboundCapabilities = {
  text: true,
  mentions: true,
  images: true,
  files: true,
  audio: true,
  replies: true,
  mixedContent: true,
  proactiveSend: true,
}

/** Deterministic Adapter double implementing the same lifecycle and receipts as production adapters. */
export class FakeAdapterConnection implements AdapterConnectionRuntime {
  readonly capabilities: AdapterOutboundCapabilities
  readonly deliveries: PhysicalDeliveryRequest[] = []
  readonly #context: AdapterConnectionContext
  readonly #receipts: AdapterDeliveryReceipt[] = []
  #running = false

  constructor(context: AdapterConnectionContext, capabilities = FAKE_ADAPTER_CAPABILITIES) {
    this.#context = context
    this.capabilities = capabilities
  }

  start(): Promise<void> {
    if (this.#running) return Promise.reject(new Error('Fake adapter connection is already running.'))
    this.#running = true
    return Promise.resolve()
  }

  stop(): Promise<void> {
    this.#running = false
    return Promise.resolve()
  }

  queueReceipt(receipt: AdapterDeliveryReceipt): void {
    this.#receipts.push(receipt)
  }

  receive(event: AdapterInboundEvent) {
    if (!this.#running) return Promise.reject(new Error('Fake adapter connection is not running.'))
    return this.#context.acceptInbound(event)
  }

  deliver(request: PhysicalDeliveryRequest, signal: AbortSignal): Promise<AdapterDeliveryReceipt> {
    if (!this.#running) return Promise.reject(new Error('Fake adapter connection is not running.'))
    if (signal.aborted) {
      return Promise.resolve({ status: 'failed', failure: { kind: 'transient', message: 'Delivery aborted.' } })
    }
    this.deliveries.push(structuredClone(request))
    return Promise.resolve(
      this.#receipts.shift() ?? {
        status: 'sent',
        platformMessageId: `fake-message-${this.deliveries.length}`,
      },
    )
  }
}

interface ScenarioAction {
  readonly id: number
  readonly at: number
  readonly label: string
  readonly run: () => Promise<void> | void
}

/** Runs asynchronous scenario actions in virtual time and stable registration order. */
export class ScenarioDriver {
  readonly #clock: VirtualClock
  readonly #actions: ScenarioAction[] = []
  #nextId = 1

  constructor(clock = new VirtualClock()) {
    this.#clock = clock
  }

  schedule(at: number, label: string, run: () => Promise<void> | void): void {
    if (!Number.isFinite(at) || at < this.#clock.now()) throw new TypeError('Scenario time must not precede now.')
    this.#actions.push({ id: this.#nextId, at, label, run })
    this.#nextId += 1
  }

  async run(): Promise<string[]> {
    const completed: string[] = []
    for (const action of this.#actions.sort((left, right) => left.at - right.at || left.id - right.id)) {
      this.#clock.advanceBy(action.at - this.#clock.now())
      await action.run()
      completed.push(action.label)
    }
    this.#actions.length = 0
    return completed
  }
}
