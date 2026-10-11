import {
  AgentIdSchema,
  AuthoringAttemptIdSchema,
  AuthoringTaskIdSchema,
  ChannelEventIdSchema,
  ChannelIdSchema,
  EpisodeIdSchema,
  ExtensionIdSchema,
  ExtensionRevisionIdSchema,
  configSchema,
  type AgentId,
  type AuthoringTaskId,
  type DshPluginEntryId,
  type ExtensionId,
  type ExtensionRevisionId,
  type HostUiPageEntry,
  type HostUiPageInstanceId,
  type JsonValue,
} from '@nekro-nxt/contracts'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  AuthoringArtifactStore,
  DynamicAuthoringService,
  ExtensionBuilder,
  ExtensionLifecycleCoordinator,
  ExtensionService,
  ExtensionSourceStore,
  extensionManifestSchema,
  materializeDynamicPackage,
  materializeImportedRevision,
  scopeHostUiCss,
  validateHostUiCss,
  validateHostUiSvg,
  type Activation,
  type AuthoringRepository,
  type DynamicAuthoringAttempt,
  type ExtensionManifest,
  type ExtensionRuntimeHost,
  type ExtensionClientDiagnostic,
  type DynamicAuthoringEvent,
  type DynamicAuthoringSnapshot,
  type DynamicAuthoringTask,
  type ExtensionRepository,
  type ExtensionRevisionVerification,
  type HostInstallation,
  type HostUiDiagnostic,
  type HostUiPermissionGrant,
  type HostUiRepository,
  type LoadedExtension,
  type LocalExtension,
  type MountedAttachment,
  type Revision,
} from '../src/index.ts'

const createAuthoringMemoryRepository = (): AuthoringRepository & {
  failDelete: boolean
  dropAttempts(taskId: DynamicAuthoringTask['id']): void
} => {
  const tasks = new Map<string, DynamicAuthoringTask>()
  const attempts = new Map<string, DynamicAuthoringAttempt>()
  const events = new Map<string, DynamicAuthoringEvent[]>()
  const appendEvent = (event: DynamicAuthoringEvent): void => {
    events.set(event.taskId, [...(events.get(event.taskId) ?? []), event])
  }
  return {
    failDelete: false,
    dropAttempts: (taskId) => {
      for (const attempt of [...attempts.values()]) if (attempt.taskId === taskId) attempts.delete(attempt.id)
    },
    listAuthoringTasks: (agentId) => [...tasks.values()].filter((task) => !agentId || task.agentId === agentId),
    listRecoverableAuthoringTasks: () =>
      [...tasks.values()].filter((task) => !['interrupted', 'stopped', 'completed'].includes(task.status)),
    getAuthoringTask: (id) => tasks.get(id),
    getAuthoringTaskByPlugin: (episodeId, pluginKey) =>
      [...tasks.values()].find((task) => task.episodeId === episodeId && task.pluginKey === pluginKey),
    listAuthoringAttempts: (taskId) =>
      [...attempts.values()]
        .filter((attempt) => taskId === undefined || attempt.taskId === taskId)
        .sort((left, right) => left.ordinal - right.ordinal),
    getAuthoringAttempt: (id) => attempts.get(id),
    listAuthoringEvents: (taskId) => events.get(taskId) ?? [],
    createAuthoringTask: ({ task, attempt, event }) => {
      tasks.set(task.id, task)
      attempts.set(attempt.id, attempt)
      appendEvent(event)
    },
    appendAuthoringAttempt: ({ task, attempt, event }) => {
      tasks.set(task.id, task)
      attempts.set(attempt.id, attempt)
      appendEvent(event)
    },
    updateAuthoringAttempt: ({ task, attempt, event }) => {
      tasks.set(task.id, task)
      attempts.set(attempt.id, attempt)
      appendEvent(event)
    },
    updateAuthoringTask: ({ task, event }) => {
      tasks.set(task.id, task)
      appendEvent(event)
    },
    deleteAuthoringTask(id) {
      if (this.failDelete) throw new Error('synthetic delete failure')
      const task = tasks.get(id)
      if (!task) return
      if (!['interrupted', 'stopped', 'completed'].includes(task.status)) throw new Error('must stop')
      tasks.delete(id)
      for (const attempt of [...attempts.values()]) if (attempt.taskId === id) attempts.delete(attempt.id)
      events.delete(id)
    },
  }
}

