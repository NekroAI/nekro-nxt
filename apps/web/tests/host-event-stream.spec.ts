import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HostEventStream } from '../src/host-event-stream.ts'

class StubEventSource {
  readonly listeners = new Map<string, Set<(event: Event) => void>>()
  readyState = 0
  closeCount = 0

  addEventListener(type: string, listener: (event: Event) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(listener)
  }

  close(): void {
    this.closeCount += 1
    this.readyState = 2
  }

  open(): void {
    this.readyState = 1
    this.emit('open')
  }

  fail(readyState: 0 | 2): void {
    this.readyState = readyState
    this.emit('error')
  }

  emit(type: string): void {
    const event = new Event(type)
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

class StubOnlineTarget {
  readonly listeners = new Set<() => void>()

  addEventListener(_type: 'online', listener: () => void): void {
    this.listeners.add(listener)
  }

  removeEventListener(_type: 'online', listener: () => void): void {
    this.listeners.delete(listener)
  }

  online(): void {
    for (const listener of this.listeners) listener()
  }
}

describe('HostEventStream', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('recreates permanently closed EventSources with bounded backoff and resets after open', () => {
    const sources: StubEventSource[] = []
    const errors: unknown[] = []
    const opens: unknown[] = []
    const stream = new HostEventStream({
      createEventSource: () => {
        const source = new StubEventSource()
        sources.push(source)
        return source
      },
      reconnectDelaysMs: [100, 200, 400],
      nativeReconnectGraceMs: 500,
      onlineTarget: null,
    })
    const unsubscribe = stream.subscribe({
      error: (event) => errors.push(event),
      open: (event) => opens.push(event),
    })

    expect(sources).toHaveLength(1)
    sources[0]!.fail(2)
    expect(errors).toHaveLength(1)
    vi.advanceTimersByTime(99)
    expect(sources).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(sources).toHaveLength(2)

    sources[1]!.fail(2)
    vi.advanceTimersByTime(199)
    expect(sources).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(sources).toHaveLength(3)

    sources[2]!.open()
    expect(opens).toHaveLength(1)
    sources[2]!.fail(2)
    vi.advanceTimersByTime(100)
    expect(sources).toHaveLength(4)

    unsubscribe()
    expect(sources[3]!.closeCount).toBe(1)
  })

  it('gives native EventSource retry time to preserve Last-Event-ID', () => {
    const sources: StubEventSource[] = []
    const stream = new HostEventStream({
      createEventSource: () => {
        const source = new StubEventSource()
        sources.push(source)
        return source
      },
      reconnectDelaysMs: [100],
      nativeReconnectGraceMs: 500,
      onlineTarget: null,
    })
    const unsubscribe = stream.subscribe({ error: () => undefined })

    sources[0]!.fail(0)
    vi.advanceTimersByTime(499)
    expect(sources).toHaveLength(1)
    sources[0]!.open()
    vi.advanceTimersByTime(1_000)
    expect(sources).toHaveLength(1)
    expect(sources[0]!.closeCount).toBe(0)

    unsubscribe()
  })

  it('reconnects immediately for manual retry and browser online recovery', () => {
    const sources: StubEventSource[] = []
    const onlineTarget = new StubOnlineTarget()
    const stream = new HostEventStream({
      createEventSource: () => {
        const source = new StubEventSource()
        sources.push(source)
        return source
      },
      reconnectDelaysMs: [100],
      onlineTarget,
    })
    const unsubscribe = stream.subscribe({ open: () => undefined })
    const unsubscribeSecond = stream.subscribe({ error: () => undefined })

    expect(sources).toHaveLength(1)

    stream.reconnectNow()
    expect(sources).toHaveLength(2)
    expect(sources[0]!.closeCount).toBe(1)

    onlineTarget.online()
    expect(sources).toHaveLength(3)
    expect(sources[1]!.closeCount).toBe(1)

    unsubscribe()
    expect(onlineTarget.listeners.size).toBe(1)
    expect(sources[2]!.closeCount).toBe(0)
    unsubscribeSecond()
    expect(onlineTarget.listeners.size).toBe(0)
    expect(sources[2]!.closeCount).toBe(1)
  })
})
