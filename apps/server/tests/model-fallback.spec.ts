import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_MODEL_FALLBACK_SETTINGS } from '@nekro-nxt/contracts'
import { NekroRuntime } from '../src/bootstrap.js'
import {
  ModelRouteHealth,
  badRequestRetries,
  fallbackReasonOf,
  isRelayUnavailable,
  routeForRequest,
} from '../src/model-fallback.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const finishTurn = function* (id: string): Generator<StreamChunk> {
  const callId = ToolCallId(id)
  const argumentsText = JSON.stringify({ outcome: 'no-response-needed', reason: '测试。' })
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id: callId, name: 'finish_channel_turn', argumentsDelta: argumentsText }
  yield {
    type: 'block-end',
    index: 0,
    block: { type: 'tool-call', id: callId, name: 'finish_channel_turn', arguments: argumentsText },
  }
}

/** `main-model` fails with `failure` while it is down; `backup-model` always answers. */
class FlakyModel extends LlmAdapter {
  readonly requests: string[] = []
  failure: { readonly code: string; readonly message: string } | undefined = { code: 'QUOTA', message: '余额不足' }

  override providerInfo(provider: string) {
    return { id: provider, name: 'flaky model' }
  }
  override listModels(provider: string) {
    return Promise.resolve([
      { provider, id: 'main-model', name: 'main', inputModalities: ['text'] as const },
      { provider, id: 'backup-model', name: 'backup', inputModalities: ['text'] as const },
    ])
  }
  override resolveModel(provider: string, model: string) {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      inputModalities: ['text'] as const,
      context: { contextWindow: 128_000 },
    })
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    await Promise.resolve()
    this.requests.push(options.model)
    if (options.model === 'main-model' && this.failure !== undefined) {
      // A complete tool call before the failure: it must not run, since the attempt failed.
      yield* finishTurn(`failed-${this.requests.length}`)
      yield { type: 'finish', reason: { kind: 'error', failure: this.failure } }
      return
    }
    yield* finishTurn(`call-${this.requests.length}`)
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

const createRuntime = (directory: string, model: LlmAdapter) =>
  NekroRuntime.create({
    coreDatabasePath: path.join(directory, 'core.sqlite'),
    sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
    assetRoot: path.join(directory, 'assets'),
    extensionDataRoot: path.join(directory, 'extension-data'),
    extensionCacheRoot: path.join(directory, 'extension-cache'),
    developmentWorkspaceRoot: path.join(directory, 'workspaces'),
    configureLlm: (context) => {
      context.llm.registerAdapter(['test-provider'], model)
    },
  })

const start = async (model: FlakyModel, fallbackModels: readonly { provider: string; model: string }[]) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-model-fallback-'))
  temporaryDirectories.push(directory)
  const runtime = await createRuntime(directory, model)
  await runtime.start()
  const entity = await runtime.createAgentWithInternalChannel({
    displayName: '备用测试',
    persona: '',
    model: { provider: 'test-provider', model: 'main-model' },
    fallbackModels,
  })
  let sent = 0
  const say = async () => {
    sent += 1
    await runtime.internalChannel.postMessage({
      channelId: entity.channelId,
      clientEventId: `message-${sent}`,
      parts: [{ type: 'text', text: `第 ${sent} 条消息` }],
    })
    await vi.waitFor(() => expect(runtime.repository.listActiveEpisodesForAgent(entity.agentId)).toHaveLength(1))
    const sessionId = runtime.repository.listActiveEpisodesForAgent(entity.agentId)[0]!.dshSessionId!
    await vi.waitFor(() => expect(model.requests.length).toBeGreaterThan(0))
    await runtime.host.whenIdle(sessionId)
    return sessionId
  }
  return { runtime, entity, say }
}

