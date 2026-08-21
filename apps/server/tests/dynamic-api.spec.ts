import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { HostApiContracts } from '@nekro-nxt/contracts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NekroRuntime } from '../src/bootstrap.js'
import { createNekroHostApi } from '../src/host-api.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

class SettledModel extends LlmAdapter {
  override providerInfo(provider: string) {
    return { id: provider, name: 'settled model' }
  }
  override listModels(provider: string) {
    return Promise.resolve([{ provider, id: 'chat-model', name: 'chat', inputModalities: ['text'] as const }])
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
  override async *stream(_: GenerateOptions): AsyncIterable<StreamChunk> {
    await Promise.resolve()
    void _
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: '内部结束。' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '内部结束。' } }
    yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

describe('NekroNxt domain API — browser dynamic client circuit', () => {
  it('resolves a dynamic approval request through the API for the Agent live Session', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-dyn-api-'))
    temporaryDirectories.push(directory)
    const runtime = await NekroRuntime.create({
      coreDatabasePath: path.join(directory, 'core.sqlite'),
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      assetRoot: path.join(directory, 'assets'),
      extensionDataRoot: path.join(directory, 'extension-data'),
      extensionCacheRoot: path.join(directory, 'extension-cache'),
      configureLlm: (context) => {
        context.llm.registerAdapter(['test-provider'], new SettledModel())
      },
    })
    await runtime.start()

    const entity = await runtime.createAgentWithWebChannel({
      displayName: '创造智能体',
      persona: '',
      model: { provider: 'test-provider', model: 'chat-model' },
      capabilities: { dynamicCreation: true },
    })
    await runtime.web.postMessage({
      channelId: entity.channelId,
      clientEventId: 'seed-session',
      parts: [{ type: 'text', text: '建立活动会话。' }],
    })
    const episode = runtime.repository
      .listActiveEpisodesForAgent(entity.agentId)
      .find((candidate) => candidate.dshSessionId !== undefined)
    const dshSessionId = episode!.dshSessionId!
    const other = await runtime.createAgentWithWebChannel({
      displayName: '另一个创造智能体',
      persona: '',
      model: { provider: 'test-provider', model: 'chat-model' },
      capabilities: { dynamicCreation: true },
    })
    await runtime.web.postMessage({
      channelId: other.channelId,
      clientEventId: 'seed-other-session',
      parts: [{ type: 'text', text: '建立另一条活动会话。' }],
    })
    const otherEpisode = runtime.repository
      .listActiveEpisodesForAgent(other.agentId)
      .find((candidate) => candidate.dshSessionId !== undefined)!

    // Define + run a client-half dynamic Package → pending approval request.
    const defined = runtime.host.defineDynamicPackage(dshSessionId, {
      plugin: { kind: 'new', idPrefix: 'client' },
      name: '动态客户端',
      purpose: '验证浏览器审批。',
      code: {
        client: `return {
          inject: ['slots'],
          apply(ctx) {
            ctx.slots.register({ name: 'agent.workbench.sections', id: 'main' }, () => React.createElement('div'))
          }
        }`,
      },
    })
    const ran = runtime.host.runDynamicPackage(dshSessionId, defined.pluginId, defined.packageId, 'run')
    await Promise.resolve()
    const inventory = runtime.host.dynamicInventory(dshSessionId)
    const row = inventory.find((r) => r.pluginId === defined.pluginId)
    const approval = row?.latestRun?.approvalRequestId
    expect(approval).toBeDefined()
    // Drive the Host half (as the browser would via runDynamicHostHalf) to get a pluginRunId.
    const hostHalf = await runtime.host.runDynamicHostHalf(
      dshSessionId,
      defined.pluginId,
      defined.packageId,
      'run',
      approval!,
      false,
    )
    expect(hostHalf.ok).toBe(true)
    if (!hostHalf.ok) throw new Error(hostHalf.message)
    const pluginRunId = hostHalf.pluginRunId
    void ran

    // Expose the API and approve through it.
    const webContext = new Context()
    await webContext.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const api = createNekroHostApi(webContext.webServer, runtime)
    const origin = `http://127.0.0.1:${api.port}`
    try {
      const crossedEpisodeResponse = await fetch(`${origin}/api/dynamic/${entity.agentId}/inventory`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ episodeId: otherEpisode.id }),
      })
      expect(crossedEpisodeResponse.status).toBe(400)

      const inventoryResponse = await fetch(`${origin}/api/dynamic/${entity.agentId}/inventory`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ episodeId: episode!.id }),
      })
      expect(inventoryResponse.ok).toBe(true)
      expect(HostApiContracts.dynamicInventory.parseResponse(await inventoryResponse.json()).rows).toHaveLength(1)

      const approveResponse = await fetch(`${origin}/api/dynamic/${entity.agentId}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ episodeId: episode!.id, requestId: approval, pluginRunId }),
      })
      expect(approveResponse.ok).toBe(true)
      const ack = HostApiContracts.dynamicApprove.parseResponse(await approveResponse.json())
      expect(ack.accepted).toBe(true)

      const clientVerificationResponse = await fetch(
        `${origin}/api/dynamic/${entity.agentId}/report-client-verification`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            episodeId: episode!.id,
            pluginId: defined.pluginId,
            packageId: defined.packageId,
            pluginRunId,
            renderedSlots: ['agent.workbench.sections'],
          }),
        },
      )
      expect(clientVerificationResponse.ok).toBe(true)
      await expect(
        runtime.host.verifyDynamicPackage(dshSessionId, defined.pluginId, defined.packageId),
      ).resolves.toMatchObject({ renderedSlots: ['agent.workbench.sections'] })

      // The run resolves and client code is now available to load in the browser.
      const clientCode = runtime.host.getDynamicClientCode(dshSessionId, defined.pluginId, pluginRunId)
      expect(clientCode.code).toContain('apply')
    } finally {
      api.dispose()
      await webContext.fiber.dispose()
      await runtime.dispose()
    }
  })
})
