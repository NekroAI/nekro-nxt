import { afterEach, describe, expect, it, vi } from 'vitest'
import { CoreService } from '@nekro-nxt/core'
import { openMigratedCoreDatabase, SqliteCoreRepository } from '@nekro-nxt/storage-sqlite'
import { ChannelRuntime, type AgentSessionDriver } from '@nekro-nxt/channel-runtime'
import { FakeAdapterConnection } from '@nekro-nxt/test-harness'
import { CommandDefinitionSchema, ExtensionRevisionIdSchema, type MessagePart } from '@nekro-nxt/contracts'
import { CommandService, type CommandObserver, type RegisteredCommand } from '../src/commands/service.js'
import { CommandRegistrations } from '../src/commands/registrations.js'

const cleanups: Array<() => Promise<void>> = []
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
async function setup(deferExecution = false, bareCommands = true, observer?: CommandObserver) {
  const database = await openMigratedCoreDatabase(':memory:')
  const repository = new SqliteCoreRepository(database)
  let sequence = 0,
    time = 1000
  const now = () => ++time
  const core = new CoreService(repository, { now, nextUlid: () => String(++sequence).padStart(8, '0') })
  const agent = core.createAgent({
    displayName: '示例智能体',
    persona: '',
    model: { provider: 'fixture', model: 'fixture' },
  })
  const connection = core.createConnection({ adapterKey: 'fake', config: {} })
  const channel = core.createChannel({ connectionId: connection.id, platformChannelId: 'group-one', kind: 'group' })
  core.createBinding({ channelId: channel.id, agentId: agent.definition.id, triggerPolicy: 'always' })
  repository.commands.setBareCommands(channel.id, bareCommands)
  const member = core.observeChannelMember({
    connectionId: connection.id,
    channelId: channel.id,
    observedAt: 1000,
    platformUserId: 'user-one',
    displayName: '示例成员',
  })
  const bot = core.observeChannelMember({
    connectionId: connection.id,
    channelId: channel.id,
    observedAt: 1000,
    platformUserId: 'bot-one',
  })
  let running = false
  const admissions: Parameters<AgentSessionDriver['admit']>[0][] = []
  const driver: AgentSessionDriver = {
    createSession: vi.fn(({ episodeId }) => Promise.resolve('session-' + episodeId)),
    applyCompatibleRevision: () => Promise.resolve(),
    sessionStatus: () => (running ? 'running' : 'idle'),
    whenIdle: () => Promise.resolve(),
    findAdmissionMessage: () => undefined,
    createHandoffSummary: () => Promise.resolve({ summary: '摘要', provider: 'fixture', model: 'fixture' }),
    cancelSession: vi.fn(() => {
      running = false
      return Promise.resolve()
    }),
    interruptTurn: vi.fn(() => {
      running = false
      return Promise.resolve({ interrupted: true, retainedPending: 0 })
    }),
    listPendingAdmissions: () => [],
    admit: (input) => {
      admissions.push(input)
      running = true
      return Promise.resolve({ dshMessageId: 'dsh-' + input.admissionId })
    },
    notifyConsoleOutbound: () => Promise.resolve(),
  }
  const commandReference: { current?: CommandService } = {}
  const adapter = new FakeAdapterConnection({
    connectionId: connection.id,
    now,
    acceptChannelInbound: () => Promise.reject(new Error('direct test')),
  })
  await adapter.start()
  const hook = vi.fn(() => Promise.resolve({ trigger: 'default' as const, hidden: false }))
  const runtime = new ChannelRuntime(core, repository, repository, driver, {
    now,
    nextUlid: () => String(++sequence).padStart(8, '0'),
    idleRolloverMs: false,
    resolveAdapter: () => adapter,
    commands: {
      commitInbound: (event) => commandReference.current!.commitInbound(event),
      excludes: (event) => commandReference.current!.excludes(event),
      project: (event) => commandReference.current!.project(event),
    },
    inboundHooks: { covers: () => true, decide: hook, stored: () => undefined },
  })
  const extensions: RegisteredCommand[] = []
  const commands = new CommandService({
    deferExecution,
    repository,
    core,
    channels: () => runtime,
    extensions: () => extensions,
    running: () => running,
    botMemberId: () => bot.member.id,
    now,
    ...(observer === undefined ? {} : { observer }),
  })
  commandReference.current = commands
  const createSession = vi.spyOn(driver, 'createSession')
  const interruptTurn = vi.spyOn(driver, 'interruptTurn')
  cleanups.push(async () => {
    await commands.dispose()
    await runtime.dispose()
    await adapter.stop()
    database.close()
  })
  const inbound = (text: string, key = String(++sequence), parts?: readonly MessagePart[]) =>
    runtime.acceptChannelInbound({
      connectionId: connection.id,
      channelId: channel.id,
      adapterKey: 'fake',
      kind: 'message-created',
      senderMemberId: member.member.id,
      parts: parts === undefined ? [{ type: 'text', text }] : [...parts],
      platformTimestamp: now(),
      receivedAt: now(),
      dedupeKey: key,
    })
  return {
    repository,
    core,
    agent,
    connection,
    channel,
    member,
    bot,
    commands,
    runtime,
    driver,
    createSession,
    interruptTurn,
    adapter,
    admissions,
    hook,
    extensions,
    acceptInbound: inbound,
    inbound: async (...args: Parameters<typeof inbound>) => {
      const commit = await inbound(...args)
      await commands.idle()
      return commit
    },
  }
}
describe('unified commands', () => {
  it('commits the next message on a sequential connection while a command handler is waiting', async () => {
    const f = await setup()
    const entered = deferred()
    const held = deferred()
    f.extensions.push({
      definition: CommandDefinitionSchema.parse({ name: 'slow', description: '慢命令' }),
      fullName: 'ext_slow:slow',
      source: '测试',
      extensionRevisionId: ExtensionRevisionIdSchema.parse('xrv_SLOW'),
      invoke: async () => {
        entered.resolve()
        await held.promise
        return { parts: [{ type: 'text', text: '完成' }] }
      },
    })
    const connection = f.acceptInbound('/slow').then(() => f.acceptInbound('后续普通消息'))
    try {
      await entered.promise
      await vi.waitFor(() => expect(f.admissions).toHaveLength(1))
      expect(f.repository.listChannelHistory(f.channel.id)).toHaveLength(2)
      expect(f.adapter.deliveries).toHaveLength(0)
    } finally {
      held.resolve()
      await connection
    }
  })
  it('rolls back the inbound fact when saving its command execution fails', async () => {
    const f = await setup()
    vi.spyOn(f.repository.commands, 'insert').mockImplementationOnce(() => {
      throw new Error('模拟执行记录写入失败')
    })
    await expect(f.inbound('/status')).rejects.toThrow('模拟执行记录写入失败')
    expect(f.repository.listChannelHistory(f.channel.id)).toEqual([])
    expect(f.adapter.deliveries).toEqual([])
    const retry = await f.inbound('/status')
    expect(f.repository.commands.forEvent(retry.channelEventId)?.status).toBe('succeeded')
  })
  it('commits sequential inbound messages without waiting for a command receipt', async () => {
    const f = await setup()
    const entered = deferred()
    const held = deferred()
    const send = f.runtime.sendCommandReply.bind(f.runtime)
    vi.spyOn(f.runtime, 'sendCommandReply').mockImplementationOnce(async (input) => {
      entered.resolve()
      await held.promise
      return send(input)
    })
    const connection = f.acceptInbound('/status').then(() => f.acceptInbound('回执前的消息'))
    try {
      await entered.promise
      await connection
      expect(f.admissions).toHaveLength(1)
      expect(f.adapter.deliveries).toEqual([])
    } finally {
      held.resolve()
      await f.commands.idle()
    }
  })
  it('executes stop and deduplicates the first command while its reply is still waiting', async () => {
    const f = await setup()
    f.commands.grant(f.channel.id, f.member.identity.id, true)
    await f.inbound('开始工作')
    const entered = deferred()
    const held = deferred()
    const send = f.runtime.sendCommandReply.bind(f.runtime)
    const delivery = vi.spyOn(f.runtime, 'sendCommandReply').mockImplementationOnce(async (input) => {
      entered.resolve()
      await held.promise
      return send(input)
    })
    await f.acceptInbound('/status', 'slow-receipt')
    try {
      await entered.promise
      await f.acceptInbound('/status', 'slow-receipt')
      const stop = await f.acceptInbound('/stop')
      await vi.waitFor(() => expect(f.interruptTurn).toHaveBeenCalledOnce())
      expect(f.repository.commands.forEvent(stop.channelEventId)?.status).toBe('succeeded')
      expect(delivery).toHaveBeenCalledTimes(2)
    } finally {
      held.resolve()
      await f.commands.idle()
    }
    expect(delivery).toHaveBeenCalledTimes(2)
  })
  it('serializes commands per channel and deduplicates them without blocking another channel', async () => {
    const f = await setup()
    const entered = deferred()
    const held = deferred()
    const invoke = vi.fn(async () => {
      entered.resolve()
      await held.promise
      return { parts: [{ type: 'text' as const, text: '完成' }] }
    })
    f.extensions.push({
      definition: CommandDefinitionSchema.parse({ name: 'slow', description: '慢命令' }),
      fullName: 'ext_slow:slow',
      source: '测试',
      extensionRevisionId: ExtensionRevisionIdSchema.parse('xrv_SLOW'),
      invoke,
    })
    const first = await f.acceptInbound('/slow', 'first')
    const duplicate = await f.acceptInbound('/slow', 'first')
    const second = await f.acceptInbound('/slow', 'second')
    try {
      await entered.promise
      expect(first.channelEventId).toBe(duplicate.channelEventId)
      expect(invoke).toHaveBeenCalledOnce()
      expect(f.repository.commands.forEvent(second.channelEventId)?.status).toBe('pending')
      const other = f.core.createChannel({ connectionId: f.connection.id, platformChannelId: 'other', kind: 'group' })
      expect((await f.commands.executeWeb(other.id, '/status', 'other', 'local')).status).toBe('succeeded')
      expect(invoke).toHaveBeenCalledOnce()
    } finally {
      held.resolve()
      await f.commands.idle()
    }
    expect(invoke).toHaveBeenCalledTimes(2)
  })
  it('leaves queued work durable when shutdown cancels an active handler', async () => {
    const f = await setup()
    const entered = deferred()
    const invoke = vi.fn(async ({ signal }: Parameters<RegisteredCommand['invoke']>[0]) => {
      entered.resolve()
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
      throw new Error('已取消')
    })
    f.extensions.push({
      definition: CommandDefinitionSchema.parse({ name: 'wait', description: '等待取消' }),
      fullName: 'ext_wait:wait',
      source: '测试',
      extensionRevisionId: ExtensionRevisionIdSchema.parse('xrv_WAIT'),
      invoke,
    })
    await f.acceptInbound('/wait')
    const queued = await f.acceptInbound('/wait')
    await entered.promise
    await f.commands.dispose()
    expect(invoke).toHaveBeenCalledOnce()
    expect(f.repository.commands.forEvent(queued.channelEventId)?.status).toBe('pending')
    expect(f.repository.commands.unfinished().map((record) => record.eventId)).toEqual([queued.channelEventId])
  })
  it('does not read historical channel events when opening command recovery', async () => {
    const f = await setup()
    await f.inbound('普通历史消息')
    const read = vi.spyOn(f.repository, 'getChannelEvent')
    const unfinished = vi.spyOn(f.repository.commands, 'unfinished')
    f.commands.open()
    f.commands.open()
    await f.commands.idle()
    expect(read).not.toHaveBeenCalled()
    expect(unfinished).toHaveBeenCalledOnce()
  })
  it('stores help and denied commands without model admission or ordinary hooks', async () => {
    const f = await setup()
    await f.inbound('/help')
    await f.inbound('/reset')
    expect(f.createSession).not.toHaveBeenCalled()
    expect(f.hook).not.toHaveBeenCalled()
    const history = f.repository.listChannelHistory(f.channel.id)
    // /help, its reply, /reset and the reply telling the member a grant is needed.
    expect(history).toHaveLength(4)
    expect(f.adapter.deliveries).toHaveLength(2)
    expect(JSON.stringify(f.adapter.deliveries[1]?.parts)).toContain('授予')
    expect(history.filter((e) => e.source === 'outbound-intent').every((e) => e.commandExecutionId !== undefined)).toBe(
      true,
    )
    expect(
      f.repository.commands
        .unfinished()
        .map((r) => r.status)
        .sort(),
    ).toEqual([])
    expect(JSON.stringify(f.adapter.deliveries[0]?.parts)).not.toContain('/reset')
    f.commands.recover()
    await f.commands.idle()
    expect(f.adapter.deliveries).toHaveLength(2)
    // With the feedback turned off, unauthorized members are recorded but not answered.
    f.commands.setUnauthorizedFeedback(false)
    const silent = await f.inbound('/reset')
    await f.commands.idle()
    expect(f.repository.commands.forEvent(silent.channelEventId)?.replySuppressed).toBe(true)
    expect(f.adapter.deliveries).toHaveLength(2)
    await f.inbound('普通消息')
    expect(f.admissions[0]?.events.map((e) => e.parts)).toEqual([[{ type: 'text', text: '普通消息' }]])
  })
  it('stops during a running turn, resets without creating a receipt Session and pauses without touching the rule', async () => {
    const f = await setup()
    f.commands.grant(f.channel.id, f.member.identity.id, true)
    await f.inbound('开始')
    await f.inbound('/stop')
    expect(f.interruptTurn).toHaveBeenCalledOnce()
    await f.inbound('/reset')
    expect(f.repository.getActiveEpisode(f.channel.id, f.agent.definition.id)).toBeUndefined()
    expect(f.createSession).toHaveBeenCalledOnce()
    await f.inbound('/pause')
    expect(f.repository.getBinding(f.channel.id)).toMatchObject({ triggerPolicy: 'always', paused: true })
    await f.inbound('/off')
    await f.inbound('/resume')
    expect(f.repository.getBinding(f.channel.id)).toMatchObject({ triggerPolicy: 'always', paused: false })
    await f.inbound('/on')
    expect(f.repository.getBinding(f.channel.id)?.paused).toBe(false)
    expect(f.createSession).toHaveBeenCalledOnce()
  })
  it('keeps the pause across rule edits, blocks every automatic trigger and resets it for another agent', async () => {
    const f = await setup()
    f.commands.grant(f.channel.id, f.member.identity.id, true)
    await f.inbound('/pause')
    expect(f.repository.getBinding(f.channel.id)?.paused).toBe(true)
    // Editing the response rule never resumes a paused channel.
    await f.runtime.replaceBinding({
      channelId: f.channel.id,
      agentId: f.agent.definition.id,
      triggerPolicy: 'mentioned-or-replied',
    })
    expect(f.repository.getBinding(f.channel.id)).toMatchObject({ triggerPolicy: 'mentioned-or-replied', paused: true })
    const before = f.admissions.length
    await f.inbound('暂停期间的普通消息', undefined, [{ type: 'text', text: '暂停期间的普通消息' }])
    expect(f.admissions).toHaveLength(before)
    await f.inbound('/resume')
    expect(f.repository.getBinding(f.channel.id)).toMatchObject({
      triggerPolicy: 'mentioned-or-replied',
      paused: false,
    })
    await f.inbound('/pause')
    const other = f.core.createAgent({
      displayName: '另一个智能体',
      persona: '',
      model: { provider: 'fixture', model: 'fixture' },
    })
    await f.runtime.replaceBinding({ channelId: f.channel.id, agentId: other.definition.id, triggerPolicy: 'always' })
    expect(f.repository.getBinding(f.channel.id)?.paused).toBe(false)
  })
  it('reports an idle /stop truthfully and the pause state in /status', async () => {
    const f = await setup()
    f.commands.grant(f.channel.id, f.member.identity.id, true)
    await f.inbound('/stop')
    await f.commands.idle()
    expect(JSON.stringify(f.adapter.deliveries.at(-1))).toContain('当前没有运行中的任务')
    await f.inbound('/pause')
    await f.inbound('/status')
    await f.commands.idle()
    expect(JSON.stringify(f.adapter.deliveries.at(-1))).toContain('已暂停')
  })
  it('isolates grants across channels and connections, and rechecks revoked grants', async () => {
    const f = await setup()
    f.commands.grant(f.channel.id, f.member.identity.id, true)
    const other = f.core.createConnection({ adapterKey: 'fake', config: {} })
    const otherChannel = f.core.createChannel({ connectionId: other.id, platformChannelId: 'other', kind: 'group' })
    f.repository.commands.setBareCommands(otherChannel.id, true)
    const otherMember = f.core.observeChannelMember({
      connectionId: other.id,
      channelId: otherChannel.id,
      observedAt: 1000,
      platformUserId: 'user-one',
    })
    expect(() => f.commands.grant(f.channel.id, otherMember.identity.id, true)).toThrow()
    expect(f.repository.commands.hasGrant(otherChannel.id, other.id, 'user-one')).toBe(false)
    f.core.createBinding({ channelId: otherChannel.id, agentId: f.agent.definition.id, triggerPolicy: 'always' })
    const rejected = await f.runtime.acceptChannelInbound({
      connectionId: other.id,
      channelId: otherChannel.id,
      adapterKey: 'fake',
      kind: 'message-created',
      senderMemberId: otherMember.member.id,
      parts: [{ type: 'text', text: '/off' }],
      facts: { role: 'admin', source: 'web' },
      platformTimestamp: 1000,
      receivedAt: 1000,
      dedupeKey: 'other-connection',
    })
    await f.commands.idle()
    expect(f.repository.commands.forEvent(rejected.channelEventId)?.error).toContain('无权执行')
    expect(f.repository.getBinding(otherChannel.id)?.paused).toBe(false)
    f.commands.grant(f.channel.id, f.member.identity.id, false)
    await f.inbound('/off')
    expect(f.repository.getBinding(f.channel.id)?.paused).toBe(false)
  })
  it('deduplicates concurrent platform and Web requests, rejects changed content, and preserves unknown receipts', async () => {
    const f = await setup()
    f.adapter.queueReceipt({ status: 'unknown', message: '测试未知结果' })
    await Promise.all([f.inbound('/status', 'duplicate'), f.inbound('/status', 'duplicate')])
    expect(f.adapter.deliveries).toHaveLength(1)
    const record = await f.commands.executeWeb(f.channel.id, '/off', 'web-one', 'local')
    await f.commands.executeWeb(f.channel.id, '/off', 'web-one', 'local')
    await expect(f.commands.executeWeb(f.channel.id, '/on', 'web-one', 'local')).rejects.toThrow('请求 ID')
    expect(record.status).toBe('succeeded')
    // Web results stay in the console, so only the platform request produced a delivery.
    expect(f.adapter.deliveries).toHaveLength(1)
    f.commands.recover()
    await f.commands.idle()
    // The unknown receipt is never resent by recovery.
    expect(f.adapter.deliveries).toHaveLength(1)
  })
  it('includes usage for malformed quotes without invoking the model', async () => {
    const f = await setup()
    const result = await f.commands.executeWeb(f.channel.id, '/help "未闭合', 'bad-quote', 'local')
    expect(result.status).toBe('failed')
    expect(result.error).toContain('引号或转义未闭合')
    expect(result.error).toContain('用法：/help')
    expect(f.createSession).not.toHaveBeenCalled()
  })
  it('supports leading bot mentions, escaping and unbound help/status without losing ordinary messages', async () => {
    const f = await setup()
    await f.inbound('', undefined, [
      { type: 'mention', memberId: f.bot.member.id },
      { type: 'text', text: ' /help' },
    ])
    expect(f.admissions).toHaveLength(0)
    await f.inbound('//hello')
    expect(f.admissions[0]?.events[0]?.parts).toEqual([{ type: 'text', text: '/hello' }])
    await f.runtime.clearBinding(f.channel.id)
    await f.commands.executeWeb(f.channel.id, '/help', 'unbound-help', 'local')
    const rejected = await f.commands.executeWeb(f.channel.id, '/reset', 'unbound-reset', 'local')
    expect(rejected.error).toContain('绑定智能体')
  })
  it('requires an address in external groups unless the administrator opted in', async () => {
    const f = await setup(false, false)
    f.commands.grant(f.channel.id, f.member.identity.id, true)
    const bare = await f.inbound('/status')
    expect(f.repository.commands.forEvent(bare.channelEventId)).toBeUndefined()
    expect(f.admissions.length).toBeGreaterThan(0)
    const addressed = await f.inbound('', undefined, [
      { type: 'mention', memberId: f.bot.member.id },
      { type: 'text', text: ' /status' },
    ])
    expect(f.repository.commands.forEvent(addressed.channelEventId)?.commandName).toBe('status')
    f.commands.setBareCommands(f.channel.id, true)
    const opted = await f.inbound('/status')
    expect(f.repository.commands.forEvent(opted.channelEventId)?.commandName).toBe('status')
  })
  it('keeps Web results in the console for external channels unless the command declares otherwise', async () => {
    const f = await setup()
    const local = await f.commands.executeWeb(f.channel.id, '/status', 'local-status', 'local')
    expect(local.replyLocal).toBe(true)
    expect(f.adapter.deliveries).toHaveLength(0)
    const definition = CommandDefinitionSchema.parse({ name: 'announce', description: '公告', consoleReply: 'channel' })
    f.extensions.push({
      definition,
      fullName: 'ext_ANN:announce',
      source: '测试',
      extensionRevisionId: ExtensionRevisionIdSchema.parse('xrv_ANN'),
      invoke: () => ({ parts: [{ type: 'text' as const, text: '大家好' }] }),
    })
    const sent = await f.commands.executeWeb(f.channel.id, '/announce', 'web-announce', 'local')
    expect(sent.replyLocal).toBeUndefined()
    expect(f.adapter.deliveries).toHaveLength(1)
    // A platform member always gets the answer in the conversation.
    await f.inbound('/status')
    await f.commands.idle()
    expect(f.adapter.deliveries).toHaveLength(2)
  })
  it('drops platform commands over the per-user limit without records, replies or model admission', async () => {
    const f = await setup()
    const results = []
    for (let index = 0; index < 12; index += 1) results.push(await f.inbound('/status', `spam-${index}`))
    await f.commands.idle()
    const records = results.map((result) => f.repository.commands.forEvent(result.channelEventId))
    expect(records.filter((record) => record !== undefined)).toHaveLength(10)
    expect(records[10]).toBeUndefined()
    expect(f.adapter.deliveries).toHaveLength(10)
    // The over-limit messages are commands, so they still never reach the model.
    expect(f.admissions).toHaveLength(0)
  })
  it('sends progress replies in order before the final result and never replays them', async () => {
    const f = await setup()
    f.extensions.push({
      definition: CommandDefinitionSchema.parse({ name: 'slow', description: '分步输出' }),
      fullName: 'ext_SLOW:slow',
      source: '测试',
      extensionRevisionId: ExtensionRevisionIdSchema.parse('xrv_SLOW'),
      invoke: (context) => {
        context.reply({ parts: [{ type: 'text', text: '第一步' }] })
        context.reply({ parts: [{ type: 'text', text: '第二步' }] })
        return { parts: [{ type: 'text', text: '全部完成' }] }
      },
    })
    const commit = await f.inbound('/slow')
    await f.commands.idle()
    const record = f.repository.commands.forEvent(commit.channelEventId)!
    expect(record.status).toBe('succeeded')
    expect(record.replies.map((reply) => [reply.ordinal, reply.kind])).toEqual([
      [0, 'progress'],
      [1, 'progress'],
      [2, 'final'],
    ])
    expect(record.replies.every((reply) => reply.intentId !== undefined)).toBe(true)
    const texts = f.adapter.deliveries.map((delivery) => JSON.stringify(delivery))
    expect(texts).toHaveLength(3)
    expect(texts[0]).toContain('第一步')
    expect(texts[1]).toContain('第二步')
    expect(texts[2]).toContain('全部完成')
    f.commands.recover()
    await f.commands.idle()
    expect(f.adapter.deliveries).toHaveLength(3)
  })
  it('caps progress replies per execution and still reports the failure as the final reply', async () => {
    const f = await setup()
    f.extensions.push({
      definition: CommandDefinitionSchema.parse({ name: 'chatty', description: '过多输出' }),
      fullName: 'ext_CHAT:chatty',
      source: '测试',
      extensionRevisionId: ExtensionRevisionIdSchema.parse('xrv_CHAT'),
      invoke: (context) => {
        for (let index = 0; index < 8; index += 1) context.reply({ parts: [{ type: 'text', text: `步骤 ${index}` }] })
        return { parts: [{ type: 'text', text: '不会到达' }] }
      },
    })
    const commit = await f.inbound('/chatty')
    await f.commands.idle()
    const record = f.repository.commands.forEvent(commit.channelEventId)!
    expect(record.status).toBe('failed')
    expect(record.replies.filter((reply) => reply.kind === 'progress')).toHaveLength(5)
    expect(record.replies.at(-1)?.kind).toBe('final')
    expect(f.adapter.deliveries).toHaveLength(6)
  })
  it('announces slow built-ins before they finish', async () => {
    const f = await setup()
    f.commands.grant(f.channel.id, f.member.identity.id, true)
    await f.inbound('开始')
    const commit = await f.inbound('/compact')
    await f.commands.idle()
    const record = f.repository.commands.forEvent(commit.channelEventId)!
    expect(record.replies.map((reply) => reply.kind)).toEqual(['progress', 'final'])
    expect(JSON.stringify(f.adapter.deliveries[0])).toContain('正在整理')
  })
  it('delivers progress replies that were saved but not sent after a restart, once', async () => {
    const f = await setup(true)
    const commit = await f.inbound('/status')
    const record = f.repository.commands.forEvent(commit.channelEventId)!
    f.repository.commands.update({
      ...record,
      status: 'succeeded',
      result: { parts: [{ type: 'text', text: '完成' }] },
      replies: [
        { ordinal: 0, kind: 'progress', parts: [{ type: 'text', text: '进行中' }] },
        { ordinal: 1, kind: 'final', parts: [{ type: 'text', text: '完成' }] },
      ],
    })
    f.commands.open()
    await f.commands.idle()
    const after = f.repository.commands.get(record.id)!
    expect(after.replies.map((reply) => reply.intentId !== undefined)).toEqual([true, true])
    expect(f.adapter.deliveries).toHaveLength(2)
    f.commands.recover()
    await f.commands.idle()
    expect(f.adapter.deliveries).toHaveLength(2)
  })
  it('tells observers about settled commands, undelivered replies and rate limiting without content', async () => {
    const settled = vi.fn<NonNullable<CommandObserver['settled']>>()
    const rateLimited = vi.fn<NonNullable<CommandObserver['rateLimited']>>()
    const f = await setup(false, true, { settled, rateLimited })
    for (let index = 0; index < 12; index += 1) await f.inbound('/status 机密参数', `obs-${index}`)
    await f.commands.idle()
    expect(settled).toHaveBeenCalled()
    const last = settled.mock.calls.at(-1)?.[0]
    expect(last).toMatchObject({ commandName: 'status' })
    // Failed argument parsing keeps the raw text in storage but observers are only given records, not content logs.
    expect(rateLimited).toHaveBeenCalledOnce()
    expect(rateLimited.mock.calls[0]?.[0]).toMatchObject({ dropped: 1 })
  })
  it('treats a platform-confirmed mention as addressing, as QQ and WeCom report it', async () => {
    const f = await setup(false, false)
    const send = (parts: readonly MessagePart[], key: string) =>
      f.runtime.acceptChannelInbound({
        connectionId: f.connection.id,
        channelId: f.channel.id,
        adapterKey: 'fake',
        kind: 'message-created',
        senderMemberId: f.member.member.id,
        parts: [...parts],
        facts: { mentionedBot: true },
        platformTimestamp: 1000,
        receivedAt: 1000,
        dedupeKey: key,
      })
    // QQ's group @ event: the platform strips the bot mention from the content.
    const qq = await send([{ type: 'text', text: ' /status' }], 'qq-at')
    await f.commands.idle()
    expect(f.repository.commands.forEvent(qq.channelEventId)?.commandName).toBe('status')
    // WeCom keeps the @name as text in front of the command.
    const wecom = await send([{ type: 'text', text: '@示例机器人 /help' }], 'wecom-at')
    await f.commands.idle()
    expect(f.repository.commands.forEvent(wecom.channelEventId)?.commandName).toBe('help')
  })
  it('leaves names that are not commands here to the agent as ordinary chat', async () => {
    const f = await setup()
    const path = await f.inbound('/usr/local 是什么目录')
    const emoticon = await f.inbound('/微笑')
    expect(f.repository.commands.forEvent(path.channelEventId)).toBeUndefined()
    expect(f.repository.commands.forEvent(emoticon.channelEventId)).toBeUndefined()
    expect(f.admissions.flatMap((admission) => admission.events.map((event) => event.id))).toContain(
      path.channelEventId,
    )
    // The console still reports a name it does not know.
    const typed = await f.commands.executeWeb(f.channel.id, '/不存在', 'web-unknown', 'local')
    expect(typed.error).toContain('未知命令')
  })
  it('decides once whether a message is a command, whatever the settings become later', async () => {
    const f = await setup(false, false)
    const unaddressed = await f.inbound('/status')
    const event = f.repository.getChannelEvent(unaddressed.channelEventId)!
    expect(f.commands.excludes(event)).toBe(false)
    f.commands.setBareCommands(f.channel.id, true)
    // Turning bare commands on later does not reclassify what was already chat.
    expect(f.commands.excludes(event)).toBe(false)
    for (let index = 0; index < 11; index += 1) await f.inbound('/status', `burst-${index}`)
    const dropped = await f.inbound('/status', 'burst-dropped')
    expect(f.repository.commands.forEvent(dropped.channelEventId)).toBeUndefined()
    f.commands.setBareCommands(f.channel.id, false)
    // A command dropped by the rate limit stays out of model context even though it has no execution.
    expect(f.commands.excludes(f.repository.getChannelEvent(dropped.channelEventId)!)).toBe(true)
  })
  it('cancels an extension handler at its declared time limit and frees the channel queue', async () => {
    const f = await setup()
    f.commands.grant(f.channel.id, f.member.identity.id, true)
    let aborted = false
    f.extensions.push({
      definition: CommandDefinitionSchema.parse({ name: 'hang', description: '不会结束', timeoutSeconds: 1 }),
      fullName: 'ext_HANG:hang',
      source: '测试',
      extensionRevisionId: ExtensionRevisionIdSchema.parse('xrv_HANG'),
      invoke: (context) =>
        new Promise(() => {
          context.signal.addEventListener('abort', () => (aborted = true), { once: true })
        }),
    })
    const hang = await f.inbound('/hang')
    const stop = await f.inbound('/stop')
    await f.commands.idle()
    const record = f.repository.commands.forEvent(hang.channelEventId)!
    expect(record.status).toBe('failed')
    expect(record.error).toContain('超过 1 秒')
    expect(aborted).toBe(true)
    expect(f.repository.commands.forEvent(stop.channelEventId)?.status).toBe('succeeded')
  })
  it('uses stable extension names, denies ambiguity and enforces permission floors', async () => {
    const f = await setup()
    const definition = CommandDefinitionSchema.parse({ name: 'echo', aliases: ['e'], description: '示例' })
    f.extensions.push(
      ...['alpha', 'beta'].map((id) => ({
        definition,
        fullName: `ext_${id}:echo`,
        source: id,
        extensionRevisionId: ExtensionRevisionIdSchema.parse(`xrv_${id}`),
        invoke: () => ({ parts: [{ type: 'text' as const, text: id }] }),
      })),
    )
    const conflict = await f.commands.executeWeb(f.channel.id, '/e', 'conflict', 'local')
    expect(conflict.error).toContain('/ext_alpha:echo')
    const success = await f.commands.executeWeb(f.channel.id, '/ext_alpha:echo', 'full', 'local')
    expect(success.result?.parts).toEqual([{ type: 'text', text: 'alpha' }])
    expect(() => f.commands.setPolicy('global', 'reset', { permission: 'public' })).toThrow()
    f.commands.setPolicy('global', 'status', { enabled: false })
    f.commands.setPolicy(f.channel.id, 'status', { enabled: true })
    expect(f.commands.catalog(f.channel.id).find((c) => c.fullName === 'status')?.available).toBe(true)
    expect(() => f.commands.setPolicy('global', 'help', { enabled: false })).toThrow()
    f.commands.setPolicy(f.channel.id, 'status', { permission: 'public' })
    f.commands.setPolicy('global', 'status', { permission: 'channel-admin' })
    expect(f.commands.catalog(f.channel.id).find((c) => c.fullName === 'status')?.permission).toBe('channel-admin')
    expect(() => f.commands.setPolicy(f.channel.id, 'status', { permission: 'public' })).toThrow('全局权限')
    f.commands.setPolicy(f.channel.id, 'status', {})
  })
  it('reports a paused command to authorized callers and keeps unauthorized platform calls silent when asked', async () => {
    const f = await setup()
    f.commands.setUnauthorizedFeedback(false)
    const invoke = vi.fn(() => ({ parts: [{ type: 'text' as const, text: 'should not run' }] }))
    f.extensions.push({
      definition: CommandDefinitionSchema.parse({
        name: 'paused',
        description: '暂停命令',
        minimumPermission: 'channel-admin',
      }),
      fullName: 'ext_PAUSED:paused',
      source: '测试',
      extensionRevisionId: ExtensionRevisionIdSchema.parse('xrv_PAUSED'),
      unavailableReason: '命令所属扩展暂时不可用，请稍后重试。',
      invoke,
    })
    const commit = await f.inbound('/paused')
    const denied = f.repository.commands.forEvent(commit.channelEventId)
    expect(denied).toMatchObject({
      status: 'failed',
      replySuppressed: true,
    })
    expect(denied?.error).toContain('无权执行')
    expect(f.adapter.deliveries).toHaveLength(0)
    f.commands.grant(f.channel.id, f.member.identity.id, true)
    const authorized = await f.inbound('/ext_PAUSED:paused')
    const paused = f.repository.commands.forEvent(authorized.channelEventId)
    expect(paused).toMatchObject({
      status: 'failed',
      commandName: 'ext_PAUSED:paused',
    })
    expect(paused?.error).toContain('暂时不可用')
    expect(f.adapter.deliveries).toHaveLength(1)
    expect(invoke).not.toHaveBeenCalled()
    expect(f.admissions).toHaveLength(0)
  })
  it('does not replay a handler after an interrupted execution', async () => {
    const f = await setup()
    const first = await f.inbound('/help')
    const record = f.repository.commands.forEvent(first.channelEventId)!
    f.repository.commands.update({ ...record, status: 'running' })
    f.repository.commands.recover(2000)
    f.commands.recover()
    await f.commands.idle()
    expect(f.repository.commands.get(record.id)?.status).toBe('uncertain')
    expect(f.adapter.deliveries).toHaveLength(1)
  })
  it('reconciles a persisted reply intent without another delivery after a lost execution update', async () => {
    const f = await setup()
    const commit = await f.inbound('/status')
    const record = f.repository.commands.forEvent(commit.channelEventId)!
    const replyIntentId = record.replies[0]?.intentId
    expect(replyIntentId).toBeDefined()
    // Simulate a crash after the Outbound was planned but before the association was saved.
    f.repository.commands.update({
      ...record,
      replies: record.replies.map((reply) => ({ ordinal: reply.ordinal, kind: reply.kind, parts: reply.parts })),
    })
    expect(f.repository.commands.unfinished()).toHaveLength(1)
    f.commands.recover()
    await f.commands.idle()
    expect(f.repository.commands.get(record.id)?.replies[0]?.intentId).toBe(replyIntentId)
    expect(f.repository.commands.unfinished()).toEqual([])
    expect(f.adapter.deliveries).toHaveLength(1)
  })
  it('rolls back a Web fact if its execution cannot be persisted', async () => {
    const f = await setup()
    vi.spyOn(f.repository.commands, 'insert').mockImplementationOnce(() => {
      throw new Error('写入失败')
    })
    await expect(f.commands.executeWeb(f.channel.id, '/status', 'atomic-web', 'local')).rejects.toThrow('写入失败')
    expect(f.repository.listChannelHistory(f.channel.id)).toEqual([])
    expect((await f.commands.executeWeb(f.channel.id, '/status', 'atomic-web', 'local')).status).toBe('succeeded')
  })
  it('recovers only pending executions and missing replies, without re-invoking completed handlers', async () => {
    const f = await setup(true)
    const pending = await f.inbound('/help')
    const completed = await f.inbound('/status')
    const interrupted = await f.inbound('/stop')
    const failedDelivery = await f.inbound('/status')
    const done = f.repository.commands.forEvent(completed.channelEventId)!
    f.repository.commands.update({
      ...done,
      status: 'succeeded',
      result: { parts: [{ type: 'text', text: '已保存结果' }] },
      replies: [{ ordinal: 0, kind: 'final', parts: [{ type: 'text', text: '已保存结果' }] }],
    })
    const running = f.repository.commands.forEvent(interrupted.channelEventId)!
    f.repository.commands.update({ ...running, status: 'running' })
    f.repository.commands.recover(2000)
    const failed = f.repository.commands.forEvent(failedDelivery.channelEventId)!
    f.repository.commands.update({
      ...failed,
      status: 'succeeded',
      replies: [{ ordinal: 0, kind: 'final', parts: [{ type: 'text', text: '无法规划' }], error: '无法规划回复' }],
    })
    expect(f.repository.commands.unfinished().map((r) => r.eventId)).toEqual([
      pending.channelEventId,
      completed.channelEventId,
      interrupted.channelEventId,
    ])
    f.commands.open()
    await f.commands.idle()
    expect(f.adapter.deliveries).toHaveLength(3)
    expect(JSON.stringify(f.adapter.deliveries[1]?.parts)).toContain('已保存结果')
    expect(f.repository.commands.forEvent(interrupted.channelEventId)?.status).toBe('uncertain')
    expect(f.interruptTurn).not.toHaveBeenCalled()
    expect(f.repository.commands.unfinished()).toEqual([])
  })
  it('keeps host capabilities authorized against the private identity when an extension attempts to change it', async () => {
    const f = await setup()
    let frozen = false
    f.extensions.push({
      definition: CommandDefinitionSchema.parse({ name: 'capability', description: '权限边界测试' }),
      fullName: 'ext_capability:capability',
      source: '权限测试',
      extensionRevisionId: ExtensionRevisionIdSchema.parse('xrv_CAPABILITY'),
      invoke: async (context) => {
        frozen = Object.isFrozen(context.identity)
        try {
          Object.assign(context.identity, { source: 'web' })
        } catch {
          /* The public identity is immutable; the capability must still check its private copy. */
        }
        await context.host.stop()
        return { parts: [{ type: 'text', text: '不应执行' }] }
      },
    })
    await f.inbound('启动轮次')
    const inbound = await f.inbound('/capability')
    expect(frozen).toBe(true)
    expect(f.repository.commands.forEvent(inbound.channelEventId)?.identity.source).toBe('platform')
    expect(f.repository.commands.forEvent(inbound.channelEventId)?.status).toBe('failed')
    expect(f.interruptTurn).not.toHaveBeenCalled()
  })
})
it('extension command disposal blocks new work, aborts and waits for cleanup', async () => {
  const activation = new CommandRegistrations()
  const definition = CommandDefinitionSchema.parse({ name: 'wait', description: '等待' })
  let cleaned = false
  activation.register(definition, async (context) => {
    await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }))
    await Promise.resolve()
    cleaned = true
    return { parts: [{ type: 'text', text: '已清理' }] }
  })
  activation.seal([definition])
  const f = await setup()
  const invoke = activation.list()[0]!.invoke
  const pending = invoke({
    channelId: f.channel.id,
    identity: { source: 'web', displayName: '测试管理员' },
    arguments: {},
    signal: new AbortController().signal,
    reply: () => undefined,
    host: {
      status: () => ({ bound: true, running: false }),
      stop: () => Promise.resolve({ stopped: false }),
      reset: () => Promise.resolve(),
    },
  })
  await Promise.resolve()
  await activation.dispose()
  expect(cleaned).toBe(true)
  expect(activation.list()).toEqual([])
  await pending
})

