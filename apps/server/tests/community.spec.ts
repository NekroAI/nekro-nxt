import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ExtensionIdSchema, HostApiContracts, type JsonValue } from '@nekro-nxt/contracts'
import type { SystemSettingRecord } from '@nekro-nxt/storage-sqlite'
import {
  CommunityError,
  CommunityService,
  DEFAULT_COMMUNITY_URL,
  normalizeCommunityUrl,
  normalizeReturnOrigin,
} from '../src/community.js'
import { LocalCredentialStore } from '../src/credentials.js'

const COMMUNITY = 'https://community.example.test'
const INSTANCE = 'https://nxt.example.test'
const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const user = { handle: 'demo-author', displayName: '示例作者', avatarUrl: null, role: 'user' }

const summary = (id: string) => ({
  id,
  scope: 'agent',
  displayName: '天气小助手',
  summary: '查询城市天气。',
  tags: ['天气'],
  publisher: { handle: 'demo-author', displayName: '示例作者', avatarUrl: null, extra: 'dropped' },
  latest: {
    id: 'rel_01demo',
    extensionId: id,
    number: 2,
    revisionId: 'xrv_01demo',
    packageSha256: 'a'.repeat(64),
    packageSize: 10,
    requiresSdk: 6,
    notes: '',
    reviewStatus: 'passed',
    grade: 'A',
    permissions: [{ key: 'network', level: 'normal', label: '访问指定网站', detail: 'api.example.com' }],
    createdAt: 1_790_000_000_000,
    withdrawn: false,
  },
  downloads: 3,
  updatedAt: 1_790_000_000_000,
  futureField: true,
})

