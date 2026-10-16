/** The parts of a Playwright browser the verifier uses. */
export interface VerifierBrowser {
  newPage(options: { readonly viewport: { readonly width: number; readonly height: number } }): Promise<{
    goto(url: string, options: { readonly waitUntil: 'domcontentloaded' }): Promise<unknown>
    waitForTimeout(ms: number): Promise<void>
    close(): Promise<void>
  }>
  close(): Promise<void>
}

/**
 * Takes creation candidates that may run without asking when no NekroNXT page does it (docs/NekroNxt界面交互模型.md
 * §7.2). An open page picks such a candidate up within a moment; one still waiting after `graceMs` is opened in the
 * headless browser, or, without one, run with its interface unchecked.
 */
export interface WaitingCandidate {
  readonly taskId: string
  /** When the task last changed; a candidate waiting longer than the grace period has no page taking care of it. */
  readonly updatedAt: number
}

export interface CandidateVerifierOptions {
  /** Tasks whose candidate waits to run and may go ahead without asking. */
  readonly waiting: () => readonly WaitingCandidate[]
  /** Whether the task has left waiting and running (it is ready, failed, stopped…). */
  readonly settled: (taskId: string) => boolean
  /** The address the headless browser opens; undefined while the web host is not up. */
  readonly origin: () => string | undefined
  readonly browser: { launch(): Promise<VerifierBrowser | undefined> }
  /** Runs the candidate without loading its interface. */
  readonly runWithoutClient: (taskId: string) => Promise<void>
  readonly log?: (message: string, error?: unknown) => void
  readonly now?: () => number
  readonly graceMs?: number
  readonly intervalMs?: number
  /** How long one candidate may take in the headless browser. */
  readonly visitMs?: number
  /** How long an idle browser stays open for the next candidate. */
  readonly idleMs?: number
}

export class CandidateVerifier {
  readonly #options: CandidateVerifierOptions
  #timer: ReturnType<typeof setInterval> | undefined
  #busy = false
  #browser: VerifierBrowser | undefined
  #idleTimer: ReturnType<typeof setTimeout> | undefined
  /** Tasks already handed to the headless browser or run without it, so one candidate is taken once. */
  readonly #taken = new Set<string>()

  constructor(options: CandidateVerifierOptions) {
    this.#options = options
  }

  start(): void {
    this.#timer ??= setInterval(() => void this.tick(), this.#options.intervalMs ?? 5_000)
    this.#timer.unref?.()
  }

  async dispose(): Promise<void> {
    if (this.#timer !== undefined) clearInterval(this.#timer)
    this.#timer = undefined
    await this.#closeBrowser()
  }

  /** One pass: takes the oldest candidate that no page has picked up. Exposed for tests. */
  async tick(): Promise<void> {
    if (this.#busy) return
    const now = (this.#options.now ?? Date.now)()
    const grace = this.#options.graceMs ?? 8_000
    const candidate = this.#options
      .waiting()
      .filter((item) => !this.#taken.has(`${item.taskId}:${item.updatedAt}`) && now - item.updatedAt >= grace)
      .sort((a, b) => a.updatedAt - b.updatedAt)[0]
    if (!candidate) return
    this.#busy = true
    this.#taken.add(`${candidate.taskId}:${candidate.updatedAt}`)
    try {
      const visited = await this.#visit(candidate.taskId)
      if (!visited) await this.#options.runWithoutClient(candidate.taskId)
    } catch (error) {
      this.#options.log?.('候选的后台验证没有完成', error)
    } finally {
      this.#busy = false
    }
  }

  /** Opens the task page in the headless browser and waits for the candidate to settle; false without a browser. */
  async #visit(taskId: string): Promise<boolean> {
    const origin = this.#options.origin()
    if (origin === undefined) return false
    this.#browser ??= await this.#options.browser.launch()
    const browser = this.#browser
    if (browser === undefined) return false
    if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer)
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await page.goto(`${origin}/workshop/tasks/${encodeURIComponent(taskId)}`, { waitUntil: 'domcontentloaded' })
      const deadline = (this.#options.now ?? Date.now)() + (this.#options.visitMs ?? 180_000)
      while (!this.#options.settled(taskId) && (this.#options.now ?? Date.now)() < deadline) {
        await page.waitForTimeout(1_000)
      }
    } finally {
      await page.close().catch(() => undefined)
      this.#idleTimer = setTimeout(() => void this.#closeBrowser(), this.#options.idleMs ?? 60_000)
      this.#idleTimer.unref?.()
    }
    return true
  }

  async #closeBrowser(): Promise<void> {
    if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer)
    this.#idleTimer = undefined
    const browser = this.#browser
    this.#browser = undefined
    await browser?.close().catch(() => undefined)
  }
}
