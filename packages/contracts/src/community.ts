import { z } from 'zod'
import { ExtensionIdSchema } from './domain.js'

/**
 * NekroNXT 社区在本机的投影。Host 代理社区开放接口并把结果归一到这些结构；社区新增的字段在 Host 处丢弃，
 * 不直接透传给页面。审查状态与社区 `ReviewStatus` 一致。
 */
export const COMMUNITY_REVIEW_STATUSES = [
  'pending',
  'reviewing',
  'passed',
  'passed_with_notes',
  'flagged',
  'held',
  'risk_confirmed',
  'rejected',
  'incomplete',
] as const
export const CommunityReviewStatusSchema = z.enum(COMMUNITY_REVIEW_STATUSES)
export type CommunityReviewStatus = z.output<typeof CommunityReviewStatusSchema>

export const CommunityGradeSchema = z.enum(['A', 'B', 'C', 'D'])

export const CommunityReleaseIdSchema = z.string().regex(/^rel_[0-9A-Za-z]+$/u)

export const CommunityAccountSchema = z
  .object({
    handle: z.string().min(1).max(80),
    displayName: z.string().max(200),
    avatarUrl: z.string().url().nullable(),
  })
  .strict()
export type CommunityAccount = z.output<typeof CommunityAccountSchema>

export const CommunityStatusSchema = z
  .object({
    communityUrl: z.string().url(),
    account: CommunityAccountSchema.nullable(),
    signedInAt: z.number().int().nullable(),
  })
  .strict()
export type CommunityStatus = z.output<typeof CommunityStatusSchema>

export const CommunityPermissionItemSchema = z
  .object({
    key: z.string().max(120),
    level: z.enum(['normal', 'elevated', 'high']),
    label: z.string().max(200),
    detail: z.string().max(2000).optional(),
  })
  .strict()

export const CommunityReleaseSchema = z
  .object({
    id: CommunityReleaseIdSchema,
    number: z.number().int().positive(),
    reviewStatus: CommunityReviewStatusSchema,
    grade: CommunityGradeSchema.nullable(),
    permissions: z.array(CommunityPermissionItemSchema).max(64),
    packageSize: z.number().int().nonnegative(),
    requiresSdk: z.number().int().positive().nullable(),
    notes: z.string().max(2000),
    createdAt: z.number().int(),
  })
  .strict()
export type CommunityRelease = z.output<typeof CommunityReleaseSchema>

export const CommunityExtensionSummarySchema = z
  .object({
    id: ExtensionIdSchema,
    scope: z.enum(['agent', 'host-adapter', 'host-ui']),
    displayName: z.string().max(200),
    summary: z.string().max(1000),
    tags: z.array(z.string().max(40)).max(16),
    publisher: CommunityAccountSchema,
    latest: CommunityReleaseSchema.nullable(),
    downloads: z.number().int().nonnegative(),
    updatedAt: z.number().int(),
    pageUrl: z.string().url(),
  })
  .strict()
export type CommunityExtensionSummary = z.output<typeof CommunityExtensionSummarySchema>

export const CommunityExtensionDetailSchema = CommunityExtensionSummarySchema.extend({
  description: z.string().max(20_000),
  sourceUrl: z.string().url().nullable(),
  review: z
    .object({
      status: CommunityReviewStatusSchema,
      grade: CommunityGradeSchema.nullable(),
      summary: z.string().max(2000).nullable(),
      highlights: z.array(z.object({ severity: z.string().max(20), title: z.string().max(200) }).strict()).max(16),
    })
    .strict()
    .nullable(),
}).strict()
export type CommunityExtensionDetail = z.output<typeof CommunityExtensionDetailSchema>

/** 安装者看到的审查标签：只描述审查发现，不做「安全」担保。 */
export const communityReviewLabel = (
  status: CommunityReviewStatus,
): { readonly tone: 'neutral' | 'ok' | 'accent' | 'warn' | 'bad'; readonly label: string } => {
  switch (status) {
    case 'passed':
      return { tone: 'ok', label: '审查通过' }
    case 'passed_with_notes':
      return { tone: 'accent', label: '审查通过，有建议' }
    case 'flagged':
      return { tone: 'warn', label: '有风险，待复审' }
    case 'risk_confirmed':
      return { tone: 'warn', label: '有风险' }
    case 'held':
      return { tone: 'bad', label: '暂停公开，待复审' }
    case 'rejected':
      return { tone: 'bad', label: '未通过' }
    case 'pending':
    case 'reviewing':
    case 'incomplete':
      return { tone: 'neutral', label: '风险未知' }
  }
}
