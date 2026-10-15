import { z } from 'zod'

export const COMMUNITY_FEEDBACK_STATUSES = [
  'new',
  'needs_info',
  'triaged',
  'planned',
  'fixed',
  'duplicate',
  'wontfix',
  'withdrawn',
] as const
export const CommunityFeedbackStatusSchema = z.enum(COMMUNITY_FEEDBACK_STATUSES)
export type CommunityFeedbackStatus = z.output<typeof CommunityFeedbackStatusSchema>
export const COMMUNITY_FEEDBACK_STATUS_LABELS: Readonly<Record<CommunityFeedbackStatus, string>> = {
  new: '新反馈',
  needs_info: '需要补充',
  triaged: '已确认',
  planned: '已计划',
  fixed: '已修复',
  duplicate: '重复',
  wontfix: '不处理',
  withdrawn: '已撤回',
}
export const CommunityFeedbackKindSchema = z.enum(['bug', 'suggestion', 'question'])
export const CommunityFeedbackIdSchema = z
  .string()
  .regex(/^fbk_[0-9a-z]{26}$/u)
  .brand<'CommunityFeedbackId'>()
export const CommunityFeedbackRefSchema = z.string().regex(/^FB-[1-9][0-9]*$/u)
export const CommunityFeedbackTargetSchema = z.union([
  z.literal('nxt'),
  z.object({ extensionId: z.string().regex(/^ext_[0-9A-Za-z]+$/u), version: z.string().max(120).optional() }).strict(),
])
const version = z.string().trim().min(1).max(120)
const timestamp = z.number().int().nonnegative()

export const CommunityFeedbackExtensionDiagnosticSchema = z
  .object({
    extensionId: z.string().max(100),
    version,
    accessLevel: z.string().max(80).optional(),
    activation: z.enum(['host', 'agent']).optional(),
  })
  .strict()
export const CommunityFeedbackDiagnosticEntrySchema = z
  .object({
    kind: z.enum(['compatibility', 'extension', 'connection']),
    summary: z.string().max(2000),
    extensionId: z.string().max(100).optional(),
  })
  .strict()

/** An explicit allowlist: credentials, account grants and arbitrary host configuration never cross this boundary. */
export const CommunityFeedbackDiagnosticsSchema = z
  .object({
    nxtVersion: version.optional(),
    releaseChannel: z.enum(['stable', 'preview', 'development']).optional(),
    hostKind: z.enum(['desktop', 'server']).optional(),
    platform: z.string().max(80).optional(),
    arch: z.string().max(40).optional(),
    dshVersion: version.optional(),
    adapters: z.array(z.string().max(100)).max(64).optional(),
    agent: z
      .object({
        accessLevel: z.string().max(80),
        subagents: z.boolean(),
        fileTools: z.boolean(),
        webSearch: z.boolean(),
        dynamicCreation: z.boolean(),
        developmentShell: z.boolean(),
        unrestrictedFileAccess: z.boolean(),
        scheduledTasks: z.boolean(),
        codeRun: z.boolean(),
        commandNetwork: z.boolean(),
        communityFeedbackAuto: z.boolean(),
      })
      .strict()
      .optional(),
    extensions: z.array(CommunityFeedbackExtensionDiagnosticSchema).max(256).optional(),
    entries: z.array(CommunityFeedbackDiagnosticEntrySchema).max(32).optional(),
    instanceId: z.string().min(1).max(100).optional(),
  })
  .strict()
export type CommunityFeedbackDiagnostics = z.output<typeof CommunityFeedbackDiagnosticsSchema>

export const CommunityFeedbackExcerptSchema = z
  .array(
    z
      .object({
        speaker: z.string().max(80),
        text: z.string().max(6000),
      })
      .strict(),
  )
  .max(8)
export type CommunityFeedbackExcerpt = z.output<typeof CommunityFeedbackExcerptSchema>

