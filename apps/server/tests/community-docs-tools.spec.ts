import { describe, expect, it } from 'vitest'
import { communityDocs, communityDocsTools } from '../src/community-docs-tools.ts'
import { CommunityError } from '../src/community.ts'
import { sessionCapabilityPacks } from '../src/session-capability-packs.ts'

const shown = {
  id: 'troubleshooting/models',
  title: '模型与回复',
  heading: '群里没反应',
  anchor: '群里没反应',
  url: 'https://nxt.nekro.ai/docs/troubleshooting/models#群里没反应',
  snippet: '先分清是“她没被叫醒”……',
}
const hit = { ...shown, extra: 'dropped' }

const fakeCommunity = (page: { markdown: string; headings?: { text: string; anchor: string }[] }) => {
  const calls: unknown[] = []
  return {
    calls,
    community: {
      searchDocs: (input: unknown) => {
        calls.push(['search', input])
        return Promise.resolve({ hits: [hit] })
      },
      readDoc: (input: unknown) => {
        calls.push(['read', input])
        return Promise.resolve({
          id: 'troubleshooting/models',
          title: '模型与回复',
          url: 'https://nxt.nekro.ai/docs/troubleshooting/models',
          summary: '智能体不回复时怎么排查。',
          ui: ['透视'],
          headings: page.headings ?? [],
          markdown: page.markdown,
        })
      },
    },
  }
}

const toolsOf = (port: ReturnType<typeof communityDocs>) =>
  Object.fromEntries(communityDocsTools(() => port).map((tool) => [tool.name, tool]))

// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- The tools read no execution context.
const NO_CONTEXT = {} as never

describe('community docs tools', () => {
  it('reads the documentation of the channel this release belongs to', async () => {
    const stable = fakeCommunity({ markdown: '' })
    await toolsOf(communityDocs(stable.community, '0.9.0+0123456'))['nekro_nxt_docs_search']!.execute(
      { query: ' 群里没反应 ' },
      NO_CONTEXT,
    )
    const preview = fakeCommunity({ markdown: '' })
    const result = await toolsOf(communityDocs(preview.community, '0.9.0-20261112-065738utc.g0123456+0123456'))[
      'nekro_nxt_docs_search'
    ]!.execute({ query: '群里没反应', limit: 3 }, NO_CONTEXT)
    expect(stable.calls).toEqual([['search', { query: '群里没反应', channel: 'stable', limit: 5 }]])
    expect(preview.calls).toEqual([['search', { query: '群里没反应', channel: 'preview', limit: 3 }]])
    expect(result).toEqual({ hits: [shown] })
  })

  it('clips a long page and lists its sections so one can be read by anchor', async () => {
    const fake = fakeCommunity({
      markdown: '甲'.repeat(13_000),
      headings: [{ text: '群里没反应', anchor: '群里没反应' }],
    })
    const tools = toolsOf(communityDocs(fake.community, 'development'))
    const page = await tools['nekro_nxt_docs_read']!.execute({ id: 'troubleshooting/models' }, NO_CONTEXT)
    expect(page).toMatchObject({
      title: '模型与回复',
      ui: ['透视'],
      sections: [{ heading: '群里没反应', anchor: '群里没反应' }],
    })
    expect(page).toHaveProperty('markdown', `${'甲'.repeat(12_000)}…`)
    await expect(tools['nekro_nxt_docs_read']!.execute({ id: '../etc' }, NO_CONTEXT)).rejects.toThrow(/页面编号/u)
  })

  it('tells the agent what to do when the community cannot answer', async () => {
    const failing = (error: CommunityError) =>
      toolsOf(
        communityDocs(
          { searchDocs: () => Promise.reject(error), readDoc: () => Promise.reject(error) },
          '0.9.0+0123456',
        ),
      )
    await expect(
      failing(new CommunityError(502, '无法连接社区', 'community-unreachable'))['nekro_nxt_docs_search']!.execute(
        { query: '接线' },
        NO_CONTEXT,
      ),
    ).rejects.toThrow(/连不上社区站.*nxt\.nekro\.ai\/docs/u)
    await expect(
      failing(new CommunityError(404, '没有这页文档。', 'community-not-found'))['nekro_nxt_docs_read']!.execute(
        { id: 'start/nowhere' },
        NO_CONTEXT,
      ),
    ).rejects.toThrow(/nekro_nxt_docs_search 重新找/u)
  })

  it('offers the docs pack only to agents granted 「查阅社区文档」', () => {
    const grants = {
      dynamicCreation: false,
      extensionAutonomy: 'manual',
      scheduledTasks: false,
      fileTools: false,
      developmentShell: false,
    } as const
    expect(sessionCapabilityPacks({ ...grants, communityDocs: true }).map((pack) => pack.name)).toContain('使用文档')
    expect(sessionCapabilityPacks({ ...grants, communityDocs: false }).map((pack) => pack.name)).not.toContain(
      '使用文档',
    )
  })
})
