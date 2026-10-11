import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AssetIdSchema,
  ChannelEventIdSchema,
  CommunityFeedbackCreateSchema,
  CommunityFeedbackDraftInputSchema,
  CommunityFeedbackSchema,
  CommunityFeedbackWithdrawSchema,
  LogicalMessageIdSchema,
  type CommunityFeedback,
  type CommunityFeedbackCreate,
} from '@nekro-nxt/contracts'
import { CoreService } from '@nekro-nxt/core'
import { CoreDatabase, SqliteCoreRepository } from '@nekro-nxt/storage-sqlite'
import { CommunityService } from '../src/community.js'
import { CommunityFeedbackService } from '../src/community-feedback.js'
import { LocalCredentialStore } from '../src/credentials.js'
import {
  collectFeedbackDiagnostics,
  feedbackMessageText,
  redactFeedbackText,
  type FeedbackRedactionContext,
} from '../src/feedback-payload.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const fixtureHome = path.join('/', 'Users', 'fixture')
const fixtureData = path.join(fixtureHome, 'nxt-data')
const fixtureGithubToken = ['github', 'pat', 'fixture0123456789abcdefgh'].join('_')
const fixturePrivateKey = [
  '-----',
  'BEGIN',
  ' PRIVATE KEY-----\nfictional-key\n-----',
  'END',
  ' PRIVATE KEY-----',
].join('')
const redaction: FeedbackRedactionContext = {
  members: [
    { key: 'mbr_first', aliases: ['林舟', '100001001'] },
    { key: 'mbr_second', aliases: ['叶晴', '100001002'] },
  ],
  channels: [{ key: 'chn_sample', aliases: ['样例频道', '200002001'] }],
  accounts: [{ key: 'con_sample', aliases: ['样例账号', '300003001'] }],
  homeDirectory: fixtureHome,
  dataDirectory: fixtureData,
}
const draftInput = (extra: Record<string, unknown> = {}) =>
  CommunityFeedbackDraftInputSchema.parse({
    kind: 'bug',
    target: 'nxt',
    title: '列表刷新问题',
    body: '保存设置后仍然显示旧值。',
    ...extra,
  })

