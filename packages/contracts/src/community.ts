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

export const CommunityEnvironmentSchema = z.enum(['production', 'staging', 'development'])
export type CommunityEnvironment = z.output<typeof CommunityEnvironmentSchema>

export const CommunityStatusSchema = z
  .object({
    communityUrl: z.string().url(),
    /** 社区自我声明的环境；连不上或旧版社区时为 null。 */
    environment: CommunityEnvironmentSchema.nullable(),
    account: CommunityAccountSchema.nullable(),
    signedInAt: z.number().int().nullable(),
    /** 最近一次更新检查发现的可更新扩展数量（只读缓存，不发起网络请求）。 */
    updatesAvailable: z.number().int().nonnegative(),
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

export type CommunityPermissionItem = z.output<typeof CommunityPermissionItemSchema>

export const CommunityReleaseSchema = z
  .object({
    id: CommunityReleaseIdSchema,
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

export const CommunityEndpointSchema = z
  .object({
    url: z.string().url(),
    source: z.enum(['setting', 'environment', 'default']),
    defaultUrl: z.string().url(),
    environmentUrl: z.string().url().nullable(),
    /** 当前地址是未加密的非本机地址。 */
    insecure: z.boolean(),
  })
  .strict()
export type CommunityEndpoint = z.output<typeof CommunityEndpointSchema>

export const CommunitySourceSchema = z
  .object({
    kind: z.literal('community'),
    communityUrl: z.string().url(),
    releaseId: CommunityReleaseIdSchema,
    publisherHandle: z.string().min(1).max(80),
    installedAt: z.number().int().nonnegative(),
  })
  .strict()
export type CommunitySource = z.output<typeof CommunitySourceSchema>

export const CommunityInstalledItemSchema = z
  .object({
    extensionId: ExtensionIdSchema,
    displayName: z.string(),
    revisionId: z.string(),
    source: CommunitySourceSchema,
    /** 来源与当前社区地址一致时才能检查更新。 */
    sameCommunity: z.boolean(),
    /** 社区仍有这个条目。 */
    found: z.boolean(),
    delisted: z.boolean(),
    delistedReason: z.string().nullable(),
    releaseWithdrawn: z.boolean(),
    latest: CommunityReleaseSchema.nullable(),
    updateAvailable: z.boolean(),
    addedPermissions: z.array(CommunityPermissionItemSchema),
  })
  .strict()
export type CommunityInstalledItem = z.output<typeof CommunityInstalledItemSchema>

export const CommunityInstalledSchema = z
  .object({ checkedAt: z.number().int().nullable(), items: z.array(CommunityInstalledItemSchema) })
  .strict()

export const CommunityMyExtensionSchema = CommunityExtensionSummarySchema.extend({
  releases: z.array(CommunityReleaseSchema.extend({ withdrawn: z.boolean() }).strict()),
  delisted: z.boolean(),
  delistedReason: z.string().nullable(),
}).strict()
export type CommunityMyExtension = z.output<typeof CommunityMyExtensionSchema>

export const COMMUNITY_REVIEW_DIMENSIONS = [
  'security',
  'transparency',
  'reliability',
  'context_cost',
  'usability',
  'maintainability',
  'compliance',
] as const

export const COMMUNITY_REVIEW_DIMENSION_LABELS: Readonly<Record<(typeof COMMUNITY_REVIEW_DIMENSIONS)[number], string>> =
  {
    security: '安全',
    transparency: '源码透明',
    reliability: '可靠性',
    context_cost: '上下文与成本',
    usability: '可用性',
    maintainability: '可维护性',
    compliance: '合规',
  }

/** 作者看到的完整审查报告。 */
export const CommunityReviewReportSchema = z
  .object({
    releaseId: CommunityReleaseIdSchema,
    status: CommunityReviewStatusSchema,
    grade: CommunityGradeSchema.nullable(),
    deterministic: z.array(
      z
        .object({
          severity: z.enum(['info', 'warning', 'risk', 'block']),
          title: z.string(),
          detail: z.string(),
          file: z.string().optional(),
          line: z.number().int().optional(),
        })
        .strict(),
    ),
    ai: z
      .object({
        summary: z.string(),
        verdict: z.string(),
        grade: CommunityGradeSchema,
        dimensions: z.array(
          z
            .object({ key: z.enum(COMMUNITY_REVIEW_DIMENSIONS), grade: CommunityGradeSchema, notes: z.string() })
            .strict(),
        ),
        findings: z.array(
          z
            .object({
              dimension: z.enum(COMMUNITY_REVIEW_DIMENSIONS),
              severity: z.enum(['info', 'suggestion', 'warning', 'risk', 'critical']),
              title: z.string(),
              detail: z.string(),
              file: z.string().optional(),
              line: z.number().int().optional(),
              suggestion: z.string().optional(),
            })
            .strict(),
        ),
        exploitability: z.string().optional(),
      })
      .strict()
      .nullable(),
    model: z.string().nullable(),
    error: z.string().nullable(),
    decisions: z.array(
      z.object({ decision: z.string(), note: z.string(), by: z.string(), createdAt: z.number().int() }).strict(),
    ),
    finishedAt: z.number().int().nullable(),
    reportUrl: z.string().url(),
  })
  .strict()
export type CommunityReviewReport = z.output<typeof CommunityReviewReportSchema>

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