export const CommunityFeedbackCreateSchema = z
  .object({
    clientRequestId: z.string().min(1).max(160),
    kind: CommunityFeedbackKindSchema,
    target: CommunityFeedbackTargetSchema,
    title: z.string().trim().min(1).max(120),
    body: z.string().trim().min(1).max(8000),
    diagnostics: CommunityFeedbackDiagnosticsSchema.default({}),
    excerpt: CommunityFeedbackExcerptSchema.optional(),
    excerptSharedWithAuthor: z.boolean().default(false),
    source: z.enum(['assistant', 'assistant_auto', 'form', 'web']),
    instanceId: z.string().min(1).max(100).optional(),
  })
  .strict()
export type CommunityFeedbackCreate = z.output<typeof CommunityFeedbackCreateSchema>
export const CommunityFeedbackMessageInputSchema = z
  .object({
    body: z.string().trim().min(1).max(4000),
    audience: z.enum(['everyone', 'staff']).default('everyone'),
  })
  .strict()
export const CommunityFeedbackSupplementSchema = z
  .object({
    diagnostics: CommunityFeedbackDiagnosticsSchema.optional(),
    excerpt: CommunityFeedbackExcerptSchema.optional(),
    excerptSharedWithAuthor: z.boolean().optional(),
  })
  .strict()
export const CommunityFeedbackWithdrawSchema = z.object({ deleteText: z.boolean().default(false) }).strict()
export const CommunityFeedbackConfirmSchema = z.object({ clientVersion: version }).strict()
export const CommunityFeedbackReopenSchema = z.object({ note: z.string().trim().min(1).max(2000) }).strict()
export const CommunityFeedbackAffectedSchema = z
  .object({
    diagnostics: CommunityFeedbackDiagnosticsSchema.optional(),
    nxtVersion: version.optional(),
  })
  .strict()
export const CommunityFeedbackTransitionSchema = z
  .object({
    status: CommunityFeedbackStatusSchema,
    fixedIn: version.optional(),
    duplicateOf: CommunityFeedbackRefSchema.optional(),
    note: z.string().trim().max(2000).optional(),
  })
  .strict()
export type CommunityFeedbackTransition = z.output<typeof CommunityFeedbackTransitionSchema>
export const CommunityFeedbackLabelsSchema = z
  .object({
    labels: z.array(z.string().trim().min(1).max(40)).max(20),
    priority: z.enum(['low', 'normal', 'high']).nullable(),
  })
  .strict()
export const CommunityFeedbackLinkSchema = z
  .object({
    githubUrl: z
      .string()
      .url()
      .max(1000)
      .refine((value) => /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/[1-9][0-9]*$/u.test(value))
      .nullable(),
  })
  .strict()
export const CommunityFeedbackVisibilitySchema = z.object({ visibility: z.enum(['private', 'public']) }).strict()

export const CommunityFeedbackEventDataSchema = z
  .object({
    from: CommunityFeedbackStatusSchema.optional(),
    to: CommunityFeedbackStatusSchema.optional(),
    fixedIn: version.nullable().optional(),
    duplicateOf: CommunityFeedbackRefSchema.nullable().optional(),
    note: z.string().max(2000).optional(),
    labels: z.array(z.string()).optional(),
    priority: z.enum(['low', 'normal', 'high']).nullable().optional(),
    visibility: z.enum(['private', 'public']).optional(),
    clientVersion: version.optional(),
    messageId: z.string().optional(),
    audience: z.enum(['everyone', 'staff']).optional(),
    deleteText: z.boolean().optional(),
    affected: z.boolean().optional(),
  })
  .strict()
export const CommunityFeedbackEventSchema = z.object({
  seq: z.number().int().positive(),
  ref: CommunityFeedbackRefSchema,
  type: z.enum([
    'created',
    'message',
    'status_changed',
    'labeled',
    'priority_changed',
    'linked_issue',
    'duplicate_marked',
    'fixed_in_set',
    'visibility_changed',
    'affected_added',
    'withdrawn',
    'reopened',
    'supplemented',
    'fix_confirmed',
  ]),
  actorKind: z.enum(['user', 'admin', 'author', 'token', 'system']).optional(),
  actor: z.string().optional(),
  tokenId: z.string().optional(),
  data: CommunityFeedbackEventDataSchema,
  createdAt: timestamp,
  title: z.string().optional(),
  status: CommunityFeedbackStatusSchema.optional(),
})
export type CommunityFeedbackEvent = z.output<typeof CommunityFeedbackEventSchema>
export const CommunityFeedbackMessageSchema = z.object({
  id: z.string(),
  authorKind: z.enum(['user', 'admin', 'author', 'system']),
  author: z.string().nullable(),
  audience: z.enum(['everyone', 'staff']),
  body: z.string(),
  createdAt: timestamp,
})