describe('Dynamic authoring artifacts', () => {
  it('publishes immutable snapshots and stages task deletion without leaving source files behind', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-authoring-artifacts-'))
    temporaryDirectories.push(directory)
    expect(() => new AuthoringArtifactStore('relative')).toThrow('absolute')
    const store = new AuthoringArtifactStore(directory)
    const agentId = AgentIdSchema.parse('agt_AUTHORINGARTIFACTS')
    const taskId = AuthoringTaskIdSchema.parse('aut_AUTHORINGARTIFACTS')
    const attemptId = AuthoringAttemptIdSchema.parse('aua_AUTHORINGARTIFACTS')
    const snapshot: DynamicAuthoringSnapshot = {
      name: '验收面板',
      purpose: '验证源码账本。',
      code: { client: 'return { apply() {} }' },
      resources: {},
      permissions: { permissions: [], networkOrigins: [] },
      contributions: [],
    }

    const relative = await store.publish(agentId, taskId, attemptId, snapshot)
    await expect(store.read(relative)).resolves.toEqual(snapshot)
    await expect(store.publish(agentId, taskId, attemptId, snapshot)).resolves.toBe(relative)
    await expect(store.publish(agentId, taskId, attemptId, { ...snapshot, purpose: '不同内容。' })).rejects.toThrow(
      '其他内容',
    )
    await expect(store.read('../outside')).rejects.toThrow('unsafe')

    const staged = await store.stageTaskDeletion(agentId, taskId)
    expect(staged).toBeDefined()
    await expect(readFile(path.join(directory, relative, 'snapshot.json'), 'utf8')).rejects.toThrow()
    await store.restoreTaskDeletion(staged!)
    await expect(store.read(relative)).resolves.toEqual(snapshot)
    const stagedAgain = await store.stageTaskDeletion(agentId, taskId)
    expect(stagedAgain).toBeDefined()
    await store.discardTaskDeletion(stagedAgain!)
    expect(await store.stageTaskDeletion(agentId, taskId)).toBeUndefined()
  })

  it('shares approval commits and refuses to overwrite a candidate created while stopping', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nxt-authoring-actions-'))
    temporaryDirectories.push(directory)
    const repository = createAuthoringMemoryRepository()
    const service = new DynamicAuthoringService(repository, new AuthoringArtifactStore(directory))
    const definition = {
      agentId: AgentIdSchema.parse('agt_ACTIONS'),
      channelId: ChannelIdSchema.parse('chn_ACTIONS'),
      episodeId: EpisodeIdSchema.parse('eps_ACTIONS'),
      initiatingEventId: ChannelEventIdSchema.parse('evt_ACTIONS'),
      approvalPolicy: 'risk-stable' as const,
      pluginKey: 'actions',
      runnerPackageId: 'package-one',
      snapshot: {
        name: '测试操作',
        purpose: '测试状态提交',
        code: { host: 'return { apply() {} }' },
        resources: {},
        permissions: { permissions: [], networkOrigins: [] },
        contributions: [],
      },
    }
    const first = await service.recordDefinition(definition)
    const decision = service.decideAttempt({
      taskId: first.task.id,
      attemptId: first.attempt.id,
      expectedRevision: first.task.revision,
      approved: true,
      approveRiskStable: true,
    })
    expect(decision).toMatchObject({ accepted: true, executionRequired: true })
    expect(service.getTask(first.task.id)?.approvedRiskDigest).toBe(first.attempt.riskDigest)
    await expect(
      service.stopTask({ taskId: first.task.id, expectedRevision: decision.taskRevision }, async () => {
        await service.recordDefinition({
          ...definition,
          runnerPackageId: 'package-two',
          snapshot: { ...definition.snapshot, name: '新的候选' },
        })
      }),
    ).rejects.toThrow('状态已更新')
    const current = service.getTask(first.task.id)!
    expect(current.status).not.toBe('stopped')
    expect(() =>
      service.decideAttempt({
        taskId: first.task.id,
        attemptId: first.attempt.id,
        expectedRevision: current.revision,
        approved: true,
        approveRiskStable: false,
      }),
    ).toThrow('候选内容已经更新')
    const stopped = await service.stopTask({ taskId: current.id, expectedRevision: current.revision }, async () => {})
    expect(stopped.status).toBe('stopped')
    expect(repository.listAuthoringAttempts(current.id).at(-1)?.state).toBe('stopped')
  })

  it('interrupts instead of restoring a candidate left unsaved beyond the recovery window', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-authoring-expiry-'))
    temporaryDirectories.push(directory)
    const repository = createAuthoringMemoryRepository()
    let clock = 1_000
    const service = new DynamicAuthoringService(repository, new AuthoringArtifactStore(directory), {
      now: () => clock,
      recoveryWindowMs: 60_000,
    })
    const episodeId = EpisodeIdSchema.parse('eps_AUTHORINGEXPIRY')
    const { task } = await service.recordDefinition({
      agentId: AgentIdSchema.parse('agt_AUTHORINGEXPIRY'),
      channelId: ChannelIdSchema.parse('chn_AUTHORINGEXPIRY'),
      episodeId,
      initiatingEventId: ChannelEventIdSchema.parse('evt_AUTHORINGEXPIRY'),
      approvalPolicy: 'risk-stable',
      pluginKey: 'plugin-expiry',
      runnerPackageId: 'package-expiry',
      snapshot: {
        name: '过期候选',
        purpose: '验证恢复窗口。',
        code: { host: 'return { apply() {} }' },
        resources: {},
        permissions: { permissions: [], networkOrigins: [] },
        contributions: [],
      },
    })
    clock += 60_000
    expect(await service.recoveryCandidates(episodeId)).toHaveLength(1)
    clock += 1
    expect(await service.recoveryCandidates(episodeId)).toEqual([])
    expect(repository.getAuthoringTask(task.id)?.status).toBe('interrupted')
    expect(repository.listAuthoringEvents(task.id).at(-1)).toMatchObject({ kind: 'task-interrupted' })
  })

  it('keeps task revisions idempotent, restores runner identities, and rolls back failed deletion', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-authoring-service-'))
    temporaryDirectories.push(directory)
    const repository = createAuthoringMemoryRepository()
    const store = new AuthoringArtifactStore(directory)
    let clock = 100
    const service = new DynamicAuthoringService(repository, store, { now: () => ++clock })
    const defaultClockService = new DynamicAuthoringService(repository, store)
    const changes: Array<{ readonly taskId: AuthoringTaskId; readonly agentId: AgentId }> = []
    const unsubscribe = service.subscribe((change) => changes.push(change))
    const unsubscribeFailingObserver = service.subscribe(() => {
      throw new Error('synthetic observer failure')
    })
    const agentId = AgentIdSchema.parse('agt_AUTHORINGSERVICE')
    const channelId = ChannelIdSchema.parse('chn_AUTHORINGSERVICE')
    const episodeId = EpisodeIdSchema.parse('eps_AUTHORINGSERVICE')
    const initiatingEventId = ChannelEventIdSchema.parse('evt_AUTHORINGSERVICE')
    expect(defaultClockService.taskForRunner(episodeId, 'not-created')).toBeUndefined()
    const base = {
      agentId,
      channelId,
      episodeId,
      initiatingEventId,
      approvalPolicy: 'risk-stable' as const,
      pluginKey: 'plugin-authoring',
    }
    const first = await service.recordDefinition({
      ...base,
      runnerPackageId: 'package-one',
      snapshot: {
        name: '状态工具',
        purpose: '验证任务账本。',
        code: { host: 'return { apply() {} }' },
        resources: {},
        permissions: { permissions: [], networkOrigins: [] },
        contributions: [],
      },
    })
    expect(changes).toEqual([{ taskId: first.task.id, agentId }])
    unsubscribeFailingObserver()
    const secondSnapshot: DynamicAuthoringSnapshot = {
      name: '状态工具修订',
      purpose: '验证同任务追加候选。',
      code: { host: 'return { apply() { return undefined } }' },
      resources: { 'assets/probe.module.css': '.probe { color: red; }' },
      clientCss: {
        path: 'assets/probe.module.css',
        sha256: createHash('sha256').update('.probe { color: red; }').digest('hex'),
      },
      permissions: { permissions: [], networkOrigins: [] },
      contributions: [],
    }
    const second = await service.recordDefinition({
      ...base,
      runnerPackageId: 'package-two',
      snapshot: secondSnapshot,
    })
    expect(second.task.id).toBe(first.task.id)
    expect(second.attempt.ordinal).toBe(2)
    const revisionBeforeReplay = repository.getAuthoringTask(first.task.id)!.revision
    const changesBeforeReplay = changes.length
    const eventsBeforeReplay = repository.listAuthoringEvents(first.task.id)
    const attemptsBeforeReplay = repository.listAuthoringAttempts(first.task.id)
    const attemptDirectoriesBeforeReplay = await readdir(
      path.join(directory, agentId, 'authoring', first.task.id, 'attempts'),
    )
    const replayed = await service.recordDefinition({
      ...base,
      runnerPackageId: 'package-two',
      snapshot: secondSnapshot,
    })
    expect(replayed).toEqual({
      task: repository.getAuthoringTask(first.task.id),
      attempt: second.attempt,
    })
    expect(repository.getAuthoringTask(first.task.id)?.revision).toBe(revisionBeforeReplay)
    expect(repository.listAuthoringEvents(first.task.id)).toEqual(eventsBeforeReplay)
    expect(repository.listAuthoringAttempts(first.task.id)).toEqual(attemptsBeforeReplay)
    expect(changes).toHaveLength(changesBeforeReplay)
    await expect(readdir(path.join(directory, agentId, 'authoring', first.task.id, 'attempts'))).resolves.toEqual(
      attemptDirectoriesBeforeReplay,
    )
    await expect(
      service.recordDefinition({
        ...base,
        runnerPackageId: 'package-two',
        snapshot: { ...secondSnapshot, purpose: '试图复用相同运行包身份提交其他内容。' },
      }),
    ).rejects.toThrow('运行包身份冲突')
    expect(repository.getAuthoringTask(first.task.id)?.revision).toBe(revisionBeforeReplay)
    expect(repository.listAuthoringEvents(first.task.id)).toEqual(eventsBeforeReplay)
    expect(repository.listAuthoringAttempts(first.task.id)).toEqual(attemptsBeforeReplay)
    await expect(readdir(path.join(directory, agentId, 'authoring', first.task.id, 'attempts'))).resolves.toEqual(
      attemptDirectoriesBeforeReplay,
    )
    expect(
      service.syncAttempt({
        episodeId: EpisodeIdSchema.parse('eps_MISSINGAUTHORING'),
        pluginKey: 'missing',
        runnerPackageId: 'missing',
        state: 'failed',
        taskStatus: 'failed',
        host: { status: 'failed', waitingFor: [] },
        client: { status: 'absent', waitingFor: [] },
        eventKind: 'attempt-failed',
      }),
    ).toBeUndefined()
    expect(
      service.syncAttempt({
        episodeId,
        pluginKey: base.pluginKey,
        runnerPackageId: 'missing',
        state: 'failed',
        taskStatus: 'failed',
        host: { status: 'failed', waitingFor: [] },
        client: { status: 'absent', waitingFor: [] },
        eventKind: 'attempt-failed',
      }),
    ).toBeUndefined()
    const verification = {
      hostStarted: true,
      clientLoaded: true,
      renderedPanels: [],
      renderedToolViews: [],
      renderedMessageRenderers: [],
      renderedPages: [],
      usedUiComponents: [],
      pageGeometry: [],
      rpcCalls: [],
      toolInvocations: [{ name: 'status_probe', succeeded: true }],
      navigationChecks: [],
      resourceChecks: ['assets/probe.module.css'],
      stoppedCleanly: false,
    } as const
    const changesBeforeVerification = changes.length
    service.syncAttempt({
      episodeId,
      pluginKey: base.pluginKey,
      runnerPackageId: 'package-two',
      runnerRunId: 'run-two',
      state: 'active',
      taskStatus: 'ready',
      host: { status: 'running', waitingFor: [] },
      client: { status: 'absent', waitingFor: [] },
      verification,
      eventKind: 'verification-completed',
    })
    expect(changes).toHaveLength(changesBeforeVerification + 1)
    const readyRevision = repository.getAuthoringTask(first.task.id)!.revision
    service.syncAttempt({
      episodeId,
      pluginKey: base.pluginKey,
      runnerPackageId: 'package-two',
      runnerRunId: 'run-two',
      state: 'active',
      taskStatus: 'ready',
      host: { status: 'running', waitingFor: [] },
      client: { status: 'absent', waitingFor: [] },
      verification,
      eventKind: 'verification-completed',
    })
    expect(repository.getAuthoringTask(first.task.id)?.revision).toBe(readyRevision)
    expect(changes).toHaveLength(changesBeforeVerification + 1)
    // A phase resync of the same live run keeps the verified, saveable state.
    service.syncAttempt({
      episodeId,
      pluginKey: base.pluginKey,
      runnerPackageId: 'package-two',
      runnerRunId: 'run-two',
      state: 'active',
      taskStatus: 'running',
      host: { status: 'running', waitingFor: [] },
      client: { status: 'absent', waitingFor: [] },
      eventKind: 'phase-changed',
    })
    expect(repository.getAuthoringTask(first.task.id)).toMatchObject({ status: 'ready', revision: readyRevision })
    expect(repository.listAuthoringAttempts(first.task.id).at(-1)?.verification).toEqual(verification)
    expect(service.taskForRunner(episodeId, base.pluginKey)?.id).toBe(first.task.id)
    await expect(service.snapshotForRunnerPackage(episodeId, base.pluginKey, 'missing')).resolves.toBeUndefined()

    const clientOnly = await service.recordDefinition({
      ...base,
      approvalPolicy: 'fully-automatic',
      pluginKey: 'plugin-client-only',
      runnerPackageId: 'package-client-only',
      snapshot: {
        name: '界面探针',
        purpose: '覆盖 Client 恢复分支。',
        code: { client: 'return { apply() {} }' },
        resources: {},
        permissions: { permissions: [], networkOrigins: [] },
        contributions: [],
      },
    })
    const recoveries = await service.recoveryCandidates(episodeId)
    const recovery = recoveries.find(({ task }) => task.id === first.task.id)
    const clientRecovery = recoveries.find(({ task }) => task.id === clientOnly.task.id)
    expect(recovery?.shouldRun).toBe(true)
    expect(clientRecovery?.shouldRun).toBe(false)
    service.rebindRecoveredAttempt({
      task: clientRecovery!.task,
      attempt: clientRecovery!.attempt,
      pluginKey: 'plugin-client-restored',
      runnerPackageId: 'package-client-restored',
      shouldRun: false,
    })
    service.syncAttempt({
      episodeId,
      pluginKey: 'plugin-client-restored',
      runnerPackageId: 'package-client-restored',
      state: 'failed',
      taskStatus: 'completed',
      host: { status: 'absent', waitingFor: [] },
      client: { status: 'failed', waitingFor: [], error: 'synthetic client failure' },
      error: { phase: 'client-apply', message: 'synthetic client failure', repairable: true },
      eventKind: 'attempt-failed',
    })
    expect(repository.getAuthoringTask(clientOnly.task.id)).toMatchObject({
      status: 'completed',
      approvedRiskDigest: clientOnly.attempt.riskDigest,
    })
    service.interruptTask(repository.getAuthoringTask(clientOnly.task.id)!, 'ignored terminal interruption')
    service.rebindRecoveredAttempt({
      task: recovery!.task,
      attempt: recovery!.attempt,
      pluginKey: 'plugin-restored',
      runnerPackageId: 'package-restored',
      shouldRun: true,
    })
    expect(repository.getAuthoringTask(first.task.id)).toMatchObject({
      pluginKey: 'plugin-restored',
      status: 'running',
    })
    service.interruptTask(repository.getAuthoringTask(first.task.id)!, 'synthetic interruption', second.attempt.id)
    expect(repository.getAuthoringTask(first.task.id)?.status).toBe('interrupted')
    const changesBeforeDeletion = changes.length
    await expect(service.deleteTask(first.task.id)).resolves.toBe(true)
    expect(changes).toHaveLength(changesBeforeDeletion + 1)
    expect(changes.at(-1)).toEqual({ taskId: first.task.id, agentId })
    await expect(service.deleteTask(first.task.id)).resolves.toBe(false)
    expect(changes).toHaveLength(changesBeforeDeletion + 1)
    unsubscribe()
    service.rebindRecoveredAttempt({
      task: recovery!.task,
      attempt: recovery!.attempt,
      pluginKey: 'missing-after-delete',
      runnerPackageId: 'missing-after-delete',
      shouldRun: false,
    })

    const missingAttempt = await service.recordDefinition({
      ...base,
      pluginKey: 'plugin-missing-attempt',
      runnerPackageId: 'package-missing-attempt',
      snapshot: {
        name: '缺失候选探针',
        purpose: '覆盖恢复缺失候选。',
        code: { host: 'return { apply() {} }' },
        resources: {},
        permissions: { permissions: [], networkOrigins: [] },
        contributions: [],
      },
    })
    repository.dropAttempts(missingAttempt.task.id)
    const candidatesWithoutMissingAttempt = await service.recoveryCandidates(episodeId)
    expect(candidatesWithoutMissingAttempt.some(({ task }) => task.id === missingAttempt.task.id)).toBe(false)
    const missingAttemptStaged = await store.stageTaskDeletion(agentId, missingAttempt.task.id)
    await store.discardTaskDeletion(missingAttemptStaged!)
    repository.failDelete = true
    await expect(service.deleteTask(missingAttempt.task.id)).rejects.toThrow('synthetic delete failure')
    repository.failDelete = false
    await expect(service.deleteTask(missingAttempt.task.id)).resolves.toBe(true)

    const missingSource = await service.recordDefinition({
      ...base,
      pluginKey: 'plugin-missing-source',
      runnerPackageId: 'package-missing-source',
      snapshot: {
        name: '缺失源码探针',
        purpose: '覆盖恢复缺失源码。',
        code: { host: 'return { apply() {} }' },
        resources: {},
        permissions: { permissions: [], networkOrigins: [] },
        contributions: [],
      },
    })
    const missingSourceStaged = await store.stageTaskDeletion(agentId, missingSource.task.id)
    await store.discardTaskDeletion(missingSourceStaged!)
    await service.recoveryCandidates(episodeId)
    expect(repository.getAuthoringTask(missingSource.task.id)?.status).toBe('interrupted')
    await expect(service.deleteTask(missingSource.task.id)).resolves.toBe(true)

    const rollback = await service.recordDefinition({
      ...base,
      pluginKey: 'plugin-rollback',
      runnerPackageId: 'package-rollback',
      snapshot: {
        name: '删除回滚探针',
        purpose: '验证目录恢复。',
        code: { host: 'return { apply() {} }' },
        resources: {},
        permissions: { permissions: [], networkOrigins: [] },
        contributions: [],
      },
    })
    service.interruptTask(rollback.task, 'ready to delete')
    repository.failDelete = true
    await expect(service.deleteTask(rollback.task.id)).rejects.toThrow('synthetic delete failure')
    await expect(store.read(rollback.attempt.sourcePath)).resolves.toMatchObject({ name: '删除回滚探针' })
    repository.failDelete = false
    await expect(service.deleteTask(rollback.task.id)).resolves.toBe(true)
  })
})

