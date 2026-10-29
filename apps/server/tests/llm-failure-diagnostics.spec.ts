import { Context } from '@deepseek-ai/cordis'
import {
  createUserMessage,
  LlmAdapter,
  LlmError,
  type GenerateOptions,
  type LlmProviderInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { causeChain, diagnosedLlmRuntime } from '../src/llm-failure-diagnostics.js'
import type { HostLogSink } from '../src/logs/service.js'

class FailingModel extends LlmAdapter {
  readonly #thrown: () => unknown
  readonly #before: StreamChunk[]
  constructor(thrown: () => unknown, before: StreamChunk[] = []) {
    super()
    this.#thrown = thrown
    this.#before = before
  }
  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: '示例模型' }
  }
  async *stream(): AsyncIterable<StreamChunk> {
    await Promise.resolve()
    for (const chunk of this.#before) yield chunk
    throw this.#thrown()
  }
}

const refused = () =>
  new LlmError('x', 'TRANSPORT', {
    cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' }),
  })

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.fiber.dispose()))
})

async function fixture(adapter: LlmAdapter, register: 'root' | 'plugin' = 'root') {
  const context = new Context()
  contexts.push(context)
  const write = vi.fn<HostLogSink['write']>()
  await context.plugin(
    diagnosedLlmRuntime({
      logs: { write, logger: vi.fn() },
      scopeOf: (sessionId) => ({ agentId: 'agent-demo', channelId: 'channel-demo', sessionId }),
    }),
  )
  if (register === 'root') context.llm.registerAdapter(['demo'], adapter)
  // Adapters DSH registers from the host profile come from their own plugin context.
  else
    await context.plugin({
      name: 'demo-adapter-plugin',
      inject: ['llm'],
      apply: (child: Context) => {
        child.llm.registerAdapter(['demo'], adapter)
      },
    })
  const run = async (options: Partial<GenerateOptions> = {}) => {
    const chunks: StreamChunk[] = []
    for await (const chunk of context.llm.stream({
      provider: 'demo',
      model: 'demo-model',
      messages: [createUserMessage({ content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } })],
      sessionId: SessionId('session-demo'),
      ...options,
    }))
      chunks.push(chunk)
    return chunks
  }
  return { context, write, run }
}

describe('model call failure causes', () => {
  it('logs the cause chain beside the model-call failure and leaves the failure unchanged', async () => {
    const { write, run } = await fixture(new FailingModel(refused))
    const chunks = await run()
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'TRANSPORT', message: 'x' } },
    })
    expect(write).toHaveBeenCalledOnce()
    expect(write.mock.calls[0]![0]).toEqual({
      level: 'error',
      message: '模型 demo/demo-model 收到响应前失败：Error ECONNREFUSED connect ECONNREFUSED 127.0.0.1:1',
      source: { kind: 'system', id: 'model-runtime', name: '模型调用' },
      scope: { agentId: 'agent-demo', channelId: 'channel-demo', sessionId: 'session-demo' },
      code: 'TRANSPORT',
      details: {
        provider: 'demo',
        model: 'demo-model',
        stage: 'request',
        errorName: 'LlmError',
        reason: 'x',
        causes: [{ name: 'Error', code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:1' }],
      },
    })
  })

  it('observes adapters registered from another plugin', async () => {
    const { write, run } = await fixture(new FailingModel(refused), 'plugin')
    await run()
    expect(write).toHaveBeenCalledOnce()
  })

  it('marks failures after the response began', async () => {
    const { write, run } = await fixture(new FailingModel(refused, [{ type: 'text-delta', index: 0, text: '你' }]))
    await run()
    expect(write.mock.calls[0]![0]).toMatchObject({ details: { stage: 'response' } })
  })

  it('skips errors without a cause and cancelled calls', async () => {
    const plain = await fixture(new FailingModel(() => new LlmError('rate limited', 'RATE_LIMIT')))
    await plain.run()
    expect(plain.write).not.toHaveBeenCalled()
    const controller = new AbortController()
    const cancelled = await fixture(
      new FailingModel(() => {
        controller.abort()
        return refused()
      }),
    )
    await cancelled.run({ signal: controller.signal })
    expect(cancelled.write).not.toHaveBeenCalled()
  })

  it('keeps three causes, steps into AggregateError and drops URL queries', () => {
    const inner = Object.assign(new Error('connect ETIMEDOUT model.example.invalid:443'), {
      code: 'ETIMEDOUT',
      errno: -60,
      syscall: 'connect',
    })
    const error = new LlmError('DeepSeek Messages transport failed', 'TRANSPORT', {
      cause: new TypeError('fetch to https://model.example.invalid/v1/messages?key=PRIVATE failed', {
        cause: new AggregateError([inner, new Error('second')], 'all attempts failed', {
          cause: undefined,
        }),
      }),
    })
    const deeper = new Error('level one', { cause: new Error('level two', { cause: error }) })
    expect(causeChain(error)).toEqual([
      { name: 'TypeError', message: 'fetch to https://model.example.invalid/v1/messages failed' },
      { name: 'AggregateError', message: 'all attempts failed' },
      {
        name: 'Error',
        code: 'ETIMEDOUT',
        errno: -60,
        syscall: 'connect',
        message: 'connect ETIMEDOUT model.example.invalid:443',
      },
    ])
    expect(causeChain(deeper)).toHaveLength(3)
    expect(JSON.stringify(causeChain(error))).not.toContain('PRIVATE')
  })
})
