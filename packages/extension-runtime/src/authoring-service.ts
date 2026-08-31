import {
  AgentIdSchema,
  AuthoringAttemptIdSchema,
  AuthoringTaskIdSchema,
  HostUiPermissionDeclarationSchema,
  JsonValueSchema,
  type AgentId,
  type AuthoringAttemptId,
  type ChannelEventId,
  type ChannelId,
  type EpisodeId,
  type JsonValue,
} from '@nekro-nxt/contracts'
import { canonicalJson } from '@nekro-nxt/core'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { monotonicFactory } from 'ulid'
import { z } from 'zod'
import type {
  AuthoringApprovalPolicy,
  AuthoringAttemptFailure,
  AuthoringAttemptState,
  AuthoringHalfState,
  AuthoringRepository,
  AuthoringTaskStatus,
  DynamicAuthoringAttempt,
  DynamicAuthoringEvent,
  DynamicAuthoringSnapshot,
  DynamicAuthoringTask,
  DynamicAuthoringVerification,
} from './authoring.js'

const SnapshotSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    purpose: z.string().trim().min(1).max(500),
    scope: z.enum(['agent', 'host-adapter', 'host-ui']),
    code: z
      .object({
        host: z
          .string()
          .max(1024 * 1024)
          .optional(),
        client: z
          .string()
          .max(1024 * 1024)
          .optional(),
      })
      .strict()
      .refine(({ host, client }) => host !== undefined || client !== undefined, '动态包必须包含 Host 或 Client 源码。'),
    resources: z.record(z.string().regex(/^assets\/[a-z0-9][a-z0-9/_.-]*$/u), z.string().max(256 * 1024)),
    clientCss: z
      .object({
        path: z.string().regex(/^assets\/[a-z0-9][a-z0-9/_-]*\.module\.css$/u),
        sha256: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict()
      .optional(),
    permissions: HostUiPermissionDeclarationSchema,
    contributions: z.array(JsonValueSchema),
  })
  .strict()

const parseSnapshot = (input: unknown): DynamicAuthoringSnapshot => {
  const parsed = SnapshotSchema.parse(input)
  return {
    name: parsed.name,
    purpose: parsed.purpose,
    scope: parsed.scope,
    code: {
      ...(parsed.code.host === undefined ? {} : { host: parsed.code.host }),
      ...(parsed.code.client === undefined ? {} : { client: parsed.code.client }),
    },
    resources: parsed.resources,
    ...(parsed.clientCss === undefined ? {} : { clientCss: parsed.clientCss }),
    permissions: parsed.permissions,
    contributions: parsed.contributions,
  }
}

const EMPTY_HALF: AuthoringHalfState = { status: 'absent', waitingFor: [] }

const digest = (value: unknown): string =>
  createHash('sha256')
    .update(canonicalJson(JsonValueSchema.parse(value)))
    .digest('hex')

const stableAttemptFields = (attempt: DynamicAuthoringAttempt) => ({
  id: attempt.id,
  taskId: attempt.taskId,
  ordinal: attempt.ordinal,
  name: attempt.name,
  purpose: attempt.purpose,
  snapshotDigest: attempt.snapshotDigest,
  riskDigest: attempt.riskDigest,
  sourcePath: attempt.sourcePath,
  ...(attempt.runnerPluginId === undefined ? {} : { runnerPluginId: attempt.runnerPluginId }),
  ...(attempt.runnerPackageId === undefined ? {} : { runnerPackageId: attempt.runnerPackageId }),
  createdAt: attempt.createdAt,
})

const assertStorageIdentity = (value: string): void => {
  if (!value || value === '.' || value === '..' || path.basename(value) !== value) {
    throw new TypeError(`Unsafe Authoring storage identity: ${value}`)
  }
}

export class AuthoringArtifactStore {
  readonly #workspaceRoot: string

  constructor(workspaceRoot: string) {
    if (!path.isAbsolute(workspaceRoot)) throw new TypeError('Authoring workspace root must be absolute.')
    this.#workspaceRoot = workspaceRoot
  }