describe('Host UI assets', () => {
  it('rejects CSS that escapes the page module boundary', () => {
    expect(() => validateHostUiCss(':global(body) { color: red; }')).toThrow(':global')
    expect(() => validateHostUiCss('@import "https://example.invalid/a.css";')).toThrow('@import')
    expect(() => validateHostUiCss('@font-face { font-family: probe; }')).toThrow('字体')
    expect(() => validateHostUiCss('.panel { background: url("probe.svg"); }')).toThrow('URL')
    expect(() => validateHostUiCss('body { color: red; }')).toThrow('根节点')
    expect(() => validateHostUiCss('button { color: red; }')).toThrow('本地 class')
    expect(() => validateHostUiCss('.panel body { color: red; }')).toThrow('产品根节点')
    expect(() => validateHostUiCss('.panel { position: fixed; }')).toThrow('fixed')
    expect(() => validateHostUiCss('.panel { width: 100vw; }')).toThrow('100vw')
    expect(() => validateHostUiCss('.panel { min-height: 100vh; }')).toThrow('100vh')
    expect(() => validateHostUiCss('.panel { margin-inline: -24px; }')).toThrow('负边距')
    expect(() => validateHostUiCss('@keyframes probe { from { opacity: 0; } }')).toThrow('@keyframes')
    expect(() => validateHostUiCss('.panel {')).toThrow('语法无效')
    expect(() => validateHostUiCss('x'.repeat(128 * 1024 + 1))).toThrow('128 KiB')
    expect(() => validateHostUiCss('.panel { color: var(--nxt-text-primary); }')).not.toThrow()
    expect(() => validateHostUiCss('#panel { display: block; }')).not.toThrow()
    expect(() => validateHostUiCss(':local(.panel) { display: block; }')).not.toThrow()
    expect(() => validateHostUiCss('@media (width > 600px) { .panel { display: grid; } }')).not.toThrow()
    expect(() => validateHostUiCss('@supports (display: grid) { .panel { display: grid; } }')).not.toThrow()
    expect(() => validateHostUiCss('@container page (width > 600px) { .panel { display: grid; } }')).not.toThrow()
  })

  it('prefixes every CSS selector with the owning Host UI Runtime boundary', () => {
    expect(scopeHostUiCss('.panel, #status { color: red; }', 'artifact_123')).toBe(
      ':where([data-host-ui-owner="artifact_123"]) .panel, ' +
        ':where([data-host-ui-owner="artifact_123"]) #status { color: red; }',
    )
    expect(scopeHostUiCss('@media (width > 600px) { :local(.panel) { display: grid; } }', 'artifact_123')).toContain(
      ':where([data-host-ui-owner="artifact_123"]) .panel',
    )
    expect(() => scopeHostUiCss('.panel {}', 'unsafe scope')).toThrow('owner scope')
  })

  it('accepts a bounded monochrome SVG and rejects executable SVG', () => {
    expect(() =>
      validateHostUiSvg('<svg viewBox="0 0 24 24"><path d="M4 4h16v16H4z" fill="currentColor"/></svg>'),
    ).not.toThrow()
    expect(() => validateHostUiSvg('<svg viewBox="0 0 24 24"><script>alert(1)</script></svg>')).toThrow('script')
    expect(() => validateHostUiSvg('<svg viewBox="0 0 24 24"><path onclick="alert(1)" d="M0 0"/></svg>')).toThrow(
      'onclick',
    )
    expect(() => validateHostUiSvg('x'.repeat(32 * 1024 + 1))).toThrow('32 KiB')
    expect(() => validateHostUiSvg('<!DOCTYPE svg><svg viewBox="0 0 24 24"></svg>')).toThrow('实体')
    expect(() => validateHostUiSvg('<?xml version="1.0"?><svg viewBox="0 0 24 24"></svg>')).toThrow('实体')
    expect(() => validateHostUiSvg('<svg viewBox="0 0 24 24">&#32;</svg>')).toThrow('实体')
    expect(() => validateHostUiSvg('<svg viewBox="0 0 24 24">')).toThrow('完整')
    expect(() => validateHostUiSvg('<svg><path d="M0 0"/></svg>')).toThrow('viewBox')
    expect(() => validateHostUiSvg('<svg viewBox="0 0 0 24"><path d="M0 0"/></svg>')).toThrow('尺寸')
    expect(() => validateHostUiSvg('<svg viewBox="0 0 513 24"><path d="M0 0"/></svg>')).toThrow('尺寸')
    expect(() => validateHostUiSvg('<svg viewBox="0 0 24 513"><path d="M0 0"/></svg>')).toThrow('尺寸')
    expect(() => validateHostUiSvg('<svg viewBox="0 0 24 24"><image href="probe"/></svg>')).toThrow('image')
    expect(() => validateHostUiSvg('<svg viewBox="0 0 24 24"><path unknown="probe"/></svg>')).toThrow('unknown')
    expect(() => validateHostUiSvg('<svg viewBox="0 0 24 24"><path disabled/></svg>')).toThrow('无法识别')
  })
})

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const agentId = (value: string): AgentId => AgentIdSchema.parse(`agt_${value}`)
const extensionId = (value: string): ExtensionId => ExtensionIdSchema.parse(`ext_${value}`)
const revisionId = (value: string): ExtensionRevisionId => ExtensionRevisionIdSchema.parse(`xrv_${value}`)

const manifestRevisionSchema = z
  .object({
    schemaVersion: z.literal(7),
    permissions: z.object({ permissions: z.array(z.string()), networkOrigins: z.array(z.string()) }).strict(),
    extensionId: ExtensionIdSchema,
    revisionId: ExtensionRevisionIdSchema,
    entrypoints: z
      .object({ host: z.literal('source/host.ts'), client: z.literal('source/client.ts') })
      .strict()
      .or(z.object({ host: z.literal('source/host.ts') }).strict())
      .or(z.object({ client: z.literal('source/client.ts') }).strict()),
    contributions: z.array(z.unknown()),
  })
  .strict()
const buildCacheSchema = z
  .object({
    revisionId: ExtensionRevisionIdSchema,
    buildKey: z.string().regex(/^[a-f0-9]{64}$/),
    hostEntry: z.literal('host.mjs').optional(),
    clientEntry: z.literal('client.mjs').optional(),
  })
  .strict()

class MemoryExtensionRepository implements ExtensionRepository, HostUiRepository {
  readonly extensions = new Map<ExtensionId, LocalExtension>()
  readonly revisions = new Map<ExtensionRevisionId, Revision>()
  readonly verifications = new Map<ExtensionRevisionId, ExtensionRevisionVerification>()
  readonly activations = new Map<string, Activation>()
  readonly clientDiagnostics = new Map<string, ExtensionClientDiagnostic>()
  readonly installations = new Map<ExtensionId, HostInstallation>()
  readonly hostUiPages = new Map<HostUiPageInstanceId, HostUiPageEntry>()
  readonly hostUiGrants = new Map<string, HostUiPermissionGrant>()
  readonly hostUiDiagnostics = new Map<HostUiPageInstanceId, HostUiDiagnostic>()
  hostUiPreferencesRevision = 0
  beforeSave?: (input: { readonly extension: LocalExtension; readonly revision: Revision }) => void
  failActivationUpsert = false
  failActivationDelete = false
  failInstallationUpsert = false
  failInstallationDelete = false
  failHostUiPageReplace = false

  getExtension(id: ExtensionId): LocalExtension | undefined {
    return this.extensions.get(id)
  }

  listExtensions(): readonly LocalExtension[] {
    return [...this.extensions.values()]
  }

  getExtensionBySlug(slug: string): LocalExtension | undefined {
    return [...this.extensions.values()].find((extension) => extension.slug === slug)
  }

  updateExtensionDetails(id: ExtensionId, details: { readonly displayName: string; readonly description: string }) {
    const extension = this.extensions.get(id)
    if (extension) this.extensions.set(id, { ...extension, ...details })
  }

  getExtensionRevision(id: ExtensionRevisionId): Revision | undefined {
    return this.revisions.get(id)
  }

  getExtensionRevisionByPayloadDigest(id: ExtensionId, payloadDigest: string): Revision | undefined {
    return [...this.revisions.values()].find(
      (revision) => revision.extensionId === id && revision.payloadDigest === payloadDigest,
    )
  }

  listExtensionRevisions(id?: ExtensionId): readonly Revision[] {
    return [...this.revisions.values()].filter((revision) => id === undefined || revision.extensionId === id)
  }

  nextExtensionRevisionNumber(id: ExtensionId): number {
    return (
      Math.max(
        0,
        ...[...this.revisions.values()].filter((revision) => revision.extensionId === id).map((r) => r.revisionNumber),
      ) + 1
    )
  }

  saveExtensionRevision(input: {
    readonly extension: LocalExtension
    readonly revision: Revision
    readonly verification?: ExtensionRevisionVerification
  }): void {
    this.beforeSave?.(input)
    if (this.revisions.has(input.revision.id)) throw new Error('Revision already exists.')
    this.extensions.set(input.extension.id, input.extension)
    this.revisions.set(input.revision.id, input.revision)
    if (input.verification) this.verifications.set(input.revision.id, input.verification)
  }
  deleteExtension(extensionId: ExtensionId): void {
    this.extensions.delete(extensionId)
    for (const [revisionId, revision] of this.revisions) {
      if (revision.extensionId === extensionId) this.revisions.delete(revisionId)
    }
  }

  getExtensionRevisionVerification(id: ExtensionRevisionId): ExtensionRevisionVerification | undefined {
    return this.verifications.get(id)
  }

  getExtensionClientDiagnostic(agent: AgentId, extension: ExtensionId): ExtensionClientDiagnostic | undefined {
    return this.clientDiagnostics.get(this.#key(agent, extension))
  }

  upsertExtensionClientDiagnostic(diagnostic: ExtensionClientDiagnostic): void {
    this.clientDiagnostics.set(this.#key(diagnostic.agentId, diagnostic.extensionId), diagnostic)
  }

  getActivation(agent: AgentId, extension: ExtensionId): Activation | undefined {
    return this.activations.get(this.#key(agent, extension))
  }

  listActivations(agent?: AgentId): readonly Activation[] {
    return [...this.activations.values()].filter((activation) => agent === undefined || activation.agentId === agent)
  }

  upsertActivation(activation: Activation): void {
    if (this.failActivationUpsert) throw new Error('Activation transaction failed.')
    this.activations.set(this.#key(activation.agentId, activation.extensionId), activation)
  }

  deleteActivation(agent: AgentId, extension: ExtensionId): void {
    if (this.failActivationDelete) throw new Error('Activation delete failed.')
    if (!this.activations.delete(this.#key(agent, extension))) throw new Error('Activation does not exist.')
    this.clientDiagnostics.delete(this.#key(agent, extension))
  }

  getHostInstallation(extension: ExtensionId): HostInstallation | undefined {
    return this.installations.get(extension)
  }

  listHostInstallations(): readonly HostInstallation[] {
    return [...this.installations.values()]
  }

  upsertHostInstallation(installation: HostInstallation): void {
    if (this.failInstallationUpsert) throw new Error('Installation transaction failed.')
    this.installations.set(installation.extensionId, installation)
  }

  deleteHostInstallation(extension: ExtensionId): void {
    if (this.failInstallationDelete) throw new Error('Installation delete failed.')
    this.installations.delete(extension)
  }

  commitHostInstallationState(input: Parameters<HostUiRepository['commitHostInstallationState']>[0]) {
    const previousInstallation = this.installations.get(input.installation.extensionId)
    const previousGrant = this.hostUiGrants.get(`extension:${input.installation.extensionId}`)
    const previousPages = new Map(this.hostUiPages)
    const previousActivations = new Map(this.activations)
    try {
      this.upsertHostInstallation(input.installation)
      for (const { activation, grant } of input.attachments ?? []) {
        this.upsertActivation(activation)
        this.upsertHostUiPermissionGrant(grant)
      }
      if (input.hostUi) {
        this.upsertHostUiPermissionGrant(input.hostUi.grant)
        return this.replaceHostUiExtensionPages({
          extensionId: input.installation.extensionId,
          revisionId: input.installation.extensionRevisionId,
          pages: input.hostUi.pages,
          clientBuildKey: input.hostUi.clientBuildKey,
          now: input.hostUi.now,
          nextPageInstanceId: input.hostUi.nextPageInstanceId,
        })
      }
      this.deleteHostUiExtensionPages(input.installation.extensionId)
      this.deleteHostUiPermissionGrant(`extension:${input.installation.extensionId}`)
      return []
    } catch (error) {
      this.activations.clear()
      for (const [key, activation] of previousActivations) this.activations.set(key, activation)
      if (previousInstallation) this.installations.set(previousInstallation.extensionId, previousInstallation)
      else this.installations.delete(input.installation.extensionId)
      if (previousGrant) this.hostUiGrants.set(previousGrant.ownerKey, previousGrant)
      else this.hostUiGrants.delete(`extension:${input.installation.extensionId}`)
      this.hostUiPages.clear()
      for (const [id, page] of previousPages) this.hostUiPages.set(id, page)
      throw error
    }
  }

  deleteHostInstallationState(input: Parameters<HostUiRepository['deleteHostInstallationState']>[0]): void {
    const previousInstallation = this.installations.get(input.extensionId)
    const previousGrant = this.hostUiGrants.get(`extension:${input.extensionId}`)
    const previousPages = new Map(this.hostUiPages)
    try {
      this.deleteHostInstallation(input.extensionId)
      this.deleteHostUiExtensionPages(input.extensionId)
      this.deleteHostUiPermissionGrant(`extension:${input.extensionId}`)
    } catch (error) {
      if (previousInstallation) this.installations.set(previousInstallation.extensionId, previousInstallation)
      if (previousGrant) this.hostUiGrants.set(previousGrant.ownerKey, previousGrant)
      this.hostUiPages.clear()
      for (const [id, page] of previousPages) this.hostUiPages.set(id, page)
      throw error
    }
  }

  listHostUiPageEntries(): readonly HostUiPageEntry[] {
    return [...this.hostUiPages.values()].sort((left, right) => left.sortOrder - right.sortOrder)
  }

  replaceHostUiExtensionPages(input: Parameters<HostUiRepository['replaceHostUiExtensionPages']>[0]) {
    if (this.failHostUiPageReplace) throw new Error('Host UI page transaction failed.')
    this.deleteHostUiExtensionPages(input.extensionId)
    return this.#appendHostUiPages(
      input.pages,
      () => ({ kind: 'extension', extensionId: input.extensionId, revisionId: input.revisionId }),
      input.clientBuildKey,
      input.now,
      input.nextPageInstanceId,
    )
  }

  deleteHostUiExtensionPages(extensionId: ExtensionId): void {
    for (const [id, page] of this.hostUiPages) {
      if (page.owner.kind === 'extension' && page.owner.extensionId === extensionId) this.hostUiPages.delete(id)
    }
  }

  replaceHostUiDshPages(input: Parameters<HostUiRepository['replaceHostUiDshPages']>[0]) {
    this.deleteHostUiDshPages(input.entryId)
    return this.#appendHostUiPages(
      input.pages,
      () => ({ kind: 'dsh-plugin', entryId: input.entryId, artifactDigest: input.artifactDigest }),
      input.clientBuildKey,
      input.now,
      input.nextPageInstanceId,
    )
  }

  deleteHostUiDshPages(entryId: DshPluginEntryId): void {
    for (const [id, page] of this.hostUiPages) {
      if (page.owner.kind === 'dsh-plugin' && page.owner.entryId === entryId) this.hostUiPages.delete(id)
    }
  }

  getHostUiPreferencesRevision(): number {
    return this.hostUiPreferencesRevision
  }

  updateHostUiPagePreferences(input: Parameters<HostUiRepository['updateHostUiPagePreferences']>[0]): number {
    if (input.expectedRevision !== this.hostUiPreferencesRevision) throw new Error('页面入口偏好已更新。')
    input.entries.forEach((preference, index) => {
      const page = this.hostUiPages.get(preference.pageInstanceId)
      if (page)
        this.hostUiPages.set(preference.pageInstanceId, { ...page, visible: preference.visible, sortOrder: index })
    })
    return ++this.hostUiPreferencesRevision
  }

  getHostUiPermissionGrant(ownerKey: string): HostUiPermissionGrant | undefined {
    return this.hostUiGrants.get(ownerKey)
  }

  upsertHostUiPermissionGrant(grant: HostUiPermissionGrant): void {
    this.hostUiGrants.set(grant.ownerKey, grant)
  }

  deleteHostUiPermissionGrant(ownerKey: string): void {
    this.hostUiGrants.delete(ownerKey)
  }

  getHostUiDiagnostic(pageInstanceId: HostUiPageInstanceId): HostUiDiagnostic | undefined {
    return this.hostUiDiagnostics.get(pageInstanceId)
  }

  upsertHostUiDiagnostic(diagnostic: HostUiDiagnostic): void {
    this.hostUiDiagnostics.set(diagnostic.pageInstanceId, diagnostic)
  }

  deleteHostUiDiagnosticsForExtension(extensionId: ExtensionId): void {
    for (const page of this.hostUiPages.values()) {
      if (page.owner.kind === 'extension' && page.owner.extensionId === extensionId) {
        this.hostUiDiagnostics.delete(page.pageInstanceId)
      }
    }
  }

  #appendHostUiPages(
    pages: Parameters<HostUiRepository['replaceHostUiExtensionPages']>[0]['pages'],
    owner: (entryId: string) => HostUiPageEntry['owner'],
    buildKey: string,
    now: number,
    nextPageInstanceId: () => HostUiPageInstanceId,
  ): readonly HostUiPageEntry[] {
    return pages.map((page, index) => {
      const pageInstanceId = nextPageInstanceId()
      const entry: HostUiPageEntry = {
        pageInstanceId,
        owner: owner(page.entryId),
        entryId: page.entryId,
        title: page.title,
        ...(page.description === undefined ? {} : { description: page.description }),
        icon: page.icon,
        objectPane: page.objectPane,
        startPath: page.startPath,
        visible: true,
        sortOrder: index,
        routeBase: `/apps/${pageInstanceId}`,
        client: { moduleUrl: '/client.mjs', buildKey },
        createdAt: now,
        updatedAt: now,
      }
      this.hostUiPages.set(pageInstanceId, entry)
      return entry
    })
  }

  #key(agent: AgentId, extension: ExtensionId): string {
    return `${agent}\0${extension}`
  }
}

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolver) => {
    resolve = resolver
  })
  return { promise, resolve }
}

