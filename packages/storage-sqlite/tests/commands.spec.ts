import { afterEach, describe, expect, it } from 'vitest'
import { CoreService } from '@nekro-nxt/core'
import { COMMAND_EXECUTION_RETAIN, openMigratedCoreDatabase, SqliteCoreRepository } from '../src/index.js'

const closers: Array<() => void> = []
afterEach(() => {
  for (const close of closers.splice(0)) close()
})

const fixture = async () => {
  const database = await openMigratedCoreDatabase(':memory:')
  closers.push(() => database.close())
  const repository = new SqliteCoreRepository(database)
  const core = new CoreService(repository)
  const connection = core.createConnection({ adapterKey: 'fixture', config: {} })
  const channel = core.createChannel({ connectionId: connection.id, platformChannelId: 'room', kind: 'group' })
  return { repository, core, connection, channel }
}

describe('command execution storage', () => {
  it('compacts settled executions beyond the retained window and keeps recent and unsettled ones whole', async () => {
    const { repository, channel } = await fixture()
    const total = COMMAND_EXECUTION_RETAIN + 5
    for (let index = 0; index < total; index += 1) {
      repository.commands.insert({
        id: `cmd_${String(index).padStart(5, '0')}`,
        channelId: channel.id,
        source: 'web',
        requestId: `request-${index}`,
        rawText: '/status',
        identity: { source: 'web', displayName: '管理员' },
        status: 'succeeded',
        result: { parts: [{ type: 'text', text: '完成' }] },
        replies: [],
        createdAt: index,
        completedAt: index,
      })
    }
    repository.commands.insert({
      id: 'cmd_pending',
      channelId: channel.id,
      source: 'web',
      requestId: 'pending',
      rawText: '/help',
      identity: { source: 'web', displayName: '管理员' },
      status: 'pending',
      replies: [],
      createdAt: 0,
    })
    expect(repository.commands.compact(channel.id)).toBe(5)
    expect(repository.commands.get('cmd_00000')?.rawText).toBe('')
    expect(repository.commands.get('cmd_00004')?.rawText).toBe('')
    expect(repository.commands.get('cmd_00005')?.rawText).toBe('/status')
    expect(repository.commands.get(`cmd_${String(total - 1).padStart(5, '0')}`)?.rawText).toBe('/status')
    expect(repository.commands.get('cmd_pending')?.rawText).toBe('/help')
    // Compaction is idempotent.
    expect(repository.commands.compact(channel.id)).toBe(0)
  })

  it('turns an interrupted run into an uncertain result with a final reply and never queues it again', async () => {
    const { repository, channel } = await fixture()
    const record = repository.commands.insert({
      id: 'cmd_running',
      channelId: channel.id,
      source: 'web',
      requestId: 'running',
      rawText: '/reset',
      identity: { source: 'web', displayName: '管理员' },
      status: 'pending',
      replies: [],
      createdAt: 1,
    })
    expect(repository.commands.claim(record.id)).toBe(true)
    repository.commands.recover(10)
    const recovered = repository.commands.get(record.id)!
    expect(recovered.status).toBe('uncertain')
    expect(recovered.replies.map((reply) => reply.kind)).toEqual(['final'])
    expect(repository.commands.claim(record.id)).toBe(false)
  })

  it('never lists command messages as pending for the agent, executed or deliberately ignored', async () => {
    const { repository, core, connection, channel } = await fixture()
    const agent = core.createAgent({ displayName: '示例', persona: '', model: { provider: 'deepseek', model: 'v4' } })
    core.createBinding({ channelId: channel.id, agentId: agent.definition.id, triggerPolicy: 'always' })
    const message = (key: string, text: string, receivedAt: number) =>
      core.appendInbound({
        connectionId: connection.id,
        channelId: channel.id,
        adapterKey: 'fixture',
        kind: 'message-created',
        parts: [{ type: 'text', text }],
        platformTimestamp: receivedAt,
        receivedAt,
        dedupeKey: key,
      }).event
    const chat = message('chat', '你好', 10)
    const executed = message('executed', '/status', 11)
    const ignored = message('ignored', '/status', 12)
    const later = message('later', '在吗', 13)
    repository.commands.insert({
      id: 'cmd_executed',
      channelId: channel.id,
      source: 'platform',
      requestId: executed.id,
      eventId: executed.id,
      rawText: '/status',
      identity: { source: 'platform', connectionId: connection.id, displayName: '平台用户' },
      status: 'succeeded',
      replies: [],
      createdAt: 11,
    })
    repository.commands.ignore(ignored.id, 'rate-limited')
    expect(repository.commands.isCommandEvent(executed.id)).toBe(true)
    expect(repository.commands.isCommandEvent(ignored.id)).toBe(true)
    expect(repository.listUnadmittedEvents(channel.id, agent.definition.id, 0).map(({ id }) => id)).toEqual([
      chat.id,
      later.id,
    ])
  })
})
