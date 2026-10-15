import { z } from 'zod'

/** Log summaries are labels; leave structured diagnostics and stacks untouched. */
export function formatLogMessage(message: string): string {
  return message.trimEnd().replace(/[。.]$/u, '')
}

export const hostLogLevelSchema = z.enum(['debug', 'info', 'warn', 'error'])
export type HostLogLevel = z.infer<typeof hostLogLevelSchema>
/** Write-only, owner-bound SDK capability. No caller-supplied identity fields. */
export interface NxtLogger {
  debug(message: string, details?: unknown): void
  info(message: string, details?: unknown): void
  warn(message: string, details?: unknown): void
  error(message: string, details?: unknown): void
}
export const hostLogSourceKindSchema = z.enum(['system', 'dsh-plugin', 'extension', 'connection', 'unknown'])
export type HostLogSourceKind = z.infer<typeof hostLogSourceKindSchema>
export const hostLogSourceSchema = z
  .object({
    kind: hostLogSourceKindSchema,
    id: z.string().min(1).max(512),
    name: z.string().min(1).max(512),
    version: z.string().max(512).optional(),
    component: z.string().max(512).optional(),
  })
  .strict()
export type HostLogSource = z.infer<typeof hostLogSourceSchema>
export const hostLogScopeSchema = z
  .object({
    extensionId: z.string().max(512).optional(),
    revisionId: z.string().max(512).optional(),
    connectionId: z.string().max(512).optional(),
    agentId: z.string().max(512).optional(),
    channelId: z.string().max(512).optional(),
    sessionId: z.string().max(512).optional(),
    episodeId: z.string().max(512).optional(),
    operationId: z.string().max(512).optional(),
  })
  .strict()
export type HostLogScope = z.infer<typeof hostLogScopeSchema>
export const hostLogEntrySchema = z
  .object({
    id: z.string(),
    sequence: z.number().int().nonnegative(),
    timestamp: z.iso.datetime(),
    runId: z.string(),
    level: hostLogLevelSchema,
    message: z.string(),
    source: hostLogSourceSchema,
    scope: hostLogScopeSchema.optional(),
    details: z.json().optional(),
    code: z.string().optional(),
    redacted: z.boolean(),
    truncated: z.boolean(),
  })
  .strict()
export type HostLogEntry = z.infer<typeof hostLogEntrySchema>
export interface HostLogInput {
  formatArgs?: readonly unknown[]
  level: HostLogLevel
  message: string
  source: HostLogSource
  scope?: HostLogScope
  details?: unknown
  code?: string
}
export const hostLogQuerySchema = z
  .object({
    levels: z.array(hostLogLevelSchema).max(4).optional(),
    sourceKinds: z.array(hostLogSourceKindSchema).max(5).optional(),
    sourceIds: z.array(z.string().max(512)).max(100).optional(),
    sources: z
      .array(hostLogSourceSchema.pick({ kind: true, id: true }))
      .max(100)
      .optional(),
    scope: hostLogScopeSchema.optional(),
    keyword: z.string().max(1000).optional(),
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
    olderCursor: z.string().max(128).optional(),
    afterCursor: z.string().max(128).optional(),
    headCursor: z.string().max(128).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict()
export type HostLogQuery = z.infer<typeof hostLogQuerySchema>
export const hostLogPageSchema = z
  .object({
    entries: z.array(hostLogEntrySchema),
    olderCursor: z.string().nullable(),
    headCursor: z.string(),
    hasMore: z.boolean(),
    gap: z.enum(['expired', 'reset']).optional(),
  })
  .strict()
export type HostLogPage = z.infer<typeof hostLogPageSchema>
export const hostLogSettingsSchema = z
  .object({
    retentionDays: z.number().int().min(1).max(30),
    maxSizeMiB: z.number().int().min(64).max(2048),
    revision: z.number().int().nonnegative(),
  })
  .strict()
export type HostLogSettings = z.infer<typeof hostLogSettingsSchema>
export const hostLogSettingsUpdateSchema = hostLogSettingsSchema
export const hostLogDebugRequestSchema = z
  .object({
    source: hostLogSourceSchema.pick({ kind: true, id: true }).optional(),
    durationMinutes: z.union([z.literal(5), z.literal(15), z.literal(30)]).default(15),
  })
  .strict()
export type HostLogDebugRequest = z.infer<typeof hostLogDebugRequestSchema>
export const hostLogDebugLeaseSchema = hostLogDebugRequestSchema.extend({ id: z.string(), expiresAt: z.iso.datetime() })
export type HostLogDebugLease = z.infer<typeof hostLogDebugLeaseSchema>
export const hostLogStatusSchema = z
  .object({
    state: z.enum(['ready', 'degraded', 'closed']),
    runId: z.string(),
    headCursor: z.string(),
    bytes: z.number().nonnegative(),
    count: z.number().int().nonnegative(),
    oldestTimestamp: z.iso.datetime().nullable(),
    newestTimestamp: z.iso.datetime().nullable(),
    queuedBytes: z.number().nonnegative(),
    droppedCount: z.number().int().nonnegative(),
    debugLeases: z.array(hostLogDebugLeaseSchema),
    error: z.string().optional(),
  })
  .strict()
export type HostLogStatus = z.infer<typeof hostLogStatusSchema>
export const hostLogStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('entries'), entries: z.array(hostLogEntrySchema), cursor: z.string() }),
  z.object({ type: z.literal('gap'), reason: z.enum(['expired', 'reset', 'overflow']), cursor: z.string() }),
  z.object({ type: z.literal('status'), status: hostLogStatusSchema }),
])
export type HostLogStreamEvent = z.infer<typeof hostLogStreamEventSchema>
export type HostLogExportFormat = 'text' | 'jsonl'