export const CommunityFeedbackSummarySchema = z.object({
  id: CommunityFeedbackIdSchema,
  ref: CommunityFeedbackRefSchema,
  title: z.string(),
  kind: CommunityFeedbackKindSchema.optional(),
  target: CommunityFeedbackTargetSchema.optional(),
  status: CommunityFeedbackStatusSchema,
  fixedIn: version.nullable(),
  affectedCount: z.number().int().nonnegative(),
  source: CommunityFeedbackCreateSchema.shape.source.optional(),
  confirmedCount: z.number().int().nonnegative().optional(),
  createdAt: timestamp.optional(),
  updatedAt: timestamp.optional(),
})
export type CommunityFeedbackSummary = z.output<typeof CommunityFeedbackSummarySchema>

/** Optional private fields are emitted only by the server's role-specific projection. */
export const CommunityFeedbackSchema = CommunityFeedbackSummarySchema.extend({
  access: z.enum(['owner', 'admin', 'author', 'subscriber', 'public']),
  body: z.string().optional(),
  diagnostics: CommunityFeedbackDiagnosticsSchema.optional(),
  excerpt: CommunityFeedbackExcerptSchema.nullable().optional(),
  excerptSharedWithAuthor: z.boolean().optional(),
  messages: z.array(CommunityFeedbackMessageSchema).optional(),
  events: z.array(CommunityFeedbackEventSchema).optional(),
  submitter: z.string().optional(),
  instanceId: z.string().nullable().optional(),
  priority: z.enum(['low', 'normal', 'high']).nullable().optional(),
  labels: z.array(z.string()).optional(),
  visibility: z.enum(['private', 'public']).optional(),
  duplicateOf: CommunityFeedbackRefSchema.nullable().optional(),
  githubUrl: z.string().nullable().optional(),
  closedAt: timestamp.nullable().optional(),
  purgedAt: timestamp.nullable().optional(),
  confirmed: z.boolean().default(false),
  affected: z.boolean().default(false),
  affectedDiagnostics: z
    .array(
      z.object({
        user: z.string(),
        diagnostics: CommunityFeedbackDiagnosticsSchema.nullable(),
        nxtVersion: version.nullable(),
        createdAt: timestamp,
      }),
    )
    .optional(),
})
export type CommunityFeedback = z.output<typeof CommunityFeedbackSchema>
export const CommunityFeedbackListSchema = z.object({
  items: z.array(CommunityFeedbackSummarySchema),
  cursor: z.string().nullable(),
})
export const CommunityFeedbackChangesSchema = z.object({
  events: z.array(CommunityFeedbackEventSchema),
  cursor: z.number().int().nonnegative(),
  hasMore: z.boolean(),
})
export type CommunityFeedbackChanges = z.output<typeof CommunityFeedbackChangesSchema>
export const CommunityFeedbackDigestSchema = z.object({
  since: timestamp,
  counts: z.object({
    status: z.record(CommunityFeedbackStatusSchema, z.number().int().nonnegative()),
    kind: z.record(CommunityFeedbackKindSchema, z.number().int().nonnegative()),
    target: z.record(z.enum(['nxt', 'extension']), z.number().int().nonnegative()),
    extensions: z.record(z.string(), z.number().int().nonnegative()),
  }),
  newItems: z.array(CommunityFeedbackSummarySchema),
  awaitingReply: z.array(CommunityFeedbackSummarySchema),
  mostAffected: z.array(CommunityFeedbackSummarySchema),
  unconfirmedFixes: z.array(CommunityFeedbackSummarySchema),
  fixedCount: z.number().int().nonnegative(),
})
export type CommunityFeedbackDigest = z.output<typeof CommunityFeedbackDigestSchema>
