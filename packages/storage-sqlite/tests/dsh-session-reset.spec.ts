import BetterSqlite3 from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AdmissionIdSchema,
  AuthoringAttemptIdSchema,
  AuthoringTaskIdSchema,
  EpisodeIdSchema,
  LogicalMessageIdSchema,
  OutboundIntentIdSchema,
  PhysicalDeliveryIdSchema,
} from '@nekro-nxt/contracts'
import { CoreService } from '@nekro-nxt/core'
import { ChannelRuntime, type AgentSessionDriver } from '@nekro-nxt/channel-runtime'
import {
  admissions,
  admissionEvents,
  dshSessionResets,
  openMigratedCoreDatabase,
  SqliteCoreRepository,
} from '../src/index.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})
const fixture = async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nxt-session-reset-'))
  directories.push(directory)
  const filename = path.join(directory, 'core.sqlite')
  const database = await openMigratedCoreDatabase(filename)
  const repository = new SqliteCoreRepository(database)
  let sequence = 0
  const core = new CoreService(repository, {
    now: () => 10,
    nextUlid: () => `TEST${String(++sequence).padStart(6, '0')}`,
  })
  const agent = core.createAgent({
    displayName: '升级样本',
    persona: '测试',
    model: { provider: 'fake', model: 'fake' },
    capabilities: {
      subagents: false,
      fileTools: false,
      webSearch: false,
      dynamicCreation: false,
      developmentShell: false,
      unrestrictedFileAccess: false,
    },
  })
  const connection = core.createConnection({ adapterKey: 'synthetic', config: {} })
  const channel = core.createChannel({ connectionId: connection.id, platformChannelId: 'synthetic', kind: 'internal' })
  const binding = {
    channelId: channel.id,
    agentId: agent.definition.id,
    boundAt: 10,
    triggerPolicy: 'always' as const,
    processingFeedback: 'off' as const,
    activityTriggerOverrides: {},
  }
  repository.replaceBinding(binding)
  const append = (key: string, receivedAt: number) =>
    core.appendInbound({
      connectionId: connection.id,
      channelId: channel.id,
      adapterKey: 'synthetic',
      kind: 'message-created',
      parts: [{ type: 'text', text: key }],
      receivedAt,
      platformTimestamp: receivedAt,
      dedupeKey: key,
    }).event
  const event = append('old-inbound', 20)
  const episodeId = EpisodeIdSchema.parse('eps_OLDSESSION')
  repository.createEpisode({
    id: episodeId,
    channelId: channel.id,
    agentId: agent.definition.id,
    agentRevisionId: agent.revision.id,
    status: 'opening',
    openedAtEventId: event.id,
    createdAt: 20,
  })
  repository.activateEpisode(episodeId, 'old-session')
  const pendingId = AdmissionIdSchema.parse('adm_PENDING')
  const claimedId = AdmissionIdSchema.parse('adm_CLAIMED')
  const loggedId = AdmissionIdSchema.parse('adm_LOGGED')
  for (const [id, state] of [
    [pendingId, 'pending'],
    [claimedId, 'claimed'],
    [loggedId, 'logged-to-session'],
  ] as const) {
    repository.createAdmission({ id, episodeId, mode: 'followup', state, eventIds: [event.id], createdAt: 21 })
  }
  append('backlog-same-time', 20)
  const taskId = AuthoringTaskIdSchema.parse('aut_UPGRADE')
  const attemptId = AuthoringAttemptIdSchema.parse('aua_UPGRADE')
  repository.createAuthoringTask({
    task: {
      id: taskId,
      agentId: agent.definition.id,
      channelId: channel.id,
      episodeId,
      initiatingEventId: event.id,
      pluginKey: 'synthetic-plugin',
      title: '样本',
      requirementSummary: '保留候选源码',
      status: 'running',
      revision: 1,
      approvalPolicy: 'risk-stable',
      approvedRiskDigest: 'approved-before-reset',
      createdAt: 22,
      updatedAt: 22,
    },
    attempt: {
      id: attemptId,
      taskId,
      ordinal: 1,
      name: '样本',
      purpose: '保留源码',
      snapshotDigest: 'a'.repeat(64),
      riskDigest: 'b'.repeat(64),
      sourcePath: '/synthetic/workspace/source.ts',
      state: 'active',
      host: { status: 'running', waitingFor: [] },
      client: { status: 'running', waitingFor: [] },
      runnerPackageId: 'package-before-reset',
      runnerRunId: 'run-before-reset',
      createdAt: 22,
    },
    event: { taskId, sequence: 1, kind: 'task-created', attemptId, payload: {}, createdAt: 22 },
  })
  const outboundId = OutboundIntentIdSchema.parse('out_PRESERVED')
  const deliveryId = PhysicalDeliveryIdSchema.parse('phy_PRESERVED')
  repository.createOutboundPlan(
    {
      id: outboundId,
      logicalMessageId: LogicalMessageIdSchema.parse('msg_OUTBOUND'),
      agentRevisionId: agent.revision.id,
      episodeId,
      parts: [{ type: 'text', text: '已经提交的出站' }],
      state: 'planned',
      createdAt: 23,
    },
    [
      {
        id: deliveryId,
        intentId: outboundId,
        sequence: 0,
        parts: [{ type: 'text', text: '已经提交的出站' }],
        state: 'planned',
      },
    ],
  )
  return {
    database,
    repository,
    core,
    filename,
    agent,
    channel,
    binding,
    append,
    event,
    episodeId,
    pendingId,
    claimedId,
    loggedId,
    taskId,
    attemptId,
    outboundId,
  }
}

