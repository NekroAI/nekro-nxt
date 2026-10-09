import { LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NekroRuntime } from '../src/bootstrap.js'
import {
  CHAT_TASK_LIMIT_PER_CHANNEL,
  FINISHED_TASK_RETENTION_MS,
  formatContextTime,
  formatTaskTime,
  parseTaskSchedule,
} from '../src/scheduled-tasks.js'

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

const withRuntime = async (test: (runtime: NekroRuntime) => Promise<void>) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-scheduled-'))
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
    await test(runtime)
  } finally {
    await runtime.dispose()
  }
}

const createAgent = (runtime: NekroRuntime, displayName: string, scheduledTasks = true) =>
  runtime.createAgentWithInternalChannel({
    displayName,
    persona: '',
    model: { provider: 'test-provider', model: 'chat-model' },
    capabilities: {
      subagents: false,
      fileTools: false,
      webSearch: false,
      dynamicCreation: false,
      developmentShell: false,
      unrestrictedFileAccess: false,
      scheduledTasks,
    },
  })

const HOUR = 60 * 60 * 1000

describe('scheduled task schedules', () => {
  const now = Date.UTC(2026, 9, 7, 4, 0)

  it('reads wall-clock times in the given zone, ISO offsets and minutes from now', () => {
    expect(parseTaskSchedule({ at: '2026-10-08 08:00', timezone: 'Asia/Shanghai' }, now)).toEqual({
      kind: 'once',
      at: Date.UTC(2026, 9, 8, 0, 0),
    })
    expect(parseTaskSchedule({ at: '2026-10-08T08:00:00+09:00' }, now)).toEqual({
      kind: 'once',
      at: Date.UTC(2026, 9, 7, 23, 0),
    })
    expect(parseTaskSchedule({ delayMinutes: 30 }, now)).toEqual({ kind: 'once', at: now + 30 * 60_000 })
    expect(parseTaskSchedule({ cron: '0 8 * * 1-5', timezone: 'Asia/Shanghai' }, now)).toEqual({
      kind: 'cron',
      cron: '0 8 * * 1-5',
      timezone: 'Asia/Shanghai',
    })
    expect(formatTaskTime(Date.UTC(2026, 9, 8, 0, 0), 'Asia/Shanghai')).toBe('2026-10-08 08:00')
  })

  it('writes context time with an explicit offset and states the date once per day', () => {
    const morning = Date.UTC(2026, 9, 8, 6, 3, 12)
    expect(formatContextTime(morning, undefined, 'Asia/Shanghai')).toBe('2026-10-08 14:03:12 +08:00')
    expect(formatContextTime(morning, undefined, 'UTC')).toBe('2026-10-08 06:03:12 +00:00')
    expect(formatContextTime(morning, undefined, 'America/St_Johns')).toBe('2026-10-08 03:33:12 -02:30')
    expect(formatContextTime(morning + 60_000, morning, 'Asia/Shanghai')).toBe('14:04:12')
    // Midnight in the zone starts a new date even when UTC has not.
    expect(formatContextTime(Date.UTC(2026, 9, 8, 16, 0, 0), morning, 'Asia/Shanghai')).toBe(
      '2026-10-09 00:00:00 +08:00',
    )
    // A DST change on the same day restates the offset.
    expect(formatContextTime(Date.UTC(2026, 10, 1, 7, 0, 0), Date.UTC(2026, 10, 1, 4, 0, 0), 'America/New_York')).toBe(
      '2026-11-01 02:00:00 -05:00',
    )
  })

  it('rejects past times, several schedules at once, bad cron and unknown zones', () => {
    expect(() => parseTaskSchedule({ at: '2026-10-07 08:00', timezone: 'Asia/Shanghai' }, now)).toThrow('已经过去')
    expect(() => parseTaskSchedule({ delayMinutes: 5, cron: '* * * * *' }, now)).toThrow('只能提供其中一个')
    expect(() => parseTaskSchedule({ cron: '0 8 * *' }, now)).toThrow('五段')
    expect(() => parseTaskSchedule({ cron: '0 8 * * *', timezone: 'Mars/Base' }, now)).toThrow('时区无效')
    expect(() => parseTaskSchedule({ at: '明天早上' }, now)).toThrow('at 需要')
  })
})

