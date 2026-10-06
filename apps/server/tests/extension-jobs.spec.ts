import { LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { AgentIdSchema, ChannelEventIdSchema, ChannelIdSchema, ExtensionIdSchema } from '@nekro-nxt/contracts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NekroRuntime } from '../src/bootstrap.js'
import { ExtensionJobScheduler, ONCE_JOB_EXPIRY_MS, type ScheduledJobRow } from '../src/extension-jobs.js'

const temporaryDirectories: string[] = []

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
  override async *stream(): AsyncIterable<StreamChunk> {
    await Promise.resolve()
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const HOUR = 60 * 60 * 1000
const agentId = AgentIdSchema.parse('agt_JOBS')
const channelId = ChannelIdSchema.parse('chn_JOBS')

const row = (overrides: Partial<ScheduledJobRow>): ScheduledJobRow => ({
  id: 'job_FIXTURE',
  agentId,
  extensionId: ExtensionIdSchema.parse('ext_JOBS'),
  channelId,
  label: '示例任务',
  schedule: { kind: 'cron', cron: '0 * * * *', timezone: 'UTC' },
  payload: null,
  nextRunAt: 0,
  ...overrides,
})

const schedulerFor = (rows: ScheduledJobRow[], options: { now: number; active?: boolean }) => {
  const order: string[] = []
  const advanced: { id: string; nextRunAt: number | undefined }[] = []
  const fire = vi.fn((job: Parameters<ConstructorParameters<typeof ExtensionJobScheduler>[0]['fire']>[0]) => {
    order.push(`fire:${job.jobId}`)
    return Promise.resolve({ channelEventId: ChannelEventIdSchema.parse('evt_FIXTURE'), inserted: true })
  })
  const scheduler = new ExtensionJobScheduler({
    due: (now) => rows.filter((candidate) => candidate.nextRunAt <= now),
    advance: ({ id, nextRunAt }) => {
      order.push(`advance:${id}`)
      advanced.push({ id, nextRunAt })
      return true
    },
    active: () => options.active ?? true,
    extensionName: () => '示例扩展',
    fire,
    now: () => options.now,
  })
  return { scheduler, fire, order, advanced }
}

describe('extension job scheduler', () => {
  it('fires each due occurrence before advancing it and collapses missed cron runs into one', async () => {
    const now = Date.UTC(2026, 0, 2, 10, 30)
    const { scheduler, fire, order, advanced } = schedulerFor([row({ nextRunAt: Date.UTC(2026, 0, 1, 0, 0) })], {
      now,
    })
    await scheduler.tick()
    expect(order).toEqual(['fire:job_FIXTURE', 'advance:job_FIXTURE'])
    expect(fire.mock.calls[0]?.[0]).toMatchObject({
      scheduledAt: Date.UTC(2026, 0, 1, 0, 0),
      firedAt: now,
      extensionName: '示例扩展',
    })
    // Thirty-odd missed hourly runs collapse: the next run is the first one after now.
    expect(advanced).toEqual([{ id: 'job_FIXTURE', nextRunAt: Date.UTC(2026, 0, 2, 11, 0) }])
    await scheduler.dispose()
  })

  it('drops one-off jobs overdue by more than seven days and keeps disabled extensions silent', async () => {
    const now = Date.UTC(2026, 0, 20)
    const expired = schedulerFor(
      [
        row({
          schedule: { kind: 'once', at: now - ONCE_JOB_EXPIRY_MS - HOUR },
          nextRunAt: now - ONCE_JOB_EXPIRY_MS - HOUR,
        }),
      ],
      { now },
    )
    await expired.scheduler.tick()
    expect(expired.fire).not.toHaveBeenCalled()
    expect(expired.advanced).toEqual([{ id: 'job_FIXTURE', nextRunAt: undefined }])

    const disabled = schedulerFor([row({ nextRunAt: now - HOUR })], { now, active: false })
    await disabled.scheduler.tick()
    expect(disabled.fire).not.toHaveBeenCalled()
    expect(disabled.advanced).toHaveLength(1)
  })

  it('shares one sweep between overlapping ticks and stops after dispose', async () => {
    const now = Date.UTC(2026, 0, 2)
    const { scheduler, fire } = schedulerFor([row({ nextRunAt: now - HOUR })], { now })
    await Promise.all([scheduler.tick(), scheduler.tick()])
    expect(fire).toHaveBeenCalledTimes(1)
    await scheduler.dispose()
    await scheduler.tick()
    expect(fire).toHaveBeenCalledTimes(1)
  })

  it('fires a due built-in reminder once Admission opens in a real Host', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-jobs-'))
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
    try {
      await runtime.start()
      const entity = await runtime.createAgentWithInternalChannel({
        displayName: '提醒智能体',
        persona: '',
        model: { provider: 'test-provider', model: 'chat-model' },
      })
      const scheduledAt = Date.now() - 1000
      runtime.repository.createExtensionJob({
        id: 'job_REMINDER',
        agentId: entity.agentId,
        extensionId: null,
        channelId: entity.channelId,
        source: 'reminder',
        declaredKey: null,
        label: '喝水提醒',
        scheduleKind: 'once',
        runAt: scheduledAt,
        cron: null,
        timezone: null,
        payloadJson: {},
        nextRunAt: scheduledAt,
        lastFiredAt: null,
        paused: false,
        createdAt: scheduledAt - 1000,
      })
      await runtime.recover()
      await vi.waitFor(() => {
        const fired = runtime.repository
          .listChannelEvents(entity.channelId, { limit: 20 })
          .find((event) => event.facts?.['extensionJob'] !== undefined)
        expect(fired?.kind).toBe('control')
        expect(fired?.facts?.['extensionJob']).toMatchObject({ jobId: 'job_REMINDER', scheduledAt })
      })
      await vi.waitFor(() => expect(runtime.repository.getExtensionJob('job_REMINDER')?.nextRunAt).toBeNull())
    } finally {
      await runtime.dispose()
    }
  })
})