/** 虚构社区：记录请求并按路径应答，令牌每次刷新都轮换。 */
const createCommunity = () => {
  const requests: { method: string; url: URL; body: BodyInit | null; headers: Headers }[] = []
  let issued = 0
  const challenges = new Map<string, string>()
  let refreshToken = ''
  let failNextRefresh: number | undefined
  const packageBytes = new TextEncoder().encode('fictional-package')
  const tokens = () => {
    issued += 1
    refreshToken = `nxtc_rt_${issued}`
    return {
      access_token: `nxtc_at_${issued}`,
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: refreshToken,
      scope: 'publish',
      user,
    }
  }
  const fetch = (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> =>
    Promise.resolve(respond(new URL(input instanceof Request ? input.url : input), init))
  const respond = (url: URL, init: RequestInit): Response => {
    const body = init.body ?? null
    requests.push({ method: init.method ?? 'GET', url, body, headers: new Headers(init.headers) })
    if (url.origin !== COMMUNITY) throw new Error(`unexpected origin ${url.origin}`)
    if (url.pathname === '/oauth/token') {
      const form = new URLSearchParams(typeof body === 'string' ? body : '')
      if (form.get('grant_type') === 'authorization_code') {
        const challenge = challenges.get(form.get('code') ?? '')
        const actual = createHash('sha256')
          .update(form.get('code_verifier') ?? '')
          .digest('base64url')
        if (challenge !== actual)
          return Response.json({ error: 'invalid_grant', error_description: 'PKCE 校验失败。' }, { status: 400 })
        return Response.json(tokens())
      }
      if (failNextRefresh !== undefined) {
        const status = failNextRefresh
        failNextRefresh = undefined
        return Response.json({ error: 'invalid_grant', error_description: '授权已失效。' }, { status })
      }
      if (form.get('refresh_token') !== refreshToken) return Response.json({ error: 'invalid_grant' }, { status: 400 })
      return Response.json(tokens())
    }
    if (url.pathname === '/oauth/revoke') return new Response(null, { status: 200 })
    if (url.pathname === '/api/v1/meta') {
      return Response.json({ name: '示例社区', environment: 'staging', version: 'v-fixture', apiVersion: 1 })
    }
    if (url.pathname === '/api/v1/updates') {
      const request = z
        .object({ items: z.array(z.object({ extensionId: z.string(), releaseId: z.string() })) })
        .parse(JSON.parse(typeof body === 'string' ? body : '{}'))
      return Response.json({
        items: request.items.map((item) => ({
          ...item,
          found: true,
          delisted: false,
          delistedReason: null,
          releaseWithdrawn: item.releaseId === 'rel_01withdrawn',
          latest: { ...summary(item.extensionId).latest, id: 'rel_01newer', futureField: 1 },
          addedPermissions: [{ key: 'history', level: 'high', label: '读取当前频道的聊天记录' }],
        })),
      })
    }
    if (url.pathname === '/api/v1/me/extensions') {
      return Response.json({
        items: [
          {
            ...summary('ext_01DEMO'),
            description: '',
            sourceUrl: null,
            review: null,
            releases: [{ ...summary('ext_01DEMO').latest, withdrawn: true }],
            delisted: false,
            delistedReason: null,
          },
        ],
      })
    }
    if (url.pathname === '/api/v1/releases/rel_01demo/review') {
      return Response.json({
        releaseId: 'rel_01demo',
        status: 'passed_with_notes',
        grade: 'A',
        deterministic: [{ id: 'x', severity: 'warning', title: '网络访问不受限', detail: '说明' }],
        ai: {
          summary: '良好。',
          verdict: 'pass_with_notes',
          grade: 'A',
          dimensions: [{ key: 'security', grade: 'A', notes: '良好' }],
          findings: [
            { dimension: 'usability', severity: 'suggestion', title: '补充说明', detail: '细节', suggestion: '建议' },
          ],
        },
        model: '示例模型',
        error: null,
        decisions: [],
        startedAt: 1,
        finishedAt: 2,
      })
    }
    if (url.pathname === '/api/v1/extensions')
      return Response.json({
        items: [
          summary('ext_01DEMO'),
          { ...summary('ext_01ICON'), iconUrl: `${COMMUNITY}/api/v1/extensions/ext_01ICON/icon?v=abcdef012345` },
          { ...summary('ext_01BADICON'), iconUrl: 'javascript:alert(1)' },
        ],
        nextCursor: null,
      })
    if (url.pathname === '/api/v1/extensions/ext_01DEMO') {
      return Response.json({
        ...summary('ext_01DEMO'),
        description: '详细介绍',
        sourceUrl: null,
        releases: [],
        review: { status: 'passed', grade: 'A', summary: '良好。', highlights: [], reviewedAt: 1 },
      })
    }
    if (url.pathname === '/api/v1/extensions/ext_MISSING') {
      return Response.json({ error: { code: 'not_found', message: '扩展不存在或尚未公开。' } }, { status: 404 })
    }
    if (url.pathname === '/api/v1/releases/rel_01demo') {
      return Response.json({
        id: 'rel_01demo',
        packageSha256: createHash('sha256').update(packageBytes).digest('hex'),
        packageSize: packageBytes.byteLength,
      })
    }
    if (url.pathname === '/api/v1/releases/rel_01tampered') {
      return Response.json({
        id: 'rel_01tampered',
        packageSha256: 'b'.repeat(64),
        packageSize: packageBytes.byteLength,
      })
    }
    if (url.pathname.endsWith('/package')) return new Response(packageBytes)
    if (url.pathname === '/api/v1/releases' && init.method === 'POST') {
      if (new Headers(init.headers).get('authorization') !== `Bearer nxtc_at_${issued}`) {
        return Response.json({ error: { code: 'invalid_token', message: '访问令牌无效。' } }, { status: 401 })
      }
      return Response.json(
        {
          extension: { id: 'ext_01DEMO' },
          release: { id: 'rel_01new', number: 3, reviewStatus: 'pending' },
          findings: [{ id: 'manifest.no-requires', severity: 'info', title: '未声明最低能力等级', detail: '' }],
        },
        { status: 201 },
      )
    }
    return new Response('not found', { status: 404 })
  }
  return {
    fetch,
    requests,
    approve(authorizeUrl: string) {
      const url = new URL(authorizeUrl)
      const code = `code-${challenges.size + 1}`
      challenges.set(code, url.searchParams.get('code_challenge') ?? '')
      return new URLSearchParams({ code, state: url.searchParams.get('state') ?? '' })
    },
    failNextRefresh(status: number) {
      failNextRefresh = status
    },
  }
}

const createFixture = async (communityUrl = COMMUNITY) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nekro-nxt-community-'))
  temporaryRoots.push(root)
  const records = new Map<string, SystemSettingRecord>()
  const repository = {
    getSystemSetting: (key: string) => records.get(key),
    putSystemSetting: (key: string, value: JsonValue, expectedRevision: number | undefined, updatedAt: number) => {
      // 与 SQLite 的 system_settings.value NOT NULL 一致。
      if (value === null) throw new Error('NOT NULL constraint failed: system_settings.value')
      const current = records.get(key)
      if (current?.revision !== expectedRevision) throw new Error('System setting revision conflict.')
      const record = { key, value, revision: (current?.revision ?? 0) + 1, updatedAt }
      records.set(key, record)
      return record
    },
  }
  const credentialRoot = path.join(root, 'credentials')
  const credentials = new LocalCredentialStore(credentialRoot)
  const community = createCommunity()
  let now = 1_790_000_000_000
  const service = new CommunityService(repository, credentials, {
    communityUrl,
    fetch: community.fetch,
    now: () => now,
  })
  return {
    service,
    community,
    repository,
    credentials,
    credentialFiles: async () =>
      (await readdir(credentialRoot).catch(() => [])).filter((name) => !name.includes('.staging')),
    advance: (ms: number) => {
      now += ms
    },
    signIn: async () => service.completeLogin(community.approve(service.startLogin(INSTANCE))),
  }
}

