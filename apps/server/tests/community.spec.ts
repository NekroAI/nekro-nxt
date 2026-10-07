import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { JsonValue } from '@nekro-nxt/contracts'
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
    if (url.pathname === '/api/v1/extensions')
      return Response.json({ items: [summary('ext_01DEMO')], nextCursor: null })
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
  let record: SystemSettingRecord | undefined
  const repository = {
    getSystemSetting: () => record,
    putSystemSetting: (key: string, value: JsonValue, expectedRevision: number | undefined, updatedAt: number) => {
      if (record?.revision !== expectedRevision) throw new Error('System setting revision conflict.')
      record = { key, value, revision: (record?.revision ?? 0) + 1, updatedAt }
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
    expect(service.status()).toEqual({ communityUrl: COMMUNITY, account: null, signedInAt: null })
    const authorize = new URL(service.startLogin(INSTANCE))
    expect(authorize.origin + authorize.pathname).toBe(`${COMMUNITY}/oauth/authorize`)
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${INSTANCE}/community/callback`)
    const account = await signIn()
    expect(account).toEqual({ handle: 'demo-author', displayName: '示例作者', avatarUrl: null })
    expect(service.status().account?.handle).toBe('demo-author')
    expect(JSON.stringify(repository.getSystemSetting())).not.toContain('nxtc_rt_')
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
    expect(service.status().account).toBeNull()
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
    expect(service.status().account?.handle).toBe('demo-author')
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
    expect(other.status().account).toBeNull()
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
    expect(list.items[0]?.latest).not.toHaveProperty('packageSha256')
    expect(community.requests.at(-1)?.url.searchParams.get('q')).toBe('天气')
    const detail = await service.getExtension('ext_01DEMO')
    expect(detail.review).toEqual({ status: 'passed', grade: 'A', summary: '良好。', highlights: [] })
    await expect(service.getExtension('ext_MISSING')).rejects.toMatchObject({
      status: 404,
      message: '扩展不存在或尚未公开。',
    })
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
