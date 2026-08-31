import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { HostApiContracts } from '@nekro-nxt/contracts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NekroRuntime } from '../src/bootstrap.js'
import { createNekroHostApi } from '../src/host-api.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

class SettledModel extends LlmAdapter {
  streamCalls = 0
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
    this.streamCalls += 1
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
    const model = new SettledModel()
    const runtime = await NekroRuntime.create({
      coreDatabasePath: path.join(directory, 'core.sqlite'),
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      assetRoot: path.join(directory, 'assets'),
      extensionDataRoot: path.join(directory, 'extension-data'),
      extensionCacheRoot: path.join(directory, 'extension-cache'),
      configureLlm: (context) => {
        context.llm.registerAdapter(['test-provider'], model)
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

    // Define + run a dual-half dynamic Package → pending approval request.
    const defined = runtime.host.defineDynamicAuthoringPackage(dshSessionId, {
      plugin: { kind: 'new', idPrefix: 'client' },
      name: '动态客户端',
      purpose: '验证浏览器审批。',
      scope: 'agent',
      code: {
        host: `return {
          inject: ['tools'],
          apply(ctx) {
            const tool = harness.defineTool({
              name: 'dynamic_client_probe',
              description: '验证带 Client 半边的动态 Tool 证据。',
              parameters: {},
              output: {
                schema: { type: 'string' },
                render(_args, value) { return [{ type: 'text', text: value }] }
              },
              execute() { return 'dynamic-client-ok' }
            })
            harness.registerTool(ctx, tool)
          }
        }`,
        client: `return {
          inject: ['slots'],
          apply(ctx) {
            ctx.slots.register({ name: 'agent.workbench.sections', id: 'main' }, () => React.createElement('div'))
          }
        }`,
      },
      resources: {},
      permissions: { permissions: [], networkOrigins: [] },
      contributions: [],
    })
    const ran = runtime.host.runDynamicPackage(dshSessionId, defined.pluginId, defined.packageId, 'run')
    await expect
      .poll(
        () =>
          runtime.host.dynamicInventory(dshSessionId).find((row) => row.pluginId === defined.pluginId)?.latestRun
            ?.approvalRequestId,
      )
      .toBeDefined()
    const approval = runtime.host.dynamicInventory(dshSessionId).find((row) => row.pluginId === defined.pluginId)
      ?.latestRun?.approvalRequestId
    expect(approval).toBeDefined()
    const authoringTask = runtime.repository.listAuthoringTasks(entity.agentId)[0]
    const authoringAttempt = authoringTask
      ? runtime.repository.listAuthoringAttempts(authoringTask.id).at(-1)
      : undefined
    expect(authoringTask?.revision).toBeGreaterThan(1)
    expect(authoringAttempt?.state).toBe('awaiting-approval')
    if (!authoringTask || !authoringAttempt) throw new Error('Expected an awaiting Authoring attempt.')
    const decisionContext = new Context()
    await decisionContext.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const decisionApi = createNekroHostApi(decisionContext.webServer, runtime)
    try {
      const authoringDecisionResponse = await fetch(
        `http://127.0.0.1:${decisionApi.port}/api/authoring/tasks/${authoringTask.id}/attempts/${authoringAttempt.id}/decision`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            expectedRevision: authoringTask.revision - 1,
            approved: true,
            approveRiskStable: true,
          }),
        },
      )
      expect(authoringDecisionResponse.ok, await authoringDecisionResponse.clone().text()).toBe(true)
      expect(
        HostApiContracts.decideAuthoringAttempt.parseResponse(await authoringDecisionResponse.json()),
      ).toMatchObject({ accepted: true, executionRequired: true })
    } finally {
      decisionApi.dispose()
      await decisionContext.fiber.dispose()
    }
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

