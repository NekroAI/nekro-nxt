import { CoreService } from '@nekro-nxt/core'
import { ChannelIdSchema, EpisodeIdSchema } from '@nekro-nxt/contracts'
import { openMigratedCoreDatabase, SqliteCoreRepository } from '@nekro-nxt/storage-sqlite'
import { expect, it } from 'vitest'
import { SessionRegistry } from '../src/session-registry.js'

it('removes partial initialization and rejects stale cleanup after a session identity is reused', async () => {
  const database = await openMigratedCoreDatabase(':memory:')
  try {
    const core = new CoreService(new SqliteCoreRepository(database))
    const { revision } = core.createAgent({
      displayName: '测试智能体',
      persona: '用于测试',
      model: { provider: 'fixture', model: 'fixture' },
    })
    const registry = new SessionRegistry<{ resource: string }>()
    const identity = {
      sessionId: 'fixture-session',
      revision,
      channelId: ChannelIdSchema.parse('chn_FIXTURE'),
      episodeId: EpisodeIdSchema.parse('eps_FIXTURE'),
    }
    const partial = registry.register(identity)
    partial.dynamic = { resource: 'partial-resource' }
    expect(() => registry.register(identity)).toThrow('already registered')
    expect([...registry.handles()]).toEqual([])
    registry.remove(identity.sessionId, partial)
    expect(() => registry.require(identity.sessionId)).toThrow('no longer registered')
    const replacement = registry.register(identity)
    replacement.imageInput = true
    registry.remove(identity.sessionId, partial)
    expect(registry.require(identity.sessionId)).toBe(replacement)
    expect(replacement.dynamic).toBeUndefined()
    expect([...registry.records()]).toEqual([replacement])
    registry.clear()
    expect([...registry.records()]).toEqual([])
    expect(registry.get(identity.sessionId)).toBeUndefined()
  } finally {
    database.close()
  }
})
