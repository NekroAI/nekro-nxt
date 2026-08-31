import {
  AgentClientSlotNameSchema,
  AuthoringAttemptIdSchema,
  AuthoringTaskIdSchema,
  HostPageContributionSchema,
  HostUiKitComponentNameSchema,
  HostUiPageGeometryEvidenceSchema,
  JsonValueSchema,
} from '@nekro-nxt/contracts'
import type {
  AgentClientSlotName,
  AgentId,
  AuthoringAttemptId,
  AuthoringTaskId,
  ChannelEventId,
  ChannelId,
  EpisodeId,
  HostPageContribution,
  HostUiKitComponentName,
  HostUiPageGeometryEvidence,
  HostUiPermissionDeclaration,
  JsonValue,
} from '@nekro-nxt/contracts'
import { z } from 'zod'

export type AuthoringTaskStatus =
  | 'working'
  | 'awaiting-approval'
  | 'running'
  | 'ready'
  | 'repairing'
  | 'failed'
  | 'interrupted'
  | 'stopped'
  | 'completed'

export type AuthoringApprovalPolicy = 'risk-stable' | 'fully-automatic'

export type AuthoringAttemptState =
  | 'drafting'
  | 'preflight-failed'
  | 'awaiting-approval'
  | 'starting-host'
  | 'loading-client'
  | 'verifying'
  | 'active'
  | 'failed'
  | 'rejected'
  | 'stopped'

export interface AuthoringHalfState {
  readonly status: 'absent' | 'pending' | 'stopped' | 'running' | 'waiting' | 'failed'
  readonly waitingFor: readonly string[]
  readonly error?: string
}

export interface AuthoringAttemptFailure {
  readonly phase:
    | 'preflight'
    | 'approval'
    | 'host-load'
    | 'host-apply'
    | 'client-load'
    | 'client-apply'
    | 'client-render'
    | 'verification'
    | 'settlement'
    | 'restore'
  readonly message: string
  readonly stack?: string
  readonly repairable: boolean
}

export interface DynamicAuthoringVerification {
  readonly hostStarted: boolean
  readonly clientLoaded: boolean
  readonly renderedSlots: readonly AgentClientSlotName[]
  readonly renderedPages: readonly HostPageContribution[]
  readonly usedUiComponents: readonly HostUiKitComponentName[]
  readonly pageGeometry: readonly HostUiPageGeometryEvidence[]
  readonly rpcCalls: readonly string[]
  readonly toolInvocations: readonly { readonly name: string; readonly succeeded: boolean }[]
  readonly navigationChecks: readonly string[]
  readonly resourceChecks: readonly string[]
  readonly stoppedCleanly: boolean
}

export interface DynamicAuthoringTask {
  readonly id: AuthoringTaskId
  readonly agentId: AgentId
  readonly channelId: ChannelId
  readonly episodeId: EpisodeId
  readonly initiatingEventId: ChannelEventId
  readonly pluginKey: string
  readonly title: string
  readonly requirementSummary: string
  readonly status: AuthoringTaskStatus
  readonly approvalPolicy: AuthoringApprovalPolicy
  readonly approvedRiskDigest?: string
  readonly revision: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly completedAt?: number
}

export interface DynamicAuthoringAttempt {
  readonly id: AuthoringAttemptId
  readonly taskId: AuthoringTaskId
  readonly ordinal: number
  readonly name: string
  readonly purpose: string
  readonly snapshotDigest: string
  readonly riskDigest: string
  readonly sourcePath: string
  readonly state: AuthoringAttemptState
  readonly host: AuthoringHalfState
  readonly client: AuthoringHalfState
  readonly error?: AuthoringAttemptFailure
  readonly verification?: DynamicAuthoringVerification
  readonly runnerPluginId?: string
  readonly runnerPackageId?: string
  readonly runnerRunId?: string
  readonly createdAt: number
  readonly settledAt?: number
}

export interface DynamicAuthoringEvent {
  readonly taskId: AuthoringTaskId
  readonly sequence: number
  readonly kind:
    | 'task-created'
    | 'attempt-created'
    | 'preflight-failed'
    | 'approval-requested'
    | 'approval-accepted'
    | 'approval-rejected'
    | 'phase-changed'
    | 'verification-completed'
    | 'attempt-failed'
    | 'task-interrupted'
    | 'task-stopped'
    | 'task-completed'
  readonly attemptId?: AuthoringAttemptId
  readonly payload: JsonValue
  readonly createdAt: number
}

