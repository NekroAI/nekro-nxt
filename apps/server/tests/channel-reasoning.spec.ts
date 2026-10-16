import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ReasoningEffortId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { HostApiContracts } from '@nekro-nxt/contracts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { NekroRuntime } from '../src/bootstrap.js'
import { createNekroHostApi } from '../src/host-api.js'
import { readChannelReasoning } from '../src/channel-reasoning.js'

class ReasoningModel extends LlmAdapter {
  override providerInfo(provider: string) {
    return { id: provider, name: '合成思考模型供应商' }
  }
  override listModels(provider: string) {
    return Promise.resolve([
      { provider, id: 'reasoning', name: '合成思考模型' },
      { provider, id: 'text-only', name: '合成文本模型' },
    ])
  }
  override resolveModel(provider: string, model: string) {
    return Promise.resolve({
      provider,
      id: model,
      name: '合成思考模型',
      ...(model === 'text-only'
        ? {}
        : {
            reasoning: {
              efforts: ['low', 'high', 'max'].map((id) => ({ id: ReasoningEffortId(id), name: id })),
              defaultEffort: ReasoningEffortId('high'),
            },
          }),
    })
  }
  override async *stream(): AsyncIterable<StreamChunk> {
    await Promise.resolve()
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it('persists independent Chat budgets, validates exact model levels, and rejects stale edits', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nekro-reasoning-'))
  const options = {
    coreDatabasePath: path.join(directory, 'core.sqlite'),
    sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
    assetRoot: path.join(directory, 'assets'),
    extensionDataRoot: path.join(directory, 'extension-data'),
    extensionCacheRoot: path.join(directory, 'extension-cache'),
    configureLlm: (context: Context) => {
      context.llm.registerAdapter(['reasoning-fixture'], new ReasoningModel())
    },
  }
  const runtime = await NekroRuntime.create(options)
  const web = new Context()
  await web.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  const api = createNekroHostApi(web.webServer, runtime)
  const origin = `http://127.0.0.1:${api.port}`
  const call = (url: string, body?: unknown) =>
    fetch(
      origin + url,
      body === undefined
        ? {}
        : { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    )
  let firstChannel: ReturnType<typeof HostApiContracts.createAgent.parseResponse>['channelId'] | undefined
  try {
    const channels: string[] = []
    for (const model of ['reasoning', 'reasoning', 'text-only']) {
      const response = await fetch(origin + '/api/agents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          displayName: '合成预算智能体',
          persona: '',
          model: { provider: 'reasoning-fixture', model },
        }),
      })
      expect(response.ok, await response.clone().text()).toBe(true)
      // Read the created channel from the real snapshot; no model call is made.
      const snapshot = HostApiContracts.snapshot.parseResponse(await (await call('/api/snapshot')).json())
      const channel = snapshot.channels.find((candidate) => !channels.includes(candidate.id))!
      channels.push(channel.id)
    }
    firstChannel = HostApiContracts.getChannelReasoning.parseParams({ channelId: channels[0] }).channelId
    const url = `/api/channels/${firstChannel}/reasoning`
    const initial = HostApiContracts.getChannelReasoning.parseResponse(await (await call(url)).json())
    expect(initial).toMatchObject({ effort: null, effectiveEffort: 'high', revision: null })
    const input = { provider: initial.provider, model: initial.model, effort: 'max', expectedRevision: null }
    const saved = await call(url, input)
    expect(saved.ok).toBe(true)
    expect(await saved.json()).toMatchObject({ effort: 'max', effectiveEffort: 'max', revision: 1 })
    expect((await call(url, input)).status).toBe(409)
    expect((await call(url, { ...input, effort: 'unsupported', expectedRevision: 1 })).status).toBe(400)
    expect((await call(url, { ...input, model: 'different', expectedRevision: 1 })).status).toBe(409)
    expect(await (await call(url)).json()).toMatchObject({ effort: 'max', revision: 1 })
    expect(await (await call(`/api/channels/${channels[1]}/reasoning`)).json()).toMatchObject({
      effort: null,
      effectiveEffort: 'high',
    })
    expect(await (await call(`/api/channels/${channels[2]}/reasoning`)).json()).not.toHaveProperty('reasoning')
    expect((await call(`/api/channels/${channels[2]}/reasoning`, { ...input, model: 'text-only' })).status).toBe(400)
    expect(readChannelReasoning(runtime.repository, firstChannel, 'different-provider', 'reasoning').effort).toBe(null)
  } finally {
    api.dispose()
    await web.fiber.dispose()
    await runtime.dispose()
  }
  try {
    const reopened = await NekroRuntime.create(options)
    try {
      expect(readChannelReasoning(reopened.repository, firstChannel, 'reasoning-fixture', 'reasoning')).toEqual({
        effort: 'max',
        revision: 1,
      })
    } finally {
      await reopened.dispose()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