/** A minimal agent Tool, so a saved package provides something (an empty Manifest V7 is rejected). */
const GREETING_TOOL = { kind: 'tool' as const, name: 'greet', description: '问候' }

const localExtension = (id: ExtensionId): LocalExtension => ({
  id,
  provides: ['agent'],
  slug: 'test-extension',
  displayName: '测试扩展',
  description: '测试启停。',
  createdAt: 1,
})

const revision = (id: ExtensionRevisionId, extension: ExtensionId, number: number): Revision => ({
  id,
  extensionId: extension,
  revisionNumber: number,
  contentDigest: `digest-${number}`,
  payloadDigest: `payload-${number}`,
  createdAt: number,
})

const materialize = (hostCode: string) =>
  materializeDynamicPackage({
    extensionId: extensionId('test'),
    revisionId: revisionId('test'),
    snapshot: {
      name: '构建探针',
      purpose: '验证受控构建。',
      hostCode,
      contributions: [GREETING_TOOL],
    },
  })

describe('Extension save', () => {
  it('materializes a page-only Manifest V7 with stable pages and an explicit permission set', () => {
    const materialized = materializeDynamicPackage({
      extensionId: extensionId('hostui'),
      revisionId: revisionId('hostui'),
      snapshot: {
        name: '项目面板',
        purpose: '展示项目状态。',
        clientCode: 'return { apply(ctx) { ctx.pages.register({ entryId: "overview" }, () => null) } }',
        permissions: { permissions: ['agents.read'], networkOrigins: [] },
        contributions: [
          {
            kind: 'host-page',
            entryId: 'overview',
            title: '项目面板',
            icon: { kind: 'host-icon', name: 'layout-dashboard' },
            objectPane: 'hidden',
            startPath: '',
          },
        ],
      },
    })
    expect(materialized.provides).toEqual(['page'])
    expect(materialized.manifest).toMatchObject({
      schemaVersion: 7,
      permissions: { permissions: ['agents.read'], networkOrigins: [] },
      contributions: [{ kind: 'host-page', entryId: 'overview' }],
    })
    expect(materialized.sources.client).toContain('defineClientExtension')
  })

  it('automatically connects declared dynamic page CSS to the persistent Client build', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-extension-dynamic-css-'))
    temporaryDirectories.push(directory)
    const css = '.panel { color: var(--nxt-text-primary); }\n'
    const page = {
      kind: 'host-page' as const,
      entryId: 'overview',
      title: '项目面板',
      icon: { kind: 'host-icon' as const, name: 'layout-dashboard' as const },
      objectPane: 'hidden' as const,
      startPath: '',
    }
    const materialized = materializeDynamicPackage({
      extensionId: extensionId('dynamicCss'),
      revisionId: revisionId('dynamicCss'),
      snapshot: {
        name: '动态样式页面',
        purpose: '验证动态页面样式随保存接入构建。',
        clientCode: `return { inject: ['pages', 'ui'], apply(ctx) { ctx.pages.register({ page: ${JSON.stringify(page)} }, () => React.createElement(ctx.ui.Section, { className: 'panel' })) } }`,
        clientCss: { path: 'assets/page.module.css', sha256: createHash('sha256').update(css).digest('hex') },
        resources: { 'assets/page.module.css': css },
        permissions: { permissions: [], networkOrigins: [] },
        contributions: [page],
      },
    })
    expect(materialized.sources.client).toContain("import '../assets/page.module.css?nxt-dynamic-css'")
    const sources = new ExtensionSourceStore(path.join(directory, 'sources'))
    await sources.publish(materialized.manifest.extensionId, materialized.manifest.revisionId, materialized)
    const artifact = await new ExtensionBuilder(path.join(directory, 'cache')).build({
      extensionId: materialized.manifest.extensionId,
      revisionId: materialized.manifest.revisionId,
      contentDigest: materialized.contentDigest,
      sourceDirectory: sources.revisionSourceDirectory(
        materialized.manifest.extensionId,
        materialized.manifest.revisionId,
      ),
    })
    expect(artifact.clientCssEntry).toBeDefined()
    expect(await readFile(artifact.clientCssEntry!, 'utf8')).toContain('.panel')
  })

  it.each([1, 2, 3, 4, 5, 6])(
    'treats a Manifest V%s Revision as unavailable without touching its source or Activation config',
    async (version) => {
      const directory = await mkdtemp(path.join(tmpdir(), 'nxt-legacy-manifest-'))
      temporaryDirectories.push(directory)
      const repository = new MemoryExtensionRepository()
      const sources = new ExtensionSourceStore(path.join(directory, 'data'))
      const extension = localExtension(extensionId('legacy'))
      const previous = revision(revisionId('legacy'), extension.id, 1)
      repository.saveExtensionRevision({ extension, revision: previous })
      const sourceDirectory = sources.revisionSourceDirectory(extension.id, previous.id)
      await mkdir(path.join(sourceDirectory, 'source'), { recursive: true })
      const manifest = JSON.stringify({
        ...(version === 1 ? {} : { schemaVersion: version }),
        ...(version >= 3 ? { scope: 'agent' } : {}),
        ...(version >= 4 ? { permissions: { permissions: [], networkOrigins: [] } } : {}),
        extensionId: extension.id,
        revisionId: previous.id,
        entrypoints: { host: 'source/host.ts' },
        ...(version === 1 ? {} : { contributions: [] }),
      })
      await writeFile(path.join(sourceDirectory, 'manifest.json'), manifest)
      await writeFile(path.join(sourceDirectory, 'source/host.ts'), 'export default async function () {}')
      repository.upsertActivation({
        agentId: agentId('legacy'),
        extensionId: extension.id,
        extensionRevisionId: previous.id,
        config: { greeting: '保留设置' },
        activatedAt: 1,
      })
      const service = new ExtensionService(repository, sources, {
        builder: new ExtensionBuilder(path.join(directory, 'cache')),
      })
      expect(service.revisionFormat(previous)).toBe('unavailable')
      expect(service.revisionManifest(previous)).toBeUndefined()
      await expect(service.buildRevision(previous)).rejects.toThrow()
      await service.dispose()
      expect(repository.getActivation(agentId('legacy'), extension.id)).toMatchObject({
        extensionRevisionId: previous.id,
        config: { greeting: '保留设置' },
      })
      expect(await readFile(path.join(sourceDirectory, 'manifest.json'), 'utf8')).toBe(manifest)
    },
  )

  it('reports missing or invalid source as unavailable', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nxt-unavailable-source-'))
    temporaryDirectories.push(directory)
    const repository = new MemoryExtensionRepository()
    const sources = new ExtensionSourceStore(directory)
    const extension = localExtension(extensionId('source'))
    const previous = revision(revisionId('source'), extension.id, 1)
    repository.saveExtensionRevision({ extension, revision: previous })
    const service = new ExtensionService(repository, sources)
    expect(service.revisionFormat(previous)).toBe('unavailable')
    const sourceDirectory = sources.revisionSourceDirectory(extension.id, previous.id)
    await mkdir(sourceDirectory, { recursive: true })
    await writeFile(path.join(sourceDirectory, 'manifest.json'), '{}')
    expect(service.revisionFormat(previous)).toBe('unavailable')
    await service.dispose()
  })

  it.each(['', '/outside.module.css', '../outside.module.css'])(
    'rejects unsafe rebuilt resource path %j and removes staging data',
    async (resourcePath) => {
      const directory = await mkdtemp(path.join(tmpdir(), 'nxt-rebuild-resource-'))
      temporaryDirectories.push(directory)
      const sources = new ExtensionSourceStore(directory)
      const materialized = materialize('export default async function () {}')
      await expect(
        sources.publish(materialized.manifest.extensionId, materialized.manifest.revisionId, {
          ...materialized,
          resources: { [resourcePath]: 'synthetic' },
        }),
      ).rejects.toThrow('Unsafe Extension storage path')
      expect(await readdir(path.join(directory, 'staging'))).toEqual([])
      expect(
        existsSync(
          sources.revisionSourceDirectory(materialized.manifest.extensionId, materialized.manifest.revisionId),
        ),
      ).toBe(false)
    },
  )

  it('publishes a complete source directory before atomically saving LocalExtension and Revision', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-extension-save-'))
    temporaryDirectories.push(directory)
    const repository = new MemoryExtensionRepository()
    const sources = new ExtensionSourceStore(path.join(directory, 'data'))
    repository.beforeSave = ({ extension, revision }) => {
      const sourceDirectory = sources.revisionSourceDirectory(extension.id, revision.id)
      expect(existsSync(sourceDirectory)).toBe(true)
      expect(existsSync(path.join(sourceDirectory, 'manifest.json'))).toBe(true)
      expect(existsSync(path.join(sourceDirectory, 'content.sha256'))).toBe(true)
      expect(existsSync(path.join(sourceDirectory, 'payload.sha256'))).toBe(true)
      expect(existsSync(path.join(sourceDirectory, 'source', 'host.ts'))).toBe(true)
      expect(existsSync(path.join(sourceDirectory, 'source-input.json'))).toBe(false)
    }
    const ids = ['extension', 'revision'].values()
    const service = new ExtensionService(repository, sources, {
      now: () => 10,
      nextUlid: () => ids.next().value ?? 'unexpected-extra-id',
    })

    const saved = await service.saveDynamicPackage({
      snapshot: {
        name: '问候',
        purpose: '问候工具',
        hostCode: 'return { apply() {} }',
        contributions: [GREETING_TOOL],
      },
      slug: 'greeting-extension',
      displayName: '问候扩展',
      description: '提供问候。',
      createdByAgentId: agentId('creator'),
    })

    expect(repository.getExtension(saved.extension.id)).toEqual(saved.extension)
    expect(repository.getExtensionRevision(saved.revision.id)).toEqual(saved.revision)
    expect(repository.listExtensions()).toEqual([saved.extension])
    expect(repository.listExtensionRevisions(saved.extension.id)).toEqual([saved.revision])
    const manifest = manifestRevisionSchema.parse(
      JSON.parse(await readFile(path.join(service.revisionSourceDirectory(saved.revision), 'manifest.json'), 'utf8')),
    )
    const sourceDirectory = service.revisionSourceDirectory(saved.revision)
    expect(manifest.revisionId).toBe(saved.revision.id)
    expect(manifest).toEqual({
      schemaVersion: 7,
      permissions: { permissions: [], networkOrigins: [] },
      extensionId: saved.extension.id,
      revisionId: saved.revision.id,
      entrypoints: { host: 'source/host.ts' },
      contributions: [GREETING_TOOL],
    })
    expect(existsSync(path.join(sourceDirectory, 'source-input.json'))).toBe(false)
    expect((await readdir(sourceDirectory)).sort()).toEqual([
      'content.sha256',
      'manifest.json',
      'payload.sha256',
      'source',
    ])
    expect((await readdir(path.join(sourceDirectory, 'source'))).sort()).toEqual(['host.ts'])
  })

  it('reuses an existing Extension as a metadata no-op while appending its next Revision', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-extension-existing-'))
    temporaryDirectories.push(directory)
    const repository = new MemoryExtensionRepository()
    const existing = localExtension(extensionId('existing'))
    const previousRevision = revision(revisionId('existingPrevious'), existing.id, 1)
    repository.saveExtensionRevision({ extension: existing, revision: previousRevision })
    const sources = new ExtensionSourceStore(path.join(directory, 'data'))
    const service = new ExtensionService(repository, sources, {
      now: () => 42,
      nextUlid: () => 'nextRevision',
    })

    const saved = await service.saveDynamicPackage({
      extensionId: existing.id,
      snapshot: { name: '新版本', purpose: '沿用已有扩展。', hostCode: 'return {}', contributions: [GREETING_TOOL] },
      slug: existing.slug,
      displayName: '忽略的新名称',
      description: '忽略的新描述',
    })

    // The Extension keeps its identity and metadata; only what it provides follows the latest Revision.
    expect(saved.extension).toEqual({ ...existing, provides: ['agent'] })
    expect(repository.listExtensions()).toEqual([{ ...existing, provides: ['agent'] }])
    expect(saved.revision).toMatchObject({
      extensionId: existing.id,
      id: revisionId('nextRevision'),
      revisionNumber: 2,
      createdAt: 42,
    })
    expect(existsSync(service.revisionSourceDirectory(saved.revision))).toBe(true)
  })

  it('reuses an existing Revision when normalized code and contributions are unchanged', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-extension-deduplicate-'))
    temporaryDirectories.push(directory)
    const repository = new MemoryExtensionRepository()
    const sources = new ExtensionSourceStore(path.join(directory, 'data'))
    const ids = ['dedupeExtension', 'dedupeRevision', 'unusedRevision'].values()
    const service = new ExtensionService(repository, sources, {
      now: () => 10,
      nextUlid: () => ids.next().value ?? 'unexpected-id',
    })
    const first = await service.saveDynamicPackage({
      snapshot: {
        name: '去重',
        purpose: '验证内容身份。',
        hostCode: 'return { apply() {} }\r\n',
        contributions: [GREETING_TOOL],
      },
      slug: 'dedupe-extension',
      displayName: '去重扩展',
      description: '',
    })
    const second = await service.saveDynamicPackage({
      extensionId: first.extension.id,
      snapshot: {
        name: '去重',
        purpose: '验证内容身份。',
        hostCode: 'return { apply() {} }\n',
        contributions: [GREETING_TOOL],
      },
      slug: first.extension.slug,
      displayName: first.extension.displayName,
      description: first.extension.description,
    })

    expect(second.revision.id).toBe(first.revision.id)
    expect(repository.listExtensionRevisions(first.extension.id)).toEqual([first.revision])
  })

  it('rejects an existing slug change and a new slug collision before publishing or committing', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-extension-slug-'))
    temporaryDirectories.push(directory)
    const repository = new MemoryExtensionRepository()
    const existing = localExtension(extensionId('slugExisting'))
    const owner = { ...localExtension(extensionId('slugOwner')), slug: 'taken-slug' }
    repository.extensions.set(existing.id, existing)
    repository.extensions.set(owner.id, owner)
    const service = new ExtensionService(repository, new ExtensionSourceStore(path.join(directory, 'data')))

    await expect(
      service.saveDynamicPackage({
        extensionId: existing.id,
        snapshot: { name: '改名', purpose: '不应改变标识。', hostCode: 'return {}', contributions: [GREETING_TOOL] },
        slug: 'new-slug',
        displayName: '改名扩展',
        description: '',
      }),
    ).rejects.toThrow('An existing Extension slug cannot be changed by a Revision.')
    await expect(
      service.saveDynamicPackage({
        snapshot: { name: '冲突', purpose: '不应发布。', hostCode: 'return {}', contributions: [GREETING_TOOL] },
        slug: owner.slug,
        displayName: '冲突扩展',
        description: '',
      }),
    ).rejects.toThrow(`Extension slug already exists: ${owner.slug}`)
    expect(repository.listExtensionRevisions()).toEqual([])
    expect(await readdir(path.join(directory, 'data')).catch(() => [])).toEqual([])
  })

  it('rejects an unsafe clock before allocating IDs or writing Extension data', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-extension-clock-'))
    temporaryDirectories.push(directory)
    const repository = new MemoryExtensionRepository()
    const service = new ExtensionService(repository, new ExtensionSourceStore(path.join(directory, 'data')), {
      now: () => Number.MAX_SAFE_INTEGER + 1,
      nextUlid: () => {
        throw new Error('ID generator should not run after clock validation.')
      },
    })

    await expect(
      service.saveDynamicPackage({
        snapshot: { name: '时钟', purpose: '拒绝非法时间。', hostCode: 'return {}', contributions: [GREETING_TOOL] },
        slug: 'clock-extension',
        displayName: '时钟扩展',
        description: '',
      }),
    ).rejects.toThrow('Clock must return a non-negative integer.')
    expect(repository.listExtensions()).toEqual([])
    expect(repository.listExtensionRevisions()).toEqual([])
    expect(await readdir(path.join(directory, 'data')).catch(() => [])).toEqual([])
  })

  it('does not commit a Revision when the source filesystem cannot stage files', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-extension-fs-failure-'))
    temporaryDirectories.push(directory)
    const repository = new MemoryExtensionRepository()
    const dataRoot = path.join(directory, 'data')
    await mkdir(dataRoot, { recursive: true })
    await writeFile(path.join(dataRoot, 'staging'), 'not a directory', 'utf8')
    const service = new ExtensionService(repository, new ExtensionSourceStore(dataRoot), { now: () => 1 })

    await expect(
      service.saveDynamicPackage({
        snapshot: {
          name: '文件失败',
          purpose: '文件系统失败时不提交。',
          hostCode: 'return {}',
          contributions: [GREETING_TOOL],
        },
        slug: 'filesystem-failure',
        displayName: '文件失败扩展',
        description: '',
      }),
    ).rejects.toThrow()
    expect(repository.listExtensions()).toEqual([])
    expect(repository.listExtensionRevisions()).toEqual([])
  })
})

