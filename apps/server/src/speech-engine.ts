import { fork } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

/** What the engine recognizes with: a sherpa-onnx recognizer kind and its files. */
export interface SpeechEngineModel {
  readonly kind: 'paraformer' | 'sense-voice'
  readonly model: string
  readonly tokens: string
}

export interface SpeechEngineRequest {
  readonly model: SpeechEngineModel
  readonly vad: string
  /** 16 kHz mono 16-bit PCM WAV. */
  readonly wav: string
  /** `auto` or a language the model knows; Paraformer ignores it. */
  readonly language: string
}

export interface SpeechSegment {
  /** Seconds from the start of the audio. */
  readonly start: number
  readonly end: number
  readonly text: string
}

export interface SpeechEngineResult {
  readonly text: string
  readonly language?: string
  /** Speech found by the voice activity detector, at most 30 s each. */
  readonly segments: readonly SpeechSegment[]
}

/** The part of a child process the engine talks to; tests pass a fake. */
export interface SpeechEngineChild {
  send(message: unknown): boolean
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
  /** The last lines it printed, for the error when it dies. */
  output?(): string
}

const ReplySchema = z.union([
  z.object({ ready: z.literal(true) }),
  z.object({
    id: z.number(),
    result: z.object({
      text: z.string(),
      language: z.string().optional(),
      segments: z.array(z.object({ start: z.number(), end: z.number(), text: z.string() })),
      rssBytes: z.number().optional(),
    }),
  }),
  z.object({ id: z.number(), error: z.string() }),
])

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'speech-engine-worker.mjs')

/**
 * Starts the engine process with this server's own runtime: Node, or Electron running as Node (the server sets
 * `ELECTRON_RUN_AS_NODE` for its children). The IPC channel closes when the server dies, and the worker exits then.
 */
export const forkSpeechEngine = (runtimeDirectory: string): SpeechEngineChild => {
  const library = [runtimeDirectory, 'node_modules'].join(path.sep)
  const native = path.join(
    library,
    `sherpa-onnx-${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`,
  )
  const variable = process.platform === 'win32' ? 'PATH' : process.platform === 'darwin' ? undefined : 'LD_LIBRARY_PATH'
  const child = fork(WORKER, [runtimeDirectory], {
    execArgv: [],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: {
      ...process.env,
      ...(variable === undefined
        ? {}
        : { [variable]: [native, process.env[variable]].filter(Boolean).join(path.delimiter) }),
    },
  })
  let tail = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    tail = (tail + chunk.toString('utf8')).slice(-2000)
  })
  return Object.assign(child, { output: () => tail.trim().split('\n').slice(-3).join(' ') })
}

const abortReason = (signal: AbortSignal): Error =>
  signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError')

interface Pending {
  readonly id: number
  readonly resolve: (result: SpeechEngineResult) => void
  readonly reject: (error: unknown) => void
}

/**
 * The local engine process: started on first use, one request at a time, stopped after `idleMs` without requests
 * and started again on the next one. A request that is cancelled or runs out of time stops the process, since a
 * decode cannot be interrupted; one that crashes it fails and the next request starts a fresh process.
 */
export class SpeechEngine {
  readonly #start: () => SpeechEngineChild
  readonly #idleMs: number
  #child: SpeechEngineChild | undefined
  #loadedModel: string | undefined
  #pending: Pending | undefined
  #sequence = 0
  #tail: Promise<unknown> = Promise.resolve()
  #idleTimer: NodeJS.Timeout | undefined
  #disposed = false

  constructor(options: { readonly start: () => SpeechEngineChild; readonly idleMs?: number }) {
    this.#start = options.start
    this.#idleMs = options.idleMs ?? 5 * 60 * 1000
  }

  /** Whether a process is running now. */
  get running(): boolean {
    return this.#child !== undefined
  }

  run(
    request: SpeechEngineRequest,
    options: { readonly signal?: AbortSignal; readonly timeoutMs: number },
  ): Promise<SpeechEngineResult> {
    const signal = options.signal
    const job = this.#tail.then(() => this.#execute(request, options))
    this.#tail = job.catch(() => undefined)
    if (signal === undefined) return job
    // A request still waiting for its turn is given up at once and skipped when its turn comes.
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(abortReason(signal))
      signal.addEventListener('abort', onAbort, { once: true })
      job.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
    })
  }

  /** Stops the process; a request in progress fails. */
  stop(): void {
    clearTimeout(this.#idleTimer)
    const child = this.#child
    this.#child = undefined
    this.#loadedModel = undefined
    child?.kill('SIGKILL')
    const pending = this.#pending
    this.#pending = undefined
    pending?.reject(new Error('语音识别已停止。'))
  }

  dispose(): void {
    this.#disposed = true
    this.stop()
  }

  #spawn(): SpeechEngineChild {
    const child = this.#start()
    child.on('message', (raw) => {
      const message = ReplySchema.safeParse(raw)
      if (!message.success || 'ready' in message.data) return
      const pending = this.#pending
      if (pending === undefined || pending.id !== message.data.id) return
      this.#pending = undefined
      if ('error' in message.data) pending.reject(new Error(`语音识别出错：${message.data.error}`))
      else {
        const { text, language, segments } = message.data.result
        pending.resolve({ text, ...(language === undefined ? {} : { language }), segments })
      }
    })
    child.on('exit', (code, signal) => {
      if (this.#child !== child) return
      this.#child = undefined
      this.#loadedModel = undefined
      const pending = this.#pending
      this.#pending = undefined
      const detail = child.output?.() ?? ''
      pending?.reject(
        new Error(`语音识别意外中断（${signal ?? `退出码 ${code ?? '未知'}`}）${detail === '' ? '' : `：${detail}`}`),
      )
    })
    return child
  }

  async #execute(
    request: SpeechEngineRequest,
    options: { readonly signal?: AbortSignal; readonly timeoutMs: number },
  ): Promise<SpeechEngineResult> {
    const { signal } = options
    if (this.#disposed) throw new Error('语音识别已停止。')
    if (signal?.aborted) throw abortReason(signal)
    clearTimeout(this.#idleTimer)
    // One model at a time: switching releases the previous one with its process.
    if (this.#child !== undefined && this.#loadedModel !== request.model.model) this.stop()
    const child = (this.#child ??= this.#spawn())
    this.#loadedModel = request.model.model
    const id = ++this.#sequence
    try {
      return await new Promise<SpeechEngineResult>((resolve, reject) => {
        // A decode cannot be interrupted, so giving up on it stops the process.
        const giveUp = (reason: unknown) => {
          this.#pending = undefined
          this.stop()
          fail(reason)
        }
        const timer = setTimeout(() => giveUp(new Error('语音识别超时。')), options.timeoutMs)
        const onAbort = () => giveUp(abortReason(signal!))
        signal?.addEventListener('abort', onAbort, { once: true })
        const settle =
          <T>(done: (value: T) => void) =>
          (value: T) => {
            clearTimeout(timer)
            signal?.removeEventListener('abort', onAbort)
            done(value)
          }
        const fail = settle(reject)
        this.#pending = { id, resolve: settle(resolve), reject: fail }
        child.send({ id, ...request, threads: 2 })
      })
    } finally {
      this.#armIdle()
    }
  }

  #armIdle(): void {
    clearTimeout(this.#idleTimer)
    if (this.#child === undefined || this.#disposed) return
    this.#idleTimer = setTimeout(() => this.stop(), this.#idleMs)
    this.#idleTimer.unref()
  }
}
