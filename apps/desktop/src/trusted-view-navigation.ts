interface NavigationEvent {
  preventDefault(): void
}

interface TrustedNavigationContents {
  readonly mainFrame: { readonly url: string }
  getURL(): string
  on(event: 'will-navigate' | 'will-redirect', listener: (event: NavigationEvent, target: string) => void): unknown
}

export interface TrustedOverlayIpcEvent {
  readonly sender: {
    readonly id: number
    readonly mainFrame: unknown
    getURL(): string
  }
  readonly senderFrame: { readonly url: string } | null
}

export const assertExactTrustedUrl = (actual: string, expected: string): void => {
  if (actual !== expected) throw new Error('可信 Desktop View 已离开预期页面。')
}

export const installExactTrustedNavigationGuard = (
  contents: TrustedNavigationContents,
  expectedUrl: () => string | undefined,
  actions: () => ReadonlyMap<string, () => void> = () => new Map(),
): void => {
  contents.on('will-navigate', (event, target) => {
    const expected = expectedUrl()
    const trustedSource =
      expected !== undefined && contents.getURL() === expected && contents.mainFrame.url === expected
    const action = trustedSource ? actions().get(target) : undefined
    if (action !== undefined) {
      event.preventDefault()
      action()
      return
    }
    if (!trustedSource || target !== expected) event.preventDefault()
  })
  contents.on('will-redirect', (event, target) => {
    const expected = expectedUrl()
    if (
      expected === undefined ||
      contents.getURL() !== expected ||
      contents.mainFrame.url !== expected ||
      target !== expected
    ) {
      event.preventDefault()
    }
  })
}

export interface TrustedLoadToken<Value> {
  readonly generation: number
  readonly value: Value
}

export class LatestTrustedLoad<Value> {
  #generation = 0
  #current: TrustedLoadToken<Value> | undefined

  get current(): TrustedLoadToken<Value> | undefined {
    return this.#current
  }

  begin(value: Value): TrustedLoadToken<Value> {
    const token = { generation: ++this.#generation, value }
    this.#current = token
    return token
  }

  isCurrent(token: TrustedLoadToken<Value>): boolean {
    return this.#current === token
  }

  clear(): void {
    this.#current = undefined
  }
}

export const runLatestTrustedLoadAction = <Value>(
  loads: LatestTrustedLoad<Value>,
  token: TrustedLoadToken<Value>,
  action: (value: Value) => void,
): boolean => {
  if (!loads.isCurrent(token)) return false
  action(token.value)
  return true
}

export type OverlayLoadDecision = 'send-open' | 'skip' | 'untrusted'

export class OverlayLoadRestoreGate {
  #documentGeneration = 0
  #intentGeneration = 0
  #lastSentKey: string | undefined

  beginDocument(): void {
    this.#documentGeneration += 1
  }

  updateIntent(): void {
    this.#intentGeneration += 1
  }

  decide(input: {
    readonly open: boolean
    readonly actualUrl: string
    readonly expectedUrl: string
  }): OverlayLoadDecision {
    if (input.actualUrl !== input.expectedUrl) return 'untrusted'
    if (!input.open) return 'skip'
    const key = `${this.#documentGeneration}:${this.#intentGeneration}`
    if (key === this.#lastSentKey) return 'skip'
    this.#lastSentKey = key
    return 'send-open'
  }
}

export const assertTrustedOverlayIpcEvent = (
  event: TrustedOverlayIpcEvent,
  expectedSenderId: number | undefined,
  expectedUrl: string,
): void => {
  if (
    expectedSenderId === undefined ||
    event.sender.id !== expectedSenderId ||
    event.senderFrame === null ||
    event.senderFrame !== event.sender.mainFrame ||
    event.senderFrame.url !== expectedUrl ||
    event.sender.getURL() !== expectedUrl
  ) {
    throw new Error('只有可信实例 Sheet 的顶层页面可以执行该操作。')
  }
}