describe('Extension source store', () => {
  it('treats a duplicate immutable publish as a no-op and rejects conflicting content', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-extension-source-'))
    temporaryDirectories.push(directory)
    const sourceStore = new ExtensionSourceStore(path.join(directory, 'data'))
    const first = materialize('return { version: 1 }')

    await sourceStore.publish(first.manifest.extensionId, first.manifest.revisionId, first)
    await sourceStore.publish(first.manifest.extensionId, first.manifest.revisionId, first)
    const sourceDirectory = sourceStore.revisionSourceDirectory(first.manifest.extensionId, first.manifest.revisionId)
    expect(await readFile(path.join(sourceDirectory, 'content.sha256'), 'utf8')).toBe(`${first.contentDigest}\n`)

    const conflict = materialize('return { version: 2 }')
    await expect(
      sourceStore.publish(conflict.manifest.extensionId, conflict.manifest.revisionId, conflict),
    ).rejects.toThrow('Extension Revision directory already has other content.')
    expect(await readFile(path.join(sourceDirectory, 'content.sha256'), 'utf8')).toBe(`${first.contentDigest}\n`)
    expect(await readdir(path.join(directory, 'data', 'staging'))).toEqual([])
  })

  it('rejects relative source roots', () => {
    expect(() => new ExtensionSourceStore('relative-root')).toThrow('Extension source root must be absolute.')
  })

  it('stages and restores a complete Extension while rejecting unknown identities and escaped trash paths', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-extension-trash-'))
    temporaryDirectories.push(directory)
    const repository = new MemoryExtensionRepository()
    const sources = new ExtensionSourceStore(path.join(directory, 'data'))
    const ids = ['trashExtension', 'trashRevision'].values()
    const service = new ExtensionService(repository, sources, {
      now: () => 20,
      nextUlid: () => ids.next().value ?? 'unexpected-trash-id',
    })

    await expect(service.stageExtensionDeletion(extensionId('missingTrash'))).rejects.toThrow(
      'Unknown Extension: ext_missingTrash',
    )
    const saved = await service.saveDynamicPackage({
      snapshot: { name: '回收测试', purpose: '验证源码恢复。', hostCode: 'return {}', contributions: [GREETING_TOOL] },
      slug: 'trash-extension',
      displayName: '回收测试',
      description: '',
    })
    const sourceDirectory = service.revisionSourceDirectory(saved.revision)
    const trash = await service.stageExtensionDeletion(saved.extension.id)
    expect(existsSync(sourceDirectory)).toBe(false)
    expect(existsSync(trash)).toBe(true)

    await expect(service.restoreStagedExtension(saved.extension.id, directory)).rejects.toThrow(
      'Extension trash path escaped its root.',
    )
    await service.restoreStagedExtension(saved.extension.id, trash)
    expect(existsSync(sourceDirectory)).toBe(true)
    await expect(service.buildRevision(saved.revision)).rejects.toThrow('Extension Builder is unavailable.')
    await expect(service.deleteRevisionCaches([saved.revision])).resolves.toBeUndefined()

    const cacheRoot = path.join(directory, 'cache')
    const builder = new ExtensionBuilder(cacheRoot)
    const builtService = new ExtensionService(repository, sources, { builder })
    const artifact = await builtService.buildRevision(saved.revision)
    expect(existsSync(artifact.directory)).toBe(true)
    await builtService.deleteRevisionCaches([saved.revision])
    expect(existsSync(path.join(cacheRoot, saved.revision.id))).toBe(false)
  })
})

