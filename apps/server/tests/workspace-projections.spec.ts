import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  HostApiContracts,
  LogicalMessageIdSchema,
  OutboundIntentIdSchema,
  PhysicalDeliveryIdSchema,
} from '@nekro-nxt/contracts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NekroRuntime } from '../src/bootstrap.js'
import { createNekroHostApi } from '../src/host-api.js'

const temporaryDirectories: string[] = []
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const waitFor = async (predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition.')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const userTexts = (options: GenerateOptions): string =>
  options.messages
    .filter((message) => message.role === 'user')
    .flatMap((message) => message.content)
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')

type ModelMode = 'block-generation' | 'call-send-tool' | 'reply'

/** Deterministic model whose behaviour each test switches between turns. */
class ControlledModel extends LlmAdapter {
  mode: ModelMode = 'reply'
  readonly calls: GenerateOptions[] = []
  generationStarted = false
  generationAborted = false

  override providerInfo(provider: string) {
    return { id: provider, name: 'Controlled model' }
  }
  override listModels(provider: string) {
    return Promise.resolve([{ provider, id: 'chat-model', name: 'Chat model', inputModalities: ['text'] as const }])
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
    this.calls.push(options)
    if (this.mode === 'block-generation') {
      this.generationStarted = true
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '正在思考' }
      await new Promise<void>((_resolve, reject) => {
        const abort = (): void => {
          this.generationAborted = true
          reject(options.signal?.reason ?? new Error('aborted'))
        }
        if (options.signal?.aborted) abort()
        options.signal?.addEventListener('abort', abort, { once: true })
      })
      return
    }
    const last = options.messages.at(-1)
    if (last?.role !== 'tool') {
      const callId = ToolCallId(`send-${this.calls.length}`)
      const toolCall = {
        type: 'tool-call' as const,
        id: callId,
        name: 'send_channel_message',
        arguments: JSON.stringify({ target: { type: 'current' }, parts: [{ type: 'text', text: '收到。' }] }),
      }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: callId, name: toolCall.name, argumentsDelta: toolCall.arguments }
      yield { type: 'block-end', index: 0, block: toolCall }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '结束。' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const fixture = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nxt-workspace-projections-'))
  temporaryDirectories.push(directory)
  const model = new ControlledModel()
  const runtime = await NekroRuntime.create({
    coreDatabasePath: path.join(directory, 'core.sqlite'),
    sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
    assetRoot: path.join(directory, 'assets'),
    extensionDataRoot: path.join(directory, 'extension-data'),
    extensionCacheRoot: path.join(directory, 'extension-cache'),
    configureLlm: (context: Context) => {
      context.llm.registerAdapter(['test-provider'], model)
    },
  })
  const seeded = runtime.core.createAgentWithChannel(
    { displayName: '停止测试智能体', persona: '', model: { provider: 'test-provider', model: 'chat-model' } },
    { connectionId: runtime.internalConnectionId, kind: 'internal', triggerPolicy: 'always' },
  )
  await runtime.start()
  await runtime.recover()
  const webContext = new Context()
  await webContext.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  const api = createNekroHostApi(webContext.webServer, runtime)
  cleanups.push(async () => {
    api.dispose()
    await webContext.fiber.dispose()
    await runtime.dispose()
  })
  const origin = `http://127.0.0.1:${api.port}`
  const adapterKey = runtime.core.getConnection(runtime.internalConnectionId)!.adapterKey
  const member = runtime.core.observeChannelMember({
    connectionId: runtime.internalConnectionId,
    channelId: seeded.channel.id,
    platformUserId: 'local-user',
    displayName: '阿青',
    observedAt: Date.now(),
  }).member
  const admit = (text: string) =>
    runtime.channels.acceptChannelInbound({
      connectionId: runtime.internalConnectionId,
      channelId: seeded.channel.id,
      adapterKey,
      kind: 'message-created',
      senderMemberId: member.id,
      parts: [{ type: 'text', text }],
      platformTimestamp: Date.now(),
      receivedAt: Date.now(),
      dedupeKey: `${text}-${Math.random()}`,
    })
  const episode = () => runtime.repository.getActiveEpisode(seeded.channel.id, seeded.definition.id)
  const sessionStatus = () => {
    const current = episode()
    return current?.dshSessionId === undefined ? 'missing' : runtime.host.sessionStatus(current.dshSessionId)
  }
  const post = async (pathname: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${origin}${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
  return { runtime, seeded, model, origin, admit, episode, sessionStatus, post }
}

describe('workspace runtime controls', () => {
  it('stops a running generation, keeps queued input, stays idle, and resumes on the next message', async () => {
    const f = await fixture()
    f.model.mode = 'block-generation'
    await f.admit('第一条：开始长时间思考')
    await waitFor(() => f.model.generationStarted)
    const runningEpisode = f.episode()!
    await f.admit('第二条：补充条件')
    await waitFor(async () => {
      const pending = HostApiContracts.getChannelPending.parseResponse(
        await (await fetch(`${f.origin}/api/channels/${f.seeded.channel.id}/pending`)).json(),
      )
      return pending.items.length === 1
    })
    const pending = HostApiContracts.getChannelPending.parseResponse(
      await (await fetch(`${f.origin}/api/channels/${f.seeded.channel.id}/pending`)).json(),
    )
    expect(pending).toMatchObject({
      episodeId: runningEpisode.id,
      items: [{ target: 'next-step', events: [{ author: '阿青', preview: '第二条：补充条件' }] }],
    })

    const stale = await f.post(`/api/channels/${f.seeded.channel.id}/stop`, { expectedEpisodeId: 'eps_STALE' })
    expect(stale.status).toBe(409)
    const stopped = await f.post(`/api/channels/${f.seeded.channel.id}/stop`, { expectedEpisodeId: runningEpisode.id })
    expect(stopped.status, await stopped.clone().text()).toBe(200)
    expect(HostApiContracts.stopChannelTask.parseResponse(await stopped.json())).toEqual({
      result: 'stopped',
      episodeId: runningEpisode.id,
      retainedPending: 1,
    })
    expect(f.model.generationAborted).toBe(true)
    // Context is not reset: the same Episode stays active, nothing new ran, and the queued input survives.
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(f.episode()?.id).toBe(runningEpisode.id)
    expect(f.sessionStatus()).toBe('idle')
    expect(f.model.calls).toHaveLength(1)
    const retained = HostApiContracts.getChannelPending.parseResponse(
      await (await fetch(`${f.origin}/api/channels/${f.seeded.channel.id}/pending`)).json(),
    )
    expect(retained.items.flatMap(({ events }) => events.map(({ preview }) => preview))).toEqual(['第二条：补充条件'])

    const idle = await f.post(`/api/channels/${f.seeded.channel.id}/stop`, {})
    expect(HostApiContracts.stopChannelTask.parseResponse(await idle.json())).toEqual({
      result: 'idle',
      episodeId: runningEpisode.id,
      retainedPending: 1,
    })

    f.model.mode = 'reply'
    await f.admit('第三条：继续')
    await waitFor(() => f.model.calls.length >= 3 && f.sessionStatus() === 'idle')
    const resumed = userTexts(f.model.calls[1]!)
    expect(resumed).toContain('第二条：补充条件')
    expect(resumed).toContain('第三条：继续')
    expect(f.episode()?.id).toBe(runningEpisode.id)

    const attention = HostApiContracts.listAttention.parseResponse(
      await (await fetch(`${f.origin}/api/attention`)).json(),
    )
    expect(attention.items.filter(({ kind }) => kind === 'turn-failed')).toEqual([])
  })

  it('stops a running tool through its abort signal without closing the Session', async () => {
    const f = await fixture()
    f.model.mode = 'reply'
    let toolSignal: AbortSignal | undefined
    const send = vi.spyOn(f.runtime.channels, 'sendMessage').mockImplementation(
      (input) =>
        new Promise((_resolve, reject) => {
          toolSignal = input.signal
          input.signal?.addEventListener('abort', () => reject(new Error('工具已停止')), { once: true })
        }),
    )
    await f.admit('请发送一条消息')
    await waitFor(() => toolSignal !== undefined)
    const toolEpisode = f.episode()!
    const stopped = await f.post(`/api/channels/${f.seeded.channel.id}/stop`, {})
    expect(HostApiContracts.stopChannelTask.parseResponse(await stopped.json())).toMatchObject({
      result: 'stopped',
      episodeId: toolEpisode.id,
    })
    expect(toolSignal?.aborted).toBe(true)
    expect(f.sessionStatus()).toBe('idle')
    expect(f.episode()?.id).toBe(toolEpisode.id)

    send.mockRestore()
    await f.admit('再试一次')
    await waitFor(async () => {
      const page = HostApiContracts.listChannelMessages.parseResponse(
        await (await fetch(`${f.origin}/api/channels/${f.seeded.channel.id}/messages`)).json(),
      )
      return page.messages.some((message) => message.role === 'agent' && message.deliveryState === 'sent')
    })
  })
})

describe('workspace projections', () => {
  it('projects per-viewer unread counts, last activity and the activity series', async () => {
    const f = await fixture()
    f.model.mode = 'reply'
    const snapshot = async (headers: Record<string, string> = {}) =>
      HostApiContracts.snapshot.parseResponse(await (await fetch(`${f.origin}/api/snapshot`, { headers })).json())
    const remote = { 'x-nxt-viewer': 'device:nxt_device_REMOTE1' }
    // Both viewers start their baseline now, so earlier history is not unread.
    expect((await snapshot()).channels[0]?.activity.unreadCount).toBe(0)
    expect((await snapshot(remote)).channels[0]?.activity.unreadCount).toBe(0)
    await new Promise((resolve) => setTimeout(resolve, 5))
    await f.admit('新消息一')
    await f.admit('新消息二')
    await waitFor(() => f.sessionStatus() === 'idle' && f.model.calls.length >= 2)
    const local = (await snapshot()).channels[0]!.activity
    expect(local).toMatchObject({ unreadCount: 2, unreadCapped: false })
    expect(local.lastMessage?.role).toMatch(/member|agent/u)

    const read = await f.post(`/api/channels/${f.seeded.channel.id}/read`, {})
    expect(HostApiContracts.markChannelRead.parseResponse(await read.json()).activity.unreadCount).toBe(0)
    expect((await snapshot()).channels[0]?.activity.unreadCount).toBe(0)
    expect((await snapshot(remote)).channels[0]?.activity.unreadCount).toBe(2)
    // A spoofed, malformed viewer header falls back to the local console.
    expect((await snapshot({ 'x-nxt-viewer': 'device:../../etc' })).channels[0]?.activity.unreadCount).toBe(0)

    const activity = HostApiContracts.getChannelActivity.parseResponse(
      await (await fetch(`${f.origin}/api/activity?window=2h&bucket=5m`)).json(),
    )
    expect(activity.bucketMs).toBe(5 * 60 * 1000)
    const series = activity.channels.find(({ channelId }) => channelId === f.seeded.channel.id)
    expect(series?.counts).toHaveLength(24)
    expect(series?.total).toBeGreaterThanOrEqual(3)
    expect((await fetch(`${f.origin}/api/activity?window=48h&bucket=5m`)).status).toBe(400)
  })

  it('surfaces an unconfirmed delivery, retries it once, and records the resolution in the message projection', async () => {
    const f = await fixture()
    f.model.mode = 'reply'
    await f.admit('触发一个会话')
    await waitFor(() => f.sessionStatus() === 'idle' && f.episode() !== undefined && f.model.calls.length >= 2)
    const episode = f.episode()!
    const intentId = OutboundIntentIdSchema.parse('out_UNCONFIRMED1')
    const deliveryId = PhysicalDeliveryIdSchema.parse('phy_UNCONFIRMED1')
    f.runtime.repository.createOutboundPlan(
      {
        id: intentId,
        logicalMessageId: LogicalMessageIdSchema.parse('msg_UNCONFIRMED1'),
        agentRevisionId: f.seeded.revision.id,
        episodeId: episode.id,
        parts: [{ type: 'text', text: '可能没有送达的场景描述' }],
        state: 'planned',
        createdAt: Date.now(),
      },
      [
        {
          id: deliveryId,
          intentId,
          sequence: 0,
          parts: [{ type: 'text', text: '可能没有送达的场景描述' }],
          state: 'planned',
        },
      ],
    )
    f.runtime.repository.markIntentSending(intentId)
    f.runtime.repository.markDeliverySending(deliveryId)
    f.runtime.repository.recordDeliveryReceipt(deliveryId, { status: 'unknown', message: '没有收到回执' }, Date.now())
    f.runtime.repository.completeOutboundIntent(intentId, 'unknown')

    const before = HostApiContracts.listAttention.parseResponse(await (await fetch(`${f.origin}/api/attention`)).json())
    const item = before.items.find(({ kind }) => kind === 'delivery-unconfirmed')
    expect(item).toMatchObject({
      severity: 'critical',
      subject: { kind: 'outbound', id: intentId },
      action: { kind: 'resolve-delivery' },
    })
    expect(item?.detail).toContain('可能没有送达的场景描述')

    const retried = await f.post(`/api/outbound/${intentId}/resolve`, { action: 'retry' })
    expect(retried.status, await retried.clone().text()).toBe(200)
    expect(HostApiContracts.resolveOutbound.parseResponse(await retried.json())).toMatchObject({
      outboundId: intentId,
      action: 'retry',
      deliveryState: 'sent',
    })
    const again = await f.post(`/api/outbound/${intentId}/resolve`, { action: 'retry' })
    expect(again.status).toBe(409)
    const after = HostApiContracts.listAttention.parseResponse(await (await fetch(`${f.origin}/api/attention`)).json())
    expect(after.items.some(({ kind }) => kind === 'delivery-unconfirmed')).toBe(false)
    expect(after.revision).not.toBe(before.revision)

    const page = HostApiContracts.listChannelMessages.parseResponse(
      await (await fetch(`${f.origin}/api/channels/${f.seeded.channel.id}/messages`)).json(),
    )
    expect(page.messages.find(({ id }) => id === intentId)).toMatchObject({
      deliveryState: 'sent',
      deliveryResolution: { action: 'retry' },
    })
  })

  it('dismisses attention items persistently and keeps agent appearance outside revisions', async () => {
    const f = await fixture()
    const listed = HostApiContracts.listAttention.parseResponse(await (await fetch(`${f.origin}/api/attention`)).json())
    const vision = listed.items.find(({ kind }) => kind === 'agent-vision-unavailable')
    expect(vision?.related.agentId).toBe(f.seeded.definition.id)
    const dismissed = await f.post(`/api/attention/${encodeURIComponent(vision!.id)}/dismiss`, undefined)
    expect(HostApiContracts.dismissAttention.parseResponse(await dismissed.json()).dismissed).toBe(true)
    const after = HostApiContracts.listAttention.parseResponse(await (await fetch(`${f.origin}/api/attention`)).json())
    expect(after.items.some(({ id }) => id === vision!.id)).toBe(false)

    const patched = await fetch(`${f.origin}/api/agents/${f.seeded.definition.id}/appearance`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hue: 268 }),
    })
    expect(HostApiContracts.updateAgentAppearance.parseResponse(await patched.json()).appearance).toEqual({ hue: 268 })
    const png = Uint8Array.from(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      ),
    )
    const uploaded = await fetch(`${f.origin}/api/agents/${f.seeded.definition.id}/avatar`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: png,
    })
    expect(uploaded.status, await uploaded.clone().text()).toBe(200)
    const appearance = HostApiContracts.uploadAgentAvatar.parseResponse(await uploaded.json()).appearance
    expect(appearance.hue).toBe(268)
    expect(appearance.avatarAssetId).toBeDefined()
    const avatar = await fetch(`${f.origin}/api/agents/${f.seeded.definition.id}/avatar`)
    expect(avatar.headers.get('content-type')).toBe('image/png')
    const rejected = await fetch(`${f.origin}/api/agents/${f.seeded.definition.id}/avatar`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new TextEncoder().encode('not an image'),
    })
    expect(rejected.status).toBe(400)

    const snapshot = HostApiContracts.snapshot.parseResponse(await (await fetch(`${f.origin}/api/snapshot`)).json())
    expect(snapshot.agents[0]).toMatchObject({ appearance: { hue: 268 }, currentRevisionId: f.seeded.revision.id })
  })
})