const setup = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nxt-feedback-test-'))
  const database = new CoreDatabase(path.join(directory, 'core.sqlite'))
  database.migrate()
  cleanups.push(async () => {
    database.close()
    await rm(directory, { recursive: true, force: true })
  })
  const repository = new SqliteCoreRepository(database)
  const core = new CoreService(repository)
  const connection = core.createConnection({ adapterKey: 'fixture', config: {} })
  const channelA = core.ensureChannel({
    connectionId: connection.id,
    platformChannelId: 'fixture-a',
    kind: 'group',
    observedAt: 1000,
  })
  const channelB = core.ensureChannel({
    connectionId: connection.id,
    platformChannelId: 'fixture-b',
    kind: 'group',
    observedAt: 1000,
  })
  const agent = core.createAgent({
    displayName: '反馈样例智能体',
    persona: '用虚构样例验证反馈。',
    model: { provider: 'fixture', model: 'fixture' },
  })
  const messageA = LogicalMessageIdSchema.parse('msg_fixtureA')
  const messageB = LogicalMessageIdSchema.parse('msg_fixtureB')
  for (const [channel, message, event] of [
    [channelA, messageA, 'evt_fixtureA'],
    [channelB, messageB, 'evt_fixtureB'],
  ] as const) {
    repository.appendChannelEvent({
      id: ChannelEventIdSchema.parse(event),
      logicalMessageId: message,
      channelId: channel.id,
      kind: 'message-created',
      parts: [{ type: 'text', text: `林舟在样例频道提到了路径 ${fixtureData}/log.txt。` }],
      sourceTimestamp: 1000,
      receivedAt: 1000,
      dedupeKey: event,
      searchText: '虚构消息',
    })
  }
  let time = 1_800_000_000_000
  let userId = 'usr_first'
  let supported = true
  let dropResponse = false
  let nextNumber = 0
  let issued = 0
  let gateRefresh: (() => Promise<void>) | undefined
  const tokens = new Map<string, { origin: string; userId: string }>()
  const remote = new Map<string, CommunityFeedback>()
  const payloads: CommunityFeedbackCreate[] = []
  const requests: Array<{ url: string; authorization: string | null }> = []
  const keyFor = (origin: string, id: string, key: string) => JSON.stringify([origin, id, key])
  const fetcher: typeof fetch = async (raw, init = {}) => {
    const url = new URL(raw instanceof Request ? raw.url : raw)
    const authorization = new Headers(init.headers).get('authorization')
    requests.push({ url: url.toString(), authorization })
    if (url.pathname === '/api/v1/meta')
      return Response.json({
        name: '虚构社区',
        environment: 'staging',
        version: 'fixture',
        ...(supported ? { features: ['feedback'] } : {}),
      })
    if (url.pathname === '/oauth/token') {
      const form = new URLSearchParams(typeof init.body === 'string' ? init.body : '')
      const identity =
        form.get('grant_type') === 'refresh_token'
          ? tokens.get(form.get('refresh_token') ?? '')
          : { origin: url.origin, userId }
      if (gateRefresh && form.get('grant_type') === 'refresh_token') await gateRefresh()
      if (!identity || identity.origin !== url.origin) throw new Error('Token crossed community identities.')
      issued += 1
      const access = `nxtc_at_fixture${issued}`,
        refresh = `nxtc_rt_fixture${issued}`
      tokens.set(access, identity)
      tokens.set(refresh, identity)
      return Response.json({
        access_token: access,
        refresh_token: refresh,
        expires_in: 3600,
        token_type: 'Bearer',
        user: { id: identity.userId, handle: identity.userId, displayName: '虚构账号', avatarUrl: null },
      })
    }
    if (url.pathname === '/oauth/revoke') return new Response(null)
    const identity = tokens.get(authorization?.replace('Bearer ', '') ?? '')
    if (!identity || identity.origin !== url.origin) throw new Error('Request crossed community identities.')
    if (url.pathname === '/api/v1/me')
      return Response.json({ id: identity.userId, handle: identity.userId, displayName: '虚构账号', avatarUrl: null })
    if (url.pathname === '/api/v1/feedback/changes') return Response.json({ events: [], cursor: 0, hasMore: false })
    if (url.pathname === '/api/v1/feedback' && init.method === 'POST') {
      const payload = CommunityFeedbackCreateSchema.parse(JSON.parse(typeof init.body === 'string' ? init.body : '{}'))
      payloads.push(payload)
      const key = keyFor(url.origin, identity.userId, payload.clientRequestId)
      let item = remote.get(key)
      if (!item) {
        nextNumber += 1
        item = CommunityFeedbackSchema.parse({
          id: `fbk_${String(nextNumber).padStart(26, '0')}`,
          ref: `FB-${nextNumber}`,
          title: payload.title,
          kind: payload.kind,
          target: payload.target,
          status: 'new',
          fixedIn: null,
          affectedCount: 0,
          confirmedCount: 0,
          createdAt: time,
          updatedAt: time,
          access: 'owner',
          body: payload.body,
          diagnostics: payload.diagnostics,
          excerpt: payload.excerpt ?? null,
          messages: [],
          events: [],
        })
        remote.set(key, item)
      }
      if (dropResponse) {
        dropResponse = false
        throw new Error('fixture lost response after acceptance')
      }
      return Response.json(item)
    }
    if (url.pathname === '/api/v1/feedback/known') return Response.json({ items: [], cursor: null })
    if (url.pathname === '/api/v1/feedback')
      return Response.json({
        items: [...remote]
          .filter(([key]) => key.startsWith(JSON.stringify([url.origin, identity.userId]).slice(0, -1)))
          .map(([, item]) => item),
        cursor: null,
      })
    const ref = url.pathname.split('/')[4]
    const item = [...remote].find(
      ([key, entry]) => key.startsWith(JSON.stringify([url.origin, identity.userId]).slice(0, -1)) && entry.ref === ref,
    )?.[1]
    if (!item) return Response.json({ error: { code: 'not_found', message: '反馈不存在。' } }, { status: 404 })
    if (url.pathname.endsWith('/withdraw')) {
      const value = CommunityFeedbackWithdrawSchema.parse(JSON.parse(typeof init.body === 'string' ? init.body : '{}'))
      item.status = 'withdrawn'
      item.diagnostics = {}
      item.excerpt = null
      if (value.deleteText) {
        item.title = '已删除'
        item.body = ''
      }
    }
    return Response.json(item)
  }
  const community = new CommunityService(repository, new LocalCredentialStore(path.join(directory, 'credentials')), {
    communityUrl: 'https://community.test',
    fetch: fetcher,
    now: () => time,
  })
  const notices: unknown[] = []
  const sources = {
    redaction: () => redaction,
    diagnostics: () => ({ nxtVersion: '0.5.0', hostKind: 'server' as const }),
    canAutoSubmit: () => true,
    notify: (value: unknown) => {
      notices.push(value)
      return Promise.resolve()
    },
  }
  let service = new CommunityFeedbackService(repository, community, sources, () => time)
  cleanups.push(async () => {
    await service.dispose()
  })
  const signIn = async (id = 'usr_first') => {
    userId = id
    const login = new URL(community.startLogin('http://127.0.0.1:4999'))
    await community.completeLogin(
      new URLSearchParams({ state: login.searchParams.get('state')!, code: 'fixture-code' }),
    )
  }
  await signIn()
  await service.updateSettings(true, true)
  return {
    get service() {
      return service
    },
    repository,
    community,
    payloads,
    remote,
    requests,
    notices,
    channelA: channelA.id,
    channelB: channelB.id,
    agentId: agent.definition.id,
    messageA,
    messageB,
    signIn,
    automatic: { agentId: agent.definition.id, channelId: channelA.id, requestedBy: 'admin-console', automatic: true },
    advance: (ms: number) => {
      time += ms
    },
    dropNextResponse: () => {
      dropResponse = true
    },
    disableSupport: () => {
      supported = false
      time += 6 * 60 * 1000
    },
    setRefreshGate: (gate: () => Promise<void>) => {
      gateRefresh = gate
    },
    restart: async () => {
      await service.dispose()
      service = new CommunityFeedbackService(repository, community, sources, () => time)
      await service.initialize()
    },
  }
}

