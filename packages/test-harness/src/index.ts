import type {
  AdapterConnectionContext,
  AdapterConnectionRuntime,
  AdapterDeliveryReceipt,
  AdapterInboundEvent,
  AdapterOutboundCapabilities,
  PhysicalDeliveryRequest,
} from '@nekro-nxt/adapter-sdk'

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