  async publish(
    agentId: AgentId,
    taskId: DynamicAuthoringTask['id'],
    attemptId: AuthoringAttemptId,
    input: DynamicAuthoringSnapshot,
  ): Promise<string> {
    assertStorageIdentity(agentId)
    assertStorageIdentity(taskId)
    assertStorageIdentity(attemptId)
    const snapshot = parseSnapshot(input)
    const relative = path.join(agentId, 'authoring', taskId, 'attempts', attemptId)
    const final = path.join(this.#workspaceRoot, relative)
    const staging = path.join(this.#workspaceRoot, agentId, 'authoring', '.staging', randomUUID())
    await mkdir(path.join(staging, 'source'), { recursive: true, mode: 0o700 })
    try {
      for (const resourcePath of Object.keys(snapshot.resources)) {
        const destination = path.join(staging, resourcePath)
        const relativeDestination = path.relative(staging, destination)
        if (relativeDestination.startsWith('..') || path.isAbsolute(relativeDestination)) {
          throw new Error(`动态资源路径越界：${resourcePath}`)
        }
        await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
      }
      const content = canonicalJson(JsonValueSchema.parse(snapshot))
      const contentDigest = createHash('sha256').update(content).digest('hex')
      await Promise.all([
        writeFile(path.join(staging, 'snapshot.json'), JSON.stringify(snapshot, null, 2) + '\n', { mode: 0o600 }),
        writeFile(path.join(staging, 'content.sha256'), contentDigest + '\n', { mode: 0o600 }),
        ...(snapshot.code.host === undefined
          ? []
          : [writeFile(path.join(staging, 'source', 'host.js'), snapshot.code.host, { mode: 0o600 })]),
        ...(snapshot.code.client === undefined
          ? []
          : [writeFile(path.join(staging, 'source', 'client.js'), snapshot.code.client, { mode: 0o600 })]),
        ...Object.entries(snapshot.resources).map(([resourcePath, source]) =>
          writeFile(path.join(staging, resourcePath), source, { mode: 0o600 }),
        ),
      ])
      await mkdir(path.dirname(final), { recursive: true, mode: 0o700 })
      try {
        await rename(staging, final)
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? Reflect.get(error, 'code') : undefined
        if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error
        const existing = (await readFile(path.join(final, 'content.sha256'), 'utf8')).trim()
        if (existing !== contentDigest) throw new Error('Authoring Attempt 目录已包含其他内容。')
      }
      return relative
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }

  async read(relativePath: string): Promise<DynamicAuthoringSnapshot> {
    if (!relativePath || path.isAbsolute(relativePath) || relativePath.split(path.sep).includes('..')) {
      throw new TypeError('Authoring snapshot path is unsafe.')
    }
    const source = await readFile(path.join(this.#workspaceRoot, relativePath, 'snapshot.json'), 'utf8')
    return parseSnapshot(JSON.parse(source))
  }

  async stageTaskDeletion(
    agentId: AgentId,
    taskId: DynamicAuthoringTask['id'],
  ): Promise<{ readonly source: string; readonly staged: string } | undefined> {
    assertStorageIdentity(agentId)
    assertStorageIdentity(taskId)
    const source = path.join(this.#workspaceRoot, agentId, 'authoring', taskId)
    const staged = path.join(this.#workspaceRoot, agentId, 'authoring', '.trash', `${taskId}-${randomUUID()}`)
    await mkdir(path.dirname(staged), { recursive: true, mode: 0o700 })
    try {
      await rename(source, staged)
      return { source, staged }
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? Reflect.get(error, 'code') : undefined
      if (code === 'ENOENT') return undefined
      throw error
    }
  }

  async restoreTaskDeletion(staged: { readonly source: string; readonly staged: string }): Promise<void> {
    await mkdir(path.dirname(staged.source), { recursive: true, mode: 0o700 })
    await rename(staged.staged, staged.source)
  }

  async discardTaskDeletion(staged: { readonly staged: string }): Promise<void> {
    await rm(staged.staged, { recursive: true, force: true })
  }
}

export interface RecordAuthoringDefinitionInput {
  readonly agentId: AgentId
  readonly channelId: ChannelId
  readonly episodeId: EpisodeId
  readonly initiatingEventId: ChannelEventId
  readonly approvalPolicy: AuthoringApprovalPolicy
  readonly pluginKey: string
  readonly runnerPackageId: string
  readonly snapshot: DynamicAuthoringSnapshot
}

export interface SyncAuthoringAttemptInput {
  readonly episodeId: EpisodeId
  readonly pluginKey: string
  readonly runnerPackageId: string
  readonly runnerRunId?: string
  readonly state: AuthoringAttemptState
  readonly taskStatus: AuthoringTaskStatus
  readonly host: AuthoringHalfState
  readonly client: AuthoringHalfState
  readonly error?: AuthoringAttemptFailure
  readonly verification?: DynamicAuthoringVerification
  readonly eventKind: DynamicAuthoringEvent['kind']
  readonly eventPayload?: JsonValue
}

export interface DynamicAuthoringChange {
  readonly taskId: DynamicAuthoringTask['id']
  readonly agentId: AgentId
}

export class DynamicAuthoringService {
  readonly #repository: AuthoringRepository
  readonly #artifacts: AuthoringArtifactStore
  readonly #now: () => number
  readonly #nextUlid: () => string
  readonly #listeners = new Set<(change: DynamicAuthoringChange) => void>()

  constructor(
    repository: AuthoringRepository,
    artifacts: AuthoringArtifactStore,
    options: { readonly now?: () => number; readonly nextUlid?: () => string } = {},
  ) {
    this.#repository = repository
    this.#artifacts = artifacts
    this.#now = options.now ?? Date.now
    this.#nextUlid = options.nextUlid ?? monotonicFactory()
  }

  async recordDefinition(input: RecordAuthoringDefinitionInput): Promise<{
    readonly task: DynamicAuthoringTask
    readonly attempt: DynamicAuthoringAttempt
  }> {
    const parsedSnapshot = parseSnapshot(input.snapshot)
    const existing = this.#repository.getAuthoringTaskByPlugin(input.episodeId, input.pluginKey)
    const taskId = existing?.id ?? AuthoringTaskIdSchema.parse(`aut_${this.#nextUlid()}`)
    const attempts = existing === undefined ? [] : this.#repository.listAuthoringAttempts(existing.id)
    const snapshotDigest = digest(parsedSnapshot)
    const replayedAttempt = attempts.find((attempt) => attempt.runnerPackageId === input.runnerPackageId)
    if (replayedAttempt !== undefined) {
      if (replayedAttempt.snapshotDigest !== snapshotDigest) {
        throw new Error('动态运行包身份冲突：同一 Package ID 已提交过其他内容。')
      }
      return { task: existing!, attempt: replayedAttempt }
    }
    const attemptId = AuthoringAttemptIdSchema.parse(`aua_${this.#nextUlid()}`)
    const now = this.#now()
    const riskDigest = digest({
      scope: parsedSnapshot.scope,
      host: parsedSnapshot.code.host !== undefined,
      client: parsedSnapshot.code.client !== undefined,
      permissions: parsedSnapshot.permissions,
      contributions: parsedSnapshot.contributions,
      resourceKinds: Object.keys(parsedSnapshot.resources)
        .map((value) => path.extname(value))
        .sort(),
    })
    const sourcePath = await this.#artifacts.publish(input.agentId, taskId, attemptId, parsedSnapshot)
    const attempt: DynamicAuthoringAttempt = {
      id: attemptId,
      taskId,
      ordinal: attempts.length + 1,
      name: parsedSnapshot.name,
      purpose: parsedSnapshot.purpose,
      snapshotDigest,
      riskDigest,
      sourcePath,
      state: 'drafting',
      host: parsedSnapshot.code.host === undefined ? EMPTY_HALF : { status: 'pending', waitingFor: [] },
      client: parsedSnapshot.code.client === undefined ? EMPTY_HALF : { status: 'pending', waitingFor: [] },
      runnerPluginId: input.pluginKey,
      runnerPackageId: input.runnerPackageId,
      createdAt: now,
    }
    if (existing === undefined) {
      const task: DynamicAuthoringTask = {
        id: taskId,
        agentId: AgentIdSchema.parse(input.agentId),
        channelId: input.channelId,
        episodeId: input.episodeId,
        initiatingEventId: input.initiatingEventId,
        pluginKey: input.pluginKey,
        title: parsedSnapshot.name,
        requirementSummary: parsedSnapshot.purpose,
        status: 'working',
        approvalPolicy: input.approvalPolicy,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      }
      this.#repository.createAuthoringTask({
        task,
        attempt,
        event: {
          taskId,
          sequence: 1,
          kind: 'task-created',
          attemptId,
          payload: { name: parsedSnapshot.name, purpose: parsedSnapshot.purpose },
          createdAt: now,
        },
      })
      this.#publish({ taskId, agentId: task.agentId })
      return { task, attempt }
    }
    const task: DynamicAuthoringTask = {
      ...existing,
      title: parsedSnapshot.name,
      status: 'repairing',
      revision: existing.revision + 1,
      updatedAt: now,
    }
    this.#repository.appendAuthoringAttempt({
      task,
      expectedRevision: existing.revision,
      attempt,
      event: {
        taskId,
        sequence: task.revision,
        kind: 'attempt-created',
        attemptId,
        payload: { ordinal: attempt.ordinal, name: attempt.name },
        createdAt: now,
      },
    })
    this.#publish({ taskId, agentId: task.agentId })
    return { task, attempt }
  }

  syncAttempt(input: SyncAuthoringAttemptInput): DynamicAuthoringAttempt | undefined {
    const currentTask = this.#repository.getAuthoringTaskByPlugin(input.episodeId, input.pluginKey)
    if (!currentTask) return undefined
    const currentAttempt = this.#repository
      .listAuthoringAttempts(currentTask.id)
      .find((attempt) => attempt.runnerPackageId === input.runnerPackageId)
    if (!currentAttempt) return undefined
    const approvedRiskDigest =
      currentTask.approvalPolicy === 'fully-automatic' || currentTask.approvedRiskDigest === currentAttempt.riskDigest
        ? currentAttempt.riskDigest
        : currentTask.approvedRiskDigest
    const semanticAttempt = {
      state: input.state,
      host: input.host,
      client: input.client,
      runnerRunId: input.runnerRunId,
      error: input.error,
      verification: input.verification,
    }
    const currentSemanticAttempt = {
      state: currentAttempt.state,
      host: currentAttempt.host,
      client: currentAttempt.client,
      runnerRunId: currentAttempt.runnerRunId,
      error: currentAttempt.error,
      verification: currentAttempt.verification,
    }
    if (
      currentTask.status === input.taskStatus &&
      currentTask.approvedRiskDigest === approvedRiskDigest &&
      JSON.stringify(currentSemanticAttempt) === JSON.stringify(semanticAttempt)
    ) {
      return currentAttempt
    }
    const now = this.#now()
    const task: DynamicAuthoringTask = {
      ...currentTask,
      status: input.taskStatus,
      ...(approvedRiskDigest === undefined ? {} : { approvedRiskDigest }),
      revision: currentTask.revision + 1,
      updatedAt: now,
      ...(input.taskStatus === 'completed' ? { completedAt: now } : {}),
    }
    const attempt: DynamicAuthoringAttempt = {
      ...stableAttemptFields(currentAttempt),
      state: input.state,
      host: input.host,
      client: input.client,
      ...(input.runnerRunId === undefined ? {} : { runnerRunId: input.runnerRunId }),
      ...(input.error === undefined ? {} : { error: input.error }),
      ...(input.verification === undefined ? {} : { verification: input.verification }),
      ...(['active', 'failed', 'rejected', 'stopped'].includes(input.state) ? { settledAt: now } : {}),
    }
    this.#repository.updateAuthoringAttempt({
      task,
      expectedRevision: currentTask.revision,
      attempt,
      event: {
        taskId: task.id,
        sequence: task.revision,
        kind: input.eventKind,
        attemptId: attempt.id,
        payload: input.eventPayload ?? { state: input.state },
        createdAt: now,
      },
    })
    this.#publish({ taskId: task.id, agentId: task.agentId })
    return attempt
  }

  async snapshotForRunnerPackage(
    episodeId: EpisodeId,
    pluginKey: string,
    runnerPackageId: string,
  ): Promise<DynamicAuthoringSnapshot | undefined> {
    const task = this.#repository.getAuthoringTaskByPlugin(episodeId, pluginKey)
    const attempt = task
      ? this.#repository
          .listAuthoringAttempts(task.id)
          .find((candidate) => candidate.runnerPackageId === runnerPackageId)
      : undefined
    return attempt === undefined ? undefined : this.#artifacts.read(attempt.sourcePath)
  }

  taskForRunner(episodeId: EpisodeId, pluginKey: string): DynamicAuthoringTask | undefined {
    return this.#repository.getAuthoringTaskByPlugin(episodeId, pluginKey)
  }

  getTask(taskId: DynamicAuthoringTask['id']): DynamicAuthoringTask | undefined {
    return this.#repository.getAuthoringTask(taskId)
  }

  subscribe(listener: (change: DynamicAuthoringChange) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async recoveryCandidates(episodeId: EpisodeId): Promise<
    readonly {
      readonly task: DynamicAuthoringTask
      readonly attempt: DynamicAuthoringAttempt
      readonly snapshot: DynamicAuthoringSnapshot
      readonly shouldRun: boolean
    }[]
  > {
    const candidates = this.#repository.listRecoverableAuthoringTasks().filter((task) => task.episodeId === episodeId)
    const result = [] as Array<{
      task: DynamicAuthoringTask
      attempt: DynamicAuthoringAttempt
      snapshot: DynamicAuthoringSnapshot
      shouldRun: boolean
    }>
    for (const task of candidates) {
      const attempt = this.#repository.listAuthoringAttempts(task.id).at(-1)
      if (!attempt) {
        this.interruptTask(task, '恢复时没有找到任何候选记录。')
        continue
      }
      try {
        result.push({
          task,
          attempt,
          snapshot: await this.#artifacts.read(attempt.sourcePath),
          shouldRun: ['awaiting-approval', 'running', 'ready'].includes(task.status),
        })
      } catch (error) {
        this.interruptTask(task, error instanceof Error ? error.message : String(error), attempt.id)
      }
    }
    return result
  }

  rebindRecoveredAttempt(input: {
    readonly task: DynamicAuthoringTask
    readonly attempt: DynamicAuthoringAttempt
    readonly pluginKey: string
    readonly runnerPackageId: string
    readonly shouldRun: boolean
  }): void {
    const current = this.#repository.getAuthoringTask(input.task.id)
    const currentAttempt = this.#repository.getAuthoringAttempt(input.attempt.id)
    if (!current || !currentAttempt || currentAttempt.taskId !== current.id) return
    const now = this.#now()
    this.#repository.updateAuthoringAttempt({
      task: {
        ...current,
        pluginKey: input.pluginKey,
        status: input.shouldRun ? 'running' : 'repairing',
        revision: current.revision + 1,
        updatedAt: now,
      },
      expectedRevision: current.revision,
      attempt: {
        ...stableAttemptFields(currentAttempt),
        state: 'drafting',
        host: input.attempt.host.status === 'absent' ? EMPTY_HALF : { status: 'pending', waitingFor: [] },
        client: input.attempt.client.status === 'absent' ? EMPTY_HALF : { status: 'pending', waitingFor: [] },
        runnerPluginId: input.pluginKey,
        runnerPackageId: input.runnerPackageId,
      },
      event: {
        taskId: current.id,
        sequence: current.revision + 1,
        kind: 'phase-changed',
        attemptId: currentAttempt.id,
        payload: { phase: 'restore-defined', shouldRun: input.shouldRun },
        createdAt: now,
      },
    })
    this.#publish({ taskId: current.id, agentId: current.agentId })
  }