describe('feedback redaction', () => {
  it('uses one identity mapping across members, channel/account labels and paths', () => {
    const value = redactFeedbackText(
      `林舟（100001001）和叶晴在样例频道 200002001 使用样例账号，日志 ${fixtureData}/log.txt 与 ${fixtureHome}/other.txt。`,
      redaction,
    )
    expect(value).toContain('成员甲（成员甲）和成员乙在群 A 群 A 使用账号 1')
    expect(value).toContain('<data>/log.txt')
    expect(value).toContain('<home>/other.txt')
    expect(value).not.toMatch(/林舟|叶晴|100001001|200002001|300003001|\/Users\/fixture/u)
  })
  it.each([
    fixtureGithubToken,
    'Authorization: Bearer fixture-secret',
    fixturePrivateKey,
    'a9B2c7D4e1F8g5H0i3J6k9L2m7N4o1P8q5R0s3T6u9V2w7X4',
  ])('removes a credential category', (text) => {
    expect(redactFeedbackText(text, redaction)).toBe('<已移除密钥>')
  })
  it('removes Windows/Unix paths and strips attachment names and asset identifiers', () => {
    expect(redactFeedbackText('路径 C:\\Users\\fixture\\test.log 或 /tmp/fixture.log', redaction)).toBe(
      '路径 <本机路径> 或 <本机路径>',
    )
    expect(
      feedbackMessageText([
        { type: 'image', assetId: AssetIdSchema.parse('ast_fixtureImage'), alt: '私人标题' },
        { type: 'file', assetId: AssetIdSchema.parse('ast_fixtureFile'), name: '私人文件.txt' },
      ]),
    ).toBe('附件一份\n附件一份')
    expect(
      collectFeedbackDiagnostics(
        { entries: [{ kind: 'connection', summary: `林舟的 ${fixtureData}/file.log 无法读取。` }] },
        redaction,
      ).entries?.[0]?.summary,
    ).toContain('成员甲的 <data>/file.log')
  })
})

