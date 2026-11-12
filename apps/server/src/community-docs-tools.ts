import { defineTool } from '@deepseek-ai/dsh-tools'
import { parseJsonValue, type JsonValue } from '@nekro-nxt/contracts'
import { z } from 'zod'
import { CommunityError, type CommunityService } from './community.js'
import { releaseIdentity } from './product-updates.js'

/** The public user documentation at nxt.nekro.ai/docs, for agents granted 「查阅社区文档」. */
export const DOCS_SEARCH_TOOL = 'nekro_nxt_docs_search'
export const DOCS_READ_TOOL = 'nekro_nxt_docs_read'
export const COMMUNITY_DOCS_TOOLS = [DOCS_SEARCH_TOOL, DOCS_READ_TOOL] as const

const READ_LIMIT = 12_000

const HitsSchema = z.object({
  hits: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      heading: z.string().nullable(),
      anchor: z.string().nullable(),
      url: z.string(),
      snippet: z.string(),
    }),
  ),
})

const PageSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  markdown: z.string(),
  heading: z.string().optional(),
  summary: z.string().optional(),
  ui: z.array(z.string()).optional(),
  headings: z.array(z.object({ text: z.string(), anchor: z.string() })).optional(),
})

const json = (value: unknown): JsonValue => parseJsonValue(JSON.parse(JSON.stringify(value)))

/** A failure the agent can pass on: whether to search again, wait, or tell the user it could not look. */
const docsErrorForAgent = (error: unknown): unknown => {
  if (!(error instanceof CommunityError)) return error
  if (error.code === 'community-timeout' || error.code === 'community-unreachable')
    return new Error(
      '现在连不上社区站，查不了文档。按你知道的回答，并告诉对方可以自己打开 https://nxt.nekro.ai/docs 查看。',
    )
  if (error.code === 'community-not-found') return new Error(`没有这页文档或这个小节，用 ${DOCS_SEARCH_TOOL} 重新找。`)
  return new Error(`社区站这次没有给出文档：${error.message}`)
}

/**
 * Stable releases read the stable documentation; preview and development builds read Preview, which follows main and
 * matches their interface.
 */
export const communityDocs = (community: Pick<CommunityService, 'searchDocs' | 'readDoc'>, releaseId: string) => {
  const channel = releaseIdentity(releaseId).channel === 'stable' ? 'stable' : 'preview'
  const read = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work()
    } catch (error) {
      throw docsErrorForAgent(error)
    }
  }
  return {
    channel,
    search: (query: string, limit: number): Promise<JsonValue> =>
      read(async () => {
        const { hits } = HitsSchema.parse(await community.searchDocs({ query, channel, limit }))
        return json({
          hits: hits.map((hit) => ({
            id: hit.id,
            title: hit.title,
            heading: hit.heading,
            anchor: hit.anchor,
            url: hit.url,
            snippet: hit.snippet,
          })),
        })
      }),
    read: (id: string, anchor: string | undefined): Promise<JsonValue> =>
      read(async () => {
        const page = PageSchema.parse(await community.readDoc({ id, anchor, channel }))
        const clipped = page.markdown.length > READ_LIMIT
        return json({
          title: page.heading === undefined ? page.title : `${page.title} · ${page.heading}`,
          url: page.url,
          ...(page.ui === undefined || page.ui.length === 0 ? {} : { ui: page.ui }),
          markdown: clipped ? `${page.markdown.slice(0, READ_LIMIT)}…` : page.markdown,
          // A clipped page lists its sections, so the agent can read the one it needs with anchor.
          ...(clipped && page.headings !== undefined
            ? { sections: page.headings.map((heading) => ({ heading: heading.text, anchor: heading.anchor })) }
            : {}),
        })
      }),
  }
}

export type CommunityDocsPort = ReturnType<typeof communityDocs>

const renderJson = (_args: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value) }]

export const communityDocsTools = (port: () => CommunityDocsPort | undefined) => {
  const requirePort = () => {
    const found = port()
    if (found === undefined) throw new Error('这台 NekroNXT 没有接入社区站，查不了文档。')
    return found
  }
  return [
    defineTool({
      name: DOCS_SEARCH_TOOL,
      description: `在 NekroNXT 官方使用文档里搜索。有人问 NekroNXT 怎么用、某个设置在哪、遇到报错或故障时先查这里。每条结果有页面编号 id、标题、小节和它的 anchor、链接 url 和一段摘录；要看全文用 ${DOCS_READ_TOOL}。`,
      parameters: {
        query: {
          type: 'string',
          required: true,
          description: '要查的问题，用对方的说法或界面上的字，比如「群里没反应」「添加平台账号」。',
        },
        limit: { type: 'number', description: '最多几条，默认 5，最多 10。' },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      execute(args) {
        const input = z
          .object({ query: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(10).optional() })
          .parse(args)
        return requirePort().search(input.query, input.limit ?? 5)
      },
    }),
    defineTool({
      name: DOCS_READ_TOOL,
      description: `读一页 NekroNXT 使用文档，或其中一个小节。id 和 anchor 来自 ${DOCS_SEARCH_TOOL} 的结果。返回的 ui 是这页功能在界面上的位置。`,
      parameters: {
        id: { type: 'string', required: true, description: '页面编号，形如 troubleshooting/models。' },
        anchor: { type: 'string', description: '只读这个小节；不写读整页。' },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      execute(args) {
        const input = z
          .object({
            id: z
              .string()
              .trim()
              .regex(/^[a-z0-9-]+\/[a-z0-9-]+$/u, '页面编号形如 troubleshooting/models'),
            anchor: z.string().trim().min(1).max(200).optional(),
          })
          .parse(args)
        return requirePort().read(input.id, input.anchor)
      },
    }),
  ]
}
