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

/** 社区评级的六个维度（审查标准 v1），从正上方顺时针排列成六边形。 */
export const COMMUNITY_RATING_DIMENSIONS = [
  'security',
  'openness',
  'reliability',
  'lightweight',
  'usability',
  'craft',
] as const
export type CommunityRatingDimension = (typeof COMMUNITY_RATING_DIMENSIONS)[number]

export const COMMUNITY_RATING_DIMENSION_LABELS: Readonly<Record<CommunityRatingDimension, string>> = {
  security: '安全',
  openness: '开放',
  reliability: '稳定',
  lightweight: '轻量',
  usability: '易用',
  craft: '工艺',
}

/** 社区的审查员，评级与审查记录以她署名。 */
export const COMMUNITY_REVIEWER_NAME = '小澄'

/** 社区判定的达成标签；不认识的标签不显示。扩展页面最多显示 {@link COMMUNITY_RATING_BADGE_LIMIT} 个。 */
export const COMMUNITY_RATING_BADGES: Readonly<
  Record<string, { readonly label: string; readonly description: string }>
> = {
  'zero-permission': { label: '零权限', description: '没有申请任何权限。' },
  'least-privilege': { label: '最小权限', description: '声明的每项能力都用得上，安全满星。' },
  'no-network': { label: '不联网', description: '不访问任何网络。' },
  'scoped-network': { label: '限定地址联网', description: '只访问指定域名或用户在配置中填写的地址。' },
  'managed-secrets': { label: '凭据托管', description: '凭据都是配置中的凭据字段，经宿主读取，没有写进源码。' },
  'readable-source': { label: '源码可读', description: '没有混淆、压缩或内嵌大段编码内容。' },
  'open-source': { label: '开源', description: '填写了公开的源码仓库。' },
  'readable-errors': { label: '错误可读', description: '失败时都返回给用户看的说明，稳定满星。' },
  'stable-context': { label: '上下文稳定', description: '不占上下文，或注入的上下文稳定、不破坏提示缓存。' },
  'complete-docs': { label: '说明完整', description: '有图标和介绍，易用至少四星。' },
}
export const COMMUNITY_RATING_BADGE_LIMIT = 4

/** 一次发布的评级：六维星级、综合评分（各维度平均，保留一位小数）与达成标签。 */
export const CommunityRatingSchema = z.object({
  standard: z.string().max(20),
  score: z.number().min(1).max(5),
  dimensions: z
    .array(
      z.object({
        key: z.string().max(40),
        stars: z.number().int().min(1).max(5),
        headline: z.string().max(200),
        cap: z.string().max(200).optional(),
      }),
    )
    .max(16),
  badges: z.array(z.string().max(40)).max(32),
})
export type CommunityRating = z.output<typeof CommunityRatingSchema>

/** 市场的排序方式。 */
export const COMMUNITY_EXTENSION_SORTS = [
  { key: 'updated', label: '最近更新' },
  { key: 'score', label: '综合评分' },
  { key: 'downloads', label: '下载最多' },
  { key: 'newest', label: '最新上架' },
] as const
export type CommunityExtensionSort = (typeof COMMUNITY_EXTENSION_SORTS)[number]['key']
export const CommunityExtensionSortSchema = z.enum(['updated', 'score', 'downloads', 'newest'])

export const CommunityReleaseIdSchema = z.string().regex(/^rel_[0-9A-Za-z]+$/u)

export const CommunityAccountSchema = z.object({
  handle: z.string().min(1).max(80),
  displayName: z.string().max(200),
  avatarUrl: z.string().url().nullable(),
})
export type CommunityAccount = z.output<typeof CommunityAccountSchema>

export const CommunityEnvironmentSchema = z.enum(['production', 'staging', 'development'])
export type CommunityEnvironment = z.output<typeof CommunityEnvironmentSchema>