it('isolates attachment cancellation while sharing host registration revocation', async () => {
  const registrations = new CommandRegistrations()
  const definition = CommandDefinitionSchema.parse({ name: 'wait', description: '等待取消' })
  const signals: AbortSignal[] = []
  const unregister = registrations.register(definition, async ({ signal }) => {
    signals.push(signal)
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
    return { parts: [{ type: 'text', text: '已取消' }] }
  })
  registrations.seal([definition])
  const first = registrations.fork()
  const second = registrations.fork()
  const f = await setup()
  const context = {
    channelId: f.channel.id,
    identity: { source: 'web' as const, displayName: '测试管理员' },
    arguments: {},
    signal: new AbortController().signal,
    reply: () => undefined,
    host: {
      status: () => ({ bound: true, running: false }),
      stop: () => Promise.resolve({ stopped: false }),
      reset: () => Promise.resolve(),
    },
  }
  const pending = [first.list()[0]!.invoke(context), second.list()[0]!.invoke(context)]
  await Promise.resolve()
  await first.dispose()
  expect(signals.map((signal) => signal.aborted)).toEqual([true, false])
  expect(second.list()).toHaveLength(1)
  const stale = second.list()[0]!.invoke
  unregister()
  expect(second.list()).toEqual([])
  await expect(stale(context)).rejects.toThrow('停用')
  await second.dispose()
  await Promise.all(pending)
  await registrations.dispose()
})

