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

class QuietModel extends LlmAdapter {
  override providerInfo(provider: string) {
    return { id: provider, name: 'quiet model' }
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
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    await Promise.resolve()
    void options
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: '内部结束。' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '内部结束。' } }
    yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

describe('NekroNxt domain API — save a running dynamic Package as a local Extension', () => {
  it('saves the active dynamic Package without auto-activating it', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-ext-save-'))
    temporaryDirectories.push(directory)
    const runtime = await NekroRuntime.create({
      coreDatabasePath: path.join(directory, 'core.sqlite'),
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      assetRoot: path.join(directory, 'assets'),
      extensionDataRoot: path.join(directory, 'extension-data'),
      extensionCacheRoot: path.join(directory, 'extension-cache'),
      configureLlm: (context) => {
        context.llm.registerAdapter(['test-provider'], new QuietModel())
      },
    })
    await runtime.start()

    // Create an intelligent-agent with dynamic creation + its default Web Channel.
    const entity = await runtime.createAgentWithWebChannel({
      displayName: '创造智能体',
      persona: '',
      model: { provider: 'test-provider', model: 'chat-model' },
      capabilities: { dynamicCreation: true },
    })

    // Admit one message so an active Episode + DSH Session is formed and the
    // dynamic-creation tools mount for this Agent.
    await runtime.web.postMessage({
      channelId: entity.channelId,
      clientEventId: 'seed-session',
      parts: [{ type: 'text', text: '建立活动会话。' }],
    })
    const episode = runtime.repository
      .listActiveEpisodesForAgent(entity.agentId)
      .find((candidate) => candidate.dshSessionId !== undefined)
    expect(episode?.dshSessionId).toBeDefined()
    const dshSessionId = episode!.dshSessionId!

    // Define + run a dynamic package in that Session (the creator workbench state).
    const defined = runtime.host.defineDynamicPackage(dshSessionId, {
      plugin: { kind: 'new', idPrefix: 'saved' },
      name: '保存探针',
      purpose: '验证动态保存为本地扩展。',
      code: {
        host: `return {
          inject: ['tools'],
          apply(ctx) {
            harness.registerTool(ctx, harness.defineTool({
              name: 'saved_probe',
              description: 'saved probe',
              parameters: {},
              output: { schema: { type: 'string' }, render(_a, v) { return [{ type: 'text', text: v }] } },
              execute() { return 'ok' }
            }))
          }
        }`,
      },
    })
    await expect(
      runtime.host.runDynamicPackage(dshSessionId, defined.pluginId, defined.packageId, 'run'),
    ).resolves.toMatchObject({ ok: true, status: 'running' })

    // Expose the API and save the running dynamic package.
    const webContext = new Context()
    await webContext.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const api = createNekroHostApi(webContext.webServer, runtime)
    const origin = `http://127.0.0.1:${api.port}`
    try {
      const snapshot = HostApiContracts.snapshot.parseResponse(await (await fetch(`${origin}/api/snapshot`)).json())
      expect(snapshot.dynamic).toEqual([
        expect.objectContaining({
          agentId: entity.agentId,
          episodeId: episode!.id,
          pluginId: defined.pluginId,
          packageId: defined.packageId,
          status: 'running',
        }),
      ])

      const saveResponse = await fetch(`${origin}/api/extensions/save-from-dynamic`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          agentId: entity.agentId,
          episodeId: episode!.id,
          pluginId: defined.pluginId,
          packageId: defined.packageId,
          displayName: '保存探针（已保存）',
          slug: 'saved-probe',
          description: '从创造工作台保存的动态 Package。',
        }),
      })
      expect(saveResponse.ok).toBe(true)
      const saved = HostApiContracts.saveExtensionFromDynamic.parseResponse(await saveResponse.json())
      expect(saved.extensionId.length).toBeGreaterThan(0)
      expect(saved.revisionId.length).toBeGreaterThan(0)
      // 保存不自动启用。
      expect(saved.activation).toBe('inactive')

      // The saved Revision is durable and remains independent from Activation.
      expect(runtime.repository.getExtension(saved.extensionId)).toMatchObject({ slug: 'saved-probe' })
      expect(runtime.repository.getExtensionRevision(saved.revisionId)).toMatchObject({
        id: saved.revisionId,
        extensionId: saved.extensionId,
      })
      expect(runtime.repository.getExtensionRevisionVerification(saved.revisionId)).toMatchObject({
        dshVersion: '0.1.1-rc.1',
        contractVersion: 'nekro-nxt-extension-v1',
        origin: {
          episodeId: episode!.id,
          pluginId: defined.pluginId,
          packageId: defined.packageId,
        },
        hostBuild: { built: true },
        clientBuild: { built: false },
        toolInvocations: [{ name: 'saved_probe', succeeded: true }],
      })
      expect(runtime.repository.listActivations(entity.agentId)).toEqual([])

      // Saving does not stop or replace the running creator-workbench Package.
      expect(
        runtime.host
          .dynamicInventory(dshSessionId)
          .some((item) => item.latestRun?.status === 'running' && item.pluginId === defined.pluginId),
      ).toBe(true)
    } finally {
      api.dispose()
      await webContext.fiber.dispose()
      await runtime.dispose()
    }
  })
})
