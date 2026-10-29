import type { Context } from '@deepseek-ai/cordis'
import {
  LlmRuntime,
  type GenerateOptions,
  type LlmAdapter,
  type PreparedAdapterCall,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { HostLogScope } from '@nekro-nxt/contracts'
import { MODEL_RUNTIME_LOG_SOURCE } from './logs/session.js'
import type { HostLogSink } from './logs/service.js'

/** Where in one adapter call the error escaped. */
export type LlmFailureStage = 'prepare' | 'request' | 'response'

export interface LlmFailureDiagnostics {
  readonly logs: HostLogSink
  /** Scope of the session a call belongs to, so the entry groups with that session's model-call failure. */
  scopeOf(sessionId: string): HostLogScope | undefined
}

interface CauseLevel {
  name?: string
  code?: string
  errno?: string | number
  syscall?: string
  message?: string
}

const MAX_CAUSE_LEVELS = 3
const MAX_MESSAGE_CHARS = 500
const STAGE_LABELS: Record<LlmFailureStage, string> = {
  prepare: '读取模型信息时',
  request: '收到响应前',
  response: '接收响应时',
}

const readField = (value: object, key: string): unknown => {
  try {
    return Reflect.get(value, key)
  } catch {
    return undefined
  }
}

/** Messages can quote a request URL; drop query strings and fragments, which may carry keys. */
const safeMessage = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const stripped = value.replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s?#'"]+)[?#][^\s'"]*/giu, '$1')
  return stripped.length > MAX_MESSAGE_CHARS ? `${stripped.slice(0, MAX_MESSAGE_CHARS)}…` : stripped
}

const describeLevel = (value: unknown): CauseLevel => {
  if (value === null || typeof value !== 'object') return { message: safeMessage(String(value)) ?? '' }
  const name = readField(value, 'name')
  const code = readField(value, 'code')
  const errno = readField(value, 'errno')
  const syscall = readField(value, 'syscall')
  const message = safeMessage(readField(value, 'message'))
  return {
    ...(typeof name === 'string' && name.length > 0 ? { name } : {}),
    ...(typeof code === 'string' || typeof code === 'number' ? { code: String(code) } : {}),
    ...(typeof errno === 'string' || typeof errno === 'number' ? { errno } : {}),
    ...(typeof syscall === 'string' ? { syscall } : {}),
    ...(message === undefined ? {} : { message }),
  }
}

/** Follow `cause`, stepping into the first member of an AggregateError such as undici's connect failures. */
const nextCause = (value: unknown): unknown => {
  if (value === null || typeof value !== 'object') return undefined
  const cause = readField(value, 'cause')
  if (cause !== undefined) return cause
  const errors = readField(value, 'errors')
  return Array.isArray(errors) && errors.length > 0 ? errors[0] : undefined
}

/** Name, code and message of up to three underlying causes; never request bodies, headers or credentials. */
export function causeChain(error: unknown): CauseLevel[] {
  const levels: CauseLevel[] = []
  const seen = new Set<unknown>([error])
  let current = nextCause(error)
  while (current !== undefined && levels.length < MAX_CAUSE_LEVELS && !seen.has(current)) {
    seen.add(current)
    levels.push(describeLevel(current))
    current = nextCause(current)
  }
  return levels
}

const isAbort = (error: unknown, signal: AbortSignal | undefined): boolean => {
  if (signal?.aborted === true) return true
  if (error === null || typeof error !== 'object') return false
  const code = readField(error, 'code')
  return readField(error, 'name') === 'AbortError' || code === 'ABORTED'
}

const levelSummary = (level: CauseLevel): string =>
  [level.name, level.code ?? level.errno, level.message].filter((part) => part !== undefined && part !== '').join(' ')

function report(
  diagnostics: LlmFailureDiagnostics,
  error: unknown,
  call: { provider: string; model: string; sessionId?: string; purpose?: string },
  stage: LlmFailureStage,
): void {
  try {
    const causes = causeChain(error)
    if (causes.length === 0) return
    const top = describeLevel(error)
    const scope = call.sessionId === undefined ? undefined : diagnostics.scopeOf(call.sessionId)
    diagnostics.logs.write({
      level: 'error',
      message: `模型 ${call.provider}/${call.model} ${STAGE_LABELS[stage]}失败：${causes.map(levelSummary).join(' ← ')}`,
      source: MODEL_RUNTIME_LOG_SOURCE,
      ...(scope === undefined ? {} : { scope }),
      ...(top.code === undefined ? {} : { code: top.code }),
      details: {
        provider: call.provider,
        model: call.model,
        stage,
        ...(call.purpose === undefined ? {} : { purpose: call.purpose }),
        ...(top.name === undefined ? {} : { errorName: top.name }),
        ...(top.message === undefined ? {} : { reason: top.message }),
        causes,
      },
    })
  } catch {
    // Diagnostics never change how the call fails.
  }
}

const callFacts = (options: GenerateOptions) => ({
  provider: options.provider,
  model: options.model,
  ...(options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) }),
  ...(options.purpose === undefined ? {} : { purpose: options.purpose }),
})

async function* observeStream(
  diagnostics: LlmFailureDiagnostics,
  options: GenerateOptions,
  open: () => AsyncIterable<StreamChunk>,
): AsyncIterable<StreamChunk> {
  let started = false
  try {
    for await (const chunk of open()) {
      started = true
      yield chunk
    }
  } catch (error) {
    if (!isAbort(error, options.signal))
      report(diagnostics, error, callFacts(options), started ? 'response' : 'request')
    throw error
  }
}

const wrapped = new WeakMap<LlmAdapter, LlmAdapter>()

/**
 * Observe errors one adapter throws and log their causes, which the runtime's serialized failure drops.
 * The same adapter always maps to the same wrapper, so replay ownership checks keep matching.
 */
export function observeLlmAdapterFailures(adapter: LlmAdapter, diagnostics: LlmFailureDiagnostics): LlmAdapter {
  const existing = wrapped.get(adapter)
  if (existing !== undefined) return existing
  const stream = (options: GenerateOptions): AsyncIterable<StreamChunk> =>
    observeStream(diagnostics, options, () => adapter.stream(options))
  const prepareCall = async (provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> => {
    let call: PreparedAdapterCall
    try {
      call = await adapter.prepareCall(provider, model, signal)
    } catch (error) {
      if (!isAbort(error, signal)) report(diagnostics, error, { provider, model }, 'prepare')
      throw error
    }
    return {
      model: call.model,
      stream: (options) => observeStream(diagnostics, options, () => call.stream(options)),
    }
  }
  const proxy = new Proxy(adapter, {
    get(target, key) {
      if (key === 'stream') return stream
      if (key === 'prepareCall') return prepareCall
      const value: unknown = Reflect.get(target, key, target)
      // Adapters may keep #private state, which only resolves with the real instance as `this`.
      if (typeof value !== 'function') return value
      const bound: unknown = value.bind(target)
      return bound
    },
  })
  wrapped.set(adapter, proxy)
  return proxy
}

/** The DSH `llm` service, with every registered adapter (NXT's and the DSH profile's) observed for failure causes. */
export function diagnosedLlmRuntime(diagnostics: LlmFailureDiagnostics): typeof LlmRuntime {
  return class DiagnosedLlmRuntime extends LlmRuntime {
    constructor(ctx: Context) {
      super(ctx)
    }
    override registerAdapter(...[providers, adapter]: Parameters<LlmRuntime['registerAdapter']>) {
      return super.registerAdapter(providers, observeLlmAdapterFailures(adapter, diagnostics))
    }
  }
}