describe('scheduled tasks in a real Host', () => {
  it('lets the agent manage only its own channel and keeps the per-channel cap', async () => {
    await withRuntime(async (runtime) => {
      const first = await createAgent(runtime, '定时甲')
      const second = await createAgent(runtime, '定时乙')
      const tasks = runtime.scheduledTasks
      const agent = { kind: 'agent', agentId: first.agentId, channelId: first.channelId } as const
      const task = tasks.create({
        agentId: first.agentId,
        channelId: first.channelId,
        label: '提醒大家喝水',
        note: '来自示例成员',
        schedule: { kind: 'cron', cron: '0 * * * *', timezone: 'UTC' },
      })
      expect(task).toMatchObject({ source: 'chat', state: 'scheduled', note: '来自示例成员' })
      expect(tasks.list({ agentId: first.agentId })).toHaveLength(1)
      expect(tasks.list({ agentId: second.agentId })).toHaveLength(0)

      const outsider = { kind: 'agent', agentId: second.agentId, channelId: second.channelId } as const
      expect(() => tasks.pause(outsider, task.id)).toThrow('没有找到')
      expect(() => tasks.update({ kind: 'admin' }, task.id, { label: '改掉' })).toThrow('不能在这里修改')

      const updated = tasks.update(agent, task.id, { label: '提醒大家喝温水', note: '' })
      expect(updated.label).toBe('提醒大家喝温水')
      expect(updated.note).toBeUndefined()

      for (let index = 1; index < CHAT_TASK_LIMIT_PER_CHANNEL; index += 1) {
        tasks.create({
          agentId: first.agentId,
          channelId: first.channelId,
          label: `示例任务 ${index}`,
          schedule: { kind: 'once', at: Date.now() + HOUR },
        })
      }
      expect(() =>
        tasks.create({
          agentId: first.agentId,
          channelId: first.channelId,
          label: '超出上限',
          schedule: { kind: 'once', at: Date.now() + HOUR },
        }),
      ).toThrow(`最多保留 ${CHAT_TASK_LIMIT_PER_CHANNEL} 个`)

      tasks.delete(agent, task.id)
      expect(tasks.list({ agentId: first.agentId })).toHaveLength(CHAT_TASK_LIMIT_PER_CHANNEL - 1)
    })
  })

  it('resumes a paused periodic task from now and runs one occurrence without moving the plan', async () => {
    await withRuntime(async (runtime) => {
      const entity = await createAgent(runtime, '定时丙')
      const admin = { kind: 'admin' } as const
      const changes: number[] = []
      const unsubscribe = runtime.scheduledTasks.subscribe(() => changes.push(Date.now()))
      const task = runtime.scheduledTasks.create({
        agentId: entity.agentId,
        channelId: entity.channelId,
        label: '每小时检查',
        schedule: { kind: 'cron', cron: '0 * * * *', timezone: 'UTC' },
      })
      expect(runtime.scheduledTasks.pause(admin, task.id).state).toBe('paused')
      runtime.repository.updateExtensionJob(task.id, { nextRunAt: Date.now() - 3 * HOUR })
      const resumed = runtime.scheduledTasks.resume(admin, task.id)
      expect(resumed.state).toBe('scheduled')
      expect(resumed.nextRunAt).toBeGreaterThan(Date.now())

      const { task: ran, woke } = await runtime.scheduledTasks.run(admin, task.id)
      expect(woke).toBe(true)
      expect(ran.nextRunAt).toBe(resumed.nextRunAt)
      expect(ran.lastFiredAt).toBeDefined()
      const fired = runtime.repository
        .listChannelEvents(entity.channelId, { limit: 20 })
        .find((event) => event.facts?.['extensionJob'] !== undefined)
      expect(fired?.kind).toBe('control')
      expect(fired?.facts?.['extensionJob']).toMatchObject({ jobId: task.id, label: '每小时检查' })
      expect(changes.length).toBeGreaterThanOrEqual(4)
      unsubscribe()

      expect(runtime.scheduledTasks.list({ agentId: entity.agentId })).toHaveLength(1)
      runtime.scheduledTasks.delete(admin, task.id)
      expect(runtime.scheduledTasks.list({ agentId: entity.agentId })).toHaveLength(0)
    })
  })

  it('removes one-off tasks that fired long ago and keeps recent ones visible', async () => {
    await withRuntime(async (runtime) => {
      const entity = await createAgent(runtime, '定时丁')
      const make = (label: string, firedAt: number) => {
        const task = runtime.scheduledTasks.create({
          agentId: entity.agentId,
          channelId: entity.channelId,
          label,
          schedule: { kind: 'once', at: Date.now() + HOUR },
        })
        runtime.repository.updateExtensionJob(task.id, { nextRunAt: null, lastFiredAt: firedAt })
        return task.id
      }
      const old = make('很久以前', Date.now() - FINISHED_TASK_RETENTION_MS - HOUR)
      const recent = make('刚刚', Date.now() - HOUR)
      runtime.scheduledTasks.prune()
      expect(runtime.repository.getExtensionJob(old)).toBeUndefined()
      expect(runtime.scheduledTasks.list({ agentId: entity.agentId })).toEqual([
        expect.objectContaining({ id: recent, state: 'finished' }),
      ])
    })
  })

  it('drops the tasks of a deleted agent', async () => {
    await withRuntime(async (runtime) => {
      const entity = await createAgent(runtime, '定时戊')
      const task = runtime.scheduledTasks.create({
        agentId: entity.agentId,
        channelId: entity.channelId,
        label: '删除后不应保留',
        schedule: { kind: 'once', at: Date.now() + HOUR },
      })
      await runtime.deleteAgent(entity.agentId, { deleteAutoCreatedBuiltInChannels: false })
      expect(runtime.repository.getExtensionJob(task.id)).toBeUndefined()
      expect(runtime.scheduledTasks.list()).toEqual([])
    })
  })

  it('offers the schedule tools only while the capability is on', async () => {
    await withRuntime(async (runtime) => {
      const on = await createAgent(runtime, '定时开')
      const off = await createAgent(runtime, '定时关', false)
      for (const [entity, key] of [
        [on, 'on'],
        [off, 'off'],
      ] as const) {
        await runtime.internalChannel.postMessage({
          channelId: entity.channelId,
          clientEventId: `schedule-tools-${key}`,
          parts: [{ type: 'text', text: '建立会话。' }],
        })
      }
      const sessionOf = (agentId: typeof on.agentId) => {
        const sessionId = runtime.repository.listActiveEpisodesForAgent(agentId)[0]?.dshSessionId
        if (!sessionId) throw new Error('Expected a live DSH Session.')
        return sessionId
      }
      const names = [
        'schedule_create',
        'schedule_list',
        'schedule_update',
        'schedule_pause',
        'schedule_resume',
        'schedule_delete',
        'schedule_run_now',
      ]
      expect(runtime.host.toolNames(sessionOf(on.agentId))).toEqual(expect.arrayContaining(names))
      expect(runtime.host.toolNames(sessionOf(off.agentId))).not.toContain('schedule_create')
      expect(runtime.repository.getAgent(off.agentId)).toBeDefined()
    })
  })
})