export const CommunityStatusSchema = z.object({
  communityUrl: z.string().url(),
  /** 社区自我声明的环境；连不上或旧版社区时为 null。 */
  environment: CommunityEnvironmentSchema.nullable(),
  account: CommunityAccountSchema.nullable(),
  signedInAt: z.number().int().nullable(),
  /** 最近一次更新检查发现的可更新扩展数量（只读缓存，不发起网络请求）。 */
  updatesAvailable: z.number().int().nonnegative(),
})
export type CommunityStatus = z.output<typeof CommunityStatusSchema>

export const CommunityPermissionItemSchema = z.object({
  key: z.string().max(120),
  level: z.enum(['normal', 'elevated', 'high']),
  label: z.string().max(200),
  detail: z.string().max(2000).optional(),
  /** `host`: approved when installed on this machine; `agent`: approved when enabled for an agent. */
  layer: z.enum(['host', 'agent']).optional(),
})

export type CommunityPermissionItem = z.output<typeof CommunityPermissionItemSchema>

export const CommunityReleaseSchema = z.object({
  id: CommunityReleaseIdSchema,
  reviewStatus: CommunityReviewStatusSchema,
  /** 审查完成后的评级；尚未审查、审查未完成或旧版社区时为 null。 */
  rating: CommunityRatingSchema.nullable(),
  permissions: z.array(CommunityPermissionItemSchema).max(64),
  packageSize: z.number().int().nonnegative(),
  requiresSdk: z.number().int().positive().nullable(),
  notes: z.string().max(2000),
  createdAt: z.number().int(),
})
export type CommunityRelease = z.output<typeof CommunityReleaseSchema>

/** 社区为官方扩展保留的发布者标识：官方扩展由多位官方成员维护，对外不显示个人账号。 */
export const COMMUNITY_OFFICIAL_HANDLE = 'nekro-nxt'

/** 发布者的展示文字：官方扩展显示「NekroNXT 官方」，其余显示 @账号。 */
export const communityPublisherLabel = (handle: string): string =>
  handle === COMMUNITY_OFFICIAL_HANDLE ? 'NekroNXT 官方' : `@${handle}`

export const CommunityExtensionSummarySchema = z.object({
  id: ExtensionIdSchema,
  /** What the extension provides, derived from its Manifest; unknown future labels are dropped. */
  provides: z.array(z.string().max(32)).max(8),
  displayName: z.string().max(200),
  summary: z.string().max(1000),
  tags: z.array(z.string().max(40)).max(16),
  /** 最新公开发布包内的扩展图标（社区的绝对地址）；没有图标或旧版社区时为 null。 */
  iconUrl: z.string().url().nullable(),
  /** 由社区后台认定的官方扩展；此时发布者是社区保留的官方主页（`COMMUNITY_OFFICIAL_HANDLE`）。 */
  official: z.boolean(),
  publisher: CommunityAccountSchema,
  latest: CommunityReleaseSchema.nullable(),
  downloads: z.number().int().nonnegative(),
  updatedAt: z.number().int(),
  pageUrl: z.string().url(),
})
export type CommunityExtensionSummary = z.output<typeof CommunityExtensionSummarySchema>

export const CommunityExtensionDetailSchema = CommunityExtensionSummarySchema.extend({
  description: z.string().max(20_000),
  sourceUrl: z.string().url().nullable(),
  /** 公开的审查记录：评级、总评、各维度说明，以及发现与自动检查的标题。 */
  review: z
    .object({
      status: CommunityReviewStatusSchema,
      rating: CommunityRatingSchema.nullable(),
      summary: z.string().max(2000).nullable(),
      dimensions: z.array(z.object({ key: z.string().max(40), notes: z.string().max(2000) })).max(16),
      findings: z
        .array(z.object({ dimension: z.string().max(40), severity: z.string().max(20), title: z.string().max(200) }))
        .max(64),
      checks: z.array(z.object({ severity: z.string().max(20), title: z.string().max(200) })).max(64),
      reviewedAt: z.number().int().nullable(),
    })
    .nullable(),
})
export type CommunityExtensionDetail = z.output<typeof CommunityExtensionDetailSchema>

/**
 * 发布时随包提交的条目信息（作者自己写的介绍）。首次发布用于建条目；之后提供了哪项就覆盖哪项，未提供的保持不变。
 */