  interruptTask(task: DynamicAuthoringTask, message: string, attemptId?: AuthoringAttemptId): void {
    const current = this.#repository.getAuthoringTask(task.id)
    if (!current || ['interrupted', 'stopped', 'completed'].includes(current.status)) return
    const now = this.#now()
    this.#repository.updateAuthoringTask({
      task: { ...current, status: 'interrupted', revision: current.revision + 1, updatedAt: now },
      expectedRevision: current.revision,
      event: {
        taskId: current.id,
        sequence: current.revision + 1,
        kind: 'task-interrupted',
        ...(attemptId === undefined ? {} : { attemptId }),
        payload: { message },
        createdAt: now,
      },
    })
    this.#publish({ taskId: current.id, agentId: current.agentId })
  }

  async deleteTask(taskId: DynamicAuthoringTask['id']): Promise<boolean> {
    const task = this.#repository.getAuthoringTask(taskId)
    if (!task) return false
    const staged = await this.#artifacts.stageTaskDeletion(task.agentId, task.id)
    try {
      this.#repository.deleteAuthoringTask(task.id)
    } catch (error) {
      if (staged) await this.#artifacts.restoreTaskDeletion(staged)
      throw error
    }
    this.#publish({ taskId: task.id, agentId: task.agentId })
    if (staged) await this.#artifacts.discardTaskDeletion(staged).catch(() => undefined)
    return true
  }

  #publish(change: DynamicAuthoringChange): void {
    for (const listener of this.#listeners) {
      try {
        listener(change)
      } catch {
        // Observers cannot roll back a Repository mutation that has already committed.
      }
    }
  }
}