describe('fallback models', () => {
  it('moves to the fallback when the quota runs out, stays there while the main model cools down, then goes back', async () => {
    const model = new FlakyModel()
    const { runtime, entity, say } = await start(model, [{ provider: 'test-provider', model: 'backup-model' }])
    try {
      const sessionId = await say()
      expect(model.requests).toEqual(['main-model', 'backup-model'])
      // The tool call of the failed attempt never ran; only the fallback's did.
      const results = runtime.host
        .normalizedSessionEvents(sessionId)
        .filter((event) => event.type === 'tool/result')
        .map((event) => JSON.stringify(event))
      expect(results.some((result) => result.includes('failed-1'))).toBe(false)
      expect(results.some((result) => result.includes('call-2'))).toBe(true)
      expect(runtime.host.modelFallbackOf(entity.channelId)).toMatchObject({
        model: { provider: 'test-provider', model: 'backup-model' },
        reason: 'quota',
      })

      // The main model is still cooling down: the next message goes straight to the fallback.
      model.requests.length = 0
      model.failure = undefined
      await say()
      expect(model.requests).toEqual(['backup-model'])

      // Once the cooldown is over, a new message goes back to the main model.
      model.requests.length = 0
      const later = Date.now() + DEFAULT_MODEL_FALLBACK_SETTINGS.quotaCooldownMinutes * 60_000 + 1000
      vi.spyOn(Date, 'now').mockReturnValue(later)
      await say()
      expect(model.requests).toEqual(['main-model'])
      expect(runtime.host.modelFallbackOf(entity.channelId)).toBeUndefined()
    } finally {
      vi.restoreAllMocks()
      await runtime.dispose()
    }
  }, 60_000)

  it('does not switch on a credential error, or without fallback models', async () => {
    const credential = new FlakyModel()
    credential.failure = { code: 'AUTH', message: 'API Key 无效' }
    const first = await start(credential, [{ provider: 'test-provider', model: 'backup-model' }])
    try {
      await first.say()
      expect(credential.requests).toEqual(['main-model'])
    } finally {
      await first.runtime.dispose()
    }

    const alone = new FlakyModel()
    const second = await start(alone, [])
    try {
      await second.say()
      expect(alone.requests).toEqual(['main-model'])
      expect(second.runtime.host.modelFallbackOf(second.entity.channelId)).toBeUndefined()
    } finally {
      await second.runtime.dispose()
    }
  }, 60_000)
})

describe('400 responses', () => {
  const relay400 = {
    code: 'INVALID_REQUEST',
    message:
      '400: {"code":"bad_response_status_code","message":"Provider API error: bad response status code 400","param":"400","type":"upstream_error"}',
  }

  it('retries a 400 the relay passed on from its upstream, then moves to the fallback', async () => {
    const model = new FlakyModel()
    model.failure = relay400
    const { runtime, entity, say } = await start(model, [{ provider: 'test-provider', model: 'backup-model' }])
    try {
      await say()
      expect(model.requests).toEqual([...Array<string>(6).fill('main-model'), 'backup-model'])
      expect(runtime.host.modelFallbackOf(entity.channelId)).toMatchObject({ reason: 'unavailable' })
    } finally {
      await runtime.dispose()
    }
  }, 60_000)

  it('tries any other 400 once more and does not switch on it', async () => {
    const model = new FlakyModel()
    model.failure = { code: 'INVALID_REQUEST', message: '400: {"error":{"message":"Invalid value for temperature"}}' }
    const { runtime, entity, say } = await start(model, [{ provider: 'test-provider', model: 'backup-model' }])
    try {
      await say()
      expect(model.requests).toEqual(['main-model', 'main-model'])
      expect(runtime.host.modelFallbackOf(entity.channelId)).toBeUndefined()
    } finally {
      await runtime.dispose()
    }
  }, 60_000)

  it('recovers when the relay answers again within the retries', async () => {
    const model = new FlakyModel()
    model.failure = relay400
    const stream = model.stream.bind(model)
    vi.spyOn(model, 'stream').mockImplementation((options) => {
      if (model.requests.length >= 2) model.failure = undefined
      return stream(options)
    })
    const { runtime, entity, say } = await start(model, [{ provider: 'test-provider', model: 'backup-model' }])
    try {
      await say()
      expect(model.requests).toEqual(['main-model', 'main-model', 'main-model'])
      expect(runtime.host.modelFallbackOf(entity.channelId)).toBeUndefined()
    } finally {
      await runtime.dispose()
    }
  }, 60_000)
})