describe('extension due-job handlers', () => {
  it('lets the extension skip waking the agent or pass a note with the due event', async () => {
    await withRuntime(async (runtime) => {
      const entity = await createAgent(runtime, '定时己')
      const saved = await runtime.extensionService.saveDynamicPackage({
        snapshot: {
          name: '示例订阅检查',
          purpose: '只有新内容时才唤醒智能体。',
          hostCode: `harness.onJob(async (job, nxt) => {
  if (job.payload.mode === 'quiet') return { wake: false }
  return { note: '新内容：' + job.label + '（' + job.channel.kind + '）' }
})
return { inject: ['nxt'], apply() {} }`,
          permissions: {
            permissions: [],
            networkOrigins: [],
            agent: { jobs: { runtime: { maxActive: 5 } } },
          },
          contributions: [],
        },
        slug: 'job-handler-probe',
        displayName: '示例订阅检查',
        description: '只有新内容时才唤醒智能体。',
        verification: {
          dshVersion: 'fixture',
          contractVersion: 'nekro-nxt-extension-v5',
          origin: { episodeId: 'fixture', pluginId: 'fixture', packageId: 'fixture', pluginRunId: 'fixture' },
          toolInvocations: [],
          rpcMethods: [],
          renderedPanels: [],
          renderedToolViews: [],
          renderedMessageRenderers: [],
          permissions: {
            permissions: [],
            networkOrigins: [],
            agent: { jobs: { runtime: { maxActive: 5 } } },
          },
        },
      })
      const requirement = runtime.extensions.agentRequirement(entity.agentId, saved.extension.id, saved.revision.id)
      await runtime.extensions.activate({
        agentId: entity.agentId,
        extensionId: saved.extension.id,
        revisionId: saved.revision.id,
        permissionApproval: { permissionDigest: requirement.permissionDigest },
      })
      const job = (id: string, mode: string) => {
        runtime.repository.createExtensionJob({
          id,
          agentId: entity.agentId,
          extensionId: saved.extension.id,
          channelId: entity.channelId,
          source: 'runtime',
          declaredKey: null,
          label: '示例订阅',
          scheduleKind: 'cron',
          runAt: null,
          cron: '0 * * * *',
          timezone: 'UTC',
          payloadJson: { mode },
          nextRunAt: Date.now() + HOUR,
          lastFiredAt: null,
          paused: false,
          createdAt: Date.now(),
        })
        return id
      }
      const admin = { kind: 'admin' } as const
      const jobEvents = () =>
        runtime.repository
          .listChannelEvents(entity.channelId, { limit: 50 })
          .filter((event) => event.facts?.['extensionJob'] !== undefined)

      const quiet = await runtime.scheduledTasks.run(admin, job('job_QUIET', 'quiet'))
      expect(quiet.woke).toBe(false)
      expect(quiet.task.lastFiredAt).toBeDefined()
      expect(jobEvents()).toHaveLength(0)

      const noted = await runtime.scheduledTasks.run(admin, job('job_NOTED', 'note'))
      expect(noted.woke).toBe(true)
      const [event] = jobEvents()
      expect(event?.facts?.['extensionJob']).toMatchObject({ jobId: 'job_NOTED', note: '新内容：示例订阅（internal）' })
      const part = event?.parts[0]
      expect(part?.type === 'text' ? part.text : '').toContain('新内容：示例订阅')
    })
  })
})
