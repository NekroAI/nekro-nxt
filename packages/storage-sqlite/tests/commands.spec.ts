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
  return { repository, channel }
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
})