describe('local community feedback', () => {
  it('claims at most five automatic sends when channels submit simultaneously', async () => {
    const fixture = await setup()
    const drafts = await Promise.all(
      Array.from({ length: 7 }, () => fixture.service.createDraft(draftInput(), fixture.automatic)),
    )
    expect(drafts.filter((draft) => draft.state === 'sent')).toHaveLength(5)
    expect(drafts.filter((draft) => draft.state === 'awaiting')).toHaveLength(2)
    expect(fixture.payloads).toHaveLength(5)
  })
  it('does not announce unchanged synchronization as another snapshot mutation', async () => {
    const fixture = await setup()
    await fixture.service.createDraft(draftInput(), fixture.automatic)
    let changes = 0
    const unsubscribe = fixture.service.subscribe(() => {
      changes += 1
    })
    await fixture.service.list(true)
    await fixture.service.list(true)
    expect(changes).toBe(0)
    unsubscribe()
  })
  it('stores redacted drafts, resolves excerpts only from the current channel and rejects supplied excerpt text', async () => {
    const fixture = await setup()
    const draft = await fixture.service.createDraft(
      draftInput({ body: `林舟的密钥 ${fixtureGithubToken}`, conversationRefs: [fixture.messageA] }),
      { ...fixture.automatic, automatic: false },
    )
    expect(draft.body).toBe('成员甲的密钥 <已移除密钥>')
    expect(draft.excerpt?.[0]?.text).toContain('成员甲在群 A')
    await expect(
      fixture.service.createDraft(draftInput({ conversationRefs: [fixture.messageB] }), {
        ...fixture.automatic,
        automatic: false,
      }),
    ).rejects.toThrow('当前频道')
    expect(() => draftInput({ excerpt: [{ speaker: '自行伪造', text: '不读取真实消息。' }] })).toThrow()
    expect(fixture.payloads).toHaveLength(0)
  })
  it('isolates old drafts, mirrors and send records after switching accounts or community origins', async () => {
    const fixture = await setup()
    const draft = await fixture.service.createDraft(draftInput())
    await fixture.service.sendDraft(draft.id)
    expect(fixture.service.lastSent()?.ref).toBe('FB-1')
    await fixture.signIn('usr_second')
    expect(await fixture.service.list()).toEqual({ drafts: [], items: [] })
    expect(fixture.service.lastSent()).toBeNull()
    await expect(fixture.service.sendDraft(draft.id)).rejects.toThrow('草稿不存在')
    await fixture.signIn('usr_first')
    expect((await fixture.service.list()).drafts[0]?.id).toBe(draft.id)
    fixture.community.setEndpoint('https://alternate.test', false)
    expect(await fixture.service.list()).toEqual({ drafts: [], items: [] })
    await fixture.signIn('usr_first')
    expect(await fixture.service.list()).toEqual({ drafts: [], items: [] })
    await expect(fixture.service.sendDraft(draft.id)).rejects.toThrow('草稿不存在')
    fixture.community.setEndpoint('https://community.test', false)
    expect(fixture.service.lastSent()?.ref).toBe('FB-1')
  })
  it('retries uncertain sends with the same idempotency key and recovers interrupted drafts', async () => {
    const fixture = await setup()
    const draft = await fixture.service.createDraft(draftInput())
    fixture.dropNextResponse()
    expect((await fixture.service.sendDraft(draft.id)).state).toBe('failed')
    await fixture.restart()
    expect((await fixture.service.sendDraft(draft.id)).state).toBe('sent')
    expect(fixture.remote.size).toBe(1)
    expect(fixture.payloads.map((payload) => payload.clientRequestId)).toEqual([draft.id, draft.id])
    const pending = await fixture.service.createDraft(draftInput())
    fixture.repository.communityFeedback.claimSend(
      pending.id,
      fixture.community.feedbackIdentity(),
      pending.updatedAt,
      false,
      Date.now(),
    )
    await fixture.restart()
    expect(fixture.repository.communityFeedback.getDraft(pending.id)?.state).toBe('failed')
  })
  it('never auto-sends a member-triggered draft or an excerpt and persists the daily five-item allowance', async () => {
    const fixture = await setup()
    const member = await fixture.service.createDraft(draftInput(), { ...fixture.automatic, requestedBy: 'mbr_first' })
    expect(member.state).toBe('awaiting')
    expect(fixture.payloads).toHaveLength(0)
    for (let index = 0; index < 5; index += 1) {
      const sent = await fixture.service.createDraft(
        draftInput({ conversationRefs: [fixture.messageA] }),
        fixture.automatic,
      )
      expect(sent.state).toBe('sent')
    }
    expect(fixture.payloads).toHaveLength(5)
    expect(
      fixture.payloads.every(
        (payload) =>
          payload.source === 'assistant_auto' && payload.excerpt === undefined && !payload.excerptSharedWithAuthor,
      ),
    ).toBe(true)
    await fixture.restart()
    const overflow = await fixture.service.createDraft(
      draftInput({ conversationRefs: [fixture.messageA] }),
      fixture.automatic,
    )
    expect(overflow.state).toBe('awaiting')
    expect(overflow.excerpt).toHaveLength(1)
    expect(fixture.payloads).toHaveLength(5)
    fixture.advance(86400000)
    expect((await fixture.service.createDraft(draftInput(), fixture.automatic)).state).toBe('sent')
  })
  it('limits agent search/status to feedback originating in its channel', async () => {
    const fixture = await setup()
    await fixture.service.createDraft(draftInput(), fixture.automatic)
    await fixture.service.createDraft(draftInput(), { ...fixture.automatic, channelId: fixture.channelB })
    const own = await fixture.service.statusForChannel(fixture.channelA)
    expect(own.map((item) => item.ref)).toEqual(['FB-1'])
    await expect(fixture.service.statusForChannel(fixture.channelB, 'FB-1')).rejects.toThrow('当前频道')
    expect((await fixture.service.searchForChannel(fixture.channelA, '列表')).map((item) => item.ref)).toEqual(['FB-1'])
  })
  it('clears the local draft and last transmitted copy when text is withdrawn', async () => {
    const fixture = await setup()
    const draft = await fixture.service.createDraft(draftInput())
    await fixture.service.sendDraft(draft.id)
    await fixture.service.act('FB-1', 'withdraw', { deleteText: true })
    expect(fixture.repository.communityFeedback.getDraft(draft.id)).toMatchObject({
      title: '已删除',
      body: '',
      diagnostics: {},
      excerpt: null,
    })
    expect(fixture.service.lastSent()).toBeNull()
    expect((await fixture.service.list()).items[0]).toMatchObject({ title: '已删除', status: 'withdrawn' })
  })
  it('does not expose feedback when an older community omits its feature advertisement', async () => {
    const fixture = await setup()
    fixture.disableSupport()
    expect(await fixture.service.getSettings()).toMatchObject({ supported: false })
    expect(fixture.service.enabled()).toBe(false)
    await expect(fixture.service.updateSettings(true, true)).rejects.toThrow('当前社区不支持')
  })
  it('does not send an old access token to a newly selected community during refresh', async () => {
    const fixture = await setup()
    fixture.advance(3600000)
    let release: (() => void) | undefined
    let started: (() => void) | undefined
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    fixture.setRefreshGate(async () => {
      started?.()
      await blocked
    })
    const identity = fixture.community.feedbackIdentity()
    const operation = fixture.community.listFeedback(identity)
    const rejection = expect(operation).rejects.toThrow('已切换')
    await ready
    fixture.community.setEndpoint('https://alternate.test', false)
    release?.()
    await rejection
    expect(
      fixture.requests.filter((request) => request.url.startsWith('https://alternate.test') && request.authorization),
    ).toEqual([])
  })
  it('does not let an older refresh replace a newly signed-in account on the same community', async () => {
    const fixture = await setup()
    fixture.advance(3600000)
    let release: (() => void) | undefined
    let started: (() => void) | undefined
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    fixture.setRefreshGate(async () => {
      started?.()
      await blocked
    })
    const pending = fixture.community.listFeedback(fixture.community.feedbackIdentity())
    const rejected = expect(pending).rejects.toThrow('已切换')
    await ready
    await fixture.signIn('usr_second')
    release?.()
    await rejected
    expect(fixture.community.feedbackIdentity().communityUserId).toBe('usr_second')
    expect((await fixture.community.listFeedback(fixture.community.feedbackIdentity())).items).toEqual([])
  })
})