export interface AuthoringRepository {
  listAuthoringTasks(agentId?: AgentId): readonly DynamicAuthoringTask[]
  listRecoverableAuthoringTasks(): readonly DynamicAuthoringTask[]
  getAuthoringTask(id: AuthoringTaskId): DynamicAuthoringTask | undefined
  getAuthoringTaskByPlugin(episodeId: EpisodeId, pluginKey: string): DynamicAuthoringTask | undefined
  listAuthoringAttempts(taskId: AuthoringTaskId): readonly DynamicAuthoringAttempt[]
  getAuthoringAttempt(id: AuthoringAttemptId): DynamicAuthoringAttempt | undefined
  listAuthoringEvents(taskId: AuthoringTaskId): readonly DynamicAuthoringEvent[]
  createAuthoringTask(input: {
    readonly task: DynamicAuthoringTask
    readonly attempt: DynamicAuthoringAttempt
    readonly event: DynamicAuthoringEvent
  }): void
  appendAuthoringAttempt(input: {
    readonly task: DynamicAuthoringTask
    readonly expectedRevision: number
    readonly attempt: DynamicAuthoringAttempt
    readonly event: DynamicAuthoringEvent
  }): void
  updateAuthoringAttempt(input: {
    readonly task: DynamicAuthoringTask
    readonly expectedRevision: number
    readonly attempt: DynamicAuthoringAttempt
    readonly event: DynamicAuthoringEvent
  }): void
  updateAuthoringTask(input: {
    readonly task: DynamicAuthoringTask
    readonly expectedRevision: number
    readonly event: DynamicAuthoringEvent
  }): void
  deleteAuthoringTask(id: AuthoringTaskId): void
}

export interface DynamicAuthoringSnapshot {
  readonly name: string
  readonly purpose: string
  readonly scope: 'agent' | 'host-adapter' | 'host-ui'
  readonly code: { readonly host?: string; readonly client?: string }
  readonly resources: Readonly<Record<string, string>>
  readonly clientCss?: { readonly path: string; readonly sha256: string }
  readonly permissions: HostUiPermissionDeclaration
  readonly contributions: readonly JsonValue[]
}

export const AuthoringHalfStateSchema = z
  .object({
    status: z.enum(['absent', 'pending', 'stopped', 'running', 'waiting', 'failed']),
    waitingFor: z.array(z.string()),
    error: z.string().optional(),
  })
  .strict()

export const AuthoringAttemptFailureSchema = z
  .object({
    phase: z.enum([
      'preflight',
      'approval',
      'host-load',
      'host-apply',
      'client-load',
      'client-apply',
      'client-render',
      'verification',
      'settlement',
      'restore',
    ]),
    message: z.string(),
    stack: z.string().optional(),
    repairable: z.boolean(),
  })
  .strict()

export const DynamicAuthoringVerificationSchema = z
  .object({
    hostStarted: z.boolean(),
    clientLoaded: z.boolean(),
    renderedSlots: z.array(AgentClientSlotNameSchema),
    renderedPages: z.array(HostPageContributionSchema),
    usedUiComponents: z.array(HostUiKitComponentNameSchema).default([]),
    pageGeometry: z.array(HostUiPageGeometryEvidenceSchema).default([]),
    rpcCalls: z.array(z.string()),
    toolInvocations: z.array(z.object({ name: z.string(), succeeded: z.boolean() }).strict()),
    navigationChecks: z.array(z.string()),
    resourceChecks: z.array(z.string()),
    stoppedCleanly: z.boolean(),
  })
  .strict()

export const DynamicAuthoringEventSchema = z
  .object({
    taskId: AuthoringTaskIdSchema,
    sequence: z.number().int().positive(),
    kind: z.enum([
      'task-created',
      'attempt-created',
      'preflight-failed',
      'approval-requested',
      'approval-accepted',
      'approval-rejected',
      'phase-changed',
      'verification-completed',
      'attempt-failed',
      'task-interrupted',
      'task-stopped',
      'task-completed',
    ]),
    attemptId: AuthoringAttemptIdSchema.optional(),
    payload: JsonValueSchema,
    createdAt: z.number().int().nonnegative(),
  })
  .strict()