describe('Extension import validation', () => {
  it('applies the page limit to imported manifests as well as dynamic packages', () => {
    const manifest = {
      schemaVersion: 7,
      extensionId: extensionId('pageLimit'),
      revisionId: revisionId('pageLimit'),
      entrypoints: { host: 'source/host.ts', client: 'source/client.ts' },
      contributions: [
        { kind: 'adapter', apiVersion: 2, key: 'synthetic', descriptorDigest: 'a'.repeat(64) },
        ...Array.from({ length: 8 }, (_, index) => ({
          kind: 'host-page',
          entryId: `page${index}`,
          title: `页面${index}`,
          icon: { kind: 'host-icon', name: 'layout-dashboard' },
          objectPane: 'hidden',
          startPath: '',
        })),
      ],
    }
    const sources = { host: 'export default function () {}', client: 'export default function () {}' }
    expect(materializeImportedRevision({ manifest, sources }).manifest.contributions).toHaveLength(9)
    expect(() =>
      materializeImportedRevision({
        manifest: {
          ...manifest,
          contributions: [...manifest.contributions, { ...manifest.contributions[1], entryId: 'ninth' }],
        },
        sources,
      }),
    ).toThrow('最多贡献 8 个顶级页面')
  })

  it('requires local build and verification before import, preserves slug ownership and records unknown DSH versions explicitly', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nxt-import-boundary-'))
    temporaryDirectories.push(directory)
    const incoming = materialize('return { apply() {} }')
    const repository = new MemoryExtensionRepository()
    const sources = new ExtensionSourceStore(path.join(directory, 'data'))
    const input = {
      extension: { ...localExtension(incoming.manifest.extensionId), slug: 'import-boundary' },
      revision: {
        id: incoming.manifest.revisionId,
        contentDigest: incoming.contentDigest,
        payloadDigest: incoming.payloadDigest,
      },
      manifest: incoming.manifest,
      sources: incoming.sources,
    }
    await expect(new ExtensionService(repository, sources).importRevision(input)).rejects.toThrow('本机构建器')
    const builder = new ExtensionBuilder(path.join(directory, 'cache'))
    await expect(new ExtensionService(repository, sources, { builder }).importRevision(input)).rejects.toThrow(
      '本机 Runtime 验证器',
    )
    expect(repository.listExtensionRevisions()).toEqual([])
    const owner = { ...localExtension(extensionId('slugowner')), slug: input.extension.slug }
    repository.extensions.set(owner.id, owner)
    const service = new ExtensionService(repository, sources, {
      builder,
      importVerifier: ({ dshVersion }) => {
        expect(dshVersion).toBe('unknown')
        return Promise.resolve({
          contractVersion: 'nekro-nxt-extension-v5',
          origin: { episodeId: 'eps_import', pluginId: 'import', packageId: 'import', pluginRunId: 'import' },
          toolInvocations: [],
          rpcMethods: [],
          renderedPanels: [],
          renderedToolViews: [],
          renderedMessageRenderers: [],
        })
      },
    })
    await expect(service.importRevision(input)).rejects.toThrow('Extension slug already exists')
    repository.extensions.delete(owner.id)
    const imported = await service.importRevision(input)
    expect(imported.idempotent).toBe(false)
    expect(repository.getExtensionRevisionVerification(imported.revision.id)?.dshVersion).toBe('unknown')
    await expect(service.importRevision(input)).resolves.toMatchObject({ idempotent: true })
    // The package of the newest Revision names the extension, also when it is imported again.
    await service.importRevision({
      ...input,
      extension: { ...input.extension, displayName: '新名字', description: '新简介' },
    })
    expect(repository.getExtension(input.extension.id)).toMatchObject({ displayName: '新名字', description: '新简介' })
    await service.dispose()
  })

  it('validates declared Host UI CSS and SVG resources and includes them in the immutable build', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-extension-ui-resources-'))
    temporaryDirectories.push(directory)
    const css = '.panel { color: var(--nxt-text-primary); }\n'
    const svg = '<svg viewBox="0 0 24 24"><path d="M4 4h16v16H4z" fill="currentColor"/></svg>\n'
    const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
    const manifest = {
      schemaVersion: 7 as const,
      extensionId: extensionId('importUiAssets'),
      revisionId: revisionId('importUiAssets'),
      entrypoints: { client: 'source/client.ts' as const },
      clientCss: { path: 'assets/page.module.css', sha256: digest(css) },
      permissions: { permissions: [], networkOrigins: [] },
      contributions: [
        {
          kind: 'host-page' as const,
          entryId: 'overview',
          title: '资源页',
          icon: { kind: 'svg' as const, path: 'assets/icon.svg', sha256: digest(svg) },
          objectPane: 'hidden' as const,
          startPath: '',
        },
      ],
    }
    const sources = {
      client: `import styles from '../assets/page.module.css'\nexport default () => ({ apply() { return styles.panel } })\n`,
    }
    const resources = { 'assets/page.module.css': css, 'assets/icon.svg': svg }
    const materialized = materializeImportedRevision({ manifest, sources, resources })
    const sourceStore = new ExtensionSourceStore(path.join(directory, 'data'))
    await sourceStore.publish(manifest.extensionId, manifest.revisionId, materialized)
    const artifact = await new ExtensionBuilder(path.join(directory, 'cache')).build({
      extensionId: manifest.extensionId,
      revisionId: manifest.revisionId,
      contentDigest: materialized.contentDigest,
      sourceDirectory: sourceStore.revisionSourceDirectory(manifest.extensionId, manifest.revisionId),
    })
    expect(artifact.clientEntry).toBeDefined()
    expect(artifact.clientCssEntry).toBeDefined()
    expect(await readFile(artifact.clientCssEntry!, 'utf8')).toMatch(/color:\s*var\(--nxt-text-primary\)/u)

    expect(() =>
      materializeImportedRevision({
        manifest,
        sources,
        resources: { ...resources, 'assets/icon.svg': svg.replace('M4', 'M5') },
      }),
    ).toThrow('资源摘要不一致')
  })

  it('rejects identity, digest, existing Revision, and existing Extension conflicts', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-extension-import-validation-'))
    temporaryDirectories.push(directory)
    const incoming = materialize('return { imported: true }')
    const extension = {
      id: incoming.manifest.extensionId,
      slug: 'imported-extension',
      displayName: '导入扩展',
      description: '',
    }
    const revisionInput = {
      id: incoming.manifest.revisionId,
      contentDigest: incoming.contentDigest,
      payloadDigest: incoming.payloadDigest,
    }
    const repository = new MemoryExtensionRepository()
    const service = new ExtensionService(repository, new ExtensionSourceStore(path.join(directory, 'data')))

    await expect(
      service.importRevision({
        extension,
        revision: revisionInput,
        manifest: { ...incoming.manifest, extensionId: extensionId('otherImported') },
        sources: incoming.sources,
      }),
    ).rejects.toThrow('导入扩展的 Manifest 身份与传输清单不一致。')
    await expect(
      service.importRevision({
        extension,
        revision: { ...revisionInput, payloadDigest: '0'.repeat(64) },
        manifest: incoming.manifest,
        sources: incoming.sources,
      }),
    ).rejects.toThrow('导入扩展的内容摘要不一致。')

    const other = localExtension(extensionId('importConflictOwner'))
    repository.saveExtensionRevision({
      extension: other,
      revision: revision(incoming.manifest.revisionId, other.id, 1),
    })
    await expect(
      service.importRevision({
        extension,
        revision: revisionInput,
        manifest: incoming.manifest,
        sources: incoming.sources,
      }),
    ).rejects.toThrow('相同 Extension/Revision 身份已存在，但内容不同')

    const identityRepository = new MemoryExtensionRepository()
    identityRepository.extensions.set(extension.id, { ...localExtension(extension.id), slug: 'different-slug' })
    const identityService = new ExtensionService(
      identityRepository,
      new ExtensionSourceStore(path.join(directory, 'identity-data')),
    )
    await expect(
      identityService.importRevision({
        extension,
        revision: revisionInput,
        manifest: incoming.manifest,
        sources: incoming.sources,
      }),
    ).rejects.toThrow('同一 Extension 身份不能改变本地 slug。')
  })
})

