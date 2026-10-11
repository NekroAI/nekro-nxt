import { z } from 'zod'
import { AgentIdSchema, ChannelIdSchema, LogicalMessageIdSchema } from './domain.js'
import {
  CommunityFeedbackCreateSchema,
  CommunityFeedbackDiagnosticsSchema,
  CommunityFeedbackExcerptSchema,
  CommunityFeedbackKindSchema,
  CommunityFeedbackRefSchema,
  CommunityFeedbackStatusSchema,
  CommunityFeedbackTargetSchema,
} from './community-feedback.js'

export const CommunityFeedbackDraftIdSchema = z
  .string()
  .regex(/^fbd_[0-9A-Za-z]+$/u)
  .brand<'CommunityFeedbackDraftId'>()
export type CommunityFeedbackDraftId = z.output<typeof CommunityFeedbackDraftIdSchema>
export const CommunityFeedbackDraftStateSchema = z.enum(['awaiting', 'sending', 'sent', 'failed', 'discarded'])
export const CommunityFeedbackDraftSchema = z
  .object({
    id: CommunityFeedbackDraftIdSchema,
    communityUrl: z.string().url(),
    communityUserId: z.string().min(1).nullable(),
    agentId: AgentIdSchema.nullable(),
    channelId: ChannelIdSchema.nullable(),
    kind: CommunityFeedbackKindSchema,
    target: CommunityFeedbackTargetSchema,
    title: z.string().max(120),
    body: z.string().max(8000),
    excerpt: CommunityFeedbackExcerptSchema.nullable(),
    excerptSharedWithAuthor: z.boolean(),
    diagnostics: CommunityFeedbackDiagnosticsSchema,
    state: CommunityFeedbackDraftStateSchema,
    requestedBy: z.string(),
    auto: z.boolean(),
    error: z.string().nullable(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict()
export type CommunityFeedbackDraft = z.output<typeof CommunityFeedbackDraftSchema>

export const CommunityFeedbackItemSchema = z
  .object({
    ref: CommunityFeedbackRefSchema,
    communityUrl: z.string().url(),
    communityUserId: z.string().min(1),
    channelId: ChannelIdSchema.nullable(),
    draftId: CommunityFeedbackDraftIdSchema.nullable(),
    title: z.string(),
    kind: CommunityFeedbackKindSchema.nullable(),
    target: CommunityFeedbackTargetSchema.nullable(),
    status: CommunityFeedbackStatusSchema,
    fixedIn: z.string().nullable(),
    unread: z.boolean(),
    lastEventSeq: z.number().int().nonnegative(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict()
export type CommunityFeedbackItem = z.output<typeof CommunityFeedbackItemSchema>

export const CommunityFeedbackDraftInputSchema = z
  .object({
    kind: CommunityFeedbackKindSchema,
    target: CommunityFeedbackTargetSchema,
    title: z.string().trim().min(1).max(120),
    body: z.string().trim().min(1).max(8000),
    conversationRefs: z.array(LogicalMessageIdSchema).max(8).optional(),
  })
  .strict()
export type CommunityFeedbackDraftInput = z.output<typeof CommunityFeedbackDraftInputSchema>
export const CommunityFeedbackDraftUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    body: z.string().trim().min(1).max(8000),
    includeExcerpt: z.boolean(),
    excerptSharedWithAuthor: z.boolean().default(false),
    expectedUpdatedAt: z.number().int().nonnegative(),
  })
  .strict()
export const CommunityFeedbackSettingsSchema = z
  .object({
    enabled: z.boolean(),
    supported: z.boolean(),
    signedIn: z.boolean(),
    communityUrl: z.string().url(),
    communityUserId: z.string().nullable(),
    consentedAt: z.number().int().nonnegative().nullable(),
  })
  .strict()
export type CommunityFeedbackSettings = z.output<typeof CommunityFeedbackSettingsSchema>
export const CommunityFeedbackSettingsUpdateSchema = z
  .object({ enabled: z.boolean(), consent: z.boolean().default(false) })
  .strict()
export const CommunityFeedbackSnapshotSchema = z
  .object({
    enabled: z.boolean(),
    signedIn: z.boolean(),
    pendingDrafts: z.number().int().nonnegative(),
    unread: z.number().int().nonnegative(),
  })
  .strict()
export const CommunityFeedbackLocalListSchema = z
  .object({ drafts: z.array(CommunityFeedbackDraftSchema), items: z.array(CommunityFeedbackItemSchema) })
  .strict()
export const CommunityFeedbackPayloadSchema = z
  .object({ payload: CommunityFeedbackCreateSchema, redactions: z.array(z.string()) })
  .strict()
export const CommunityFeedbackLastPayloadSchema = z
  .object({
    ref: CommunityFeedbackRefSchema,
    sentAt: z.number().int().nonnegative(),
    payload: CommunityFeedbackCreateSchema,
  })
  .strict()
  .nullable()
