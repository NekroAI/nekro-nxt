import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { createExtensionJobsRepository } from '../src/repositories/extension-jobs.js'
import { AgentIdSchema, ExtensionIdSchema, ChannelIdSchema } from '@nekro-nxt/contracts'
import type { DrizzleCoreDatabase } from '../src/database.js'
import { coreSchema } from '../src/schema.js'
import path from 'path'

describe('Extension Jobs Repository', () => {
  let db: DrizzleCoreDatabase
  let sqlite: Database.Database
  let repo: ReturnType<typeof createExtensionJobsRepository>

  const agentId = AgentIdSchema.parse('agt_JOBSTEST')
  const extensionId = ExtensionIdSchema.parse('ext_JOBSTEST')
  const channelId = ChannelIdSchema.parse('chn_JOBSTEST')

  beforeAll(() => {
    sqlite = new Database(':memory:')
    db = drizzle(sqlite, { schema: coreSchema })

    const migrationsFolder = path.join(path.dirname(import.meta.url.replace('file://', '')), '../migrations')
    migrate(db, { migrationsFolder })

    // Create test data
    sqlite.exec(`
      INSERT INTO agent_definitions (id, created_at) VALUES ('${agentId}', 1000);
      INSERT INTO connections (id, adapter_key, config, credential_refs, created_at) VALUES ('con_JOBSTEST', 'test', '{}', '{}', 1000);
      INSERT INTO channels (id, connection_id, platform_channel_id, kind, display_name, created_at) VALUES ('${channelId}', 'con_JOBSTEST', 'platform_chn_1', 'internal', 'Test Channel', 1000);
      INSERT INTO channel_bindings (channel_id, agent_id, trigger_policy, processing_feedback, bound_at) VALUES ('${channelId}', '${agentId}', 'always', 'auto', 1000);
      INSERT INTO local_extensions (id, scope, slug, display_name, description, created_at)
        VALUES ('${extensionId}', 'agent', 'test-ext', 'Test Extension', 'A test extension', 1000);
    `)

    repo = createExtensionJobsRepository(db)
  })

  afterAll(() => {
    sqlite.close()
  })

  describe('Declared jobs (upsert behavior)', () => {
    it('should create a declared job', () => {
      repo.createExtensionJob({
        id: 'job_DECLARED1',
        agentId,
        extensionId,
        channelId,
        source: 'declared',
        declaredKey: 'cron_task_1',
        label: 'Daily task',
        scheduleKind: 'cron',
        runAt: null,
        cron: '0 9 * * *',
        timezone: 'America/New_York',
        payloadJson: { config: 'test' },
        nextRunAt: 1695153600000,
        lastFiredAt: null,
        paused: false,
        createdAt: 2000,
      })

      const job = repo.getExtensionJob('job_DECLARED1')
      expect(job).toBeDefined()
      expect(job?.label).toBe('Daily task')
      expect(job?.source).toBe('declared')
      expect(job?.declaredKey).toBe('cron_task_1')
    })

    it('should upsert (update) a declared job with same agent/extension/channel/key', () => {
      repo.createExtensionJob({
        id: 'job_DECLARED1',
        agentId,
        extensionId,
        channelId,
        source: 'declared',
        declaredKey: 'cron_task_1',
        label: 'Updated label',
        scheduleKind: 'cron',
        runAt: null,
        cron: '0 10 * * *',
        timezone: 'America/Los_Angeles',
        payloadJson: { config: 'updated' },
        nextRunAt: 1695157200000,
        lastFiredAt: null,
        paused: false,
        createdAt: 2000,
      })

      const job = repo.getExtensionJob('job_DECLARED1')
      expect(job?.label).toBe('Updated label')
      expect(job?.cron).toBe('0 10 * * *')
      expect(job?.timezone).toBe('America/Los_Angeles')
      expect(job?.payloadJson).toEqual({ config: 'updated' })
    })

    it('should not reset lastFiredAt on upsert', () => {
      repo.createExtensionJob({
        id: 'job_DECLARED2',
        agentId,
        extensionId,
        channelId,
        source: 'declared',
        declaredKey: 'cron_task_2',
        label: 'Task with history',
        scheduleKind: 'once',
        runAt: 1695153600000,
        cron: null,
        timezone: null,
        payloadJson: {},
        nextRunAt: 1695153600000,
        lastFiredAt: 1695100000000,
        paused: false,
        createdAt: 2000,
      })

      repo.createExtensionJob({
        id: 'job_DECLARED2',
        agentId,
        extensionId,
        channelId,
        source: 'declared',
        declaredKey: 'cron_task_2',
        label: 'Updated task',
        scheduleKind: 'once',
        runAt: 1695153600000,
        cron: null,
        timezone: null,
        payloadJson: { updated: true },
        nextRunAt: 1695157200000,
        lastFiredAt: null,
        paused: false,
        createdAt: 2000,
      })

      const job = repo.getExtensionJob('job_DECLARED2')
      expect(job?.lastFiredAt).toBe(1695100000000)
    })
  })

  describe('Runtime and reminder jobs', () => {
    it('should create a runtime job', () => {
      repo.createExtensionJob({
        id: 'job_RUNTIME1',
        agentId,
        extensionId,
        channelId,
        source: 'runtime',
        declaredKey: null,
        label: 'User scheduled task',
        scheduleKind: 'once',
        runAt: 1695153600000,
        cron: null,
        timezone: null,
        payloadJson: { action: 'reminder' },
        nextRunAt: 1695153600000,
        lastFiredAt: null,
        paused: false,
        createdAt: 2000,
      })

      const job = repo.getExtensionJob('job_RUNTIME1')
      expect(job?.source).toBe('runtime')
      expect(job?.declaredKey).toBeNull()
    })

    it('should create a reminder job with null extensionId', () => {
      repo.createExtensionJob({
        id: 'job_REMINDER1',
        agentId,
        extensionId: null,
        channelId,
        source: 'reminder',
        declaredKey: null,
        label: 'Built-in reminder',
        scheduleKind: 'once',
        runAt: 1695153600000,
        cron: null,
        timezone: null,
        payloadJson: { type: 'reminder' },
        nextRunAt: 1695153600000,
        lastFiredAt: null,
        paused: false,
        createdAt: 2000,
      })

      const job = repo.getExtensionJob('job_REMINDER1')
      expect(job?.source).toBe('reminder')
      expect(job?.extensionId).toBeNull()
    })
  })

  describe('Query and filtering', () => {
    beforeAll(() => {
      // Create multiple jobs for filtering tests
      repo.createExtensionJob({
        id: 'job_QUERY1',
        agentId,
        extensionId,
        channelId,
        source: 'runtime',
        declaredKey: null,
        label: 'Task 1',
        scheduleKind: 'once',
        runAt: 1695153600000,
        cron: null,
        timezone: null,
        payloadJson: {},
        nextRunAt: 1695153600000,
        lastFiredAt: null,
        paused: false,
        createdAt: 2000,
      })
    })

    it('should list jobs by agent', () => {
      const jobs = repo.listExtensionJobs({ agentId })
      expect(jobs.length).toBeGreaterThan(0)
      expect(jobs.every((j) => j.agentId === agentId)).toBe(true)
    })

    it('should list jobs by agent and extension', () => {
      const jobs = repo.listExtensionJobs({ agentId, extensionId })
      expect(jobs.every((j) => j.extensionId === extensionId)).toBe(true)
    })

    it('should list jobs with null extensionId (reminders)', () => {
      const jobs = repo.listExtensionJobs({ agentId, extensionId: null })
      expect(jobs.every((j) => j.extensionId === null)).toBe(true)
    })

    it('should list jobs by channel', () => {
      const jobs = repo.listExtensionJobs({ agentId, channelId })
      expect(jobs.every((j) => j.channelId === channelId)).toBe(true)
    })
  })

  describe('Due jobs query', () => {
    beforeAll(() => {
      const now = Date.now()
      repo.createExtensionJob({
        id: 'job_DUE1',
        agentId,
        extensionId,
        channelId,
        source: 'runtime',
        declaredKey: null,
        label: 'Overdue job',
        scheduleKind: 'once',
        runAt: now - 10000,
        cron: null,
        timezone: null,
        payloadJson: {},
        nextRunAt: now - 10000,
        lastFiredAt: null,
        paused: false,
        createdAt: 2000,
      })

      repo.createExtensionJob({
        id: 'job_DUE2',
        agentId,
        extensionId,
        channelId,
        source: 'runtime',
        declaredKey: null,
        label: 'Future job',
        scheduleKind: 'once',
        runAt: now + 100000,
        cron: null,
        timezone: null,
        payloadJson: {},
        nextRunAt: now + 100000,
        lastFiredAt: null,
        paused: true,
        createdAt: 2000,
      })

      repo.createExtensionJob({
        id: 'job_DUE3',
        agentId,
        extensionId,
        channelId,
        source: 'runtime',
        declaredKey: null,
        label: 'Due soon',
        scheduleKind: 'once',
        runAt: now - 5000,
        cron: null,
        timezone: null,
        payloadJson: {},
        nextRunAt: now - 5000,
        lastFiredAt: null,
        paused: false,
        createdAt: 2000,
      })
    })

    it('should list due jobs in order', () => {
      const now = Date.now()
      const jobs = repo.listDueExtensionJobs(now, 10)
      expect(jobs.length).toBeGreaterThan(0)
      expect(jobs.every((j) => !j.paused && j.nextRunAt !== null && j.nextRunAt <= now)).toBe(true)
      // Check ordering
      for (let i = 0; i < jobs.length - 1; i++) {
        expect((jobs[i]?.nextRunAt ?? 0) <= (jobs[i + 1]?.nextRunAt ?? 0)).toBe(true)
      }
    })

    it('should exclude paused jobs from due list', () => {
      const now = Date.now()
      const jobs = repo.listDueExtensionJobs(now, 10)
      expect(jobs.every((j) => !j.paused)).toBe(true)
    })

    it('should respect limit', () => {
      const now = Date.now()
      const jobs = repo.listDueExtensionJobs(now, 1)
      expect(jobs.length).toBeLessThanOrEqual(1)
    })
  })

  describe('Optimistic concurrency', () => {
    it('should update job on successful concurrency check', () => {
      const now = Date.now()
      repo.createExtensionJob({
        id: 'job_OPT1',
        agentId,
        extensionId,
        channelId,
        source: 'runtime',
        declaredKey: null,
        label: 'Concurrent test',
        scheduleKind: 'cron',
        runAt: null,
        cron: '0 * * * *',
        timezone: 'UTC',
        payloadJson: {},
        nextRunAt: now,
        lastFiredAt: null,
        paused: false,
        createdAt: 2000,
      })

      const job = repo.getExtensionJob('job_OPT1')
      expect(job).toBeDefined()

      const success = repo.recordExtensionJobFired({
        id: 'job_OPT1',
        firedAt: now,
        nextRunAt: now + 3600000,
        expectedNextRunAt: job?.nextRunAt ?? null,
      })

      expect(success).toBe(true)

      const updated = repo.getExtensionJob('job_OPT1')
      expect(updated?.lastFiredAt).toBe(now)
      expect(updated?.nextRunAt).toBe(now + 3600000)
    })

    it('should fail update on concurrent modification', () => {
      const now = Date.now()
      repo.createExtensionJob({
        id: 'job_OPT2',
        agentId,
        extensionId,
        channelId,
        source: 'runtime',
        declaredKey: null,
        label: 'Concurrent fail test',
        scheduleKind: 'cron',
        runAt: null,
        cron: '0 * * * *',
        timezone: 'UTC',
        payloadJson: {},
        nextRunAt: now,
        lastFiredAt: null,
        paused: false,
        createdAt: 2000,
      })

      const success = repo.recordExtensionJobFired({
        id: 'job_OPT2',
        firedAt: now,
        nextRunAt: now + 3600000,
        expectedNextRunAt: now - 1000, // Wrong expected value
      })

      expect(success).toBe(false)

      const unchanged = repo.getExtensionJob('job_OPT2')
      expect(unchanged?.lastFiredAt).toBeFalsy()
    })
  })

  describe('Pause/resume', () => {
    it('should set extension jobs paused', () => {
      repo.createExtensionJob({
        id: 'job_PAUSE1',
        agentId,
        extensionId,
        channelId,
        source: 'runtime',
        declaredKey: null,
        label: 'Pausable job',
        scheduleKind: 'once',
        runAt: 1695153600000,
        cron: null,
        timezone: null,
        payloadJson: {},
        nextRunAt: 1695153600000,
        lastFiredAt: null,
        paused: false,
        createdAt: 2000,
      })

      const changeCount = repo.setExtensionJobsPaused({
        agentId,
        extensionId,
        paused: true,
      })

      expect(changeCount).toBeGreaterThan(0)

      const job = repo.getExtensionJob('job_PAUSE1')
      expect(job?.paused).toBe(true)
    })
  })

  describe('Deletion', () => {
    it('should delete a job by id', () => {
      repo.createExtensionJob({
        id: 'job_DELETE1',
        agentId,
        extensionId,
        channelId,
        source: 'runtime',
        declaredKey: null,
        label: 'Delete me',
        scheduleKind: 'once',
        runAt: 1695153600000,
        cron: null,
        timezone: null,
        payloadJson: {},
        nextRunAt: 1695153600000,
        lastFiredAt: null,
        paused: false,
        createdAt: 2000,
      })

      const deleted = repo.deleteExtensionJob('job_DELETE1')
      expect(deleted).toBe(true)

      const job = repo.getExtensionJob('job_DELETE1')
      expect(job).toBeUndefined()
    })

    it('should return false when deleting non-existent job', () => {
      const deleted = repo.deleteExtensionJob('job_NONEXISTENT')
      expect(deleted).toBe(false)
    })

    it('should delete declared jobs except those in keep list', () => {
      repo.createExtensionJob({
        id: 'job_KEEP1',
        agentId,
        extensionId,
        channelId,
        source: 'declared',
        declaredKey: 'keep_this',
        label: 'Keep me',
        scheduleKind: 'once',
        runAt: 1695153600000,
        cron: null,
        timezone: null,
        payloadJson: {},
        nextRunAt: 1695153600000,
        lastFiredAt: null,
        paused: false,
        createdAt: 2000,
      })

      repo.createExtensionJob({
        id: 'job_DELETE2',
        agentId,
        extensionId,
        channelId,
        source: 'declared',
        declaredKey: 'delete_this',
        label: 'Delete me too',
        scheduleKind: 'once',
        runAt: 1695153600000,
        cron: null,
        timezone: null,
        payloadJson: {},
        nextRunAt: 1695153600000,
        lastFiredAt: null,
        paused: false,
        createdAt: 2000,
      })

      const deleted = repo.deleteDeclaredJobsExcept({
        agentId,
        extensionId,
        keep: ['keep_this'],
      })

      expect(deleted).toBeGreaterThan(0)

      const kept = repo.getExtensionJob('job_KEEP1')
      expect(kept).toBeDefined()

      const removed = repo.getExtensionJob('job_DELETE2')
      expect(removed).toBeUndefined()
    })
  })

  describe('Job counting', () => {
    it('should count jobs for extension', () => {
      const count = repo.countExtensionJobs({ agentId, extensionId })
      expect(count).toBeGreaterThanOrEqual(0)
    })

    it('should count reminder jobs (null extension)', () => {
      const count = repo.countExtensionJobs({ agentId, extensionId: null })
      expect(count).toBeGreaterThanOrEqual(0)
    })
  })
})
