import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  CommunityExtensionDetailSchema,
  CommunityExtensionSortSchema,
  CommunityExtensionSummarySchema,
  CommunityFreshnessSchema,
  communityPublisherLabel,
  EXTENSION_SDK_LEVEL,
  ExtensionIdSchema,
  parseJsonValue,
  type CommunityExtensionDetail,
  type CommunityExtensionSort,
  type CommunityExtensionSummary,
  type CommunityPermissionItem,
  type CommunityRelease,
  type CommunityReviewStatus,
  type ExtensionId,
  type JsonValue,
} from '@nekro-nxt/contracts'
import { z } from 'zod'
import { CommunityError, explainCommunityLevelRejection, type CommunityService } from './community.js'

/** Browsing the community catalog (#121): read-only, every agent may look. */
export const COMMUNITY_SEARCH_TOOL = 'nekro_nxt_community_search'
export const COMMUNITY_EXTENSION_TOOL = 'nekro_nxt_community_extension'
export const COMMUNITY_BROWSE_TOOLS = [COMMUNITY_SEARCH_TOOL, COMMUNITY_EXTENSION_TOOL] as const

export const REVIEW_STATUS_LABEL: Readonly<Record<CommunityReviewStatus, string>> = {
  pending: '尚未开始',
  reviewing: '进行中',
  passed: '通过',
  passed_with_notes: '通过，有建议',
  flagged: '发现风险，等待复审',
  held: '暂停公开',
  risk_confirmed: '确认有风险',
  rejected: '未通过',
  incomplete: '未完成',
}

/** Same words as the community page on the web. */
const PERMISSION_LEVEL_LABEL: Readonly<Record<CommunityPermissionItem['level'], string>> = {
  normal: '常规',
  elevated: '需留意',
  high: '高风险',
}

const severityLabel = (severity: string): string =>
  severity === 'critical' || severity === 'block'
    ? '严重'
    : severity === 'risk'
      ? '风险'
      : severity === 'warning'
        ? '提醒'
        : severity === 'suggestion'
          ? '建议'
          : '信息'

export const COMMUNITY_SIGNED_OUT_FOR_AGENT = '这台 NekroNXT 还没有登录社区，请管理员先在「社区 → 账号」登录。'

const sentence = (text: string): string => {
  const trimmed = text.trim().replace(/[。.]+$/u, '')
  return trimmed === '' ? '' : `${trimmed}。`
}

/**
 * A community failure in words the agent can act on: what happened and who does what next. Anything that is not a
 * community failure is returned as it was.
 */
export const communityErrorForAgent = (error: unknown): unknown => {
  const explained = explainCommunityLevelRejection(error)
  if (!(explained instanceof CommunityError)) return error
  // The community is behind this NekroNXT: the explanation already says to wait for it.
  if (explained !== error) return explained
  const message = sentence(explained.message)
  const rewrite = (text: string) => new CommunityError(explained.status, text, explained.code)
  switch (explained.code) {
    case 'community-signed-out':
      return rewrite(
        message.includes('失效')
          ? '这台 NekroNXT 的社区登录已失效，请管理员在「社区 → 账号」重新登录。'
          : COMMUNITY_SIGNED_OUT_FOR_AGENT,
      )
    case 'community-timeout':
    case 'community-unreachable':
      return rewrite(
        '现在连不上社区，可能是网络不通或社区暂时不可用。过一会儿再试；一直连不上时请管理员检查网络和「社区」里的地址。',
      )
    case 'community-not-found':
      return rewrite(
        `社区上找不到：${message}编号可能写错了，也可能已经下架或撤回；用 ${COMMUNITY_SEARCH_TOOL} 重新找。`,
      )
    case 'community-identity-changed':
      return rewrite('社区地址或登录的账号刚刚换过，请重新操作一次。')
    case 'community-upgrade-required':
      return rewrite(`${message}这台 NekroNXT 现在装不了，请告诉管理员先升级 NekroNXT。`)
  }
  if (explained.status === 401) {
    return rewrite('这台 NekroNXT 的社区登录已失效，请管理员在「社区 → 账号」重新登录。')
  }
  if (explained.status >= 500) return rewrite(`社区这次没有给出能用的结果：${message}过一会儿再试。`)
  return rewrite(`社区没有接受：${message}能按原因改的改好再试，改不了的告诉管理员。`)
}