export const COMMUNITY_LISTING_LIMITS = { summary: 160, description: 20_000, tags: 8, tag: 40 } as const

export const CommunityListingInputSchema = z.object({
  summary: z.string().trim().max(COMMUNITY_LISTING_LIMITS.summary).optional(),
  description: z.string().max(COMMUNITY_LISTING_LIMITS.description).optional(),
  tags: z
    .array(z.string().trim().min(1).max(COMMUNITY_LISTING_LIMITS.tag))
    .max(COMMUNITY_LISTING_LIMITS.tags)
    .optional(),
  sourceUrl: z
    .string()
    .trim()
    .url()
    .refine((value) => /^https?:\/\//iu.test(value), '源码地址必须是 http(s) 链接。')
    .optional(),
})
export type CommunityListingInput = z.output<typeof CommunityListingInputSchema>

export const CommunityEndpointSchema = z.object({
  url: z.string().url(),
  source: z.enum(['setting', 'environment', 'default']),
  defaultUrl: z.string().url(),
  environmentUrl: z.string().url().nullable(),
  /** 当前地址是未加密的非本机地址。 */
  insecure: z.boolean(),
})
export type CommunityEndpoint = z.output<typeof CommunityEndpointSchema>

export const CommunitySourceSchema = z.object({
  kind: z.literal('community'),
  communityUrl: z.string().url(),
  releaseId: CommunityReleaseIdSchema,
  publisherHandle: z.string().min(1).max(80),
  installedAt: z.number().int().nonnegative(),
})
export type CommunitySource = z.output<typeof CommunitySourceSchema>

export const CommunityInstalledItemSchema = z.object({
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
export type CommunityInstalledItem = z.output<typeof CommunityInstalledItemSchema>

export const CommunityInstalledSchema = z.object({
  checkedAt: z.number().int().nullable(),
  items: z.array(CommunityInstalledItemSchema),
})

export const CommunityMyExtensionSchema = CommunityExtensionSummarySchema.extend({
  releases: z.array(CommunityReleaseSchema.extend({ withdrawn: z.boolean() })),
  delisted: z.boolean(),
  delistedReason: z.string().nullable(),
})
export type CommunityMyExtension = z.output<typeof CommunityMyExtensionSchema>

/** 审查发现可归属的维度：六个评级维度加合规。 */
export const COMMUNITY_REVIEW_DIMENSION_LABELS: Readonly<Record<string, string>> = {
  ...COMMUNITY_RATING_DIMENSION_LABELS,
  compliance: '合规',
}

/** 作者看到的完整审查报告。 */
export const CommunityReviewReportSchema = z.object({
  releaseId: CommunityReleaseIdSchema,
  status: CommunityReviewStatusSchema,
  rating: CommunityRatingSchema.nullable(),
  deterministic: z.array(
    z.object({
      severity: z.enum(['info', 'warning', 'risk', 'block']),
      title: z.string(),
      detail: z.string(),
      file: z.string().optional(),
      line: z.number().int().optional(),
    }),
  ),
  ai: z
    .object({
      summary: z.string(),
      verdict: z.string(),
      compliance: z.object({ ok: z.boolean(), notes: z.string() }).nullable(),
      dimensions: z.array(
        z.object({
          key: z.string(),
          stars: z.number().int().min(1).max(5),
          headline: z.string(),
          notes: z.string(),
          /** 不满五星时拿下一颗星的修改建议。 */
          nextStar: z.string().optional(),
        }),
      ),
      findings: z.array(
        z.object({
          dimension: z.string(),
          severity: z.enum(['info', 'suggestion', 'warning', 'risk', 'critical']),
          title: z.string(),
          detail: z.string(),
          file: z.string().optional(),
          line: z.number().int().optional(),
          suggestion: z.string().optional(),
        }),
      ),
      exploitability: z.string().optional(),
    })
    .nullable(),
  model: z.string().nullable(),
  error: z.string().nullable(),
  decisions: z.array(z.object({ decision: z.string(), note: z.string(), by: z.string(), createdAt: z.number().int() })),
  finishedAt: z.number().int().nullable(),
  reportUrl: z.string().url(),
})
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
