import { Context, type Message } from '@deepseek-ai/cordis'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { ChannelIdSchema, EpisodeIdSchema } from '@nekro-nxt/contracts'
import { CoreService } from '@nekro-nxt/core'
import { openMigratedCoreDatabase, SqliteCoreRepository } from '@nekro-nxt/storage-sqlite'
import { describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from '../src/session-registry.ts'
import { SessionRuntimeProjection } from '../src/session-runtime-projection.ts'

describe('SessionRuntimeProjection channel runtime subscription', () => {
  it('logs a failed runtime listener once, continues other channels, and cancels pending work on disposal', async () => {
    const context = new Context()
    const database = await openMigratedCoreDatabase(':memory:')
    const sessions = new SessionRegistry<unknown>()
    const projection = new SessionRuntimeProjection(context, sessions)
    const diagnostics: Message[] = []
    vi.useFakeTimers()
    try {
      await context.plugin(SessionProjectionRegistry)
      context.logger.exporter({ levels: { default: 0 }, export: (message) => diagnostics.push(message) })
      const core = new CoreService(new SqliteCoreRepository(database))
      const { revision } = core.createAgent({
        displayName: '测试智能体',
        persona: '',
        model: { provider: 'synthetic-provider', model: 'synthetic-model' },
      })
      const first = Session.create(SessionId('synthetic-first'))
      const second = Session.create(SessionId('synthetic-second'))
      const firstChannel = ChannelIdSchema.parse('chn_first')
      const secondChannel = ChannelIdSchema.parse('chn_second')
      for (const [session, channelId] of [
        [first, firstChannel],
        [second, secondChannel],
      ] as const) {
        sessions.register({ sessionId: session.id, revision, channelId, episodeId: EpisodeIdSchema.parse('eps_test') })
      }
      const failure = new Error('synthetic runtime serialization failure')
      const listener = vi.fn((channelId) => {
        if (channelId === firstChannel) throw failure
      })
      projection.subscribeChannelRuntime(listener)
      const notify = (session: Session) =>
        context.emit('session/event', session, {
          type: 'turn/start',
          seq: SessionSeq(0),
          time: 1000,
          data: { turn: 1 },
        })
      notify(first)
      notify(first)
      notify(second)
      expect(() => vi.advanceTimersByTime(100)).not.toThrow()
      expect(listener.mock.calls).toEqual([[firstChannel], [secondChannel]])
      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]).toMatchObject({ type: 'error' })
      expect(diagnostics[0]?.args).toContain(failure)

      notify(second)
      vi.advanceTimersByTime(100)
      expect(listener).toHaveBeenCalledTimes(3)
      // The same deterministic failure is not reported again on every event.
      notify(first)
      vi.advanceTimersByTime(100)
      expect(listener).toHaveBeenCalledTimes(4)
      expect(diagnostics).toHaveLength(1)
      notify(first)
      projection.dispose()
      vi.advanceTimersByTime(100)
      notify(second)
      vi.advanceTimersByTime(100)
      expect(listener).toHaveBeenCalledTimes(4)
      expect(diagnostics).toHaveLength(1)
    } finally {
      projection.dispose()
      vi.useRealTimers()
      await context.fiber.dispose()
      database.close()
    }
  })
})
