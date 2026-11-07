import {
  EXTENSION_SDK_LEVEL,
  ExtensionIdSchema,
  type CommunityExtensionDetail,
  type CommunityExtensionSummary,
  type CommunityRelease,
  type CommunityReviewReport,
} from '@nekro-nxt/contracts'
import { describe, expect, it } from 'vitest'
import {
  communityBrowser,
  communityBrowseTools,
  communityErrorForAgent,
  communityExtensionView,
  communitySearchRow,
  type CommunityLocalState,
  reviewDigest,
} from '../src/community-agent-tools.ts'
import { CommunityError } from '../src/community.ts'

const WEATHER = ExtensionIdSchema.parse('ext_01WEATHER')
const DICE = ExtensionIdSchema.parse('ext_01DICE')

const release = (number: number, overrides: Partial<CommunityRelease> = {}): CommunityRelease => ({
  id: `rel_0${number}weather`,
  number,
  reviewStatus: 'passed',
  rating: { standard: 'v1', score: 4.3, dimensions: [], badges: [] },
  permissions: [],
  packageSize: 2048,
  requiresSdk: null,
  notes: `第 ${number} 次发布的更新说明。`,
  createdAt: Date.UTC(2026, 9, number),
  ...overrides,
})

const summary = (
  id: typeof WEATHER,
  overrides: Partial<CommunityExtensionSummary> = {},
): CommunityExtensionSummary => ({
  id,
  provides: ['agent'],
  displayName: id === WEATHER ? '示例天气' : '示例骰子',
  summary: '查询虚构城市的天气。',
  tags: ['天气'],
  iconUrl: null,
  official: false,
  publisher: { handle: 'fixture-author', displayName: '示例作者', avatarUrl: null },
  latest: release(3),
  downloads: 12,
  updatedAt: 1,
  pageUrl: `https://community.example/extensions/${id}`,
  ...overrides,
})

const detail = (overrides: Partial<CommunityExtensionDetail> = {}): CommunityExtensionDetail => ({
  ...summary(WEATHER),
  latest: release(3, {
    permissions: [
      { key: 'network', level: 'elevated', label: '访问网络', detail: 'api.example.com', layer: 'agent' },
      { key: 'history', level: 'high', label: '读取聊天记录', layer: 'host' },
    ],
  }),
  description: '## 用法\n\n问「示例市天气」。',
  sourceUrl: 'https://example.com/weather',
  review: {
    status: 'passed_with_notes',
    rating: { standard: 'v1', score: 4.3, dimensions: [], badges: [] },
    summary: '整体良好。',
    dimensions: [],
    findings: [
      { dimension: 'security', severity: 'risk', title: '网络地址范围偏宽' },
      { dimension: 'usability', severity: 'suggestion', title: '补充示例' },
    ],
    checks: [],
    reviewedAt: 1,
  },
  releases: [
    { ...release(3), withdrawn: false },
    { ...release(2, { reviewStatus: 'rejected', rating: null }), withdrawn: true },
  ],
  ...overrides,
})

/** Weather is installed here and has a newer release; dice is not installed. */
const local: CommunityLocalState = {
  installed: (id) => id === WEATHER,
  updatable: (id) => id === WEATHER,
}

describe('community rows for the agent', () => {
  it('keeps a search row to what choosing needs, with what this machine has', () => {
    expect(communitySearchRow(summary(WEATHER), local)).toEqual({
      id: WEATHER,
      name: '示例天气',
      summary: '查询虚构城市的天气。',
      publisher: '@fixture-author',
      latest: 3,
      review: '通过',
      rating: 4.3,
      installed: true,
      updatable: true,
    })
    const unreleased = communitySearchRow(
      summary(DICE, { latest: null, publisher: { handle: 'nekro-nxt', displayName: '', avatarUrl: null } }),
      local,
    )
    expect(unreleased).toMatchObject({ publisher: 'NekroNXT 官方', latest: null, review: null, rating: null })
    expect(unreleased).toMatchObject({ installed: false, updatable: false })
    expect(
      communitySearchRow(summary(DICE, { latest: release(1, { requiresSdk: EXTENSION_SDK_LEVEL + 1 }) }), local),
    ).toMatchObject({ needsNewerNekroNxt: true })
  })

  it('shows versions, permissions with levels and the review record of one extension', () => {
    const view = communityExtensionView(detail(), local)
    expect(view.versions).toEqual([
      { number: 3, date: '2026-10-03', notes: '第 3 次发布的更新说明。', review: '通过', rating: 4.3 },
      {
        number: 2,
        date: '2026-10-02',
        notes: '第 2 次发布的更新说明。',
        review: '未通过',
        rating: null,
        withdrawn: true,
      },
    ])
    expect(view.latestPermissions).toEqual([
      { label: '访问网络', level: '需留意', layer: '智能体', detail: 'api.example.com' },
      { label: '读取聊天记录', level: '高风险', layer: '本机' },
    ])
    expect(view.review).toEqual({
      status: '通过，有建议',
      rating: 4.3,
      summary: '整体良好。',
      findings: ['风险：网络地址范围偏宽', '建议：补充示例'],
    })
    expect(view).toMatchObject({ installed: true, updatable: true, sourceUrl: 'https://example.com/weather' })
  })

  it('falls back to the newest release when an older community sends no version list', () => {
    const { releases: _omitted, ...older } = detail()
    void _omitted
    expect(communityExtensionView(older, local).versions.map((version) => version.number)).toEqual([3])
  })
})