describe('model route choice', () => {
  const main = { provider: 'p', model: 'main' }
  const backup = { provider: 'p', model: 'backup' }
  const spare = { provider: 'p', model: 'spare' }
  const chain = [main, backup, spare]

  const failure = (code: string, message = '') => ({ code, message })

  it('switches only for a used-up quota or a model that stayed unavailable', () => {
    expect(fallbackReasonOf(failure('QUOTA'))).toBe('quota')
    expect(fallbackReasonOf(failure('ACCOUNT_QUOTA'))).toBe('quota')
    expect(fallbackReasonOf(failure('RATE_LIMIT'))).toBe('rate-limit')
    for (const code of ['SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE']) {
      expect(fallbackReasonOf(failure(code))).toBe('unavailable')
    }
    for (const code of [
      'AUTH',
      'INVALID_CREDENTIAL',
      'CONTEXT_WINDOW_EXCEEDED',
      'INVALID_ARGS',
      'MALFORMED_RESPONSE',
      'INVALID_REQUEST',
    ]) {
      expect(fallbackReasonOf(failure(code))).toBeUndefined()
    }
  })

  // Bodies as one-hub and new-api sent them while their upstream account pool had nothing free (2026-11).
  const oneHub =
    '400: {"code":"bad_response_status_code","message":"Provider API error: bad response status code 400","param":"400","type":"upstream_error"}'
  const newApi =
    '400: {"error":{"message":"当前号池渠道暂时无可用资源，请稍后重试 (request id: 2026110614394653)","type":"new_api_error","param":"","code":"pool_channel_unavailable"}}'
  const badArgument = '400: {"error":{"message":"Invalid value for \'temperature\'","type":"invalid_request_error"}}'

  it('counts a 400 a relay passed on from an unavailable upstream as an unavailable model', () => {
    expect(isRelayUnavailable(failure('INVALID_REQUEST', oneHub))).toBe(true)
    expect(isRelayUnavailable(failure('INVALID_REQUEST', newApi))).toBe(true)
    expect(isRelayUnavailable(failure('INVALID_REQUEST', badArgument))).toBe(false)
    // Only a 400: the same words under another code keep that code's meaning.
    expect(isRelayUnavailable(failure('AUTH', oneHub))).toBe(false)
    expect(fallbackReasonOf(failure('INVALID_REQUEST', oneHub))).toBe('unavailable')
    expect(fallbackReasonOf(failure('INVALID_REQUEST', badArgument))).toBeUndefined()
  })

  it('retries a relay 400 like a server error and any other 400 once', () => {
    expect(badRequestRetries(failure('INVALID_REQUEST', newApi))).toBe(5)
    expect(badRequestRetries(failure('INVALID_REQUEST', badArgument))).toBe(1)
    expect(badRequestRetries(failure('SERVER', oneHub))).toBe(0)
  })

  it('stays on the current route mid-turn and goes back to the main model only when a turn starts', () => {
    const health = new ModelRouteHealth()
    health.markFailed(main, 'rate-limit', 1000)
    expect(routeForRequest({ chain, current: backup, startsTurn: true, health, now: 500 })).toEqual(backup)
    expect(routeForRequest({ chain, current: backup, startsTurn: false, health, now: 2000 })).toEqual(backup)
    expect(routeForRequest({ chain, current: backup, startsTurn: true, health, now: 2000 })).toEqual(main)
  })

  it('leaves a route that started cooling down, and keeps the current one when every route is cooling', () => {
    const health = new ModelRouteHealth()
    health.markFailed(main, 'quota', 1000)
    health.markFailed(backup, 'unavailable', 1000)
    expect(routeForRequest({ chain, current: backup, startsTurn: false, health, now: 500 })).toEqual(spare)
    health.markFailed(spare, 'unavailable', 1000)
    expect(routeForRequest({ chain, current: spare, startsTurn: true, health, now: 500 })).toEqual(spare)
  })
})