describe('community URLs', () => {
  it('defaults to the official community and only accepts HTTPS or loopback HTTP origins', () => {
    expect(normalizeCommunityUrl(undefined)).toBe(DEFAULT_COMMUNITY_URL)
    expect(normalizeCommunityUrl('  ')).toBe(DEFAULT_COMMUNITY_URL)
    expect(normalizeCommunityUrl('http://localhost:5180')).toBe('http://localhost:5180')
    expect(() => normalizeCommunityUrl('http://community.example.test')).toThrow('HTTPS')
    expect(() => normalizeCommunityUrl('https://community.example.test/path')).toThrow('只能包含')
    expect(normalizeReturnOrigin('http://nas.example.test:4960/settings/community')).toBe(
      'http://nas.example.test:4960',
    )
    expect(() => normalizeReturnOrigin('javascript:alert(1)')).toThrow()
  })
})

describe('CommunityService sign-in', () => {
  it('signs in with PKCE, keeps the refresh token in the credential store and the account in settings', async () => {
    const { service, repository, signIn, credentialFiles } = await createFixture()
    expect(await service.status()).toEqual({
      communityUrl: COMMUNITY,
      environment: 'staging',
      account: null,
      signedInAt: null,
      updatesAvailable: 0,
    })
    const authorize = new URL(service.startLogin(INSTANCE))
    expect(authorize.origin + authorize.pathname).toBe(`${COMMUNITY}/oauth/authorize`)
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${INSTANCE}/community/callback`)
    const account = await signIn()
    expect(account).toEqual({ handle: 'demo-author', displayName: '示例作者', avatarUrl: null })
    expect((await service.status()).account?.handle).toBe('demo-author')
    expect(JSON.stringify(repository.getSystemSetting('community.accounts'))).not.toContain('nxtc_rt_')
    expect(await credentialFiles()).toHaveLength(1)
  })

  it('accepts each state once and reports denial and expiry', async () => {
    const { service, community, advance } = await createFixture()
    const params = community.approve(service.startLogin(INSTANCE))
    await service.completeLogin(params)
    await expect(service.completeLogin(params)).rejects.toMatchObject({ code: 'community-login-expired' })
    const denied = new URL(service.startLogin(INSTANCE)).searchParams.get('state') ?? ''
    await expect(
      service.completeLogin(new URLSearchParams({ state: denied, error: 'access_denied' })),
    ).rejects.toMatchObject({
      code: 'community-login-denied',
    })
    const late = community.approve(service.startLogin(INSTANCE))
    advance(11 * 60_000)
    await expect(service.completeLogin(late)).rejects.toBeInstanceOf(CommunityError)
    const missingCode = new URL(service.startLogin(INSTANCE)).searchParams.get('state') ?? ''
    await expect(service.completeLogin(new URLSearchParams({ state: missingCode }))).rejects.toMatchObject({
      code: 'community-login-failed',
    })
  })

  it('rotates the refresh token once for concurrent requests and replaces the stored credential', async () => {
    const { service, community, signIn, advance, credentialFiles } = await createFixture()
    await signIn()
    advance(2 * 60 * 60_000)
    const [first, second] = await Promise.all([
      service.publish({ filename: 'weather.nxt-extension', body: new Uint8Array([1]), notes: '' }),
      service.publish({ filename: 'weather.nxt-extension', body: new Uint8Array([1]), notes: '' }),
    ])
    expect(first.releaseId).toBe('rel_01new')
    expect(second.reportUrl).toBe(`${COMMUNITY}/me/releases/rel_01new`)
    expect(community.requests.filter((request) => request.url.pathname === '/oauth/token')).toHaveLength(2)
    expect(await credentialFiles()).toHaveLength(1)
  })

  it('signs out locally when the community rejects the refresh token', async () => {
    const { service, community, signIn, advance, credentialFiles } = await createFixture()
    await signIn()
    advance(2 * 60 * 60_000)
    community.failNextRefresh(400)
    await expect(
      service.publish({ filename: 'x.nxt-extension', body: new Uint8Array([1]), notes: '' }),
    ).rejects.toMatchObject({
      code: 'community-signed-out',
    })
    expect((await service.status()).account).toBeNull()
    expect(await credentialFiles()).toHaveLength(0)
  })

  it('keeps the sign-in when the community is temporarily unavailable', async () => {
    const { service, community, signIn, advance } = await createFixture()
    await signIn()
    advance(2 * 60 * 60_000)
    community.failNextRefresh(503)
    await expect(
      service.publish({ filename: 'x.nxt-extension', body: new Uint8Array([1]), notes: '' }),
    ).rejects.toMatchObject({
      code: 'community-request-failed',
    })
    expect((await service.status()).account?.handle).toBe('demo-author')
  })

  it('logs out, revokes at the community and forgets a sign-in made against another community URL', async () => {
    const { service, community, signIn, credentialFiles, repository, credentials } = await createFixture()
    await signIn()
    await expect(service.publish({ filename: 'x', body: new Uint8Array([1]), notes: '' })).resolves.toBeDefined()
    expect((await service.logout()).account).toBeNull()
    expect(community.requests.some((request) => request.url.pathname === '/oauth/revoke')).toBe(true)
    expect(await credentialFiles()).toHaveLength(0)
    await expect(service.publish({ filename: 'x', body: new Uint8Array([1]), notes: '' })).rejects.toMatchObject({
      code: 'community-signed-out',
    })

    await signIn()
    const other = new CommunityService(repository, credentials, { communityUrl: 'https://other.example.test' })
    expect((await other.status()).account).toBeNull()
  })
})

describe('CommunityService endpoint', () => {
  it('prefers the configured address over the environment and default, and keeps logins per address', async () => {
    const { service, signIn } = await createFixture()
    expect(service.endpoint()).toMatchObject({ url: COMMUNITY, source: 'environment', insecure: false })
    await signIn()
    expect(() => service.setEndpoint('http://community-dev.lan:5180', false)).toThrow('确认风险')
    expect(() => service.setEndpoint('http://community.example.org', true)).toThrow('HTTPS')
    expect(service.setEndpoint('http://community-dev.lan:5180', true)).toMatchObject({
      url: 'http://community-dev.lan:5180',
      source: 'setting',
      insecure: true,
    })
    expect((await service.status()).account).toBeNull()
    // 私有 IPv4 段同样按局域网处理（地址由片段拼接，避免在仓库中出现字面 IP）。
    const privateIp = ['10', '0', '0', '8'].join('.')
    expect(() => service.setEndpoint(`http://${privateIp}:5180`, false)).toThrow('确认风险')
    expect(service.setEndpoint(null, false)).toMatchObject({ url: COMMUNITY, source: 'environment' })
    expect((await service.status()).account?.handle).toBe('demo-author')
  })

  it('tests a candidate address without changing the configuration', async () => {
    const { service } = await createFixture()
    expect(await service.testEndpoint(COMMUNITY, false)).toMatchObject({ ok: true, environment: 'staging' })
    expect(await service.testEndpoint('https://unknown.example.test', false)).toMatchObject({ ok: false })
    expect(service.endpoint().source).toBe('environment')
  })

  it('migrates a sign-in stored by earlier versions', async () => {
    const { service, repository, credentials } = await createFixture()
    const reference = await credentials.save('nxtc_rt_legacy')
    repository.putSystemSetting(
      'community.account',
      {
        version: 1,
        communityUrl: COMMUNITY,
        account: { handle: 'legacy-author', displayName: '旧账号', avatarUrl: null },
        refreshTokenRef: reference,
        signedInAt: 1,
      },
      undefined,
      1,
    )
    expect((await service.status()).account?.handle).toBe('legacy-author')
  })
})