describe('atomic Session retirement', () => {
  it('preserves product facts, cancels Admissions, interrupts authoring and excludes only old backlog', async () => {
    const f = await fixture()
    try {
      const outbound = f.repository.getOutbound(f.outboundId)
      const report = f.repository.retireDshSessionEpisodes({ migrationId: 'sqlite17-to-jsonl:synthetic', closedAt: 30 })
      expect(report).toMatchObject({
        episodesClosed: 1,
        admissionsCancelled: 2,
        bindingsCutOff: 1,
        authoringTasksInterrupted: 1,
        alreadyApplied: false,
      })
      expect(f.repository.getEpisode(f.episodeId)).toMatchObject({
        status: 'closed',
        closeReason: 'incompatible-session-storage',
      })
      expect(
        f.database.db
          .select()
          .from(admissions)
          .all()
          .map(({ state }) => state),
      ).toEqual(['cancelled', 'cancelled', 'logged-to-session'])
      expect(f.database.db.select().from(admissionEvents).all()).toHaveLength(3)
      expect(() => f.repository.claimAdmission(f.pendingId)).toThrow('not pending')
      expect(() => f.repository.completeAdmission(f.claimedId, 'stale-session-message', f.event.id)).toThrow(
        'not claimed',
      )
      expect(f.repository.listRecoverableAdmissions(f.episodeId)).toEqual([])
      expect(f.repository.listUnadmittedEvents(f.channel.id, f.agent.definition.id, 10)).toEqual([])
      expect(f.repository.getBinding(f.channel.id)).toEqual(f.binding)
      expect(f.repository.getAgent(f.agent.definition.id)).toEqual(f.agent)
      expect(f.repository.getOutbound(f.outboundId)).toEqual(outbound)
      expect(f.repository.getChannelEvent(f.event.id)).toEqual(f.event)
      expect(f.repository.getAuthoringTask(f.taskId)).toMatchObject({ status: 'interrupted', revision: 2 })
      expect(f.repository.getAuthoringTask(f.taskId)?.approvedRiskDigest).toBeUndefined()
      expect(f.repository.getAuthoringAttempt(f.attemptId)).toMatchObject({
        sourcePath: '/synthetic/workspace/source.ts',
        snapshotDigest: 'a'.repeat(64),
        state: 'stopped',
        host: { status: 'stopped' },
        client: { status: 'stopped' },
      })
      expect(f.repository.getAuthoringAttempt(f.attemptId)?.runnerRunId).toBeUndefined()
      expect(f.repository.listAuthoringEvents(f.taskId).at(-1)).toMatchObject({
        kind: 'task-interrupted',
        sequence: 2,
        payload: { migrationId: report.migrationId, reason: 'incompatible-session-storage' },
      })
      const next = f.append('new-inbound-same-time', 20)
      expect(f.repository.listUnadmittedEvents(f.channel.id, f.agent.definition.id, 10)).toEqual([next])
    } finally {
      f.database.close()
    }
  })

  it('opens the startup gate against real persisted cutoffs without replaying old inbound', async () => {
    const f = await fixture()
    const admitted: string[] = []
    const driver: AgentSessionDriver = {
      createSession: ({ episodeId }) => Promise.resolve(`new-${episodeId}`),
      applyCompatibleRevision: () => Promise.resolve(),
      sessionStatus: () => 'idle',
      findAdmissionMessage: () => undefined,
      createHandoffSummary: () => Promise.resolve({ summary: '', provider: 'fake', model: 'fake' }),
      cancelSession: () => Promise.resolve(),
      admit: ({ admissionId, events }) => {
        admitted.push(...events.map(({ id }) => id))
        return Promise.resolve({ dshMessageId: `message-${admissionId}` })
      },
      notifyConsoleOutbound: () => Promise.resolve(),
    }
    const runtime = new ChannelRuntime(f.core, f.repository, f.repository, driver, {
      deferAdmission: true,
      resolveAdapter: () => undefined,
      now: () => 100,
    })
    try {
      // This case targets admission, with the existing outbox already authoritatively settled.
      f.repository.markIntentSending(f.outboundId)
      f.repository.completeOutboundIntent(f.outboundId, 'failed')
      f.repository.retireDshSessionEpisodes({ migrationId: 'startup-gate', closedAt: 30 })
      const next = f.append('new-while-restoring', 31)
      expect((await runtime.recover()).resumedEpisodes).toBe(0)
      expect(admitted).toEqual([])
      await runtime.openAdmission()
      expect(admitted).toEqual([next.id])
      await runtime.openAdmission()
      expect(admitted).toEqual([next.id])
      expect(f.repository.listRecoverableEpisodes()).toHaveLength(1)
    } finally {
      await runtime.dispose()
      f.database.close()
    }
  })

  it('does not close a new Session after process death between Core commit and marker completion', async () => {
    const f = await fixture()
    const input = { migrationId: 'stable-source-identity', closedAt: 30 }
    const first = f.repository.retireDshSessionEpisodes(input)
    const next = f.append('new-inbound', 31)
    const newId = EpisodeIdSchema.parse('eps_NEWSESSION')
    f.repository.createEpisode({
      id: newId,
      channelId: f.channel.id,
      agentId: f.agent.definition.id,
      agentRevisionId: f.agent.revision.id,
      status: 'opening',
      openedAtEventId: next.id,
      createdAt: 31,
    })
    f.repository.activateEpisode(newId, 'new-session')
    f.database.close()
    const reopened = await openMigratedCoreDatabase(f.filename)
    try {
      const repository = new SqliteCoreRepository(reopened)
      expect(repository.retireDshSessionEpisodes({ ...input, closedAt: 100 })).toEqual({
        ...first,
        alreadyApplied: true,
      })
      expect(repository.getDshSessionStorageRetirement(input.migrationId)).toEqual({ ...first, alreadyApplied: true })
      expect(repository.getEpisode(newId)?.status).toBe('active')
      expect(repository.listAuthoringEvents(f.taskId)).toHaveLength(2)
      expect(repository.listUnadmittedEvents(f.channel.id, f.agent.definition.id, 10)).toEqual([next])
      // A later explicitly declared incompatible upgrade has its own receipt and boundary.
      expect(
        repository.retireDshSessionEpisodes({ migrationId: 'synthetic-next-incompatible-format', closedAt: 101 }),
      ).toMatchObject({ alreadyApplied: false, episodesClosed: 1, authoringTasksInterrupted: 0 })
      expect(repository.listUnadmittedEvents(f.channel.id, f.agent.definition.id, 10)).toEqual([])
    } finally {
      reopened.close()
    }
  })

  it('rolls back all changes if the receipt cannot commit and retries the entire transaction', async () => {
    const f = await fixture()
    const fault = new BetterSqlite3(f.filename)
    try {
      fault.exec(
        "CREATE TRIGGER fail_reset_receipt BEFORE INSERT ON dsh_session_resets BEGIN SELECT RAISE(ABORT, 'synthetic commit failure'); END",
      )
      expect(() => f.repository.retireDshSessionEpisodes({ migrationId: 'retry', closedAt: 30 })).toThrow(
        'synthetic commit failure',
      )
      expect(f.repository.getEpisode(f.episodeId)?.status).toBe('active')
      expect(f.repository.getAuthoringTask(f.taskId)?.status).toBe('running')
      expect(f.repository.listAuthoringEvents(f.taskId)).toHaveLength(1)
      expect(f.database.db.select().from(admissions).where(eq(admissions.id, f.claimedId)).get()?.state).toBe('claimed')
      expect(f.database.db.select().from(dshSessionResets).all()).toEqual([])
      expect(f.repository.listUnadmittedEvents(f.channel.id, f.agent.definition.id, 10)).toHaveLength(1)
      fault.exec('DROP TRIGGER fail_reset_receipt')
      expect(f.repository.retireDshSessionEpisodes({ migrationId: 'retry', closedAt: 30 })).toMatchObject({
        alreadyApplied: false,
        episodesClosed: 1,
      })
    } finally {
      fault.close()
      f.database.close()
    }
  })

  it('scopes cutoffs to the original Binding and does not rewrite boundAt', async () => {
    const f = await fixture()
    try {
      f.repository.retireDshSessionEpisodes({ migrationId: 'binding-cutoff', closedAt: 30 })
      const updated = { ...f.binding, triggerPolicy: 'mentioned-or-replied' as const }
      f.repository.replaceBinding(updated)
      expect(f.repository.listUnadmittedEvents(f.channel.id, f.agent.definition.id, 10)).toEqual([])
      f.repository.clearBinding(f.channel.id)
      f.repository.replaceBinding({ ...f.binding, boundAt: 19 })
      expect(f.repository.listUnadmittedEvents(f.channel.id, f.agent.definition.id, 19)).toHaveLength(1)
    } finally {
      f.database.close()
    }
  })

  it('rejects invalid reset identities before changing data', async () => {
    const f = await fixture()
    try {
      expect(() => f.repository.retireDshSessionEpisodes({ migrationId: '', closedAt: 30 })).toThrow(
        'stable migration ID',
      )
      expect(() => f.repository.retireDshSessionEpisodes({ migrationId: 'invalid', closedAt: -1 })).toThrow(
        'non-negative',
      )
      expect(f.repository.getDshSessionStorageRetirement('not-applied')).toBeUndefined()
    } finally {
      f.database.close()
    }
  })
})