describe('community failures for the agent', () => {
  const said = (error: unknown) => {
    const mapped = communityErrorForAgent(error)
    return mapped instanceof Error ? mapped.message : String(mapped)
  }

  it('asks an administrator to sign in when this machine is signed out or the sign-in expired', () => {
    expect(said(new CommunityError(401, '请先在「社区 → 账号」登录社区。', 'community-signed-out'))).toBe(
      '这台 NekroNXT 还没有登录社区，请管理员先在「社区 → 账号」登录。',
    )
    expect(said(new CommunityError(401, '社区登录已失效，请重新登录。', 'community-signed-out'))).toContain(
      '登录已失效，请管理员在「社区 → 账号」重新登录',
    )
    expect(said(new CommunityError(401, 'Unauthorized'))).toContain('重新登录')
  })

  it('says to wait for the community when it is behind this NekroNXT', () => {
    const behind = new CommunityError(
      400,
      `需要扩展能力等级 ${EXTENSION_SDK_LEVEL}，当前为 ${EXTENSION_SDK_LEVEL - 1}，请升级 NekroNXT。`,
    )
    expect(said(behind)).toContain('等社区更新后再发布，扩展和 NekroNXT 都不用改')
  })

  it('asks for an upgrade when a release needs a newer NekroNXT', () => {
    const upgrade = new CommunityError(409, '这个扩展需要更新版本的 NekroNXT，请先升级。', 'community-upgrade-required')
    expect(said(upgrade)).toBe(
      '这个扩展需要更新版本的 NekroNXT，请先升级。这台 NekroNXT 现在装不了，请告诉管理员先升级 NekroNXT。',
    )
  })

  it('passes on what the community refused, and what to do after a network failure or a missing entry', () => {
    expect(said(new CommunityError(400, '更新说明太长。'))).toBe(
      '社区没有接受：更新说明太长。能按原因改的改好再试，改不了的告诉管理员。',
    )
    for (const code of ['community-unreachable', 'community-timeout'])
      expect(said(new CommunityError(502, '无法连接社区，请检查网络后再试。', code))).toContain('过一会儿再试')
    expect(said(new CommunityError(404, '扩展不存在或尚未公开。', 'community-not-found'))).toBe(
      '社区上找不到：扩展不存在或尚未公开。编号可能写错了，也可能已经下架或撤回；用 nekro_nxt_community_search 重新找。',
    )
    expect(said(new CommunityError(502, '社区返回了无法识别的内容。'))).toContain('社区这次没有给出能用的结果')
    expect(said(new CommunityError(409, '社区或账号已切换，请重新操作。', 'community-identity-changed'))).toContain(
      '重新操作一次',
    )
    const plain = new Error('别的问题。')
    expect(communityErrorForAgent(plain)).toBe(plain)
  })
})