/** Runs a community read or action and hands its failure back in the agent's words. */
export const forAgent = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work()
  } catch (error) {
    throw communityErrorForAgent(error)
  }
}

/** What this machine has of a community extension. */
export interface CommunityLocalState {
  installed(extensionId: ExtensionId): boolean
  /** The community has a newer release than the installed version. */
  updatable(extensionId: ExtensionId): boolean
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text)

const day = (time: number): string => new Date(time).toISOString().slice(0, 10)

const needsNewer = (release: CommunityRelease | null) =>
  release?.requiresSdk != null && release.requiresSdk > EXTENSION_SDK_LEVEL ? { needsNewerNekroNxt: true } : {}

const hereOf = (id: ExtensionId, local: CommunityLocalState) => {
  const installed = local.installed(id)
  return { installed, updatable: installed && local.updatable(id) }
}

/** One compact row of a search result. */
export const communitySearchRow = (item: CommunityExtensionSummary, local: CommunityLocalState) => ({
  id: item.id,
  name: item.displayName,
  summary: clip(item.summary, 160),
  publisher: communityPublisherLabel(item.publisher.handle),
  latest: item.latest?.number ?? null,
  review: item.latest === null ? null : REVIEW_STATUS_LABEL[item.latest.reviewStatus],
  rating: item.latest?.rating?.score ?? null,
  ...needsNewer(item.latest),
  ...hereOf(item.id, local),
})

const VERSION_LIMIT = 20

/** One extension in full: versions, the newest release's permissions and the public review record. */
export const communityExtensionView = (detail: CommunityExtensionDetail, local: CommunityLocalState) => {
  const releases = detail.releases ?? (detail.latest === null ? [] : [{ ...detail.latest, withdrawn: false }])
  const review = detail.review
  return {
    id: detail.id,
    name: detail.displayName,
    summary: detail.summary,
    publisher: communityPublisherLabel(detail.publisher.handle),
    provides: detail.provides,
    tags: detail.tags,
    description: clip(detail.description, 4000),
    sourceUrl: detail.sourceUrl,
    pageUrl: detail.pageUrl,
    ...needsNewer(detail.latest),
    ...hereOf(detail.id, local),
    versions: releases.slice(0, VERSION_LIMIT).map((release) => ({
      number: release.number ?? null,
      date: day(release.createdAt),
      notes: clip(release.notes, 300),
      review: REVIEW_STATUS_LABEL[release.reviewStatus],
      rating: release.rating?.score ?? null,
      ...(release.withdrawn ? { withdrawn: true } : {}),
    })),
    ...(releases.length > VERSION_LIMIT ? { olderVersions: releases.length - VERSION_LIMIT } : {}),
    latestPermissions: (detail.latest?.permissions ?? []).map((permission) => ({
      label: permission.label,
      level: PERMISSION_LEVEL_LABEL[permission.level],
      layer: (permission.layer ?? 'agent') === 'host' ? '本机' : '智能体',
      ...(permission.detail === undefined ? {} : { detail: clip(permission.detail, 200) }),
    })),
    review:
      review === null
        ? null
        : {
            status: REVIEW_STATUS_LABEL[review.status],
            rating: review.rating?.score ?? null,
            summary: review.summary === null ? null : clip(review.summary, 600),
            findings: review.findings
              .slice(0, 10)
              .map((finding) => `${severityLabel(finding.severity)}：${finding.title}`),
            ...(review.findings.length > 10 ? { moreFindings: review.findings.length - 10 } : {}),
          },
  }
}

const json = (value: unknown): JsonValue => parseJsonValue(JSON.parse(JSON.stringify(value)))

const staleNote = (read: unknown) =>
  CommunityFreshnessSchema.safeParse(read).data?.stale === true
    ? { note: '社区这次没连上，下面是稍早取回的结果。' }
    : {}