describe('Extension materialization and build policy', () => {
  it('normalizes the same immutable source input to the same digest and entrypoint manifest', () => {
    const first = materialize('return { apply() {} }\r\n')
    const second = materialize('return { apply() {} }\n')
    expect(first.contentDigest).toBe(second.contentDigest)
    expect(first.sources.host).toContain("from '@nekro-nxt/extension-sdk'")
    expect(first.manifest).toEqual({
      schemaVersion: 7,
      permissions: { permissions: [], networkOrigins: [] },
      extensionId: extensionId('test'),
      revisionId: revisionId('test'),
      entrypoints: { host: 'source/host.ts' },
      contributions: [GREETING_TOOL],
    })
    expect(first).not.toHaveProperty('sourceInput')
  })

  it('builds Host-only, Client-only, and dual-entrypoint revisions through the public artifact contract', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-extension-entrypoints-'))
    temporaryDirectories.push(directory)
    const sourceStore = new ExtensionSourceStore(path.join(directory, 'data'))
    const builder = new ExtensionBuilder(path.join(directory, 'cache'))
    const panel = {
      kind: 'panel' as const,
      id: 'status',
      anchor: 'agent' as const,
      title: '状态',
      densities: ['compact' as const],
    }
    const variants = [
      {
        name: 'hostonly',
        snapshot: { name: 'Host', purpose: 'Host 构建。', hostCode: 'return {}', contributions: [GREETING_TOOL] },
      },
      {
        name: 'clientonly',
        snapshot: { name: 'Client', purpose: 'Client 构建。', clientCode: 'return {}', contributions: [panel] },
      },
      {
        name: 'dual',
        snapshot: {
          name: '双入口',
          purpose: '双入口构建。',
          hostCode: 'return {}',
          clientCode: 'return {}',
          contributions: [panel],
        },
      },
    ] as const

    for (const variant of variants) {
      const materialized = materializeDynamicPackage({
        extensionId: extensionId(variant.name),
        revisionId: revisionId(variant.name),
        snapshot: variant.snapshot,
      })
      await sourceStore.publish(materialized.manifest.extensionId, materialized.manifest.revisionId, materialized)
      const artifact = await builder.build({
        extensionId: materialized.manifest.extensionId,
        revisionId: materialized.manifest.revisionId,
        contentDigest: materialized.contentDigest,
        sourceDirectory: sourceStore.revisionSourceDirectory(
          materialized.manifest.extensionId,
          materialized.manifest.revisionId,
        ),
      })

      expect(artifact.revisionId).toBe(materialized.manifest.revisionId)
      expect(builder.buildKey(materialized.contentDigest)).toBe(artifact.buildKey)
      expect(artifact.hostEntry === undefined).toBe(!('hostCode' in variant.snapshot))
      expect(artifact.clientEntry === undefined).toBe(!('clientCode' in variant.snapshot))
      if (artifact.hostEntry) expect(existsSync(artifact.hostEntry)).toBe(true)
      if (artifact.clientEntry) expect(existsSync(artifact.clientEntry)).toBe(true)

      if (variant.name !== 'hostonly') {
        await writeFile(
          path.join(artifact.directory, 'build.json'),
          JSON.stringify({ revisionId: artifact.revisionId, buildKey: artifact.buildKey, hostEntry: 'host.mjs' }),
          'utf8',
        )
        await expect(
          builder.build({
            extensionId: materialized.manifest.extensionId,
            revisionId: materialized.manifest.revisionId,
            contentDigest: materialized.contentDigest,
            sourceDirectory: sourceStore.revisionSourceDirectory(
              materialized.manifest.extensionId,
              materialized.manifest.revisionId,
            ),
          }),
        ).resolves.toEqual(artifact)
      }
    }
  })

  it('requires an absolute build cache root', () => {
    expect(() => new ExtensionBuilder('relative-cache-root')).toThrow('Extension build cache root must be absolute.')
  })

  it('validates materialized identities before constructing the revision payload', () => {
    expect(() =>
      materializeDynamicPackage({
        extensionId: ExtensionIdSchema.parse('../outside'),
        revisionId: revisionId('test'),
        snapshot: {
          name: '构建探针',
          purpose: '验证严格物化。',
          hostCode: 'return { apply() {} }',
        },
      }),
    ).toThrow('ExtensionId has an invalid format')
  })

  it('rejects malformed or structurally invalid source manifests before building', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-extension-manifest-'))
    temporaryDirectories.push(directory)
    const sourceStore = new ExtensionSourceStore(path.join(directory, 'data'))
    const materialized = materialize('return { apply() {} }')
    await sourceStore.publish(materialized.manifest.extensionId, materialized.manifest.revisionId, materialized)
    const sourceDirectory = sourceStore.revisionSourceDirectory(
      materialized.manifest.extensionId,
      materialized.manifest.revisionId,
    )
    const manifestPath = path.join(sourceDirectory, 'manifest.json')
    const cache = path.join(directory, 'cache')
    const buildInput = {
      extensionId: materialized.manifest.extensionId,
      revisionId: materialized.manifest.revisionId,
      contentDigest: materialized.contentDigest,
      sourceDirectory,
    }

    await expect(
      new ExtensionBuilder(cache).build({ ...buildInput, extensionId: extensionId('other') }),
    ).rejects.toThrow('Extension Manifest identity does not match build input.')

    await writeFile(
      manifestPath,
      JSON.stringify({ ...materialized.manifest, revisionId: revisionId('otherRevision') }),
      'utf8',
    )
    await expect(new ExtensionBuilder(cache).build(buildInput)).rejects.toThrow(
      'Extension Manifest revision does not match build input.',
    )

    await writeFile(manifestPath, '{', 'utf8')
    await expect(new ExtensionBuilder(cache).build(buildInput)).rejects.toBeInstanceOf(SyntaxError)

    await writeFile(
      manifestPath,
      JSON.stringify({
        ...materialized.manifest,
        schemaVersion: 1,
        apiVersion: '1',
        compatible: { nekroNxt: '^0.1.0', dsh: '^0.1.1-rc.2' },
        requestedCapabilities: [],
        contributions: [],
        name: '过早预留',
      }),
      'utf8',
    )
    await expect(new ExtensionBuilder(cache).build(buildInput)).rejects.toMatchObject({ name: 'ZodError' })
    expect(await readdir(cache).catch(() => [])).toEqual([])
  })

  it('rebuilds malformed and structurally invalid cache manifests', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-extension-cache-'))
    temporaryDirectories.push(directory)
    const sourceStore = new ExtensionSourceStore(path.join(directory, 'data'))
    const materialized = materialize('return { apply() {} }')
    await sourceStore.publish(materialized.manifest.extensionId, materialized.manifest.revisionId, materialized)
    const buildInput = {
      extensionId: materialized.manifest.extensionId,
      revisionId: materialized.manifest.revisionId,
      contentDigest: materialized.contentDigest,
      sourceDirectory: sourceStore.revisionSourceDirectory(
        materialized.manifest.extensionId,
        materialized.manifest.revisionId,
      ),
    }
    const builder = new ExtensionBuilder(path.join(directory, 'cache'))
    const artifact = await builder.build(buildInput)
    const cacheManifestPath = path.join(artifact.directory, 'build.json')
    expect(buildCacheSchema.parse(JSON.parse(await readFile(cacheManifestPath, 'utf8')))).toEqual({
      revisionId: materialized.manifest.revisionId,
      buildKey: artifact.buildKey,
      hostEntry: 'host.mjs',
    })

    await expect(builder.build(buildInput)).resolves.toEqual(artifact)

    await writeFile(
      cacheManifestPath,
      JSON.stringify({ revisionId: materialized.manifest.revisionId, buildKey: '0'.repeat(64) }),
      'utf8',
    )
    await expect(builder.build(buildInput)).resolves.toEqual(artifact)

    await writeFile(cacheManifestPath, '{', 'utf8')
    await expect(builder.build(buildInput)).resolves.toEqual(artifact)

    await writeFile(cacheManifestPath, JSON.stringify({ ...artifact, unexpected: true }), 'utf8')
    await expect(builder.build(buildInput)).resolves.toEqual(artifact)

    await writeFile(
      cacheManifestPath,
      JSON.stringify({ revisionId: materialized.manifest.revisionId, buildKey: artifact.buildKey }),
      'utf8',
    )
    await expect(builder.build(buildInput)).resolves.toEqual(artifact)

    const hostEntry = artifact.hostEntry
    if (hostEntry === undefined) throw new Error('Expected the Host build artifact to have an entrypoint.')
    await rm(hostEntry)
    await expect(builder.build(buildInput)).resolves.toEqual(artifact)
    expect(existsSync(hostEntry)).toBe(true)
  })

  it('rejects undeclared bare imports and leaves no committed cache artifact', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-extension-policy-'))
    temporaryDirectories.push(directory)
    const sourceStore = new ExtensionSourceStore(path.join(directory, 'data'))
    const materialized = materialize("return await import('node:fs')")
    await sourceStore.publish(materialized.manifest.extensionId, materialized.manifest.revisionId, materialized)
    const cache = path.join(directory, 'cache')
    await expect(
      new ExtensionBuilder(cache).build({
        revisionId: materialized.manifest.revisionId,
        contentDigest: materialized.contentDigest,
        sourceDirectory: sourceStore.revisionSourceDirectory(
          materialized.manifest.extensionId,
          materialized.manifest.revisionId,
        ),
      }),
    ).rejects.toThrow('Extension import is not allowed: node:fs')
    expect(await readdir(cache).catch(() => [])).toEqual([])
  })

  it('cleans the temporary build and preserves unrelated cache siblings after an entrypoint failure', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-extension-build-cleanup-'))
    temporaryDirectories.push(directory)
    const sourceStore = new ExtensionSourceStore(path.join(directory, 'data'))
    const materialized = materialize('return {}')
    await sourceStore.publish(materialized.manifest.extensionId, materialized.manifest.revisionId, materialized)
    const sourceDirectory = sourceStore.revisionSourceDirectory(
      materialized.manifest.extensionId,
      materialized.manifest.revisionId,
    )
    const hostPath = path.join(sourceDirectory, 'source', 'host.ts')
    await rm(hostPath)
    await mkdir(hostPath)
    const cache = path.join(directory, 'cache')
    const revisionCacheDirectory = path.join(cache, materialized.manifest.revisionId)
    await mkdir(path.join(revisionCacheDirectory, 'keep'), { recursive: true })

    await expect(
      new ExtensionBuilder(cache).build({
        extensionId: materialized.manifest.extensionId,
        revisionId: materialized.manifest.revisionId,
        contentDigest: materialized.contentDigest,
        sourceDirectory,
      }),
    ).rejects.toThrow('Extension entrypoint is not a file: host')
    expect(await readdir(revisionCacheDirectory)).toEqual(['keep'])
  })

  it('rejects parent-traversal storage identities', () => {
    const sourceStore = new ExtensionSourceStore('/tmp/nekro-nxt-extension-path-policy')
    expect(() =>
      sourceStore.revisionSourceDirectory(ExtensionIdSchema.parse('../outside'), revisionId('safe')),
    ).toThrow('ExtensionId has an invalid format')
  })
})

// —— Extension lifecycle (扩展形态统一) ——

/** Records what the coordinator asks of the Server: loads, attachments, safe gaps and disposals, in order. */
class FakeRuntimeHost implements ExtensionRuntimeHost {
  readonly events: string[] = []
  readonly loaded = new Map<ExtensionId, ExtensionRevisionId>()
  readonly attached = new Map<string, JsonValue>()
  readonly failLoad = new Set<ExtensionRevisionId>()
  readonly failAttach = new Set<string>()
  readonly occupiedAdapterKeys = new Set<string>()
  safeGate: Promise<void> | undefined

  load(input: Parameters<ExtensionRuntimeHost['load']>[0]): Promise<LoadedExtension> {
    const { revision, manifest } = input
    this.events.push(`load:${revision.id}`)
    if (this.failLoad.has(revision.id)) return Promise.reject(new Error(`Load failed: ${revision.id}`))
    this.loaded.set(revision.extensionId, revision.id)
    const adapterKey = manifest.contributions.find((entry) => entry.kind === 'adapter')?.key
    return Promise.resolve({
      ...(adapterKey === undefined ? {} : { adapterKey }),
      attach: (agent: AgentId, config: JsonValue): Promise<MountedAttachment> => {
        const key = `${agent}\0${revision.id}`
        this.events.push(`attach:${agent}:${revision.id}`)
        if (this.failAttach.has(key)) return Promise.reject(new Error(`Attach failed: ${agent}`))
        this.attached.set(key, config)
        return Promise.resolve({
          dispose: () => {
            this.events.push(`detach:${agent}:${revision.id}`)
            this.attached.delete(key)
            return Promise.resolve()
          },
        })
      },
      call: (method: string, value: JsonValue) => Promise.resolve({ method, value, revision: revision.id }),
      dispose: () => {
        this.events.push(`dispose:${revision.id}`)
        if (this.loaded.get(revision.extensionId) === revision.id) this.loaded.delete(revision.extensionId)
        return Promise.resolve()
      },
    })
  }

  waitUntilAgentSafe(agent: AgentId): Promise<void> {
    this.events.push(`safe:${agent}`)
    return this.safeGate ?? Promise.resolve()
  }

  waitUntilAdapterSafe(adapterKey: string): Promise<void> {
    this.events.push(`adapter-safe:${adapterKey}`)
    return Promise.resolve()
  }

  assertAdapterKeyAvailable(adapterKey: string): Promise<void> {
    return this.occupiedAdapterKeys.has(adapterKey)
      ? Promise.reject(new Error(`适配器 key 已被占用: ${adapterKey}`))
      : Promise.resolve()
  }
}

const lifecycleVerification = (id: ExtensionRevisionId): ExtensionRevisionVerification => ({
  revisionId: id,
  dshVersion: 'test',
  contractVersion: 'nekro-nxt-extension-v5',
  origin: { episodeId: 'eps_test', pluginId: 'test', packageId: 'test', pluginRunId: 'test' },
  verifiedAt: 1,
  hostBuild: { built: true, buildKey: 'build' },
  clientBuild: { built: false, buildKey: 'build' },
  toolInvocations: [],
  rpcMethods: [],
  renderedPanels: [],
  renderedToolViews: [],
  renderedMessageRenderers: [],
})

/** A Manifest V7 with an agent Tool, a host and an agent config field, and optional extras per test. */
const lifecycleManifest = (
  item: Revision,
  extra: {
    readonly permissions?: Record<string, unknown>
    readonly adapterKey?: string
    readonly agentLayer?: boolean
  } = {},
): ExtensionManifest =>
  extensionManifestSchema.parse({
    schemaVersion: 7,
    extensionId: item.extensionId,
    revisionId: item.id,
    entrypoints: { host: 'source/host.ts' },
    permissions: { permissions: [], networkOrigins: [], ...extra.permissions },
    config: {
      host: {
        schema: configSchema.object({ endpoint: configSchema.string('地址', { default: 'https://api.example.com' }) }),
      },
      ...(extra.agentLayer === false
        ? {}
        : { agent: { schema: configSchema.object({ greeting: configSchema.string('问候', { default: '你好' }) }) } }),
    },
    contributions: [
      ...(extra.agentLayer === false ? [] : [GREETING_TOOL]),
      ...(extra.adapterKey === undefined
        ? []
        : [{ kind: 'adapter', apiVersion: 2, key: extra.adapterKey, descriptorDigest: 'a'.repeat(64) }]),
      ...(extra.agentLayer === false && extra.adapterKey === undefined ? [{ kind: 'rpc', method: 'items.list' }] : []),
    ],
  })

const lifecycleFixture = (
  manifests: Readonly<Record<string, (item: Revision) => ExtensionManifest | undefined>> = {},
  now: () => number = () => 100,
) => {
  const repository = new MemoryExtensionRepository()
  const host = new FakeRuntimeHost()
  const extension = localExtension(extensionId('lifecycle'))
  const first = revision(revisionId('lifecycleFirst'), extension.id, 1)
  const second = revision(revisionId('lifecycleSecond'), extension.id, 2)
  for (const item of [first, second]) {
    repository.saveExtensionRevision({ extension, revision: item, verification: lifecycleVerification(item.id) })
  }
  const coordinator = new ExtensionLifecycleCoordinator(
    repository,
    {
      revisionSourceDirectory: (item) => `/source/${item.id}`,
      revisionManifest: (item) => (manifests[item.id] ?? ((value: Revision) => lifecycleManifest(value)))(item),
    },
    {
      build: ({ revisionId: id, contentDigest }) =>
        Promise.resolve({ revisionId: id, buildKey: contentDigest, directory: `/cache/${id}` }),
    },
    host,
    { now },
  )
  return { repository, host, extension, first, second, coordinator }
}

