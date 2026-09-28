export interface HostReleaseState {
  readonly expected: string | undefined
  readonly actual: string | undefined
  readonly checking: boolean
  readonly mismatch: boolean
}

/** One document/API origin owns this guard; never compare Desktop's other instances. */
export class HostReleaseGuard {
  #state: HostReleaseState
  readonly #listeners = new Set<() => void>()
  #probe: Promise<void> | undefined

  constructor(expected?: string) {
    this.#state = { expected: expected || undefined, actual: undefined, checking: false, mismatch: false }
  }

  getSnapshot = (): HostReleaseState => this.#state
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  observe(releaseId: unknown): void {
    if (typeof releaseId !== 'string' || !releaseId.trim()) return
    const expected = this.#state.expected ?? releaseId
    this.#publish({
      expected,
      actual: releaseId,
      checking: false,
      mismatch: this.#state.mismatch || expected !== releaseId,
    })
  }

  reconnect(): void {
    if (!this.#state.expected || this.#state.mismatch) return
    this.#publish({ ...this.#state, checking: true })
  }

  rejectCurrentRelease(): void {
    this.#publish({ ...this.#state, checking: false, mismatch: true })
  }

  assertCompatible(): void {
    if (this.#state.mismatch) throw new Error('服务已升级，当前页面版本过旧。未发送此操作，请保留草稿后刷新页面。')
  }

  /** Probe before dispatch, so a disconnected old tab cannot submit to a new Host. */
  async beforeMutation(): Promise<void> {
    this.assertCompatible()
    if (!this.#state.expected) return
    this.#probe ??= this.#checkRelease().finally(() => {
      this.#probe = undefined
    })
    await this.#probe
    this.assertCompatible()
  }

  async #checkRelease(): Promise<void> {
    const response = await fetch('/health/live', { cache: 'no-store', signal: AbortSignal.timeout(5_000) })
    if (!response.ok) throw new Error('尚未确认服务版本，此操作未发送，请等待连接恢复。')
    const body: unknown = await response.json()
    if (
      body === null ||
      typeof body !== 'object' ||
      !('releaseId' in body) ||
      typeof body.releaseId !== 'string' ||
      !body.releaseId.trim()
    ) {
      throw new Error('服务版本信息无效，此操作未发送。')
    }
    this.observe(body.releaseId)
  }

  #publish(state: HostReleaseState): void {
    if (Object.keys(state).every((key) => Reflect.get(state, key) === Reflect.get(this.#state, key))) return
    this.#state = state
    for (const listener of this.#listeners) listener()
  }
}

// Build pipelines set the exact same Release ID as their Server. Development
// and older bundles learn a page-local baseline from their first snapshot.
export const hostReleaseGuard = new HostReleaseGuard(
  typeof __NEKRO_PRODUCT_RELEASE_ID__ === 'string' ? __NEKRO_PRODUCT_RELEASE_ID__ : undefined,
)