describe('community browsing tools', () => {
  /** A community whose cache always reads fresh, or returns an earlier copy when `stale`. */
  const fakeCommunity = (input: { readonly stale?: boolean; readonly failure?: Error } = {}) => {
    const queries: unknown[] = []
    return {
      queries,
      community: {
        cachedRead: async (
          _kind: string,
          query: Readonly<Record<string, string | undefined>>,
          _refresh: boolean,
          load: () => Promise<object>,
        ) => {
          queries.push(query)
          if (input.failure !== undefined) throw input.failure
          return { ...(await load()), fetchedAt: 1, stale: input.stale === true }
        },
        listExtensions: () => Promise.resolve({ items: [summary(WEATHER), summary(DICE)], nextCursor: 'cursor-2' }),
        getExtension: () => Promise.resolve(detail()),
      },
    }
  }

  const toolsOf = (browser: ReturnType<typeof communityBrowser> | undefined) =>
    Object.fromEntries(communityBrowseTools(() => browser).map((tool) => [tool.name, tool]))

  it('searches through the shared cache and returns compact rows with the next page', async () => {
    const fake = fakeCommunity()
    const tools = toolsOf(communityBrowser(fake.community, local))
    const result = await tools['nekro_nxt_community_search']!.execute(
      { query: ' 天气 ', provides: 'agent', sort: 'score' },
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- The tool reads no execution context.
      {} as never,
    )
    expect(fake.queries).toEqual([{ query: '天气', provides: 'agent', sort: 'score' }])
    expect(result).toMatchObject({
      nextCursor: 'cursor-2',
      items: [
        { id: WEATHER, installed: true, updatable: true },
        { id: DICE, installed: false, updatable: false },
      ],
    })
    expect(result).not.toHaveProperty('note')
  })

  it('says when the result is an earlier copy and words a failure for the agent', async () => {
    const stale = toolsOf(communityBrowser(fakeCommunity({ stale: true }).community, local))
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- The tool reads no execution context.
    await expect(stale['nekro_nxt_community_extension']!.execute({ id: WEATHER }, {} as never)).resolves.toMatchObject({
      name: '示例天气',
      note: '社区这次没连上，下面是稍早取回的结果。',
    })
    const failing = toolsOf(
      communityBrowser(
        fakeCommunity({ failure: new CommunityError(502, '无法连接社区，请检查网络后再试。', 'community-unreachable') })
          .community,
        local,
      ),
    )
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- The tool reads no execution context.
    await expect(failing['nekro_nxt_community_search']!.execute({}, {} as never)).rejects.toThrow('现在连不上社区')
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- The tool reads no execution context.
    await expect(failing['nekro_nxt_community_extension']!.execute({ id: '天气' }, {} as never)).rejects.toThrow(
      '不是社区扩展编号',
    )
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- The tool reads no execution context.
    await expect(toolsOf(undefined)['nekro_nxt_community_search']!.execute({}, {} as never)).rejects.toThrow(
      '没有接入社区',
    )
  })
})

describe('review digest for the publishing agent (#92)', () => {
  const report = (ai: CommunityReviewReport['ai']): CommunityReviewReport => ({
    releaseId: 'rel_fixture',
    status: 'flagged',
    rating: null,
    deterministic: [
      { severity: 'info', title: '体积', detail: '包很小。' },
      { severity: 'risk', title: '访问任意网站', detail: '声明了 unrestricted。', file: 'index.js', line: 3 },
    ],
    ai,
    model: null,
    error: null,
    decisions: [],
    finishedAt: null,
    reportUrl: 'https://community.example/me/releases/rel_fixture',
  })

  it('gives the verdict, the findings worst first, and what earns each missing star', () => {
    const digest = reviewDigest(
      report({
        summary: '能用，但网络异常没有兜底。',
        verdict: '修改后再发',
        compliance: null,
        dimensions: [
          { key: 'reliability', stars: 3, headline: '', notes: '', nextStar: '请求失败时重试并告诉用户。' },
          { key: 'craft', stars: 5, headline: '', notes: '' },
        ],
        findings: [
          {
            dimension: 'usability',
            severity: 'suggestion',
            title: '提示太短',
            detail: '……',
            suggestion: '写明怎么用。',
          },
          { dimension: 'reliability', severity: 'warning', title: '没有超时', detail: '请求会一直等。' },
          { dimension: 'craft', severity: 'info', title: '命名清楚', detail: '……' },
        ],
      }),
    )
    expect(digest).toContain('审查结论：修改后再发')
    expect(digest).toContain('- 访问任意网站：声明了 unrestricted。（index.js:3）')
    expect(digest).not.toContain('体积')
    expect(digest).not.toContain('命名清楚')
    expect(digest.indexOf('没有超时')).toBeLessThan(digest.indexOf('提示太短'))
    expect(digest).toContain('：写明怎么用。')
    expect(digest).toContain('（3 星）：请求失败时重试并告诉用户。')
    expect(digest).not.toContain('5 星')
  })

  it('stays empty when the review has nothing to say', () => {
    expect(reviewDigest({ ...report(null), deterministic: [] })).toBe('')
  })
})
