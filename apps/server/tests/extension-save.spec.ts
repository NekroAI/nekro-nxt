import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { HostApiContracts } from '@nekro-nxt/contracts'
import { strFromU8, unzipSync } from 'fflate'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
        dshVersion: '0.1.1-rc.2',
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

      const exportResponse = await fetch(
        `${origin}/api/extensions/${saved.extensionId}/revisions/${saved.revisionId}/export`,
      )
      expect(exportResponse.ok).toBe(true)
      expect(exportResponse.headers.get('content-disposition')).toContain('.nxt-extension')
      const archiveBytes = new Uint8Array(await exportResponse.arrayBuffer())
      const archive = unzipSync(archiveBytes)
      const transferManifest: unknown = JSON.parse(strFromU8(archive['manifest.json']!))
      expect(transferManifest).toMatchObject({
        schemaVersion: 1,
        kind: 'nekro-nxt-extension',
        extension: { id: saved.extensionId, scope: 'agent', slug: 'saved-probe' },
        revision: { id: saved.revisionId },
      })
      expect(strFromU8(archive['revision/source/host.ts']!)).toContain('saved_probe')

      const importDirectory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-extension-import-'))
      temporaryDirectories.push(importDirectory)
      const importedRuntime = await NekroRuntime.create({
        coreDatabasePath: path.join(importDirectory, 'core.sqlite'),
        sessionDatabasePath: path.join(importDirectory, 'sessions.sqlite'),
        assetRoot: path.join(importDirectory, 'assets'),
        extensionDataRoot: path.join(importDirectory, 'extension-data'),
        extensionCacheRoot: path.join(importDirectory, 'extension-cache'),
      })
      const importWebContext = new Context()
      await importWebContext.plugin(WebServer, { host: '127.0.0.1', port: 0 })
      const importApi = createNekroHostApi(importWebContext.webServer, importedRuntime)
      const importOrigin = `http://127.0.0.1:${importApi.port}`
      try {
        const inspectResponse = await fetch(`${importOrigin}/api/extensions/imports/inspect`, {
          method: 'POST',
          headers: { 'content-type': 'application/vnd.nekro-nxt.extension+zip' },
          body: Buffer.from(archiveBytes),
        })
        expect(inspectResponse.ok).toBe(true)
        const inspection = HostApiContracts.inspectExtensionImport.parseResponse(await inspectResponse.json())
        expect(inspection).toMatchObject({
          extensionId: saved.extensionId,
          revisionId: saved.revisionId,
          idempotent: false,
          slugConflict: false,
        })
        const commitResponse = await fetch(`${importOrigin}/api/extensions/imports/${inspection.token}/commit`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
        expect(commitResponse.ok).toBe(true)
        expect(HostApiContracts.commitExtensionImport.parseResponse(await commitResponse.json())).toMatchObject({
          extensionId: saved.extensionId,
          revisionId: saved.revisionId,
          idempotent: false,
        })
        expect(importedRuntime.repository.listActivations()).toEqual([])
        expect(importedRuntime.repository.getHostInstallation(saved.extensionId)).toBeUndefined()
        expect(importedRuntime.repository.getExtensionRevisionVerification(saved.revisionId)).toMatchObject({
          revisionId: saved.revisionId,
          dshVersion: '0.1.1-rc.2',
          origin: { pluginRunId: 'local-runtime-verification' },
          toolInvocations: [{ name: 'saved_probe', succeeded: true }],
        })

        const repeatedInspect = await fetch(`${importOrigin}/api/extensions/imports/inspect`, {
          method: 'POST',
          body: Buffer.from(archiveBytes),
        })
        const repeated = HostApiContracts.inspectExtensionImport.parseResponse(await repeatedInspect.json())
        expect(repeated.idempotent).toBe(true)
        const repeatedCommit = await fetch(`${importOrigin}/api/extensions/imports/${repeated.token}/commit`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
        expect(HostApiContracts.commitExtensionImport.parseResponse(await repeatedCommit.json()).idempotent).toBe(true)

        const expiringInspect = await fetch(`${importOrigin}/api/extensions/imports/inspect`, {
          method: 'POST',
          body: Buffer.from(archiveBytes),
        })
        const expiring = HostApiContracts.inspectExtensionImport.parseResponse(await expiringInspect.json())
        const inspectedAt = Date.now()
        const now = vi.spyOn(Date, 'now').mockReturnValue(inspectedAt + 10 * 60_000 + 1)
        try {
          const expiredCommit = await fetch(`${importOrigin}/api/extensions/imports/${expiring.token}/commit`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
          expect(expiredCommit.status).toBe(400)
          expect(await expiredCommit.text()).toContain('扩展导入检查已失效')
        } finally {
          now.mockRestore()
        }
      } finally {
        importApi.dispose()
        await importWebContext.fiber.dispose()
        await importedRuntime.dispose()
      }

      // Saving does not stop or replace the running creator-workbench Package.
      expect(
        runtime.host
          .dynamicInventory(dshSessionId)
          .some((item) => item.latestRun?.status === 'running' && item.pluginId === defined.pluginId),
      ).toBe(true)

      const activationResponse = await fetch(
        `${origin}/api/agents/${entity.agentId}/extensions/${saved.extensionId}/activation`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ revisionId: saved.revisionId }),
        },
      )
      expect(activationResponse.ok).toBe(true)
      expect(runtime.repository.getActivation(entity.agentId, saved.extensionId)).toBeDefined()
      const sourceDirectory = runtime.extensionService.revisionSourceDirectory(
        runtime.repository.getExtensionRevision(saved.revisionId)!,
      )
      const deleteResponse = await fetch(`${origin}/api/extensions/${saved.extensionId}`, { method: 'DELETE' })
      expect(deleteResponse.ok).toBe(true)
      expect(HostApiContracts.deleteLocalExtension.parseResponse(await deleteResponse.json())).toEqual({
        deleted: true,
      })
      expect(runtime.repository.getExtension(saved.extensionId)).toBeUndefined()
      expect(runtime.repository.getExtensionRevision(saved.revisionId)).toBeUndefined()
      expect(runtime.repository.getActivation(entity.agentId, saved.extensionId)).toBeUndefined()
      await expect(access(sourceDirectory)).rejects.toThrow()
    } finally {
      api.dispose()
      await webContext.fiber.dispose()
      await runtime.dispose()
    }
  })
})
