import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import {
  ChannelEventIdSchema,
  ChannelIdSchema,
  ChannelMemberIdSchema,
  HostApiContracts,
  HostApiErrorSchema,
  HostSseEventSchema,
  ExtensionIdSchema,
  ExtensionRevisionIdSchema,
  HostUiPageInstanceIdSchema,
  LogicalMessageIdSchema,
} from '@nekro-nxt/contracts'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { NekroRuntime } from '../src/bootstrap.js'
import { createNekroHostApi, projectHistoryEntry } from '../src/host-api.js'
import { PRODUCT_VERSION } from '../src/product-version.js'
import { DEEPSEEK_HARNESS_VERSION } from '../src/dsh-version.js'
import { checkSignInOptions, configureDshLlmProviders, registerNekroSpaRoutes } from '../src/main.js'

/** Documentation-range addresses (RFC 5737), assembled so no literal address appears in the source. */
const testAddress = (host: number): string => ['203', '0', '113', String(host)].join('.')

const systemText = (options: GenerateOptions | undefined): string =>
  options?.messages
    .filter((message) => message.role === 'system')
    .flatMap((message) => message.content)
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n') ?? ''

const temporaryDirectories: string[] = []

const LlmProviderSnapshotSchema = z
  .object({
    providers: z.array(
      z
        .object({
          provider: z.string(),
          settingsRevision: z.number(),
          configured: z.boolean().optional(),
          active: z.boolean().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough()

const DshPluginCatalogSchema = z
  .object({
    plugins: z.array(
      z
        .object({
          packageName: z.string(),
          packageVersion: z.string(),
          origin: z.enum(['builtin', 'profile', 'dynamic']),
          settingsNamespaces: z.array(z.string()),
        })
        .strict(),
    ),
  })
  .passthrough()

const DshSettingsSnapshotSchema = z
  .object({
    namespaces: z.array(
      z
        .object({
          ns: z.string(),
          revision: z.number(),
          resolved: z.record(z.string(), z.unknown()),
          secrets: z.array(z.unknown()),
        })
        .passthrough(),
    ),
  })
  .passthrough()

const DshSettingsMutationSchema = z
  .object({ revision: z.number(), resolved: z.object({ maxUses: z.number() }).passthrough() })
  .passthrough()

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

class ScriptedCommunicationModel extends LlmAdapter {
  constructor(readonly supportsImage = false) {
    super()
  }

  override providerInfo(provider: string) {
    return { id: provider, name: 'Deterministic communication model' }
  }

  override listModels(provider: string) {
    return Promise.resolve([
      {
        provider,
        id: 'chat-model',
        name: 'Chat model',
        inputModalities: this.supportsImage ? (['text', 'image'] as const) : (['text'] as const),
      },
    ])
  }

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      inputModalities: this.supportsImage ? (['text', 'image'] as const) : (['text'] as const),
      context: { contextWindow: 128_000 },
    })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    await Promise.resolve()
    if (systemText(options).startsWith('你在给一个群聊智能体写压缩记录')) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '用户希望继续当前频道任务。' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '用户希望继续当前频道任务。' } }
      yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (!options.messages.some((message) => message.role === 'tool')) {
      const callId = ToolCallId('scripted-send-message')
      const toolCall = {
        type: 'tool-call' as const,
        id: callId,
        name: 'send_channel_message',
        arguments: JSON.stringify({
          target: { type: 'current' },
          parts: [{ type: 'text', text: '这是通信工具确认发送的回复。' }],
        }),
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '这段模型原始文字只能留在运行轨迹。' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '这段模型原始文字只能留在运行轨迹。' } }
      yield { type: 'block-start', index: 1, blockType: 'tool-call' }
      yield {
        type: 'tool-call-delta',
        index: 1,
        id: callId,
        name: 'send_channel_message',
        argumentsDelta: toolCall.arguments,
      }
      yield { type: 'block-end', index: 1, block: toolCall }
      yield { type: 'usage', usage: { inputTokens: 16, outputTokens: 8, totalTokens: 24 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: '工具完成后的原始结束文字也不会发送。' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '工具完成后的原始结束文字也不会发送。' } }
    yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

describe('NekroNxt Server domain API (WebServer seam)', () => {
  it('projects platform activities as system facts while preserving actor relations', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-host-activity-projection-'))
    temporaryDirectories.push(directory)
    const runtime = await NekroRuntime.create({
      coreDatabasePath: path.join(directory, 'core.sqlite'),
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      assetRoot: path.join(directory, 'assets'),
      extensionDataRoot: path.join(directory, 'extension-data'),
      extensionCacheRoot: path.join(directory, 'extension-cache'),
    })
    const memberId = ChannelMemberIdSchema.parse('mbr_ACTIVITYACTOR')
    try {
      expect(
        projectHistoryEntry(runtime, {
          source: 'channel-event',
          sourceId: ChannelEventIdSchema.parse('evt_ACTIVITY1'),
          logicalMessageId: LogicalMessageIdSchema.parse('msg_ACTIVITY1'),
          channelId: ChannelIdSchema.parse('chn_ACTIVITY1'),
          occurredAt: 1_700_000_000_000,
          senderMemberId: memberId,
          activityKey: 'member-joined',
          parts: [
            {
              type: 'rich',
              adapterKey: 'fixture-beta',
              kind: 'member-joined',
              summary: '一名成员加入了频道。',
            },
          ],
        }),
      ).toMatchObject({
        role: 'system',
        sender: { memberId },
        activityKey: 'member-joined',
      })
    } finally {
      await runtime.dispose()
    }
  })

  it('keeps legacy Host UI preferences but excludes its pages from the runnable snapshot', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nxt-legacy-page-snapshot-'))
    temporaryDirectories.push(directory)
    const runtime = await NekroRuntime.create({
      coreDatabasePath: path.join(directory, 'core.sqlite'),
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      assetRoot: path.join(directory, 'assets'),
      extensionDataRoot: path.join(directory, 'extension-data'),
      extensionCacheRoot: path.join(directory, 'extension-cache'),
    })
    const webContext = new Context()
    await webContext.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const api = createNekroHostApi(webContext.webServer, runtime)
    try {
      const extension = {
        id: ExtensionIdSchema.parse('ext_legacy'),
        provides: ['page'] as const,
        slug: 'legacy-ui',
        displayName: '旧页面',
        description: '',
        createdAt: 1,
      }
      const revision = {
        id: ExtensionRevisionIdSchema.parse('xrv_legacy'),
        extensionId: extension.id,
        revisionNumber: 1,
        contentDigest: 'a'.repeat(64),
        payloadDigest: 'b'.repeat(64),
        createdAt: 1,
        ancestry: [],
        origin: 'file' as const,
        dataVersion: 1,
      }
      runtime.repository.saveExtensionRevision({ extension, revision })
      const pages = [
        {
          kind: 'host-page' as const,
          entryId: 'overview',
          title: '保留的页面',
          icon: { kind: 'host-icon' as const, name: 'layout-dashboard' as const },
          objectPane: 'hidden' as const,
          startPath: '',
        },
      ]
      runtime.repository.replaceHostUiExtensionPages({
        extensionId: extension.id,
        revisionId: revision.id,
        pages,
        clientBuildKey: 'a'.repeat(64),
        now: 1,
        nextPageInstanceId: () => HostUiPageInstanceIdSchema.parse('hup_legacy'),
      })
      const sourceDirectory = runtime.extensionService.revisionSourceDirectory(revision)
      await mkdir(sourceDirectory, { recursive: true })
      await writeFile(
        path.join(sourceDirectory, 'manifest.json'),
        JSON.stringify({
          schemaVersion: 4,
          scope: 'host-ui',
          extensionId: extension.id,
          revisionId: revision.id,
          entrypoints: { client: 'source/client.ts' },
          permissions: { permissions: [], networkOrigins: [] },
          contributions: pages,
        }),
      )
      const preserved = runtime.repository.listHostUiPageEntries()
      expect(preserved).toHaveLength(1)
      const snapshot = HostApiContracts.snapshot.parseResponse(
        await (await fetch(`http://127.0.0.1:${api.port}/api/snapshot`)).json(),
      )
      expect(snapshot.hostUi.pages).toEqual([])
      expect(snapshot.extensions[0]?.revisions[0]?.format).toBe('unavailable')
      expect(runtime.repository.listHostUiPageEntries()).toEqual(preserved)
    } finally {
      api.dispose()
      await webContext.fiber.dispose()
      await runtime.dispose()
    }
  })

  it('rejects oversized JSON requests without buffering the full body', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-host-api-body-limit-'))
    temporaryDirectories.push(directory)
    const runtime = await NekroRuntime.create({
      coreDatabasePath: path.join(directory, 'core.sqlite'),
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      assetRoot: path.join(directory, 'assets'),
      extensionDataRoot: path.join(directory, 'extension-data'),
      extensionCacheRoot: path.join(directory, 'extension-cache'),
    })
    const webContext = new Context()
    await webContext.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const api = createNekroHostApi(webContext.webServer, runtime)
    try {
      const response = await fetch(`http://127.0.0.1:${api.port}/api/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: '超限智能体', padding: 'x'.repeat(2 * 1024 * 1024) }),
      })
      expect(response.status).toBe(400)
      expect(await response.text()).toContain('JSON body exceeds 2097152 bytes')
      expect(runtime.core.listAgents()).toEqual([])
    } finally {
      api.dispose()
      await webContext.fiber.dispose()
      await runtime.dispose()
    }
  })

  it('creates an intelligent-agent, admits an internal message, and exposes only the communication-tool reply', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-host-api-'))
    temporaryDirectories.push(directory)
    const runtime = await NekroRuntime.create({
      coreDatabasePath: path.join(directory, 'core.sqlite'),
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      assetRoot: path.join(directory, 'assets'),
      extensionDataRoot: path.join(directory, 'extension-data'),
      extensionCacheRoot: path.join(directory, 'extension-cache'),
      configureLlm: (context: Context) => {
        context.llm.registerAdapter(['test-provider'], new ScriptedCommunicationModel())
      },
    })
    await runtime.start()
    await runtime.recover()

    const webContext = new Context()
    await webContext.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const api = createNekroHostApi(webContext.webServer, runtime)
    const origin = `http://127.0.0.1:${api.port}`

    try {
      const providerTest = await fetch(`${origin}/api/llm/test-provider`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'test-provider', model: 'chat-model' }),
      })
      expect(providerTest.ok).toBe(true)
      expect(await providerTest.json()).toEqual({ provider: 'test-provider', model: 'chat-model' })

      const invalidModelResponse = await fetch(`${origin}/api/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          displayName: '不应创建的智能体',
          persona: '',
          model: { provider: 'test-provider', model: 'missing-model' },
        }),
      })
      expect(invalidModelResponse.status).toBe(400)
      const invalidModelError = HostApiErrorSchema.parse(await invalidModelResponse.json()).error
      expect(invalidModelError.code).toBe('request-failed')
      expect(invalidModelError.message).toContain('test-provider/missing-model')
      expect(
        HostApiContracts.snapshot.parseResponse(await (await fetch(`${origin}/api/snapshot`)).json()).agents,
      ).toEqual([])

      const importedAgent = runtime.core.createAgent({
        displayName: '仅迁入配置的智能体',
        persona: '没有迁入频道数据。',
        model: { provider: 'test-provider', model: 'chat-model' },
      })
      const importedSnapshot = HostApiContracts.snapshot.parseResponse(
        await (await fetch(`${origin}/api/snapshot`)).json(),
      )
      expect(importedSnapshot.productMetadata).toEqual({
        displayName: 'NekroNXT',
        organizationName: 'NekroAI',
        version: PRODUCT_VERSION,
        releaseId: `@nekro-nxt/server@${PRODUCT_VERSION}`,
        repositoryUrl: 'https://github.com/NekroAI/nekro-nxt',
        licenseSpdx: 'AGPL-3.0-only',
        dshVersion: DEEPSEEK_HARNESS_VERSION,
      })
      expect(importedSnapshot.agents).toEqual([
        expect.objectContaining({ id: importedAgent.definition.id, channels: [] }),
      ])
      expect(importedSnapshot.channels).toEqual([])

      // Closed-loop A: create an intelligent-agent through the real HTTP surface.
      const createdResponse = await fetch(`${origin}/api/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          displayName: '网页智能体',
          persona: '简洁准确地回应。',
          model: { provider: 'test-provider', model: 'chat-model' },
        }),
      })
      expect(createdResponse.status).toBe(201)
      const created = HostApiContracts.createAgent.parseResponse(await createdResponse.json())
      expect(created.agentId.length).toBeGreaterThan(0)
      expect(created.channelId.length).toBeGreaterThan(0)
      expect(runtime.repository.getAgent(created.agentId)?.revision.capabilities).toMatchObject({
        subagents: true,
        fileTools: false,
        webSearch: false,
      })

      const sender = runtime.core.observeChannelMember({
        connectionId: created.connectionId,
        channelId: created.channelId,
        platformUserId: 'sender-openid',
        displayName: '成员甲',
        observedAt: Date.now(),
      }).member
      const mentioned = runtime.core.observeChannelMember({
        connectionId: created.connectionId,
        channelId: created.channelId,
        platformUserId: 'mentioned-openid',
        displayName: '成员乙',
        observedAt: Date.now(),
      }).member
      runtime.core.appendInbound({
        connectionId: created.connectionId,
        channelId: created.channelId,
        adapterKey: runtime.core.getConnection(created.connectionId)!.adapterKey,
        platformEventId: 'member-projection-1',
        kind: 'message-created',
        senderMemberId: sender.id,
        parts: [
          { type: 'text', text: '请看' },
          { type: 'mention', memberId: mentioned.id },
        ],
        platformTimestamp: Date.now(),
        receivedAt: Date.now(),
        dedupeKey: 'member-projection-1',
        facts: { mentionedBot: true },
      })

      // Related collections are captured once for the whole snapshot, not once per entity.
      const revisionReads = vi.spyOn(runtime.repository, 'listExtensionRevisions')
      const attemptReads = vi.spyOn(runtime.repository, 'listAuthoringAttempts')
      const snapshot = HostApiContracts.snapshot.parseResponse(await (await fetch(`${origin}/api/snapshot`)).json())
      expect(revisionReads).toHaveBeenCalledExactlyOnceWith()
      expect(attemptReads).toHaveBeenCalledExactlyOnceWith()
      revisionReads.mockRestore()
      attemptReads.mockRestore()
      expect(snapshot.models.find((model) => model.id === 'chat-model')).toMatchObject({
        provider: 'test-provider',
        name: 'Chat model',
      })
      expect(
        snapshot.connectionAdapters.some(
          (descriptor) =>
            descriptor.provisioning === 'system-singleton' && descriptor.channelKinds.includes('internal'),
        ),
      ).toBe(true)
      expect(snapshot.connectionAdapters.some((descriptor) => descriptor.provisioning === 'user-created')).toBe(true)
      expect(snapshot.agents.some((agent) => agent.id === created.agentId)).toBe(true)
      expect(snapshot.agents.find((agent) => agent.id === created.agentId)?.displayName).toBe('网页智能体')
      expect(snapshot.agents.find((agent) => agent.id === created.agentId)?.runtimeStatus).toBe('idle')
      expect(snapshot.agents.find((agent) => agent.id === created.agentId)?.runtimePhase).toBe('idle')
      expect(snapshot.agents.find((agent) => agent.id === created.agentId)?.imagePolicy).toEqual({
        history: {
          mode: 'persistent-distinct',
          detail: 'auto',
          restoreAfterCompaction: { recentMessages: 32, maxImages: 12 },
        },
        textModel: { mode: 'disabled' },
      })
      expect(snapshot.agents.find((agent) => agent.id === created.agentId)?.imageDiagnostics).toMatchObject({
        route: { mode: 'unavailable' },
        residentImages: 0,
        duplicateImagesSkipped: 0,
      })
      expect(snapshot.channels.find((channel) => channel.id === created.channelId)?.runtimePhase).toBe('idle')
      const idleRuntime = HostApiContracts.getChannelRuntime.parseResponse(
        await (await fetch(`${origin}/api/channels/${created.channelId}/runtime`)).json(),
      )
      expect(idleRuntime).toMatchObject({
        channelId: created.channelId,
        agentId: created.agentId,
        phase: 'idle',
        pendingInjectCount: 0,
        turns: [],
      })
      expect(snapshot.channels.some((channel) => channel.id === created.channelId)).toBe(true)
      expect(snapshot.channels.find((channel) => channel.id === created.channelId)?.boundAgentId).toBe(created.agentId)
      expect(snapshot.messages).toEqual([])
      const renamed = await fetch(`${origin}/api/channels/${created.channelId}/display-name`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: '本地识别名称' }),
      })
      expect(renamed.status).toBe(200)
      const renamedSnapshot = HostApiContracts.snapshot.parseResponse(
        await (await fetch(`${origin}/api/snapshot`)).json(),
      )
      expect(renamedSnapshot.channels.find((channel) => channel.id === created.channelId)).toMatchObject({
        displayName: '本地识别名称',
        platformChannelId: `internal-${created.agentId}`,
      })
      const externalDescriptor = renamedSnapshot.connectionAdapters.find(
        ({ provisioning, activities }) =>
          provisioning === 'user-created' &&
          activities.some((activity) => activity.scope === 'channel' && activity.triggerable),
      )
      if (!externalDescriptor) throw new Error('测试快照缺少可创建的外部 Adapter。')
      const externalConnection = runtime.core.createConnection({ adapterKey: externalDescriptor.key, config: {} })
      const aliasResponse = await fetch(`${origin}/api/connections/${externalConnection.id}/alias`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ alias: '  外部机器人  ' }),
      })
      expect(aliasResponse.status).toBe(200)
      expect(HostApiContracts.updateConnectionAlias.parseResponse(await aliasResponse.json())).toEqual({
        connectionId: externalConnection.id,
        alias: '外部机器人',
      })
      const aliasedSnapshot = HostApiContracts.snapshot.parseResponse(
        await (await fetch(`${origin}/api/snapshot`)).json(),
      )
      expect(aliasedSnapshot.connections.find((connection) => connection.id === externalConnection.id)).toMatchObject({
        alias: '外部机器人',
      })
      const triggerableActivity = externalDescriptor.activities.find(
        (activity) => activity.scope === 'channel' && activity.triggerable,
      )
      if (!triggerableActivity) throw new Error('测试 Adapter 缺少可触发频道活动。')
      const defaultsResponse = await fetch(
        `${origin}/api/connections/${externalConnection.id}/activity-trigger-defaults`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ activityKeys: [triggerableActivity.key] }),
        },
      )
      expect(defaultsResponse.status).toBe(200)
      expect(
        HostApiContracts.updateConnectionActivityTriggerDefaults.parseResponse(await defaultsResponse.json()),
      ).toEqual({ connectionId: externalConnection.id, activityKeys: [triggerableActivity.key] })

      const restorableChannel = runtime.core.createChannel({
        connectionId: externalConnection.id,
        platformChannelId: 'restorable-channel',
        kind: triggerableActivity.channelKinds?.[0] ?? 'group',
      })
      const archiveResponse = await fetch(`${origin}/api/connections/${externalConnection.id}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deleteChannelData: false }),
      })
      expect(archiveResponse.status).toBe(200)
      expect(HostApiContracts.deleteConnection.parseResponse(await archiveResponse.json())).toEqual({
        connectionId: externalConnection.id,
        archived: true,
      })
      const archivedSnapshot = HostApiContracts.snapshot.parseResponse(
        await (await fetch(`${origin}/api/snapshot`)).json(),
      )
      expect(archivedSnapshot.connections.some(({ id }) => id === externalConnection.id)).toBe(false)
      expect(archivedSnapshot.channels.some(({ id }) => id === restorableChannel.id)).toBe(false)
      expect(archivedSnapshot.archivedConnections).toContainEqual(
        expect.objectContaining({ id: externalConnection.id, channelCount: 1 }),
      )

      const restoreResponse = await fetch(`${origin}/api/connections/${externalConnection.id}/restore`, {
        method: 'POST',
      })
      expect(restoreResponse.status).toBe(200)
      expect(HostApiContracts.restoreConnection.parseResponse(await restoreResponse.json())).toEqual({
        connectionId: externalConnection.id,
        restored: true,
      })
      const restoredSnapshot = HostApiContracts.snapshot.parseResponse(
        await (await fetch(`${origin}/api/snapshot`)).json(),
      )
      expect(
        restoredSnapshot.connections.find(({ id }) => id === externalConnection.id)?.activityTriggerDefaults,
      ).toEqual([triggerableActivity.key])
      expect(restoredSnapshot.channels.some(({ id }) => id === restorableChannel.id)).toBe(true)

      const purgeResponse = await fetch(`${origin}/api/connections/${externalConnection.id}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deleteChannelData: true }),
      })
      expect(purgeResponse.status).toBe(200)
      expect(runtime.repository.getChannelReference(restorableChannel.id)).toBeUndefined()
      expect(runtime.repository.getArchivedConnection(externalConnection.id)).toBeUndefined()
      const internalConnection = runtime.core.getConnection(created.connectionId)
      if (!internalConnection) throw new Error('测试快照缺少内置连接。')
      const internalDescriptor = aliasedSnapshot.connectionAdapters.find(
        ({ key }) => key === internalConnection.adapterKey,
      )
      if (!internalDescriptor) throw new Error('测试快照缺少内置 Adapter Descriptor。')
      const firstUsersResponse = await fetch(
        `${origin}/api/platform-users?adapterKey=${encodeURIComponent(internalConnection.adapterKey)}&limit=1`,
      )
      expect(firstUsersResponse.status).toBe(200)
      const firstUsers = HostApiContracts.listPlatformUsers.parseResponse(await firstUsersResponse.json())
      expect(firstUsers).toMatchObject({
        total: 2,
        items: [
          expect.objectContaining({
            adapter: { key: internalConnection.adapterKey, displayName: internalDescriptor.displayName },
            activeChannelCount: 1,
            historicalOnly: false,
          }),
        ],
      })
      expect(firstUsers.nextCursor).toBeDefined()
      expect(JSON.stringify(firstUsers)).not.toContain('sender-openid')
      expect(JSON.stringify(firstUsers)).not.toContain('mentioned-openid')
      const systemAliasResponse = await fetch(`${origin}/api/connections/${created.connectionId}/alias`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ alias: '不应修改' }),
      })
      expect(systemAliasResponse.status).toBe(400)
      const initialHistory = HostApiContracts.listChannelMessages.parseResponse(
        await (await fetch(`${origin}/api/channels/${created.channelId}/messages?limit=40`)).json(),
      )
      expect(initialHistory.messages.find((message) => message.sender?.memberId === sender.id)).toMatchObject({
        sender: { displayName: '成员甲' },
        mentionedConnectionAccount: true,
        parts: [
          { type: 'text', text: '请看' },
          { type: 'mention', memberId: mentioned.id, displayName: '成员乙' },
        ],
      })

      const pngBytes = new Uint8Array(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
          'base64',
        ),
      )
      const preparedAsset = await runtime.assetService.prepare({
        bytes: pngBytes,
        declaredMediaType: 'image/png',
      })
      await runtime.channels.acceptChannelInbound({
        connectionId: created.connectionId,
        channelId: created.channelId,
        adapterKey: runtime.core.getConnection(runtime.internalConnectionId)!.adapterKey,
        platformEventId: 'asset-http-event',
        platformMessageId: 'asset-http-message',
        kind: 'message-created',
        parts: [{ type: 'image', assetId: preparedAsset.asset.id, alt: '一像素图片' }],
        platformTimestamp: Date.now(),
        receivedAt: Date.now(),
        dedupeKey: 'asset-http-event',
        assetOccurrences: [{ partIndex: 0, assetId: preparedAsset.asset.id }],
      })
      const assetResponse = await fetch(`${origin}/api/channels/${created.channelId}/assets/${preparedAsset.asset.id}`)
      expect(assetResponse.status).toBe(200)
      expect(assetResponse.headers.get('content-type')).toBe('image/png')
      expect(new Uint8Array(await assetResponse.arrayBuffer())).toEqual(pngBytes)

      // Admit an internal message through the real HTTP surface.
      const admitted = await fetch(`${origin}/api/channels/${created.channelId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ parts: [{ type: 'text', text: '你好，请回复我。' }], clientEventId: 'browser-1' }),
      })
      expect(admitted.status).toBe(200)

      // Wait for the DSH Agent Loop to settle (the scripted model replies via send_channel_message).
      const web = runtime.internalChannel
      const session = runtime.host
      const before = Date.now()
      // Poll the Channel history endpoint until the agent reply lands (bounded wait, no fake clock).
      for (;;) {
        const latest = HostApiContracts.listChannelMessages.parseResponse(
          await (await fetch(`${origin}/api/channels/${created.channelId}/messages?limit=40`)).json(),
        )
        const agentMessages = latest.messages.filter((message) => message.role === 'agent')
        if (
          agentMessages.some((message) =>
            message.parts.some((part) => part.type === 'text' && part.text === '这是通信工具确认发送的回复。'),
          )
        ) {
          break
        }
        if (Date.now() - before > 10_000) throw new Error('Timed out waiting for the communication-tool reply.')
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      void web
      void session

      // Only the communication-tool reply is a channel message; raw model text stays internal.
      const finalSnapshot = HostApiContracts.listChannelMessages.parseResponse(
        await (await fetch(`${origin}/api/channels/${created.channelId}/messages?limit=40`)).json(),
      )
      const allTexts = finalSnapshot.messages.flatMap((message) =>
        message.parts
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .filter((text) => text.length > 0),
      )
      expect(allTexts).toContain('这是通信工具确认发送的回复。')
      expect(allTexts.join(' ')).not.toContain('模型原始文字只能留在运行轨迹')
      expect(allTexts.join(' ')).not.toContain('工具完成后的原始结束文字也不会发送')

      const firstPage = HostApiContracts.listChannelMessages.parseResponse(
        await (await fetch(`${origin}/api/channels/${created.channelId}/messages?limit=1`)).json(),
      )
      expect(firstPage.messages).toHaveLength(1)
      expect(firstPage.hasMore).toBe(true)
      expect(firstPage.messages[0]?.id).toBe(finalSnapshot.messages.at(-1)?.id)
      const cursor = firstPage.messages[0]!
      const olderPage = HostApiContracts.listChannelMessages.parseResponse(
        await (
          await fetch(
            `${origin}/api/channels/${created.channelId}/messages?limit=1&beforeOccurredAt=${cursor.occurredAt}&beforeSourceId=${cursor.id}`,
          )
        ).json(),
      )
      expect(olderPage.messages).toHaveLength(1)
      expect(olderPage.messages[0]?.id).toBe(finalSnapshot.messages.at(-2)?.id)

      const observerResponse = await fetch(`${origin}/api/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          displayName: '观察智能体',
          persona: '',
          model: { provider: 'test-provider', model: 'chat-model' },
        }),
      })
      const observer = HostApiContracts.createAgent.parseResponse(await observerResponse.json())
      const bindingResponse = await fetch(`${origin}/api/bindings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          agentId: observer.agentId,
          channelId: created.channelId,
          triggerPolicy: 'observe-only',
        }),
      })
      expect(bindingResponse.status).toBe(201)
      const reboundSnapshot = HostApiContracts.snapshot.parseResponse(
        await (await fetch(`${origin}/api/snapshot`)).json(),
      )
      expect(reboundSnapshot.agents.find((agent) => agent.id === observer.agentId)?.channels).toContain(
        created.channelId,
      )
      expect(reboundSnapshot.channels.find((channel) => channel.id === created.channelId)?.bindings).toEqual([
        expect.objectContaining({ agentId: observer.agentId, triggerPolicy: 'observe-only' }),
      ])

      const extraChannelResponse = await fetch(`${origin}/api/channels`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: '独立网页台' }),
      })
      expect(extraChannelResponse.status).toBe(201)
      const extraChannel = HostApiContracts.createInternalChannel.parseResponse(await extraChannelResponse.json())
      const extraSnapshot = HostApiContracts.snapshot.parseResponse(
        await (await fetch(`${origin}/api/snapshot`)).json(),
      )
      expect(extraSnapshot.channels.find((channel) => channel.id === extraChannel.channelId)).toMatchObject({
        displayName: '独立网页台',
        kind: 'internal',
        bindings: [],
      })

      const clearResponse = await fetch(`${origin}/api/bindings/${created.channelId}`, { method: 'DELETE' })
      expect(clearResponse.status).toBe(200)
      const clearedSnapshot = HostApiContracts.snapshot.parseResponse(
        await (await fetch(`${origin}/api/snapshot`)).json(),
      )
      expect(clearedSnapshot.channels.find((channel) => channel.id === created.channelId)?.boundAgentId).toBeUndefined()
      expect(clearedSnapshot.channels.find((channel) => channel.id === created.channelId)?.bindings).toEqual([])
    } finally {
      api.dispose()
      await webContext.fiber.dispose()
      await runtime.dispose()
    }
  })

  it('creates a new AgentRevision when capabilities change through the API', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-cap-api-'))
    temporaryDirectories.push(directory)
    const runtime = await NekroRuntime.create({
      coreDatabasePath: path.join(directory, 'core.sqlite'),
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      assetRoot: path.join(directory, 'assets'),
      extensionDataRoot: path.join(directory, 'extension-data'),
      extensionCacheRoot: path.join(directory, 'extension-cache'),
    })
    const seeded = runtime.core.createAgentWithChannel(
      {
        displayName: '能力智能体',
        persona: '',
        model: { provider: 'test-provider', model: 'chat-model' },
      },
      {
        connectionId: runtime.internalConnectionId,
        kind: 'internal',
        triggerPolicy: 'always',
      },
    )
    const entity = { agentId: seeded.definition.id, channelId: seeded.channel.id }
    const before = runtime.repository.getAgent(entity.agentId)!
    const webContext = new Context()
    await webContext.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const api = createNekroHostApi(webContext.webServer, runtime)
    const origin = `http://127.0.0.1:${api.port}`
    try {
      const response = await fetch(`${origin}/api/agents/${entity.agentId}/capabilities`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dynamicCreation: true }),
      })
      expect(response.ok).toBe(true)
      const result = HostApiContracts.updateAgentCapabilities.parseResponse(await response.json())
      expect(result.capabilities).toMatchObject({
        dynamicCreation: true,
        developmentShell: false,
        unrestrictedFileAccess: false,
      })
      // 不可变 Revision：新 Revision id 与原不同。
      expect(result.currentRevisionId).not.toBe(before.revision.id)

      const restoredResponse = await fetch(`${origin}/api/agents/${entity.agentId}/capabilities`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dynamicCreation: false }),
      })
      expect(restoredResponse.ok).toBe(true)
      const restored = HostApiContracts.updateAgentCapabilities.parseResponse(await restoredResponse.json())
      expect(restored.currentRevisionId).toBe(before.revision.id)
      expect(restored.capabilities.dynamicCreation).toBe(false)
    } finally {
      api.dispose()
      await webContext.fiber.dispose()
      await runtime.dispose()
    }
  })

  it('keeps command network and linked account grants through the capabilities API, and rejects unknown accounts', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-accounts-api-'))
    temporaryDirectories.push(directory)
    // GitHub answers for one fictional token; every other request, the test's own included, goes out as usual.
    const realFetch = globalThis.fetch
    const githubStub: typeof fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (!url.startsWith('https://api.github.com/')) return realFetch(input, init)
      const accepted = new Headers(init?.headers).get('authorization') === 'Bearer tok-fixture'
      return Promise.resolve(new Response(JSON.stringify({ login: 'octo-fixture' }), { status: accepted ? 200 : 401 }))
    }
    globalThis.fetch = githubStub
    const runtime = await NekroRuntime.create({
      coreDatabasePath: path.join(directory, 'core.sqlite'),
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      assetRoot: path.join(directory, 'assets'),
      extensionDataRoot: path.join(directory, 'extension-data'),
      extensionCacheRoot: path.join(directory, 'extension-cache'),
    })
    const seeded = runtime.core.createAgentWithChannel(
      { displayName: '账号智能体', persona: '', model: { provider: 'test-provider', model: 'chat-model' } },
      { connectionId: runtime.internalConnectionId, kind: 'internal', triggerPolicy: 'always' },
    )
    const agentId = seeded.definition.id
    const webContext = new Context()
    await webContext.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const api = createNekroHostApi(webContext.webServer, runtime)
    const origin = `http://127.0.0.1:${api.port}`
    const post = (body: unknown) =>
      fetch(`${origin}/api/agents/${agentId}/capabilities`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    try {
      const network = HostApiContracts.updateAgentCapabilities.parseResponse(
        await (await post({ commandNetwork: false })).json(),
      )
      expect(network.capabilities.commandNetwork).toBe(false)
      expect(runtime.repository.getAgent(agentId)?.revision.capabilities.commandNetwork).toBe(false)

      const unknown = await post({ commandAccounts: [{ service: 'github', accountId: 'nope' }] })
      expect(unknown.ok).toBe(false)
      expect(runtime.repository.getAgent(agentId)?.revision.capabilities.commandAccounts).toEqual([])

      // 关联账号: a token GitHub accepts becomes an account; the library grants nothing by itself.
      const json = { 'content-type': 'application/json' }
      const added = await fetch(`${origin}/api/settings/linked-accounts`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ platform: 'github', method: 'token', token: 'tok-fixture' }),
      })
      expect(added.ok).toBe(true)
      const addedView = HostApiContracts.addLinkedAccount.parseResponse(await added.json())
      expect(addedView.platforms.map((platform) => [platform.id, platform.name, platform.addMethods])).toEqual([
        ['github', 'GitHub', ['token', 'gh-login']],
      ])
      expect(addedView.platforms[0]?.tool).toMatchObject({ id: 'github-cli', name: 'GitHub CLI' })
      const [account] = addedView.platforms[0]!.accounts
      expect(account).toMatchObject({ login: 'octo-fixture', source: 'token', grantedAgentIds: [], available: true })
      // Credentials stay generic: the account is not one of them.
      expect(runtime.credentialLibrary.list()).toEqual([])

      const granted = HostApiContracts.updateAgentCapabilities.parseResponse(
        await (
          await post({ commandAccounts: [{ service: 'github', accountId: account!.id, usage: ['issues'] }] })
        ).json(),
      )
      expect(granted.capabilities.commandAccounts).toEqual([
        { service: 'github', accountId: account!.id, usage: ['issues'] },
      ])
      const listed = HostApiContracts.getLinkedAccounts.parseResponse(
        await (await fetch(`${origin}/api/settings/linked-accounts`)).json(),
      )
      expect(listed.platforms[0]?.accounts[0]?.grantedAgentIds).toEqual([agentId])
      expect(JSON.stringify(listed)).not.toContain('tok-fixture')
      const uses = await fetch(`${origin}/api/settings/linked-accounts/${account!.id}/uses`)
      expect(HostApiContracts.getLinkedAccountUses.parseResponse(await uses.json())).toEqual({ uses: [] })

      // Another account's token does not replace this one's.
      const replaced = await fetch(`${origin}/api/settings/linked-accounts/${account!.id}/token`, {
        method: 'PUT',
        headers: json,
        body: JSON.stringify({ method: 'token', token: 'tok-unknown' }),
      })
      expect(replaced.status).toBe(400)

      // Removing a granted account first lists who has it, then goes once confirmed.
      const remove = (confirm: boolean) =>
        fetch(`${origin}/api/settings/linked-accounts/${account!.id}/remove`, {
          method: 'POST',
          headers: json,
          body: JSON.stringify({ confirm }),
        })
      expect(HostApiContracts.removeLinkedAccount.parseResponse(await (await remove(false)).json())).toEqual({
        removed: false,
        grantedAgentIds: [agentId],
      })
      const removed = HostApiContracts.removeLinkedAccount.parseResponse(await (await remove(true)).json())
      expect(removed.removed && removed.view.platforms[0]?.accounts).toEqual([])
      expect(runtime.linkedAccounts.list()).toEqual([])
      expect((await fetch(`${origin}/api/settings/command-accounts`)).ok).toBe(false)
    } finally {
      globalThis.fetch = realFetch
      api.dispose()
      await webContext.fiber.dispose()
      await runtime.dispose()
    }
  })

  it('resets channel context with optimistic concurrency and tombstones an intelligent-agent', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-context-api-'))
    temporaryDirectories.push(directory)
    const runtime = await NekroRuntime.create({
      coreDatabasePath: path.join(directory, 'core.sqlite'),
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      assetRoot: path.join(directory, 'assets'),
      extensionDataRoot: path.join(directory, 'extension-data'),
      extensionCacheRoot: path.join(directory, 'extension-cache'),
      configureLlm: (context: Context) => {
        context.llm.registerAdapter(['test-provider'], new ScriptedCommunicationModel())
      },
    })
    const seeded = runtime.core.createAgentWithChannel(
      {
        displayName: '上下文测试智能体',
        persona: '',
        model: { provider: 'test-provider', model: 'chat-model' },
      },
      {
        connectionId: runtime.internalConnectionId,
        kind: 'internal',
        triggerPolicy: 'always',
      },
    )
    await runtime.start()
    await runtime.recover()
    const webContext = new Context()
    await webContext.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const api = createNekroHostApi(webContext.webServer, runtime)
    const origin = `http://127.0.0.1:${api.port}`
    const admit = (dedupeKey: string) =>
      runtime.channels.acceptChannelInbound({
        connectionId: runtime.internalConnectionId,
        channelId: seeded.channel.id,
        adapterKey: runtime.core.getConnection(runtime.internalConnectionId)!.adapterKey,
        kind: 'message-created',
        parts: [{ type: 'text', text: dedupeKey }],
        platformTimestamp: Date.now(),
        receivedAt: Date.now(),
        dedupeKey,
      })

    try {
      await admit('context-before-compact')
      const first = runtime.repository.getActiveEpisode(seeded.channel.id, seeded.definition.id)!
      const stale = await fetch(`${origin}/api/channels/${seeded.channel.id}/context-reset`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'compact', expectedEpisodeId: 'eps_STALE' }),
      })
      expect(stale.status).toBe(409)

      const contextReset = (mode: 'compact' | 'clear', expectedEpisodeId: string) =>
        fetch(`${origin}/api/channels/${seeded.channel.id}/context-reset`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode, expectedEpisodeId }),
        })
      const channelRuntime = async () =>
        HostApiContracts.getChannelRuntime.parseResponse(
          await (await fetch(`${origin}/api/channels/${seeded.channel.id}/runtime`)).json(),
        )

      // Compaction answers before the summary is written; the channel shows it until the new session opens.
      const resetEpisode = runtime.channels.resetEpisode.bind(runtime.channels)
      let release!: () => void
      const held = new Promise<void>((resolve) => (release = resolve))
      const spy = vi.spyOn(runtime.channels, 'resetEpisode').mockImplementationOnce(async (...args) => {
        await held
        return resetEpisode(...args)
      })
      const compactResponse = await contextReset('compact', first.id)
      expect(compactResponse.status, await compactResponse.clone().text()).toBe(200)
      const compacted = HostApiContracts.resetChannelContext.parseResponse(await compactResponse.json())
      expect(compacted).toEqual({ mode: 'compact', closedEpisodeId: first.id })
      expect((await channelRuntime()).compaction).toMatchObject({ kind: 'new-session' })
      expect((await contextReset('clear', first.id)).status).toBe(409)
      release()
      await spy.mock.results[0]!.value
      expect((await channelRuntime()).compaction).toBeUndefined()
      expect(runtime.repository.getEpisode(first.id)).toMatchObject({ closeReason: 'context-compacted' })
      const second = runtime.repository.getActiveEpisode(seeded.channel.id, seeded.definition.id)!
      expect(second.id).not.toBe(first.id)

      // A failure stays on the channel until the next compaction starts.
      spy.mockRejectedValueOnce(new Error('摘要模型不可用'))
      expect((await contextReset('compact', second.id)).status).toBe(200)
      await expect(spy.mock.results[1]!.value).rejects.toThrow('摘要模型不可用')
      expect((await channelRuntime()).compactionFailure).toMatchObject({ message: '摘要模型不可用' })
      expect((await channelRuntime()).compaction).toBeUndefined()
      spy.mockRestore()

      const clearResponse = await contextReset('clear', second.id)
      expect(clearResponse.status, await clearResponse.clone().text()).toBe(200)
      const cleared = HostApiContracts.resetChannelContext.parseResponse(await clearResponse.json())
      expect(cleared).toEqual({ mode: 'clear', closedEpisodeId: second.id })
      expect(runtime.repository.getActiveEpisode(seeded.channel.id, seeded.definition.id)).toBeUndefined()

      const removableChannel = runtime.core.createChannel({
        connectionId: runtime.internalConnectionId,
        platformChannelId: 'manual-removable-channel',
        kind: 'internal',
        displayName: '可删除内置频道',
      })
      runtime.core.createBinding({
        channelId: removableChannel.id,
        agentId: seeded.definition.id,
        triggerPolicy: 'always',
      })
      const removableEvent = await runtime.channels.acceptChannelInbound({
        connectionId: runtime.internalConnectionId,
        channelId: removableChannel.id,
        adapterKey: runtime.core.getConnection(runtime.internalConnectionId)!.adapterKey,
        kind: 'message-created',
        parts: [{ type: 'text', text: '频道删除前的历史' }],
        platformTimestamp: Date.now(),
        receivedAt: Date.now(),
        dedupeKey: 'channel-before-delete',
      })
      const staleChannelDelete = await fetch(`${origin}/api/channels/${removableChannel.id}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedBoundAgentId: null }),
      })
      expect(staleChannelDelete.status).toBe(409)
      const channelDelete = await fetch(`${origin}/api/channels/${removableChannel.id}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedBoundAgentId: seeded.definition.id }),
      })
      expect(channelDelete.status, await channelDelete.clone().text()).toBe(200)
      expect(HostApiContracts.deleteChannel.parseResponse(await channelDelete.json())).toEqual({
        channelId: removableChannel.id,
        deleted: true,
      })
      expect(runtime.repository.getChannel(removableChannel.id)).toBeUndefined()
      expect(runtime.repository.getChannelEvent(removableEvent.channelEventId)).toBeDefined()

      await admit('context-before-delete')
      const wrongConfirmation = await fetch(`${origin}/api/agents/${seeded.definition.id}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedCurrentRevisionId: seeded.revision.id,
          confirmationName: '名称不匹配',
        }),
      })
      expect(wrongConfirmation.status).toBe(400)

      const deleteResponse = await fetch(`${origin}/api/agents/${seeded.definition.id}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedCurrentRevisionId: seeded.revision.id,
          confirmationName: seeded.revision.displayName,
        }),
      })
      expect(deleteResponse.status, await deleteResponse.clone().text()).toBe(200)
      expect(HostApiContracts.deleteAgent.parseResponse(await deleteResponse.json())).toEqual({
        agentId: seeded.definition.id,
        deleted: true,
        unboundChannelIds: [],
        deletedChannelIds: [seeded.channel.id],
      })
      expect(runtime.repository.getAgent(seeded.definition.id)).toBeUndefined()
      expect(runtime.repository.getAgentRevision(seeded.revision.id)).toEqual(seeded.revision)
      expect(runtime.repository.getChannel(seeded.channel.id)).toBeUndefined()
      expect(runtime.repository.getBinding(seeded.channel.id)).toBeUndefined()
      const snapshot = HostApiContracts.snapshot.parseResponse(await (await fetch(`${origin}/api/snapshot`)).json())
      expect(snapshot.agents.some((agent) => agent.id === seeded.definition.id)).toBe(false)
      expect(snapshot.channels.some((channel) => channel.id === seeded.channel.id)).toBe(false)

      const mixed = runtime.core.createAgentWithChannel(
        {
          displayName: '混合频道智能体',
          persona: '',
          model: { provider: 'test-provider', model: 'chat-model' },
        },
        { connectionId: runtime.internalConnectionId, kind: 'internal', triggerPolicy: 'always' },
      )
      const manualBuiltIn = runtime.core.createChannel({
        connectionId: runtime.internalConnectionId,
        platformChannelId: 'manual-built-in-kept',
        kind: 'internal',
      })
      const external = runtime.core.createChannel({
        connectionId: runtime.internalConnectionId,
        platformChannelId: 'external-kept',
        kind: 'group',
      })
      runtime.core.createBinding({
        channelId: manualBuiltIn.id,
        agentId: mixed.definition.id,
        triggerPolicy: 'always',
      })
      runtime.core.createBinding({ channelId: external.id, agentId: mixed.definition.id, triggerPolicy: 'always' })
      const mixedWorkspace = path.join(runtime.workspaceRoot, mixed.definition.id)
      await mkdir(mixedWorkspace, { recursive: true })
      await writeFile(path.join(mixedWorkspace, 'note.txt'), '虚构样本')
      const mixedDelete = await fetch(`${origin}/api/agents/${mixed.definition.id}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedCurrentRevisionId: mixed.revision.id,
          confirmationName: mixed.revision.displayName,
          deleteAutoCreatedBuiltInChannels: true,
          deleteWorkspace: true,
        }),
      })
      expect(mixedDelete.status, await mixedDelete.clone().text()).toBe(200)
      expect(HostApiContracts.deleteAgent.parseResponse(await mixedDelete.json())).toEqual({
        agentId: mixed.definition.id,
        deleted: true,
        unboundChannelIds: [manualBuiltIn.id, external.id],
        deletedChannelIds: [mixed.channel.id],
      })
      expect(runtime.repository.getChannel(mixed.channel.id)).toBeUndefined()
      expect(existsSync(mixedWorkspace)).toBe(false)
      expect(runtime.repository.getChannel(manualBuiltIn.id)).toBeDefined()
      expect(runtime.repository.getChannel(external.id)).toBeDefined()
      expect(runtime.repository.getBinding(manualBuiltIn.id)).toBeUndefined()
      expect(runtime.repository.getBinding(external.id)).toBeUndefined()

      const kept = runtime.core.createAgentWithChannel(
        {
          displayName: '保留频道智能体',
          persona: '',
          model: { provider: 'test-provider', model: 'chat-model' },
        },
        { connectionId: runtime.internalConnectionId, kind: 'internal', triggerPolicy: 'always' },
      )
      const keptWorkspace = path.join(runtime.workspaceRoot, kept.definition.id)
      await mkdir(keptWorkspace, { recursive: true })
      const keptDelete = await fetch(`${origin}/api/agents/${kept.definition.id}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedCurrentRevisionId: kept.revision.id,
          confirmationName: kept.revision.displayName,
          deleteAutoCreatedBuiltInChannels: false,
        }),
      })
      expect(keptDelete.status, await keptDelete.clone().text()).toBe(200)
      expect(HostApiContracts.deleteAgent.parseResponse(await keptDelete.json())).toEqual({
        agentId: kept.definition.id,
        deleted: true,
        unboundChannelIds: [kept.channel.id],
        deletedChannelIds: [],
      })
      expect(runtime.repository.getChannel(kept.channel.id)).toBeDefined()
      expect(existsSync(keptWorkspace)).toBe(true)
      expect(runtime.repository.getBinding(kept.channel.id)).toBeUndefined()
    } finally {
      api.dispose()
      await webContext.fiber.dispose()
      await runtime.dispose()
    }
  })

  it('clears the history of a channel physically and keeps its binding for a fresh conversation', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-history-purge-api-'))
    temporaryDirectories.push(directory)
    const runtime = await NekroRuntime.create({
      coreDatabasePath: path.join(directory, 'core.sqlite'),
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      assetRoot: path.join(directory, 'assets'),
      extensionDataRoot: path.join(directory, 'extension-data'),
      extensionCacheRoot: path.join(directory, 'extension-cache'),
      configureLlm: (context: Context) => {
        context.llm.registerAdapter(['test-provider'], new ScriptedCommunicationModel())
      },
    })
    const seeded = runtime.core.createAgentWithChannel(
      { displayName: '清除测试智能体', persona: '', model: { provider: 'test-provider', model: 'chat-model' } },
      { connectionId: runtime.internalConnectionId, kind: 'internal', triggerPolicy: 'always' },
    )
    await runtime.start()
    await runtime.recover()
    const webContext = new Context()
    await webContext.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const api = createNekroHostApi(webContext.webServer, runtime)
    const origin = `http://127.0.0.1:${api.port}`
    const channelId = seeded.channel.id
    const adapterKey = runtime.core.getConnection(runtime.internalConnectionId)!.adapterKey
    const purgeUrl = `${origin}/api/channels/${channelId}/history-purge`
    const purge = (expectedBoundAgentId: string | null) =>
      fetch(purgeUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedBoundAgentId }),
      })
    const sessionDirectories = async (): Promise<string[]> => {
      const root = path.join(directory, 'dsh', 'sessions')
      if (!existsSync(root)) return []
      const { readdir } = await import('node:fs/promises')
      const found: string[] = []
      for (const project of await readdir(root)) found.push(...(await readdir(path.join(root, project))))
      return found
    }

    try {
      const { asset } = await runtime.assetService.prepare({ bytes: new TextEncoder().encode('清除前的附件') })
      await runtime.channels.acceptChannelInbound({
        connectionId: runtime.internalConnectionId,
        channelId,
        adapterKey,
        kind: 'message-created',
        parts: [
          { type: 'text', text: '清除前的消息' },
          { type: 'file', assetId: asset.id, name: 'notes.txt' },
        ],
        platformTimestamp: Date.now(),
        receivedAt: Date.now(),
        dedupeKey: 'before-history-purge',
        assetOccurrences: [{ partIndex: 1, assetId: asset.id }],
      })
      const first = runtime.repository.getActiveEpisode(channelId, seeded.definition.id)!
      await vi.waitFor(() =>
        expect(
          runtime.repository
            .listChannelHistory(channelId, { limit: 10 })
            .some((entry) => entry.source === 'outbound-intent' && entry.state === 'sent'),
        ).toBe(true),
      )
      await vi.waitFor(async () => expect(await sessionDirectories()).toContain(first.dshSessionId))

      const preview = HostApiContracts.previewChannelHistoryPurge.parseResponse(await (await fetch(purgeUrl)).json())
      expect(preview).toEqual({ messages: 2, conversations: 1, attachments: 1 })

      const compacting = vi.spyOn(runtime.host, 'manualCompactionRunning').mockReturnValue(true)
      expect(
        HostApiContracts.previewChannelHistoryPurge.parseResponse(await (await fetch(purgeUrl)).json()).blockedReason,
      ).toBe('上下文正在压缩，完成后再清除。')
      const blocked = await purge(seeded.definition.id)
      expect(blocked.status).toBe(409)
      expect(await blocked.text()).toContain('上下文正在压缩')
      compacting.mockRestore()
      expect(runtime.repository.getActiveEpisode(channelId, seeded.definition.id)?.id).toBe(first.id)

      expect((await purge(null)).status).toBe(409)
      const prepared = vi.spyOn(runtime.assetService, 'preparedRecently').mockReturnValue(false)
      const response = await purge(seeded.definition.id)
      prepared.mockRestore()
      expect(response.status, await response.clone().text()).toBe(200)
      expect(HostApiContracts.purgeChannelHistory.parseResponse(await response.json())).toEqual({
        messages: 2,
        conversations: 1,
        attachments: 1,
      })
      expect(runtime.repository.listChannelHistory(channelId, { limit: 10 })).toEqual([])
      expect(runtime.repository.getEpisode(first.id)).toBeUndefined()
      expect(runtime.repository.getAssetById(asset.id)).toBeUndefined()
      expect(existsSync(runtime.assetService.blobPath(asset))).toBe(false)
      expect(await sessionDirectories()).not.toContain(first.dshSessionId)
      expect(runtime.repository.getBinding(channelId)?.agentId).toBe(seeded.definition.id)

      await runtime.channels.acceptChannelInbound({
        connectionId: runtime.internalConnectionId,
        channelId,
        adapterKey,
        kind: 'message-created',
        parts: [{ type: 'text', text: '清除后的第一条' }],
        platformTimestamp: Date.now(),
        receivedAt: Date.now(),
        dedupeKey: 'after-history-purge',
      })
      const fresh = runtime.repository.getActiveEpisode(channelId, seeded.definition.id)
      expect(fresh?.id).toBeDefined()
      expect(fresh?.id).not.toBe(first.id)
      await vi.waitFor(() =>
        expect(
          runtime.repository
            .listChannelHistory(channelId, { limit: 10 })
            .some((entry) => entry.source === 'outbound-intent' && entry.state === 'sent'),
        ).toBe(true),
      )
    } finally {
      api.dispose()
      await webContext.fiber.dispose()
      await runtime.dispose()
    }
  })

  it('defaults Web Search on only when the DSH Provider credential is ready', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-cap-default-api-'))
    temporaryDirectories.push(directory)
    const dshRoot = path.join(directory, 'dsh')
    await mkdir(dshRoot, { recursive: true })
    const runtime = await NekroRuntime.create({
      coreDatabasePath: path.join(directory, 'core.sqlite'),
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      assetRoot: path.join(directory, 'assets'),
      extensionDataRoot: path.join(directory, 'extension-data'),
      extensionCacheRoot: path.join(directory, 'extension-cache'),
      llmSettingsPath: path.join(dshRoot, 'settings.yaml'),
      llmCredentialPath: path.join(dshRoot, 'credentials.yaml'),
      configureLlm: async (context: Context) => {
        context.llm.registerAdapter(['test-provider'], new ScriptedCommunicationModel())
        await context.credentials.set(credentialRef('DEEPSEEK_API_KEY'), 'configured-test-key')
      },
    })
    const webContext = new Context()
    await webContext.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const api = createNekroHostApi(webContext.webServer, runtime)
    const origin = `http://127.0.0.1:${api.port}`
    try {
      const response = await fetch(`${origin}/api/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          displayName: '搜索默认智能体',
          persona: '',
          model: { provider: 'test-provider', model: 'chat-model' },
        }),
      })
      expect(response.status, await response.clone().text()).toBe(201)
      const created = HostApiContracts.createAgent.parseResponse(await response.json())
      expect(runtime.repository.getAgent(created.agentId)?.revision.capabilities).toMatchObject({
        subagents: true,
        fileTools: false,
        webSearch: true,
      })
    } finally {
      api.dispose()
      await webContext.fiber.dispose()
      await runtime.dispose()
    }
  })

  it('tests the current provider draft without mutating saved settings or credentials', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-llm-draft-test-'))
    temporaryDirectories.push(directory)
    const upstreamRequests: Array<{ readonly authorization?: string; readonly url?: string; readonly body: string }> =
      []
    const upstream = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        upstreamRequests.push({
          ...(request.headers.authorization === undefined ? {} : { authorization: request.headers.authorization }),
          ...(request.url === undefined ? {} : { url: request.url }),
          body: Buffer.concat(chunks).toString('utf8'),
        })
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'synthetic rejected credential' } }))
      })
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const address = upstream.address()
    if (address === null || typeof address === 'string')
      throw new TypeError('Draft upstream did not expose a TCP port.')
    const dshRoot = path.join(directory, 'dsh')
    const runtime = await NekroRuntime.create({
      coreDatabasePath: path.join(directory, 'core.sqlite'),
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      assetRoot: path.join(directory, 'assets'),
      extensionDataRoot: path.join(directory, 'extension-data'),
      extensionCacheRoot: path.join(directory, 'extension-cache'),
      llmSettingsPath: path.join(dshRoot, 'settings.yaml'),
      llmCredentialPath: path.join(dshRoot, 'credentials.yaml'),
      configureLlm: configureDshLlmProviders([]),
    })
    const webContext = new Context()
    await webContext.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const api = createNekroHostApi(webContext.webServer, runtime)
    const origin = `http://127.0.0.1:${api.port}`
    try {
      const directoryView = await runtime.host.getLlmProviderSettings()
      const settingsRevision = directoryView.providers[0]?.settingsRevision
      if (settingsRevision === undefined) throw new TypeError('Missing draft-test settings revision.')
      await runtime.host.saveLlmProvider({
        provider: 'draft-gateway',
        expectedRevision: settingsRevision,
        apiKey: 'saved-provider-key',
        displayName: 'Saved gateway',
        baseURL: 'https://saved.example.test/v1',
        api: 'openai-completions',
        models: [{ id: 'saved-model' }],
      })
      const before = await runtime.host.getLlmProviderSettings()
      const beforeProvider = before.providers.find((provider) => provider.provider === 'draft-gateway')
      if (!beforeProvider) throw new TypeError('Saved draft-test provider is missing.')

      const draftKey = 'synthetic-draft-key'
      const response = await fetch(`${origin}/api/llm/test-provider`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: 'draft-gateway',
          model: 'draft-model',
          settingsNs: 'llm-pi-ai',
          apiKey: draftKey,
          baseURL: `http://127.0.0.1:${address.port}/v1`,
          api: 'openai-completions',
          models: [{ id: 'draft-model' }],
        }),
      })
      expect(response.status).toBe(400)
      const responseText = await response.text()
      expect(responseText).toContain('认证失败')
      expect(responseText).not.toContain(draftKey)
      expect(responseText).not.toContain('saved-provider-key')
      expect(upstreamRequests).toHaveLength(1)
      expect(upstreamRequests[0]).toMatchObject({
        authorization: `Bearer ${draftKey}`,
        url: '/v1/chat/completions',
      })
      expect(JSON.parse(upstreamRequests[0]!.body)).toMatchObject({ model: 'draft-model' })

      const after = await runtime.host.getLlmProviderSettings()
      const afterProvider = after.providers.find((provider) => provider.provider === 'draft-gateway')
      expect(afterProvider).toMatchObject({
        settingsRevision: beforeProvider.settingsRevision,
        baseURL: 'https://saved.example.test/v1',
        api: 'openai-completions',
        models: [{ id: 'saved-model', name: 'saved-model' }],
        credential: { configured: true },
      })
    } finally {
      api.dispose()
      await webContext.fiber.dispose()
      await runtime.dispose()
      await new Promise<void>((resolve, reject) =>
        upstream.close((error) => {
          if (error) reject(error)
          else resolve()
        }),
      )
    }
  })

  it('tests an unsaved DeepSeek key, and the saved key when the key field is left empty', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-llm-deepseek-draft-'))
    temporaryDirectories.push(directory)
    const upstreamRequests: Array<{ readonly apiKey?: string; readonly url?: string }> = []
    const upstream = createServer((request, response) => {
      request.resume()
      request.on('end', () => {
        const apiKey = request.headers['x-api-key']
        upstreamRequests.push({
          ...(typeof apiKey === 'string' ? { apiKey } : {}),
          ...(request.url === undefined ? {} : { url: request.url }),
        })
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'synthetic rejected credential' } }))
      })
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const address = upstream.address()
    if (address === null || typeof address === 'string')
      throw new TypeError('DeepSeek upstream did not expose a TCP port.')
    const dshRoot = path.join(directory, 'dsh')
    const runtime = await NekroRuntime.create({
      coreDatabasePath: path.join(directory, 'core.sqlite'),
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      assetRoot: path.join(directory, 'assets'),
      extensionDataRoot: path.join(directory, 'extension-data'),
      extensionCacheRoot: path.join(directory, 'extension-cache'),
      llmSettingsPath: path.join(dshRoot, 'settings.yaml'),
      llmCredentialPath: path.join(dshRoot, 'credentials.yaml'),
      configureLlm: configureDshLlmProviders([]),
    })
    const webContext = new Context()
    await webContext.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const api = createNekroHostApi(webContext.webServer, runtime)
    const origin = `http://127.0.0.1:${api.port}`
    const testProvider = (body: Record<string, unknown>): Promise<Response> =>
      fetch(`${origin}/api/llm/test-provider`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: 'deepseek-official',
          model: 'deepseek-flash',
          settingsNs: 'llm-deepseek',
          baseURL: `http://127.0.0.1:${address.port}/anthropic`,
          ...body,
        }),
      })
    try {
      const before = await runtime.host.getLlmProviderSettings()
      const deepseek = before.providers.find((provider) => provider.provider === 'deepseek-official')
      if (!deepseek) throw new TypeError('DeepSeek provider is missing.')
      await runtime.host.saveLlmProvider({
        provider: 'deepseek-official',
        expectedRevision: deepseek.settingsRevision,
        apiKey: 'saved-deepseek-key',
      })
      const saved = (await runtime.host.getLlmProviderSettings()).providers.find(
        (provider) => provider.provider === 'deepseek-official',
      )

      const draftKey = 'synthetic-deepseek-draft-key'
      const withDraftKey = await testProvider({ apiKey: draftKey })
      expect(withDraftKey.status).toBe(400)
      const draftText = await withDraftKey.text()
      expect(draftText).toContain('认证失败')
      expect(draftText).not.toContain(draftKey)

      const withSavedKey = await testProvider({})
      expect(withSavedKey.status).toBe(400)
      expect(await withSavedKey.text()).toContain('认证失败')

      expect(upstreamRequests).toEqual([
        { apiKey: draftKey, url: '/anthropic/v1/messages' },
        { apiKey: 'saved-deepseek-key', url: '/anthropic/v1/messages' },
      ])
      const after = (await runtime.host.getLlmProviderSettings()).providers.find(
        (provider) => provider.provider === 'deepseek-official',
      )
      expect(after).toMatchObject({
        settingsRevision: saved?.settingsRevision,
        credential: { configured: true },
      })
      expect(after?.baseURL).toBe(saved?.baseURL)
    } finally {
      api.dispose()
      await webContext.fiber.dispose()
      await runtime.dispose()
      await new Promise<void>((resolve, reject) =>
        upstream.close((error) => {
          if (error) reject(error)
          else resolve()
        }),
      )
    }
  })

  it('records the latest connection test per saved configuration without keeping any key', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-llm-test-record-'))
    temporaryDirectories.push(directory)
    let accept = false
    const upstream = createServer((request, response) => {
      request.resume()
      request.on('end', () => {
        if (!accept) {
          response.writeHead(401, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: { message: 'synthetic rejected credential' } }))
          return
        }
        const chunk = (delta: Record<string, unknown>, finish: string | null) =>
          `data: ${JSON.stringify({
            id: 'chatcmpl-fixture',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'probe-model',
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(`${chunk({ role: 'assistant', content: 'OK' }, null)}${chunk({}, 'stop')}data: [DONE]\n\n`)
      })
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const address = upstream.address()
    if (address === null || typeof address === 'string') throw new TypeError('Upstream did not expose a TCP port.')
    const baseURL = `http://127.0.0.1:${address.port}/v1`
    const dshRoot = path.join(directory, 'dsh')
    const runtime = await NekroRuntime.create({
      coreDatabasePath: path.join(directory, 'core.sqlite'),
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      assetRoot: path.join(directory, 'assets'),
      extensionDataRoot: path.join(directory, 'extension-data'),
      extensionCacheRoot: path.join(directory, 'extension-cache'),
      llmSettingsPath: path.join(dshRoot, 'settings.yaml'),
      llmCredentialPath: path.join(dshRoot, 'credentials.yaml'),
      configureLlm: configureDshLlmProviders([]),
    })
    const webContext = new Context()
    await webContext.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const api = createNekroHostApi(webContext.webServer, runtime)
    const origin = `http://127.0.0.1:${api.port}`
    const savedKey = 'synthetic-saved-probe-key'
    const view = async () => {
      const settings = HostApiContracts.llmProviders.parseResponse(
        await (await fetch(`${origin}/api/llm/providers`)).json(),
      )
      const provider = settings.providers.find((entry) => entry.provider === 'probe-gateway')
      if (!provider) throw new TypeError('Probe provider is missing.')
      return provider
    }
    // What the settings page sends: the saved address and protocol, the model list and no new key.
    const testSaved = (overrides: Record<string, unknown> = {}) =>
      fetch(`${origin}/api/llm/test-provider`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: 'probe-gateway',
          model: 'probe-model',
          settingsNs: 'llm-pi-ai',
          baseURL,
          api: 'openai-completions',
          models: [{ id: 'probe-model' }],
          ...overrides,
        }),
      })
    try {
      const revision = (await runtime.host.getLlmProviderSettings()).providers[0]?.settingsRevision
      if (revision === undefined) throw new TypeError('Missing settings revision.')
      await runtime.host.saveLlmProvider({
        provider: 'probe-gateway',
        expectedRevision: revision,
        apiKey: savedKey,
        displayName: 'Probe gateway',
        baseURL,
        api: 'openai-completions',
        models: [{ id: 'probe-model' }],
      })
      expect((await view()).lastTest).toBeNull()

      expect((await testSaved()).status).toBe(400)
      const failed = (await view()).lastTest
      expect(failed).toMatchObject({ ok: false, model: 'probe-model' })
      expect(failed?.message).toContain('认证失败')

      accept = true
      expect((await testSaved()).status).toBe(200)
      const passed = (await view()).lastTest
      expect(passed).toMatchObject({ ok: true, model: 'probe-model' })
      expect(passed).not.toHaveProperty('message')

      // An unsaved draft with another address keeps the saved configuration's result.
      accept = false
      expect(
        (await testSaved({ baseURL: `http://127.0.0.1:${address.port}/v2`, apiKey: 'synthetic-other-key' })).status,
      ).toBe(400)
      expect((await view()).lastTest).toEqual(passed)

      const stored = JSON.stringify(runtime.repository.getSystemSetting('llm.provider-test.probe-gateway')?.value)
      expect(stored).not.toContain(savedKey)
      expect(stored).not.toContain('synthetic-other-key')
      expect(stored).not.toContain('Bearer')
      expect(stored).not.toContain('这是一次连接测试')

      // A new key retires the result; so does a new address after a later test.
      await runtime.host.saveLlmProvider({
        provider: 'probe-gateway',
        expectedRevision: (await view()).settingsRevision,
        apiKey: 'synthetic-rotated-probe-key',
      })
      expect((await view()).lastTest).toBeNull()
      accept = true
      expect((await testSaved()).status).toBe(200)
      expect((await view()).lastTest).toMatchObject({ ok: true })
      await runtime.host.saveLlmProvider({
        provider: 'probe-gateway',
        expectedRevision: (await view()).settingsRevision,
        baseURL: `http://127.0.0.1:${address.port}/v3`,
      })
      expect((await view()).lastTest).toBeNull()

      await runtime.host.removeLlmProvider('probe-gateway', (await view()).settingsRevision)
      expect(runtime.repository.getSystemSetting('llm.provider-test.probe-gateway')?.value).toEqual({
        version: 1,
        entries: [],
      })
    } finally {
      api.dispose()
      await webContext.fiber.dispose()
      await runtime.dispose()
      await new Promise<void>((resolve, reject) =>
        upstream.close((error) => {
          if (error) reject(error)
          else resolve()
        }),
      )
    }
  })

  it('refuses proxied requests without sign-in in front, and keeps the access address', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-proxy-guard-'))
    temporaryDirectories.push(directory)
    const runtime = await NekroRuntime.create({
      coreDatabasePath: path.join(directory, 'core.sqlite'),
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      assetRoot: path.join(directory, 'assets'),
      extensionDataRoot: path.join(directory, 'extension-data'),
      extensionCacheRoot: path.join(directory, 'extension-cache'),
    })
    // Settings that would put such an instance behind a proxy are refused at startup.
    expect(() => checkSignInOptions({ trustProxy: true }, undefined)).toThrow('NEKRO_TRUST_PROXY')
    expect(() => checkSignInOptions({ developmentWebOrigin: 'http://127.0.0.1:4961' }, undefined)).toThrow(
      'NEKRO_DEV_WEB_ORIGIN',
    )
    expect(() => checkSignInOptions({ trustProxy: true }, 'k'.repeat(32))).not.toThrow()
    const distIndex = path.join(directory, 'index.html')
    await writeFile(distIndex, '<!doctype html><title>fixture</title>')
    const webContext = new Context()
    await webContext.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const api = createNekroHostApi(webContext.webServer, runtime, undefined, undefined, undefined, true)
    const disposeSpa = registerNekroSpaRoutes(webContext.webServer, distIndex, true)
    const origin = `http://127.0.0.1:${api.port}`
    try {
      expect((await fetch(`${origin}/api/snapshot`)).status).toBe(200)
      expect((await fetch(`${origin}/settings`)).status).toBe(200)
      // The entry page is compressed on request and always varies by encoding.
      const compressedPage = await fetch(`${origin}/settings`, { headers: { 'accept-encoding': 'gzip' } })
      expect(compressedPage.headers.get('vary')).toBe('accept-encoding')
      expect(compressedPage.headers.get('content-encoding')).toBe('gzip')
      expect(await compressedPage.text()).toContain('<title>fixture</title>')
      // The access address keeps only the origin and accepts only HTTPS.
      const put = (publicOrigin: string | null) =>
        fetch(`${origin}/api/settings/access`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ publicOrigin }),
        })
      expect(await (await put('https://nxt.example.test/')).json()).toEqual({
        publicOrigin: 'https://nxt.example.test',
      })
      expect(await (await fetch(`${origin}/api/settings/access`)).json()).toEqual({
        publicOrigin: 'https://nxt.example.test',
      })
      for (const invalid of ['http://nxt.example.test', 'https://nxt.example.test/app', 'nxt.example.test']) {
        expect((await put(invalid)).status).toBe(400)
      }
      expect(await (await put(null)).json()).toEqual({})
      for (const header of [
        { 'x-forwarded-for': `${testAddress(9)}` },
        { 'x-forwarded-proto': 'https' },
        { forwarded: `for=${testAddress(9)}` },
      ]) {
        const refused = await fetch(`${origin}/api/snapshot`, { headers: header })
        expect(refused.status).toBe(403)
        expect(await refused.text()).toContain('没有设置管理密钥')
        expect((await fetch(`${origin}/settings`, { headers: header })).status).toBe(403)
      }
    } finally {
      disposeSpa()
      api.dispose()
      await webContext.fiber.dispose()
      await runtime.dispose()
    }
  })

  it('persists notification settings and exposes a transient Desktop notification feed', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-notification-api-'))
    temporaryDirectories.push(directory)
    const runtime = await NekroRuntime.create({
      coreDatabasePath: path.join(directory, 'core.sqlite'),
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      assetRoot: path.join(directory, 'assets'),
      extensionDataRoot: path.join(directory, 'extension-data'),
      extensionCacheRoot: path.join(directory, 'extension-cache'),
    })
    const webContext = new Context()
    await webContext.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const api = createNekroHostApi(webContext.webServer, runtime)
    const origin = `http://127.0.0.1:${api.port}`
    try {
      const snapshot = HostApiContracts.snapshot.parseResponse(await (await fetch(`${origin}/api/snapshot`)).json())
      expect(snapshot.notificationSettings).toEqual({
        system: { enabled: true },
        bark: { enabled: false, serverUrl: 'https://api.day.app', deviceKeyConfigured: false },
        browserPush: { enabled: true },
        wecom: { enabled: false, webhookConfigured: false },
        ntfy: { enabled: false, serverUrl: 'https://ntfy.sh', topicConfigured: false, tokenConfigured: false },
        events: {
          'dynamic-client-approval-requested': true,
          'community-feedback-update': true,
          'credential-requested': true,
          'extension-notification': true,
        },
      })

      const connected = HostApiContracts.listClientNotifications.parseResponse(
        await (await fetch(`${origin}/api/client-notifications`)).json(),
      )
      expect(connected).toEqual({ cursor: 0, notifications: [] })

      const updatedResponse = await fetch(`${origin}/api/settings/notifications`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          system: { enabled: true },
          bark: {
            enabled: false,
            serverUrl: 'https://push.example.test',
            deviceKey: 'host-api-test-device-key',
          },
          events: { 'dynamic-client-approval-requested': true, 'extension-notification': false },
        }),
      })
      expect(updatedResponse.ok).toBe(true)
      expect(HostApiContracts.updateNotificationSettings.parseResponse(await updatedResponse.json())).toMatchObject({
        revision: 1,
        bark: { serverUrl: 'https://push.example.test', deviceKeyConfigured: true },
        events: { 'extension-notification': false },
      })

      const testResponse = await fetch(`${origin}/api/settings/notifications/test-system`, { method: 'POST' })
      expect(testResponse.ok).toBe(true)
      const feed = HostApiContracts.listClientNotifications.parseResponse(
        await (await fetch(`${origin}/api/client-notifications?cursor=${connected.cursor}`)).json(),
      )
      expect(feed.notifications).toEqual([expect.objectContaining({ title: 'NekroNXT 测试通知', route: '/settings' })])

      // A client that names its run waits for the next notification and gets it as soon as it is published.
      const run = HostApiContracts.listClientNotifications.parseResponse(
        await (await fetch(`${origin}/api/client-notifications?boot=`)).json(),
      )
      expect(run.bootId).toEqual(expect.any(String))
      const waiting = fetch(`${origin}/api/client-notifications?cursor=${run.cursor}&boot=${run.bootId}&wait=30`)
      await new Promise((resolve) => setTimeout(resolve, 50))
      await fetch(`${origin}/api/settings/notifications/test-system`, { method: 'POST' })
      expect(HostApiContracts.listClientNotifications.parseResponse(await (await waiting).json())).toMatchObject({
        cursor: run.cursor + 1,
        notifications: [{ title: 'NekroNXT 测试通知' }],
      })
      expect((await fetch(`${origin}/api/client-notifications?wait=31`)).status).toBe(400)

      // The local console has no login device: it can see subscriptions but not add one.
      expect(
        HostApiContracts.listPushSubscriptions.parseResponse(
          await (await fetch(`${origin}/api/push/subscriptions`)).json(),
        ),
      ).toEqual({ subscriptions: [] })
      const subscribe = await fetch(`${origin}/api/push/subscriptions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          endpoint: 'https://push.example.test/console',
          keys: { p256dh: 'synthetic-p256dh', auth: 'synthetic-auth' },
          label: 'Mac · Chrome',
        }),
      })
      expect(subscribe.status).toBe(403)
    } finally {
      api.dispose()
      await webContext.fiber.dispose()
      await runtime.dispose()
    }
  })

  it('round-trips image policy and only accepts an explicitly visual auxiliary model', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-image-policy-api-'))
    temporaryDirectories.push(directory)
    const runtime = await NekroRuntime.create({
      coreDatabasePath: path.join(directory, 'core.sqlite'),
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      assetRoot: path.join(directory, 'assets'),
      extensionDataRoot: path.join(directory, 'extension-data'),
      extensionCacheRoot: path.join(directory, 'extension-cache'),
      configureLlm: (context: Context) => {
        context.llm.registerAdapter(['text-provider'], new ScriptedCommunicationModel(false))
        context.llm.registerAdapter(['vision-provider'], new ScriptedCommunicationModel(true))
      },
    })
    const webContext = new Context()
    await webContext.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const api = createNekroHostApi(webContext.webServer, runtime)
    const origin = `http://127.0.0.1:${api.port}`
    const base = {
      displayName: '图片策略智能体',
      persona: '只报告可见证据。',
      model: { provider: 'text-provider', model: 'chat-model' },
    }
    const policy = {
      history: {
        mode: 'persistent-distinct' as const,
        detail: 'high' as const,
        restoreAfterCompaction: { recentMessages: 12, maxImages: 4 },
      },
      textModel: {
        mode: 'auxiliary' as const,
        model: { provider: 'vision-provider', model: 'chat-model' },
        maxTokens: 4096,
      },
    }
    try {
      for (const model of [
        { provider: 'text-provider', model: 'chat-model' },
        { provider: 'missing-provider', model: 'unknown-model' },
      ]) {
        const rejected = await fetch(`${origin}/api/agents`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...base,
            imagePolicy: { ...policy, textModel: { ...policy.textModel, model } },
          }),
        })
        expect(rejected.status).toBe(400)
      }

      const response = await fetch(`${origin}/api/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...base, imagePolicy: policy }),
      })
      expect(response.status).toBe(201)
      const created = HostApiContracts.createAgent.parseResponse(await response.json())
      let snapshot = HostApiContracts.snapshot.parseResponse(await (await fetch(`${origin}/api/snapshot`)).json())
      const initial = snapshot.agents.find((agent) => agent.id === created.agentId)!
      expect(initial.imagePolicy).toEqual(policy)
      expect(initial.imageDiagnostics).toMatchObject({
        route: { mode: 'delegated', provider: 'vision-provider', model: 'chat-model' },
        blockers: [],
      })

      const disabledPolicy = { ...policy, textModel: { mode: 'disabled' as const } }
      const revised = await fetch(`${origin}/api/agents/${created.agentId}/revision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedCurrentRevisionId: initial.currentRevisionId,
          ...base,
          imagePolicy: disabledPolicy,
        }),
      })
      expect(revised.status).toBe(200)
      snapshot = HostApiContracts.snapshot.parseResponse(await (await fetch(`${origin}/api/snapshot`)).json())
      const updated = snapshot.agents.find((agent) => agent.id === created.agentId)!
      expect(updated.imagePolicy).toEqual(disabledPolicy)
      expect(runtime.repository.getAgent(created.agentId)?.revision.contentDigest).toMatch(/^v5:sha256:/u)
    } finally {
      api.dispose()
      await webContext.fiber.dispose()
      await runtime.dispose()
    }
  })

  it('revises persona and model through the immutable revision API', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-revision-api-'))
    temporaryDirectories.push(directory)
    const runtime = await NekroRuntime.create({
      coreDatabasePath: path.join(directory, 'core.sqlite'),
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      assetRoot: path.join(directory, 'assets'),
      extensionDataRoot: path.join(directory, 'extension-data'),
      extensionCacheRoot: path.join(directory, 'extension-cache'),
    })
    const seeded = runtime.core.createAgentWithChannel(
      {
        displayName: '旧名称',
        persona: '旧人设',
        model: { provider: 'old-provider', model: 'old-model', reasoningEffort: 'high' },
      },
      {
        connectionId: runtime.internalConnectionId,
        kind: 'internal',
        triggerPolicy: 'always',
      },
    )
    const entity = { agentId: seeded.definition.id, channelId: seeded.channel.id }
    const before = runtime.repository.getAgent(entity.agentId)!
    const webContext = new Context()
    await webContext.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const api = createNekroHostApi(webContext.webServer, runtime)
    const origin = `http://127.0.0.1:${api.port}`
    try {
      const response = await fetch(`${origin}/api/agents/${entity.agentId}/revision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedCurrentRevisionId: before.revision.id,
          displayName: '新名称',
          persona: '新人设',
          model: { provider: 'new-provider', model: 'new-model' },
        }),
      })
      expect(response.ok).toBe(true)
      const after = runtime.repository.getAgent(entity.agentId)!
      expect(after.revision.id).not.toBe(before.revision.id)
      expect(after.revision).toMatchObject({
        displayName: '新名称',
        persona: '新人设',
        model: { provider: 'new-provider', model: 'new-model' },
        capabilities: before.revision.capabilities,
      })
    } finally {
      api.dispose()
      await webContext.fiber.dispose()
      await runtime.dispose()
    }
  })

  it('persists a DSH provider and write-only credential, then restores it after restart', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-llm-settings-'))
    temporaryDirectories.push(directory)
    const settingsPath = path.join(directory, 'dsh', 'settings.yaml')
    const credentialPath = path.join(directory, 'dsh', '.credentials.yaml')
    const createRuntime = () =>
      NekroRuntime.create({
        coreDatabasePath: path.join(directory, 'core.sqlite'),
        sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
        assetRoot: path.join(directory, 'assets'),
        extensionDataRoot: path.join(directory, 'extension-data'),
        extensionCacheRoot: path.join(directory, 'extension-cache'),
        llmSettingsPath: settingsPath,
        llmCredentialPath: credentialPath,
        configureLlm: configureDshLlmProviders([]),
      })

    const first = await createRuntime()
    const firstWeb = new Context()
    await firstWeb.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const firstApi = createNekroHostApi(firstWeb.webServer, first)
    try {
      const before = LlmProviderSnapshotSchema.parse(
        await (await fetch(`http://127.0.0.1:${firstApi.port}/api/llm/providers`)).json(),
      )
      const opencode = before.providers.find((provider) => provider.provider === 'opencode-go')!
      expect(opencode.configured).toBe(false)
      const savedResponse = await fetch(`http://127.0.0.1:${firstApi.port}/api/llm/providers/opencode-go`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedRevision: opencode.settingsRevision, apiKey: 'write-only-test-key' }),
      })
      expect(savedResponse.ok).toBe(true)
      const savedText = await savedResponse.text()
      expect(savedText).not.toContain('write-only-test-key')
      const saved = LlmProviderSnapshotSchema.parse(JSON.parse(savedText))
      expect(saved.providers.find((provider) => provider.provider === 'opencode-go')?.active).toBe(true)

      const customResponse = await fetch(`http://127.0.0.1:${firstApi.port}/api/llm/providers/acme-gateway`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: saved.providers[0]!.settingsRevision,
          apiKey: 'custom-write-only-test-key',
          displayName: 'Acme Gateway',
          baseURL: 'https://gateway.example.test/v1',
          api: 'openai-completions',
          models: [{ id: 'acme-chat', name: 'Acme Chat', contextWindow: 64_000, maxTokens: 8_000 }],
        }),
      })
      expect(customResponse.ok).toBe(true)
      const customText = await customResponse.text()
      expect(customText).not.toContain('custom-write-only-test-key')
      const custom = LlmProviderSnapshotSchema.parse(JSON.parse(customText))
      expect(custom.providers.find((provider) => provider.provider === 'acme-gateway')?.active).toBe(true)
      const customRow = custom.providers.find((provider) => provider.provider === 'acme-gateway')!
      const editedResponse = await fetch(`http://127.0.0.1:${firstApi.port}/api/llm/providers/acme-gateway`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: customRow.settingsRevision,
          displayName: 'Acme Gateway Updated',
          baseURL: 'https://gateway.example.test/v2',
          api: 'openai-responses',
          models: [{ id: 'acme-next', name: 'Acme Next' }],
        }),
      })
      expect(editedResponse.ok).toBe(true)

      const pluginResponse = await fetch(`http://127.0.0.1:${firstApi.port}/api/dsh/plugins`)
      expect(pluginResponse.ok).toBe(true)
      const pluginCatalog = DshPluginCatalogSchema.parse(await pluginResponse.json())
      expect(pluginCatalog.plugins).toContainEqual(
        expect.objectContaining({
          packageName: '@deepseek-ai/dsh-web-search-deepseek',
          origin: 'builtin',
          settingsNamespaces: ['web-search-deepseek'],
        }),
      )
      expect(pluginCatalog.plugins).toContainEqual(
        expect.objectContaining({
          packageName: '@deepseek-ai/dsh-agent-loop',
          origin: 'builtin',
          settingsNamespaces: ['agent-loop'],
        }),
      )
      expect(pluginCatalog.plugins).toContainEqual(
        expect.objectContaining({
          packageName: '@deepseek-ai/dsh-bash-sandbox',
          origin: 'builtin',
          settingsNamespaces: [],
        }),
      )

      const settingsResponse = await fetch(`http://127.0.0.1:${firstApi.port}/api/dsh/settings`)
      expect(settingsResponse.ok).toBe(true)
      const settingsText = await settingsResponse.text()
      expect(settingsText).not.toContain('write-only-test-key')
      expect(settingsText).not.toContain('custom-write-only-test-key')
      const settings = DshSettingsSnapshotSchema.parse(JSON.parse(settingsText))
      const webSearch = settings.namespaces.find((namespace) => namespace.ns === 'web-search-deepseek')!
      expect(webSearch.resolved).toMatchObject({ apiKeyEnv: 'DEEPSEEK_API_KEY', maxTokens: 1024, maxUses: 2 })
      expect(webSearch.secrets).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: ['apiKey'], set: false })]),
      )

      const mutateResponse = await fetch(
        `http://127.0.0.1:${firstApi.port}/api/dsh/settings/web-search-deepseek/mutate`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            expectedRevision: webSearch.revision,
            ops: [{ op: 'set', path: ['maxUses'], value: 3 }],
          }),
        },
      )
      expect(mutateResponse.ok).toBe(true)
      const mutated = DshSettingsMutationSchema.parse(await mutateResponse.json())
      expect(mutated).toMatchObject({ resolved: { maxUses: 3 } })
      const conflictResponse = await fetch(
        `http://127.0.0.1:${firstApi.port}/api/dsh/settings/web-search-deepseek/mutate`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            expectedRevision: webSearch.revision,
            ops: [{ op: 'set', path: ['maxUses'], value: 4 }],
          }),
        },
      )
      expect(conflictResponse.status).toBe(409)
      const unsetResponse = await fetch(
        `http://127.0.0.1:${firstApi.port}/api/dsh/settings/web-search-deepseek/mutate`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            expectedRevision: mutated.revision,
            ops: [{ op: 'unset', path: ['maxUses'] }],
          }),
        },
      )
      expect(unsetResponse.ok).toBe(true)
      expect(await unsetResponse.json()).toMatchObject({ resolved: { maxUses: 2 } })

      const credentialSet = await fetch(`http://127.0.0.1:${firstApi.port}/api/dsh/credentials/DEEPSEEK_API_KEY`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: 'generic-write-only-key' }),
      })
      expect(credentialSet.ok).toBe(true)
      expect(await credentialSet.text()).not.toContain('generic-write-only-key')
      const credentialDescribe = await fetch(`http://127.0.0.1:${firstApi.port}/api/dsh/credentials/describe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refs: ['DEEPSEEK_API_KEY'] }),
      })
      expect(await credentialDescribe.json()).toEqual({
        credentials: { DEEPSEEK_API_KEY: { configured: true, source: 'file', writable: true } },
      })
      const invalidCredentialRef = await fetch(`http://127.0.0.1:${firstApi.port}/api/dsh/credentials/describe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refs: ['invalid/ref'] }),
      })
      expect(invalidCredentialRef.status).toBe(400)
      const credentialUnset = await fetch(`http://127.0.0.1:${firstApi.port}/api/dsh/credentials/DEEPSEEK_API_KEY`, {
        method: 'DELETE',
      })
      expect(await credentialUnset.json()).toEqual({ configured: false, writable: true })
    } finally {
      firstApi.dispose()
      await firstWeb.fiber.dispose()
      await first.dispose()
    }

    expect((await stat(credentialPath)).mode & 0o777).toBe(0o600)
    const second = await createRuntime()
    try {
      const restored = await second.host.getLlmProviderSettings()
      const restoredProvider = restored.providers.find((provider) => provider.provider === 'opencode-go')
      expect(restoredProvider?.configured).toBe(true)
      expect(restoredProvider?.active).toBe(true)
      expect(restoredProvider?.credential).toMatchObject({ configured: true, source: 'file' })
      const restoredCustom = restored.providers.find((provider) => provider.provider === 'acme-gateway')
      expect(restoredCustom?.active).toBe(true)
      expect(restoredCustom?.displayName).toBe('Acme Gateway Updated')
      expect(restoredCustom?.baseURL).toBe('https://gateway.example.test/v2')
      expect(restoredCustom?.api).toBe('openai-responses')
      expect(restoredCustom?.models).toEqual([{ id: 'acme-next', name: 'Acme Next' }])
      expect(await second.host.listAvailableLlmModels()).not.toHaveLength(0)
    } finally {
      await second.dispose()
    }
  })

  it('pushes channel-fact payloads over SSE and replays them via Last-Event-ID', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-host-sse-'))
    temporaryDirectories.push(directory)
    const runtime = await NekroRuntime.create({
      coreDatabasePath: path.join(directory, 'core.sqlite'),
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      assetRoot: path.join(directory, 'assets'),
      extensionDataRoot: path.join(directory, 'extension-data'),
      extensionCacheRoot: path.join(directory, 'extension-cache'),
      configureLlm: (context: Context) => {
        context.llm.registerAdapter(['test-provider'], new ScriptedCommunicationModel())
      },
    })
    await runtime.start()
    await runtime.recover()
    const webContext = new Context()
    await webContext.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const api = createNekroHostApi(webContext.webServer, runtime)
    const origin = `http://127.0.0.1:${api.port}`
    try {
      const created = HostApiContracts.createAgent.parseResponse(
        await (
          await fetch(`${origin}/api/agents`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              displayName: '推送智能体',
              persona: '',
              model: { provider: 'test-provider', model: 'chat-model' },
            }),
          })
        ).json(),
      )
      const live = await fetch(`${origin}/api/events`)
      expect(live.headers.get('content-type')).toContain('text/event-stream')
      const admitted = await fetch(`${origin}/api/channels/${created.channelId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ parts: [{ type: 'text', text: 'SSE 直接推送。' }], clientEventId: 'sse-1' }),
      })
      expect(admitted.status).toBe(200)
      const liveEvents = await readSseEvents(
        live,
        (events) =>
          events.some(
            (event) => event.name === 'channel-fact' && JSON.stringify(event.data).includes('SSE 直接推送。'),
          ) && events.some((event) => event.name === 'runtime' && JSON.stringify(event.data).includes('"totalTokens"')),
      )
      const runtimeEvent = liveEvents.find(
        (event) => event.name === 'runtime' && JSON.stringify(event.data).includes('"totalTokens"'),
      )
      const runtimePayload = HostSseEventSchema.parse({ event: 'runtime', data: runtimeEvent?.data })
      if (runtimePayload.event !== 'runtime') throw new Error('Expected a runtime SSE frame.')
      expect(
        runtimePayload.data.turns.flatMap((turn) => turn.steps).some((step) => step.usage?.totalTokens === 24),
      ).toBe(true)
      const runtimeResponse = await fetch(`${origin}/api/channels/${created.channelId}/runtime`)
      expect(runtimeResponse.status).toBe(200)
      const trajectory = HostApiContracts.getChannelRuntime.parseResponse(await runtimeResponse.json())
      expect(trajectory.turns.flatMap((turn) => turn.steps).some((step) => step.usage?.totalTokens === 24)).toBe(true)
      expect((await fetch(`${origin}/api/snapshot`)).status).toBe(200)
      const hello = liveEvents.find((event) => event.name === 'status')
      expect(hello?.data).toMatchObject({ ok: true, replay: 'none' })
      const fact = liveEvents.find((event) => event.name === 'channel-fact')
      expect(fact?.id).toMatch(/^[a-zA-Z0-9_-]{1,100}:[1-9]\d*$/u)
      expect(fact?.data).toMatchObject({ channelId: created.channelId, revision: 1 })
      const items = z
        .object({
          items: z.array(
            z.object({
              kind: z.enum(['inbound', 'outbound']),
              message: z.object({ role: z.string(), parts: z.array(z.unknown()) }).passthrough(),
            }),
          ),
        })
        .parse(fact?.data).items
      expect(
        items.some((item) => item.kind === 'inbound' && JSON.stringify(item.message).includes('SSE 直接推送。')),
      ).toBe(true)

      const replay = await fetch(`${origin}/api/events`, {
        headers: { 'Last-Event-ID': String(fact?.id) },
      })
      const replayEvents = await readSseEvents(replay, (events) => events.some((event) => event.name === 'status'))
      expect(replayEvents.find((event) => event.name === 'status')?.data).toMatchObject({ replay: 'complete' })
      expect(
        replayEvents.filter((event) => event.name === 'channel-fact').every((event) => event.id !== fact?.id),
      ).toBe(true)
    } finally {
      api.dispose()
      await webContext.fiber.dispose()
      await runtime.dispose()
    }
  })
})

type ParsedSseEvent = {
  readonly id?: string
  readonly name: string
  readonly data: unknown
}

const readSseEvents = async (
  response: Response,
  ready: (events: readonly ParsedSseEvent[]) => boolean,
  timeoutMs = 4_000,
): Promise<readonly ParsedSseEvent[]> => {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('SSE response has no body.')
  const decoder = new TextDecoder()
  let buffer = ''
  const events: ParsedSseEvent[] = []
  const deadline = Date.now() + timeoutMs
  try {
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now())
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ readonly timeout: true }>((resolve) => setTimeout(() => resolve({ timeout: true }), remaining)),
      ])
      if ('timeout' in chunk) break
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      const blocks = buffer.split('\n\n')
      buffer = blocks.pop() ?? ''
      for (const block of blocks) {
        if (!block.trim() || block.startsWith(':')) continue
        let id: string | undefined
        let name = 'message'
        let data: string | undefined
        for (const line of block.split('\n')) {
          if (line.startsWith('id: ')) id = line.slice(4)
          else if (line.startsWith('event: ')) name = line.slice(7)
          else if (line.startsWith('data: ')) data = line.slice(6)
        }
        events.push({
          ...(id === undefined ? {} : { id }),
          name,
          data: data === undefined ? undefined : JSON.parse(data),
        })
      }
      if (ready(events)) return events
    }
    throw new Error(`Timed out waiting for SSE events. seen=${events.map((event) => event.name).join(',')}`)
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}