/** Catalog reads share the web's five-minute cache, so an agent and a page browsing together reach the community once. */
export const communityBrowser = (
  community: Pick<CommunityService, 'cachedRead' | 'listExtensions' | 'getExtension'>,
  local: CommunityLocalState,
) => ({
  search: (input: {
    readonly query?: string | undefined
    readonly provides?: string | undefined
    readonly sort?: CommunityExtensionSort | undefined
    readonly cursor?: string | undefined
  }): Promise<JsonValue> =>
    forAgent(async () => {
      const query = {
        ...(input.query === undefined ? {} : { query: input.query }),
        ...(input.provides === undefined ? {} : { provides: input.provides }),
        ...(input.sort === undefined ? {} : { sort: input.sort }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      }
      const read = await community.cachedRead('extensions', query, false, () => community.listExtensions(query))
      const page = z
        .object({ items: z.array(CommunityExtensionSummarySchema), nextCursor: z.string().nullable() })
        .parse(read)
      return json({
        items: page.items.map((item) => communitySearchRow(item, local)),
        nextCursor: page.nextCursor,
        ...staleNote(read),
      })
    }),
  extension: (extensionId: ExtensionId): Promise<JsonValue> =>
    forAgent(async () => {
      const read = await community.cachedRead('extension', { extensionId }, false, () =>
        community.getExtension(extensionId),
      )
      return json({ ...communityExtensionView(CommunityExtensionDetailSchema.parse(read), local), ...staleNote(read) })
    }),
})

export type CommunityBrowsePort = ReturnType<typeof communityBrowser>

const renderJson = (_args: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value) }]

export const communityBrowseTools = (port: () => CommunityBrowsePort | undefined) => {
  const requirePort = () => {
    const found = port()
    if (found === undefined) throw new Error('这台 NekroNXT 没有接入社区。')
    return found
  }
  return [
    defineTool({
      name: COMMUNITY_SEARCH_TOOL,
      description: `在 NekroNXT 社区里找扩展。每个结果有编号、名称、简介、发布者、最新发布号（latest）、审查结论、评分，以及这台机器是否已安装（installed）、能否更新（updatable）。看某个扩展的版本、权限和审查详情用 ${COMMUNITY_EXTENSION_TOOL}。`,
      parameters: {
        query: { type: 'string', description: '关键词；不写时按排序列出全部。' },
        provides: {
          type: 'string',
          enum: ['agent', 'page', 'adapter', 'mcp'],
          description: '只看提供这类能力的：agent 智能体工具，page 页面，adapter 平台适配，mcp MCP 服务。',
        },
        sort: {
          type: 'string',
          enum: ['updated', 'score', 'downloads', 'newest'],
          description: 'updated 最近更新（默认），score 综合评分，downloads 下载最多，newest 最新上架。',
        },
        cursor: { type: 'string', description: '上一页结果里的 nextCursor，用来看下一页。' },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      execute(args) {
        const input = z
          .object({
            query: z.string().trim().max(200).optional(),
            provides: z.enum(['agent', 'page', 'adapter', 'mcp']).optional(),
            sort: CommunityExtensionSortSchema.optional(),
            cursor: z.string().max(500).optional(),
          })
          .parse(args)
        return requirePort().search({
          ...(input.query === undefined || input.query === '' ? {} : { query: input.query }),
          ...(input.provides === undefined ? {} : { provides: input.provides }),
          ...(input.sort === undefined ? {} : { sort: input.sort }),
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        })
      },
    }),
    defineTool({
      name: COMMUNITY_EXTENSION_TOOL,
      description:
        '查看社区上的一个扩展：介绍、各次发布（发布号、日期、更新说明、审查结论、评分、是否已撤回）、最新发布要的权限和级别、审查结论和发现的问题，以及这台机器是否已安装、能否更新。',
      parameters: {
        id: { type: 'string', required: true, description: `社区扩展编号，见 ${COMMUNITY_SEARCH_TOOL} 的结果。` },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      execute(args) {
        const input = z.object({ id: z.string().trim().min(1) }).parse(args)
        const id = ExtensionIdSchema.safeParse(input.id)
        if (!id.success) throw new Error(`「${input.id}」不是社区扩展编号；用 ${COMMUNITY_SEARCH_TOOL} 查找。`)
        return requirePort().extension(id.data)
      },
    }),
  ]
}