      const clientCodeResponse = await fetch(`${origin}/api/dynamic/${entity.agentId}/get-client-code`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          episodeId: episode!.id,
          pluginId: defined.pluginId,
          pluginRunId,
        }),
      })
      expect(clientCodeResponse.ok, await clientCodeResponse.clone().text()).toBe(true)
      const parsedClientCode = HostApiContracts.dynamicGetClientCode.parseResponse(await clientCodeResponse.json())
      expect(parsedClientCode).toMatchObject({
        pluginId: defined.pluginId,
        packageId: defined.packageId,
        pluginRunId,
        name: '动态客户端',
      })
      expect(parsedClientCode.code).toContain('apply')

      const approveResponse = await fetch(`${origin}/api/dynamic/${entity.agentId}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ episodeId: episode!.id, requestId: approval, pluginRunId }),
      })
      expect(approveResponse.ok).toBe(true)
      const ack = HostApiContracts.dynamicApprove.parseResponse(await approveResponse.json())
      expect(ack.accepted).toBe(true)

      const clientVerificationRequest = () =>
        fetch(`${origin}/api/dynamic/${entity.agentId}/report-client-verification`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            episodeId: episode!.id,
            pluginId: defined.pluginId,
            packageId: defined.packageId,
            pluginRunId,
            renderedSlots: ['agent.workbench.sections'],
          }),
        })
      const continuationErrors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      const clientVerificationResponse = await clientVerificationRequest()
      expect(clientVerificationResponse.ok).toBe(true)
      const repeatedClientVerificationResponse = await clientVerificationRequest()
      expect(repeatedClientVerificationResponse.ok).toBe(true)
      const settleSpy = vi.spyOn(runtime.host, 'whenAuthoringSettled')
      const saveResponse = await fetch(`${origin}/api/extensions/save-from-dynamic`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          taskId: authoringTask.id,
          attemptId: authoringAttempt.id,
          displayName: '续跑静止探针',
          slug: 'continuation-settle-probe',
          description: '等待智能体收尾后保存精确候选。',
        }),
      })
      expect(saveResponse.ok, await saveResponse.clone().text()).toBe(true)
      expect(HostApiContracts.saveExtensionFromDynamic.parseResponse(await saveResponse.json())).toMatchObject({
        activation: 'inactive',
      })
      expect(settleSpy).toHaveBeenCalledWith(dshSessionId)
      expect(runtime.repository.getAuthoringTask(authoringTask.id)?.status).toBe('completed')
      await runtime.host.waitUntilSafe(entity.agentId)
      expect(
        continuationErrors.mock.calls.filter(([message]) => String(message).includes('扩展开发自动续跑事件注入失败')),
      ).toEqual([])
      continuationErrors.mockRestore()
      const verification = await runtime.host.verifyDynamicPackage(dshSessionId, defined.pluginId, defined.packageId)
      expect(verification).toMatchObject({
        toolNames: ['dynamic_client_probe'],
        toolInvocations: [{ name: 'dynamic_client_probe', succeeded: true }],
        renderedSlots: ['agent.workbench.sections'],
      })
      expect(
        verification.contributions.some(
          (contribution) => contribution.kind === 'tool' && contribution.name === 'dynamic_client_probe',
        ),
      ).toBe(true)

      // The run resolves and client code is now available to load in the browser.
      const clientCode = runtime.host.getDynamicClientCode(dshSessionId, defined.pluginId, pluginRunId)
      expect(clientCode.code).toContain('apply')
    } finally {
      api.dispose()
      await webContext.fiber.dispose()
      await runtime.dispose()
    }
  })

  it('restores a verified Host-only authoring task from its persisted source ledger', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-authoring-recovery-'))
    temporaryDirectories.push(directory)
    const models: SettledModel[] = []
    const options = {
      coreDatabasePath: path.join(directory, 'core.sqlite'),
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      assetRoot: path.join(directory, 'assets'),
      extensionDataRoot: path.join(directory, 'extension-data'),
      extensionCacheRoot: path.join(directory, 'extension-cache'),
      configureLlm: (context: Context) => {
        const model = new SettledModel()
        models.push(model)
        context.llm.registerAdapter(['test-provider'], model)
      },
    }
    let runtime = await NekroRuntime.create(options)
    await runtime.start()
    let disposed = false
    try {
      const entity = await runtime.createAgentWithWebChannel({
        displayName: '恢复验证智能体',
        persona: '',
        model: { provider: 'test-provider', model: 'chat-model' },
        capabilities: { dynamicCreation: true },
      })
      await runtime.web.postMessage({
        channelId: entity.channelId,
        clientEventId: 'seed-recovery-session',
        parts: [{ type: 'text', text: '建立恢复测试会话。' }],
      })
      const episode = runtime.repository
        .listActiveEpisodesForAgent(entity.agentId)
        .find((candidate) => candidate.dshSessionId !== undefined)
      if (!episode?.dshSessionId) throw new Error('Expected a live recovery Session.')
      const firstSessionId = episode.dshSessionId
      const callsBeforeAuthoringResult = models[0]?.streamCalls ?? 0
      const defined = runtime.host.defineDynamicAuthoringPackage(firstSessionId, {
        plugin: { kind: 'new', idPrefix: 'recv' },
        name: '恢复探针',
        purpose: '重启后继续提供同一个已验证工具。',
        scope: 'agent',
        code: {
          host: `return {
            inject: ['tools'],
            apply(ctx) {
              harness.registerTool(ctx, harness.defineTool({
                name: 'recovery_probe',
                description: '返回恢复状态。',
                parameters: {},
                output: { schema: { type: 'string' }, render(_args, value) { return [{ type: 'text', text: value }] } },
                execute() { return 'restored' }
              }))
            }
          }`,
        },
        resources: {},
        permissions: { permissions: [], networkOrigins: [] },
        contributions: [],
      })
      await expect(
        runtime.host.runDynamicPackage(firstSessionId, defined.pluginId, defined.packageId, 'run'),
      ).resolves.toMatchObject({ ok: true, status: 'running' })
      await expect.poll(() => runtime.repository.listAuthoringTasks(entity.agentId)[0]?.status).toBe('ready')
      await runtime.host.whenAuthoringSettled(firstSessionId)
      expect(models[0]?.streamCalls ?? 0).toBeGreaterThan(callsBeforeAuthoringResult)
      const taskBeforeRestart = runtime.repository.listAuthoringTasks(entity.agentId)[0]
      expect(taskBeforeRestart).toBeDefined()
      const attemptBeforeRestart = runtime.repository.listAuthoringAttempts(taskBeforeRestart!.id).at(-1)
      expect(attemptBeforeRestart?.state).toBe('active')

      const snapshotContext = new Context()
      await snapshotContext.plugin(WebServer, { host: '127.0.0.1', port: 0 })
      const snapshotApi = createNekroHostApi(snapshotContext.webServer, runtime)
      try {
        const snapshotResponse = await fetch(`http://127.0.0.1:${snapshotApi.port}/api/snapshot`)
        expect(snapshotResponse.ok).toBe(true)
        const snapshot = HostApiContracts.snapshot.parseResponse(await snapshotResponse.json())
        const projectedTask = snapshot.authoringTasks.find((task) => task.id === taskBeforeRestart!.id)
        expect(projectedTask?.activeAttempt?.id).toBe(attemptBeforeRestart?.id)
        expect(projectedTask?.candidateAttempt?.id).toBe(attemptBeforeRestart?.id)
      } finally {
        snapshotApi.dispose()
        await snapshotContext.fiber.dispose()
      }

      await runtime.dispose()
      disposed = true
      runtime = await NekroRuntime.create(options)
      disposed = false
      await runtime.start()
      await runtime.recover()

      await expect.poll(() => runtime.repository.getAuthoringTask(taskBeforeRestart!.id)?.status).toBe('ready')
      const taskAfterRestart = runtime.repository.getAuthoringTask(taskBeforeRestart!.id)
      expect(taskAfterRestart?.pluginKey).not.toBe(defined.pluginId)
      const recoveredEpisode = runtime.repository.getEpisode(episode.id)
      expect(recoveredEpisode?.dshSessionId).toBe(firstSessionId)
      expect(runtime.host.toolNames(firstSessionId)).toContain('recovery_probe')
      const inventory = runtime.host.dynamicInventory(firstSessionId)
      expect(inventory).toHaveLength(1)
      expect(inventory[0]?.latestRun?.status).toBe('running')
    } finally {
      if (!disposed) await runtime.dispose()
    }
  })
})