describe('Extension lifecycle', () => {
  it('installs on first enable, runs the factory once and attaches each agent on the installed record', async () => {
    const { repository, host, extension, first, coordinator } = lifecycleFixture()
    const one = agentId('lifecycleOne')
    const two = agentId('lifecycleTwo')

    await coordinator.activate({ agentId: one, extensionId: extension.id, revisionId: first.id })
    await coordinator.activate({
      agentId: two,
      extensionId: extension.id,
      revisionId: first.id,
      config: { greeting: '早上好' },
    })

    expect(host.events.filter((event) => event.startsWith('load:'))).toEqual([`load:${first.id}`])
    expect(repository.getHostInstallation(extension.id)).toMatchObject({
      extensionRevisionId: first.id,
      config: { endpoint: 'https://api.example.com' },
    })
    expect(repository.getActivation(one, extension.id)).toMatchObject({
      extensionRevisionId: first.id,
      config: { greeting: '你好' },
    })
    expect(host.attached.get(`${two}\0${first.id}`)).toEqual({ greeting: '早上好' })
    expect(coordinator.isAttached(one, extension.id)).toBe(true)
    await expect(coordinator.call(extension.id, 'items.list', null, { surface: 'page' })).resolves.toMatchObject({
      revision: first.id,
    })

    await coordinator.disable(one, extension.id)
    expect(repository.getActivation(one, extension.id)).toBeUndefined()
    expect(repository.getHostInstallation(extension.id)).toBeDefined()
    expect(host.loaded.get(extension.id)).toBe(first.id)
  })

  it('switches the installation with every agent, carrying configuration and keeping one current version', async () => {
    const { repository, host, extension, first, second, coordinator } = lifecycleFixture()
    const one = agentId('switchOne')
    const two = agentId('switchTwo')
    await coordinator.activate({ agentId: one, extensionId: extension.id, revisionId: first.id })
    await coordinator.activate({
      agentId: two,
      extensionId: extension.id,
      revisionId: first.id,
      config: { greeting: '保留' },
    })
    host.events.length = 0

    await coordinator.install({ extensionId: extension.id, revisionId: second.id })

    expect(host.events).toEqual([
      `safe:${one}`,
      `detach:${one}:${first.id}`,
      `safe:${two}`,
      `detach:${two}:${first.id}`,
      `dispose:${first.id}`,
      `load:${second.id}`,
      `attach:${one}:${second.id}`,
      `attach:${two}:${second.id}`,
    ])
    expect(repository.getHostInstallation(extension.id)?.extensionRevisionId).toBe(second.id)
    expect(repository.listActivations().map((activation) => activation.extensionRevisionId)).toEqual([
      second.id,
      second.id,
    ])
    expect(repository.getActivation(two, extension.id)?.config).toEqual({ greeting: '保留' })
  })

  it('restores the previous record and leaves the database unchanged when the new record fails to load', async () => {
    const { repository, host, extension, first, second, coordinator } = lifecycleFixture()
    const one = agentId('rollbackOne')
    await coordinator.activate({ agentId: one, extensionId: extension.id, revisionId: first.id })
    host.failLoad.add(second.id)

    await expect(coordinator.install({ extensionId: extension.id, revisionId: second.id })).rejects.toThrow(
      'Load failed',
    )

    expect(repository.getHostInstallation(extension.id)?.extensionRevisionId).toBe(first.id)
    expect(repository.getActivation(one, extension.id)?.extensionRevisionId).toBe(first.id)
    expect(host.loaded.get(extension.id)).toBe(first.id)
    expect(host.attached.has(`${one}\0${first.id}`)).toBe(true)
  })

  it('restores the previous record when an agent cannot attach to the new one or the commit fails', async () => {
    const { repository, host, extension, first, second, coordinator } = lifecycleFixture()
    const one = agentId('attachFailOne')
    await coordinator.activate({ agentId: one, extensionId: extension.id, revisionId: first.id })
    host.failAttach.add(`${one}\0${second.id}`)
    await expect(coordinator.install({ extensionId: extension.id, revisionId: second.id })).rejects.toThrow(
      'Attach failed',
    )
    expect(host.loaded.get(extension.id)).toBe(first.id)
    expect(host.attached.has(`${one}\0${first.id}`)).toBe(true)

    host.failAttach.clear()
    repository.failInstallationUpsert = true
    await expect(coordinator.install({ extensionId: extension.id, revisionId: second.id })).rejects.toThrow(
      'Installation transaction failed.',
    )
    expect(repository.getHostInstallation(extension.id)?.extensionRevisionId).toBe(first.id)
    expect(repository.getActivation(one, extension.id)?.extensionRevisionId).toBe(first.id)
    expect(host.loaded.get(extension.id)).toBe(first.id)
  })

  it('asks for the host approval at install and the agent approval at enable, and records both grants', async () => {
    const { repository, extension, first, coordinator } = lifecycleFixture({
      [revisionId('lifecycleFirst')]: (item) =>
        lifecycleManifest(item, {
          permissions: {
            permissions: ['agents.read'],
            host: { network: { mode: 'domains', domains: ['api.example.com'] } },
            agent: { history: { read: true } },
          },
        }),
    })
    const one = agentId('approvalOne')
    const host = coordinator.hostRequirement(extension.id, first.id)
    const agent = coordinator.agentRequirement(one, extension.id, first.id)
    expect(host).toMatchObject({ approvalRequired: true, declaration: { permissions: ['agents.read'] } })
    expect(host.declaration.capabilities?.network).toEqual({ mode: 'domains', domains: ['api.example.com'] })
    expect(agent).toMatchObject({ approvalRequired: true, declaration: { capabilities: { history: { read: true } } } })

    await expect(
      coordinator.activate({ agentId: one, extensionId: extension.id, revisionId: first.id }),
    ).rejects.toThrow(`permission-approval-required:${host.permissionDigest}`)
    await expect(
      coordinator.activate({
        agentId: one,
        extensionId: extension.id,
        revisionId: first.id,
        hostPermissionApproval: { permissionDigest: host.permissionDigest },
      }),
    ).rejects.toThrow(`permission-approval-required:${agent.permissionDigest}`)
    expect(coordinator.getTransition(one, extension.id)).toMatchObject({ state: 'failed', target: 'enabled' })

    await coordinator.activate({
      agentId: one,
      extensionId: extension.id,
      revisionId: first.id,
      hostPermissionApproval: { permissionDigest: host.permissionDigest },
      permissionApproval: { permissionDigest: agent.permissionDigest },
    })
    expect(repository.getHostUiPermissionGrant(`extension:${extension.id}`)?.permissionDigest).toBe(
      host.permissionDigest,
    )
    expect(repository.getHostUiPermissionGrant(`activation:${one}:${extension.id}`)?.permissionDigest).toBe(
      agent.permissionDigest,
    )
    expect(coordinator.getTransition(one, extension.id)).toBeUndefined()
    expect(coordinator.agentRequirement(one, extension.id, first.id).approvalRequired).toBe(false)
  })

  it('requires the agents to approve a switch only when the new record asks them for more', async () => {
    const { extension, first, second, coordinator } = lifecycleFixture({
      [revisionId('lifecycleSecond')]: (item) =>
        lifecycleManifest(item, { permissions: { agent: { llm: { maxCallsPerTurn: 2, maxOutputTokens: 400 } } } }),
    })
    const one = agentId('expandOne')
    await coordinator.activate({ agentId: one, extensionId: extension.id, revisionId: first.id })
    const expansion = coordinator.switchAgentRequirement(extension.id, second.id)
    expect(expansion?.approvalRequired).toBe(true)
    await expect(coordinator.install({ extensionId: extension.id, revisionId: second.id })).rejects.toThrow(
      `permission-approval-required:${expansion?.permissionDigest ?? ''}`,
    )
    await coordinator.install({
      extensionId: extension.id,
      revisionId: second.id,
      agentPermissionApproval: { permissionDigest: expansion?.permissionDigest ?? '' },
    })
    expect(coordinator.switchAgentRequirement(extension.id, second.id)).toBeUndefined()
  })

  it('checks the adapter key before stopping anything and waits for the adapter safe gap on switch', async () => {
    const adapterManifest = (item: Revision) => lifecycleManifest(item, { adapterKey: 'synthetic', agentLayer: false })
    const { host, extension, first, second, coordinator } = lifecycleFixture({
      [revisionId('lifecycleFirst')]: adapterManifest,
      [revisionId('lifecycleSecond')]: adapterManifest,
    })
    await coordinator.install({ extensionId: extension.id, revisionId: first.id })
    host.occupiedAdapterKeys.add('synthetic')
    host.events.length = 0
    await expect(coordinator.install({ extensionId: extension.id, revisionId: second.id })).rejects.toThrow('已被占用')
    expect(host.events).toEqual([])

    host.occupiedAdapterKeys.clear()
    await coordinator.install({ extensionId: extension.id, revisionId: second.id })
    expect(host.events).toEqual(['adapter-safe:synthetic', `dispose:${first.id}`, `load:${second.id}`])
    await expect(
      coordinator.activate({ agentId: agentId('adapterAgent'), extensionId: extension.id, revisionId: second.id }),
    ).rejects.toThrow('没有智能体能力')
  })

  it('rejects unverified and unreadable records before loading anything', async () => {
    const { repository, host, extension, first, second, coordinator } = lifecycleFixture({
      [revisionId('lifecycleSecond')]: () => undefined,
    })
    repository.verifications.delete(first.id)
    await expect(coordinator.install({ extensionId: extension.id, revisionId: first.id })).rejects.toThrow(
      '本机完成验证',
    )
    await expect(coordinator.install({ extensionId: extension.id, revisionId: second.id })).rejects.toThrow('旧格式')
    expect(host.events).toEqual([])
  })

  it('uninstalls every attachment, the instance and their grants', async () => {
    const { repository, host, extension, first, coordinator } = lifecycleFixture()
    const one = agentId('uninstallOne')
    await coordinator.activate({ agentId: one, extensionId: extension.id, revisionId: first.id })
    await coordinator.uninstall(extension.id)
    expect(repository.getHostInstallation(extension.id)).toBeUndefined()
    expect(repository.getActivation(one, extension.id)).toBeUndefined()
    expect(repository.getHostUiPermissionGrant(`activation:${one}:${extension.id}`)).toBeUndefined()
    expect(host.loaded.has(extension.id)).toBe(false)
    await expect(coordinator.call(extension.id, 'items.list', null, { surface: 'page' })).rejects.toThrow(
      '没有在本机运行',
    )
  })

  it('applies host and agent configuration by reloading or re-attaching only what changed', async () => {
    const { repository, host, extension, first, coordinator } = lifecycleFixture()
    const one = agentId('configOne')
    await coordinator.activate({ agentId: one, extensionId: extension.id, revisionId: first.id })
    host.events.length = 0
    await coordinator.updateAgentConfig(one, extension.id, { greeting: '晚上好' })
    expect(host.events).toEqual([`safe:${one}`, `detach:${one}:${first.id}`, `attach:${one}:${first.id}`])
    expect(repository.getActivation(one, extension.id)?.config).toEqual({ greeting: '晚上好' })

    host.events.length = 0
    await coordinator.updateHostConfig(extension.id, { endpoint: 'https://self-hosted.example.com' })
    expect(host.events).toContain(`load:${first.id}`)
    expect(repository.getHostInstallation(extension.id)?.config).toEqual({
      endpoint: 'https://self-hosted.example.com',
    })
    expect(host.attached.get(`${one}\0${first.id}`)).toEqual({ greeting: '晚上好' })
  })

  it('restores instances before attachments and records failures without inventing state', async () => {
    const { repository, host, extension, first, coordinator } = lifecycleFixture()
    const one = agentId('restoreOne')
    repository.installations.set(extension.id, {
      extensionId: extension.id,
      extensionRevisionId: first.id,
      installedAt: 1,
      config: {},
    })
    repository.upsertActivation({
      agentId: one,
      extensionId: extension.id,
      extensionRevisionId: first.id,
      config: { greeting: '你好' },
      activatedAt: 1,
    })

    await expect(coordinator.restoreAttachments()).resolves.toEqual({ restored: 0, failed: 1 })
    expect(coordinator.getAttachmentDiagnostic(one, extension.id)).toMatchObject({ status: 'restore-failed' })

    await expect(coordinator.restoreInstances()).resolves.toEqual({ restored: 1, failed: 0 })
    await expect(coordinator.restoreAttachments()).resolves.toEqual({ restored: 1, failed: 0 })
    expect(host.attached.has(`${one}\0${first.id}`)).toBe(true)
    await expect(coordinator.restoreInstances()).resolves.toEqual({ restored: 0, failed: 0 })
  })

  it('publishes a waiting request until the agent safe gap and rejects work after disposal', async () => {
    const { host, extension, first, coordinator } = lifecycleFixture()
    const one = agentId('waitingOne')
    await coordinator.install({ extensionId: extension.id, revisionId: first.id })
    const gate = deferred<void>()
    host.safeGate = gate.promise
    const pending = coordinator.activate({ agentId: one, extensionId: extension.id, revisionId: first.id })
    await Promise.resolve()
    expect(coordinator.getTransition(one, extension.id)).toMatchObject({ state: 'waiting', target: 'enabled' })
    expect(coordinator.listTransitions(extension.id)).toHaveLength(1)
    gate.resolve()
    await pending
    expect(coordinator.getTransition(one, extension.id)).toBeUndefined()

    host.safeGate = undefined
    await coordinator.dispose()
    expect(host.loaded.has(extension.id)).toBe(false)
    await expect(coordinator.install({ extensionId: extension.id, revisionId: first.id })).rejects.toThrow('已停止')
  })
})