describe('CommunityService installed extensions and authoring', () => {
  const source = (releaseId: string, communityUrl = COMMUNITY) => ({
    kind: 'community' as const,
    communityUrl,
    releaseId,
    publisherHandle: 'demo-author',
    installedAt: 1,
  })

  it('checks updates only for extensions from the current community and caches the count', async () => {
    const { service } = await createFixture()
    const result = await service.installed([
      {
        extensionId: ExtensionIdSchema.parse('ext_01DEMO'),
        displayName: '天气小助手',
        revisionId: 'xrv_a',
        source: source('rel_01demo'),
      },
      {
        extensionId: ExtensionIdSchema.parse('ext_01OTHER'),
        displayName: '旧社区扩展',
        revisionId: 'xrv_b',
        source: source('rel_01x', 'https://old.example.test'),
      },
      {
        extensionId: ExtensionIdSchema.parse('ext_01GONE'),
        displayName: '已撤回',
        revisionId: 'xrv_c',
        source: source('rel_01withdrawn'),
      },
    ])
    expect(result.items[0]).toMatchObject({ sameCommunity: true, updateAvailable: true, latest: { id: 'rel_01newer' } })
    expect(result.items[0]?.latest).not.toHaveProperty('futureField')
    expect(result.items[0]?.addedPermissions.map((item) => item.key)).toEqual(['history'])
    expect(result.items[1]).toMatchObject({ sameCommunity: false, found: false, updateAvailable: false })
    expect(result.items[2]).toMatchObject({ releaseWithdrawn: true })
    expect((await service.status()).updatesAvailable).toBe(2)
    expect(service.cachedInstalled()?.items).toHaveLength(3)
    // 缓存直接作为 listCommunityInstalled 的响应返回，必须通过严格的响应校验。
    expect(() => HostApiContracts.listCommunityInstalled.response.parse(service.cachedInstalled())).not.toThrow()
  })

  it('lists my extensions and reads review reports when signed in', async () => {
    const { service, signIn } = await createFixture()
    await expect(service.mine()).rejects.toMatchObject({ code: 'community-signed-out' })
    await signIn()
    const mine = await service.mine()
    expect(mine[0]?.releases[0]).toMatchObject({ id: 'rel_01demo', withdrawn: true })
    const report = await service.review('rel_01demo')
    expect(report).toMatchObject({
      status: 'passed_with_notes',
      reportUrl: `${COMMUNITY}/me/releases/rel_01demo`,
      ai: { findings: [{ suggestion: '建议' }] },
    })
    expect(report.deterministic[0]).not.toHaveProperty('id')
  })
})

