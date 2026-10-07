import { z } from 'zod'
import { CommunityAccountSchema } from './community.js'
import { AgentIdSchema } from './domain.js'

/**
 * 社区人设在本机的投影：名称、头像、简介、作者介绍、标签与人设正文（对应智能体的 `persona`）。不含模型与扩展。
 * Host 宽松读取社区响应并归一到这些结构；头像改写为本机代理地址，页面不直接跨域读取社区图片。
 */
export const CommunityPersonaIdSchema = z.string().regex(/^psn_[0-9A-Za-z]+$/u)
export const CommunityPersonaRevisionIdSchema = z.string().regex(/^prv_[0-9A-Za-z]+$/u)

/** 人设正文上限，与智能体设定一致。 */
export const COMMUNITY_PERSONA_MAX_LENGTH = 64 * 1024
/** 发布头像上限（社区约定 ≤512 KiB 的 PNG、JPEG 或 WebP）。 */
export const COMMUNITY_PERSONA_AVATAR_MAX_BYTES = 512 * 1024
export const COMMUNITY_PERSONA_AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const

const TagsSchema = z.array(z.string().min(1).max(40)).max(16)

export const CommunityPersonaSummarySchema = z
  .object({
    id: CommunityPersonaIdSchema,
    name: z.string().min(1).max(200),
    summary: z.string().max(1000),
    tags: TagsSchema,
    /** 本机代理地址 `/api/community/personas/<id>/avatar?v=…`；没有头像时为 null。 */
    avatarUrl: z.string().startsWith('/api/community/personas/').nullable(),
    official: z.boolean(),
    publisher: CommunityAccountSchema,
    installs: z.number().int().nonnegative(),
    updatedAt: z.number().int(),
    pageUrl: z.string().url(),
  })
  .strict()
export type CommunityPersonaSummary = z.output<typeof CommunityPersonaSummarySchema>

export const CommunityPersonaDetailSchema = CommunityPersonaSummarySchema.extend({
  description: z.string().max(20_000),
  persona: z.string().max(COMMUNITY_PERSONA_MAX_LENGTH),
  revision: z
    .object({ id: CommunityPersonaRevisionIdSchema, notes: z.string().max(2000), createdAt: z.number().int() })
    .strict(),
  review: z
    .object({ status: z.enum(['approved', 'flagged']), summary: z.string().max(2000).nullable() })
    .strict()
    .nullable(),
}).strict()
export type CommunityPersonaDetail = z.output<typeof CommunityPersonaDetailSchema>

export const CommunityPersonaReviewStatusSchema = z.enum(['pending', 'approved', 'flagged', 'rejected'])
export type CommunityPersonaReviewStatus = z.output<typeof CommunityPersonaReviewStatusSchema>

export const CommunityMyPersonaSchema = CommunityPersonaSummarySchema.extend({
  status: z.enum(['listed', 'delisted']),
  latestRevision: z
    .object({
      id: CommunityPersonaRevisionIdSchema,
      createdAt: z.number().int(),
      reviewStatus: CommunityPersonaReviewStatusSchema,
      reviewSummary: z.string().max(2000).nullable(),
    })
    .strict(),
}).strict()
export type CommunityMyPersona = z.output<typeof CommunityMyPersonaSchema>

export const CommunityMyPersonasSchema = z
  .object({
    items: z.array(CommunityMyPersonaSchema),
    /** 本机智能体最近一次发布到当前社区的人设，用于「更新已发布的人设」。 */
    agentLinks: z.record(AgentIdSchema, CommunityPersonaIdSchema),
  })
  .strict()

/** 作者看到的审查状态文字。 */
export const communityPersonaReviewLabel = (
  status: CommunityPersonaReviewStatus,
): { readonly tone: 'neutral' | 'ok' | 'warn' | 'bad'; readonly label: string } => {
  switch (status) {
    case 'approved':
      return { tone: 'ok', label: '已公开' }
    case 'pending':
      return { tone: 'neutral', label: '审查中' }
    case 'flagged':
      return { tone: 'warn', label: '待人工复核' }
    case 'rejected':
      return { tone: 'bad', label: '未通过' }
  }
}
