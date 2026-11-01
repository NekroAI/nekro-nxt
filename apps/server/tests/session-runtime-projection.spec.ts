import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { Context, type Message } from '@deepseek-ai/cordis'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { ChannelIdSchema, EpisodeIdSchema } from '@nekro-nxt/contracts'
import { CoreService } from '@nekro-nxt/core'
import { openMigratedCoreDatabase, SqliteCoreRepository } from '@nekro-nxt/storage-sqlite'
import { describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from '../src/session-registry.ts'
import { SessionRuntimeProjection, toolProgressUpdate } from '../src/session-runtime-projection.ts'

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

  it('publishes tool progress at most twice a second, keeps the latest and forgets it when the call returns', async () => {
    const context = new Context()
    const database = await openMigratedCoreDatabase(':memory:')
    const sessions = new SessionRegistry<unknown>()
    vi.useFakeTimers()
    const projection = new SessionRuntimeProjection(context, sessions)
    try {
      await context.plugin(SessionProjectionRegistry)
      const core = new CoreService(new SqliteCoreRepository(database))
      const { revision } = core.createAgent({
        displayName: '测试智能体',
        persona: '',
        model: { provider: 'synthetic-provider', model: 'synthetic-model' },
      })
      const session = Session.create(SessionId('synthetic-progress'))
      const channelId = ChannelIdSchema.parse('chn_progress')
      sessions.register({ sessionId: session.id, revision, channelId, episodeId: EpisodeIdSchema.parse('eps_test') })
      const listener = vi.fn()
      projection.subscribeChannelRuntime(listener)
      projection.reportToolProgress(session.id, 'call_1', { text: '第 1 段', fraction: 0.1 })
      vi.advanceTimersByTime(100)
      expect(listener).toHaveBeenCalledTimes(1)
      projection.reportToolProgress(session.id, 'call_1', { text: '第 2 段', fraction: 0.2 })
      projection.reportToolProgress(session.id, 'call_1', { text: '第 3 段', fraction: 2 })
      vi.advanceTimersByTime(200)
      expect(listener).toHaveBeenCalledTimes(1)
      expect(projection.toolProgress(session.id).get('call_1')).toEqual({ text: '第 3 段', fraction: 1 })
      vi.advanceTimersByTime(400)
      expect(listener).toHaveBeenCalledTimes(2)
      projection.reportToolProgress(session.id, 'call_1', { fraction: 0.5 })
      projection.reportToolProgress('unknown-session', 'call_1', { text: '无主' })
      expect(projection.toolProgress('unknown-session').size).toBe(0)
      context.emit('session/event', session, {
        type: 'tool/result',
        surfaceOp: 'append',
        seq: SessionSeq(1),
        time: 2000,
        data: {
          turn: 1,
          step: 1,
          message: createToolResultMessage({ callId: ToolCallId('call_1'), content: [], isError: false }),
        },
      })
      expect(projection.toolProgress(session.id).size).toBe(0)
    } finally {
      projection.dispose()
      vi.useRealTimers()
      await context.fiber.dispose()
      database.close()
    }
  })

  it('accepts only a sentence and a share as progress', () => {
    expect(toolProgressUpdate({ text: '  处理中  ' })).toEqual({ text: '处理中' })
    expect(toolProgressUpdate({ text: 'x'.repeat(300), fraction: -1 })).toEqual({
      text: `${'x'.repeat(199)}…`,
      fraction: 0,
    })
    for (const value of [undefined, null, 'text', { text: '' }, { text: 3 }])
      expect(toolProgressUpdate(value)).toBeUndefined()
  })
})