describe('CommunityService catalog', () => {
  it('normalizes listings and details, dropping fields NekroNXT does not know', async () => {
    const { service, community } = await createFixture()
    const list = await service.listExtensions({ query: '天气', scope: 'agent' })
    expect(list.items[0]).toMatchObject({
      id: 'ext_01DEMO',
      pageUrl: `${COMMUNITY}/extensions/ext_01DEMO`,
      publisher: { handle: 'demo-author', displayName: '示例作者', avatarUrl: null },
    })
    expect(list.items[0]).not.toHaveProperty('futureField')
    // 旧版社区没有图标字段；只接受 http(s) 图标地址。
    expect(list.items.map((item) => item.iconUrl)).toEqual([
      null,
      `${COMMUNITY}/api/v1/extensions/ext_01ICON/icon?v=abcdef012345`,
      null,
    ])
    expect(list.items[0]?.latest).not.toHaveProperty('packageSha256')
    expect(community.requests.at(-1)?.url.searchParams.get('q')).toBe('天气')
    const detail = await service.getExtension('ext_01DEMO')
    expect(detail.review).toEqual({ status: 'passed', grade: 'A', summary: '良好。', highlights: [] })
    await expect(service.getExtension('ext_MISSING')).rejects.toMatchObject({
      status: 404,
      message: '扩展不存在或尚未公开。',
    })
  })

  it('submits only the listing fields the author provided with a release', async () => {
    const { service, community, signIn } = await createFixture()
    await signIn()
    await service.publish({ filename: 'weather.nxt-extension', body: new Uint8Array([1]), notes: '修复' })
    const lastForm = (): FormData => {
      const body = community.requests.at(-1)?.body
      if (!(body instanceof FormData)) throw new Error('发布请求应是 multipart 表单。')
      return body
    }
    expect([...lastForm().keys()].sort()).toEqual(['notes', 'package'])
    await service.publish({
      filename: 'weather.nxt-extension',
      body: new Uint8Array([1]),
      notes: '',
      listing: {
        summary: '查询城市天气。',
        description: '## 用法\n\n问「示例市天气」。',
        tags: ['天气', '提醒'],
        sourceUrl: 'https://example.com/weather',
      },
    })
    const form = lastForm()
    expect(form.get('summary')).toBe('查询城市天气。')
    expect(form.get('description')).toBe('## 用法\n\n问「示例市天气」。')
    const tags = form.get('tags')
    expect(typeof tags === 'string' ? JSON.parse(tags) : tags).toEqual(['天气', '提醒'])
    expect(form.get('sourceUrl')).toBe('https://example.com/weather')
  })

  it('downloads a release only when it matches the recorded digest', async () => {
    const { service } = await createFixture()
    expect(new TextDecoder().decode(await service.downloadRelease('rel_01demo'))).toBe('fictional-package')
    await expect(service.downloadRelease('rel_01tampered')).rejects.toThrow('不一致')
  })

  it('reports unreachable communities as readable errors', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'nekro-nxt-community-'))
    temporaryRoots.push(root)
    const service = new CommunityService(
      {
        getSystemSetting: () => undefined,
        putSystemSetting: () => {
          throw new Error('unused')
        },
      },
      new LocalCredentialStore(path.join(root, 'credentials')),
      { communityUrl: COMMUNITY, fetch: () => Promise.reject(new TypeError('fetch failed')) },
    )
    await expect(service.listExtensions({})).rejects.toThrow('无法连接社区')
  })
})