it('rechecks a revoked grant after waiting for the model admission lane', async () => {
  const f = await setup()
  f.commands.grant(f.channel.id, f.member.identity.id, true)
  let release!: () => void
  let entered!: () => void
  const entering = new Promise<void>((resolve) => {
    entered = resolve
  })
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  vi.spyOn(f.driver, 'admit').mockImplementationOnce(async () => {
    entered()
    await held
    return { dshMessageId: 'held' }
  })
  const message = f.inbound('普通消息占用边界')
  await entering
  const command = f.inbound('/off')
  f.commands.grant(f.channel.id, f.member.identity.id, false)
  release()
  await message
  const commit = await command
  expect(f.repository.commands.forEvent(commit.channelEventId)?.status).toBe('failed')
  expect(f.repository.getBinding(f.channel.id)?.triggerPolicy).toBe('always')
})

it('rejects stale bound capabilities and keeps ordinary messages while an extension command waits', async () => {
  const f = await setup()
  let release!: () => void
  let entered!: () => void
  const entering = new Promise<void>((resolve) => {
    entered = resolve
  })
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const definition = CommandDefinitionSchema.parse({ name: 'slow', description: '并发测试' })
  f.extensions.push({
    definition,
    source: '并发测试',
    fullName: 'ext_concurrent:slow',
    extensionRevisionId: ExtensionRevisionIdSchema.parse('xrv_CONCURRENT'),
    invoke: async (context) => {
      entered()
      await held
      await context.host.stop()
      return { parts: [{ type: 'text', text: '完成' }] }
    },
  })
  const command = f.commands.executeWeb(f.channel.id, '/slow', 'slow-one', 'local')
  await entering
  await f.acceptInbound('仍然入库并准入')
  const next = f.core.createAgent({
    displayName: '另一个智能体',
    persona: '',
    model: { provider: 'fixture', model: 'fixture' },
  })
  await f.runtime.replaceBinding({ channelId: f.channel.id, agentId: next.definition.id, triggerPolicy: 'always' })
  release()
  expect((await command).status).toBe('failed')
  expect(
    f.admissions
      .flatMap((a) => a.events)
      .some((e) => e.parts.some((p) => p.type === 'text' && p.text === '仍然入库并准入')),
  ).toBe(true)
  expect(f.interruptTurn).not.toHaveBeenCalled()
})

it('holds startup commands until extension activations have been restored', async () => {
  const f = await setup(true)
  // Before mounts are restored the committed activation already declares the command (an unavailable placeholder),
  // so it is recognized and held rather than handed to the model as chat.
  const ready = {
    definition: CommandDefinitionSchema.parse({ name: 'ready', description: '启动恢复测试' }),
    fullName: 'ext_ready:ready',
    source: '恢复测试',
    extensionRevisionId: ExtensionRevisionIdSchema.parse('xrv_READY'),
  }
  f.extensions.push({
    ...ready,
    unavailableReason: '恢复中',
    invoke: () => ({ parts: [{ type: 'text', text: '未恢复' }] }),
  })
  const commit = await f.inbound('/ready')
  expect(f.repository.commands.forEvent(commit.channelEventId)?.status).toBe('pending')
  expect(f.adapter.deliveries).toHaveLength(0)
  expect(f.admissions).toHaveLength(0)
  f.extensions.splice(0, f.extensions.length, {
    ...ready,
    invoke: () => ({ parts: [{ type: 'text', text: '已恢复' }] }),
  })
  f.commands.open()
  await f.commands.idle()
  expect(f.repository.commands.forEvent(commit.channelEventId)?.status).toBe('succeeded')
  expect(f.adapter.deliveries).toHaveLength(1)
})
