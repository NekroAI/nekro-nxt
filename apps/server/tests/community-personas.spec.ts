import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AgentIdSchema,
  AgentRevisionIdSchema,
  ChannelIdSchema,
  HostApiContracts,
  promptDocumentPlainText,
  type AgentId,
  type AgentRevisionId,
  type JsonValue,
} from '@nekro-nxt/contracts'
import type { AgentRevisionContent } from '@nekro-nxt/core'
import type { SystemSettingRecord } from '@nekro-nxt/storage-sqlite'
import { CommunityService } from '../src/community.js'
import {
  CommunityPersonaService,
  installCommunityPersona,
  sniffPersonaAvatar,
  type PersonaInstallTarget,
} from '../src/community-personas.js'
import { LocalCredentialStore } from '../src/credentials.js'

const COMMUNITY = 'https://community.example.test'
const INSTANCE = 'https://nxt.example.test'
const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** 社区收到的 multipart 表单。 */
const formOf = (body: BodyInit | null | undefined): FormData => {
  if (!(body instanceof FormData)) throw new Error('expected a form body')
  return body
}

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const user = { handle: 'demo-author', displayName: '示例作者', avatarUrl: null }

const personaSummary = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: '温柔的图书管理员',
  summary: '轻声细语，帮你找书。',
  tags: ['陪伴', 42, '图书'],
  avatarUrl: `${COMMUNITY}/api/v1/personas/${id}/avatar?v=abc123def456`,
  official: false,
  publisher: { handle: 'demo-author', displayName: '示例作者', avatarUrl: null, extra: 'dropped' },
  installs: 7,
  updatedAt: 1_790_000_000_000,
  futureField: true,
  ...extra,
})

const personaDetail = (id: string) => ({
  ...personaSummary(id),
  description: '## 介绍\n适合读书会频道。',
  persona: '你是一位温柔的图书管理员，说话轻声细语。',
  revision: { id: 'prv_01REVA', notes: '首次发布', createdAt: 1_790_000_000_000 },
  review: { status: 'approved', summary: '内容合规。', model: 'dropped' },
})

/** 虚构社区：只实现人设相关接口与登录。 */
const createCommunity = () => {
  const requests: { method: string; url: URL; body: BodyInit | null; headers: Headers }[] = []
  const challenges = new Map<string, string>()
  let issued = 0
  let avatarFails = false
  const tokens = () => {
    issued += 1
    return {
      access_token: `nxtc_at_${issued}`,
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: `nxtc_rt_${issued}`,
      user,
    }
  }
  const respond = (url: URL, init: RequestInit): Response => {
    const body = init.body ?? null
    const method = init.method ?? 'GET'
    requests.push({ method, url, body, headers: new Headers(init.headers) })
    if (url.pathname === '/oauth/token') {
      const form = new URLSearchParams(typeof body === 'string' ? body : '')
      const challenge = challenges.get(form.get('code') ?? '')
      const actual = createHash('sha256')
        .update(form.get('code_verifier') ?? '')
        .digest('base64url')
      return challenge === actual ? Response.json(tokens()) : Response.json({ error: 'invalid_grant' }, { status: 400 })
    }
    if (url.pathname === '/api/v1/meta')
      return Response.json({ name: '示例社区', environment: 'staging', version: 'x' })
    if (url.pathname === '/api/v1/personas' && method === 'GET') {
      return Response.json({
        items: [personaSummary('psn_01ALPHA'), { id: 'broken' }, personaSummary('psn_01BETA', { avatarUrl: null })],
        nextCursor: 'cursor-2',
      })
    }
    if (url.pathname === '/api/v1/personas/psn_01ALPHA') return Response.json(personaDetail('psn_01ALPHA'))
    if (url.pathname === '/api/v1/personas/psn_MISSING') {
      return Response.json({ error: { code: 'not_found', message: '人设不存在或尚未公开。' } }, { status: 404 })
    }
    if (url.pathname === '/api/v1/personas/psn_01ALPHA/avatar') {
      if (avatarFails) return new Response('gone', { status: 500 })
      return new Response(PNG, { headers: { 'content-type': 'image/png' } })
    }
    if (url.pathname === '/api/v1/personas/psn_01ALPHA/installs' && method === 'POST') {
      return new Response(null, { status: 204 })
    }
    const authorized = new Headers(init.headers).get('authorization') === `Bearer nxtc_at_${issued}`
    if (url.pathname === '/api/v1/me/personas') {
      if (!authorized) return Response.json({ error: { message: '未登录。' } }, { status: 401 })
      return Response.json({
        items: [
          {
            ...personaSummary('psn_01MINE'),
            status: 'listed',
            latestRevision: { id: 'prv_01MINE', createdAt: 1, reviewStatus: 'flagged', reviewSummary: '需要复核。' },
          },
          {
            ...personaSummary('psn_01DRAFT'),
            status: 'delisted',
            latestRevision: { id: 'prv_01DRAFT', createdAt: 1, reviewStatus: 'unknown-future', reviewSummary: null },
          },
        ],
      })
    }
    if (url.pathname === '/api/v1/personas' && method === 'POST') {
      if (!authorized) return Response.json({ error: { message: '未登录。' } }, { status: 401 })
      const form = formOf(body)
      const personaId = form.get('personaId')
      return Response.json(
        {
          ...personaSummary(typeof personaId === 'string' ? personaId : 'psn_01NEW', { name: form.get('name') }),
          status: 'listed',
          latestRevision: { id: 'prv_01NEW', createdAt: 2, reviewStatus: 'pending', reviewSummary: null },
        },
        { status: 201 },
      )
    }
    return new Response('not found', { status: 404 })
  }
  return {
    requests,
    fetch: (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> =>
      Promise.resolve(respond(new URL(input instanceof Request ? input.url : input), init)),
    approve(authorizeUrl: string) {
      const url = new URL(authorizeUrl)
      const code = `code-${challenges.size + 1}`
      challenges.set(code, url.searchParams.get('code_challenge') ?? '')
      return new URLSearchParams({ code, state: url.searchParams.get('state') ?? '' })
    },
    failAvatar() {
      avatarFails = true
    },
  }
}

const createFixture = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nekro-nxt-personas-'))
  temporaryRoots.push(root)
  const records = new Map<string, SystemSettingRecord>()
  const repository = {
    getSystemSetting: (key: string) => records.get(key),
    putSystemSetting: (key: string, value: JsonValue, expectedRevision: number | undefined, updatedAt: number) => {
      const current = records.get(key)
      if (current?.revision !== expectedRevision) throw new Error('System setting revision conflict.')
      const record = { key, value, revision: (current?.revision ?? 0) + 1, updatedAt }
      records.set(key, record)
      return record
    },
  }
  const community = createCommunity()
  const service = new CommunityService(repository, new LocalCredentialStore(path.join(root, 'credentials')), {
    communityUrl: COMMUNITY,
    fetch: community.fetch,
  })
  const personas = new CommunityPersonaService(service, repository)
  return {
    personas,
    community,
    signIn: async () => service.completeLogin(community.approve(service.startLogin(INSTANCE))),
  }
}

/** 虚构的本机智能体存储：记录创建、修订与头像上传。 */
const createTarget = () => {
  const agentId = AgentIdSchema.parse('agt_01existing')
  const revisions = new Map<AgentId, AgentRevisionContent & { id: AgentRevisionId }>([
    [
      agentId,
      {
        id: AgentRevisionIdSchema.parse('arev_01current'),
        displayName: '资料员',
        persona: '严谨、简洁',
        model: { provider: 'fixture', model: 'fixture-model' },
        capabilities: { subagents: false, fileTools: true },
        dynamicClientApprovalPolicy: 'manual',
      },
    ],
  ])
  const avatars: AgentId[] = []
  let next = 0
  const target: PersonaInstallTarget = {
    defaultCapabilities: () => Promise.resolve({ subagents: true, fileTools: false }),
    createAgent: (content) => {
      const id = AgentIdSchema.parse('agt_01installed')
      revisions.set(id, { ...content, id: AgentRevisionIdSchema.parse('arev_01created') })
      return Promise.resolve({ agentId: id, channelId: ChannelIdSchema.parse('chn_01installed') })
    },
    currentRevision: (id) => revisions.get(id),
    reviseAgent: (id, expected, content) => {
      if (revisions.get(id)?.id !== expected) throw new Error('conflict')
      next += 1
      const revision = { ...content, id: AgentRevisionIdSchema.parse(`arev_01next${next}`) }
      revisions.set(id, revision)
      return revision.id
    },
    uploadAvatar: (id) => {
      avatars.push(id)
      return Promise.resolve()
    },
  }
  return { target, revisions, avatars, agentId }
}

describe('CommunityPersonaService catalog', () => {
  it('reads listings leniently, skips broken items and proxies avatars through the instance', async () => {
    const { personas, community } = await createFixture()
    const list = await personas.list({ query: '图书', tag: '陪伴', official: '1' })
    expect(list.nextCursor).toBe('cursor-2')
    expect(list.items.map((item) => item.id)).toEqual(['psn_01ALPHA', 'psn_01BETA'])
    expect(list.items[0]).toMatchObject({
      tags: ['陪伴', '图书'],
      avatarUrl: '/api/community/personas/psn_01ALPHA/avatar?v=abc123def456',
      pageUrl: `${COMMUNITY}/personas/psn_01ALPHA`,
      publisher: { handle: 'demo-author', displayName: '示例作者', avatarUrl: null },
      installs: 7,
    })
    expect(list.items[0]).not.toHaveProperty('futureField')
    expect(list.items[1]?.avatarUrl).toBeNull()
    const sent = community.requests.at(-1)?.url
    expect([sent?.searchParams.get('q'), sent?.searchParams.get('tag'), sent?.searchParams.get('official')]).toEqual([
      '图书',
      '陪伴',
      '1',
    ])
    expect(() => HostApiContracts.listCommunityPersonas.response.parse(list)).not.toThrow()
  })

  it('reads details with the persona body and light review, and reports missing personas', async () => {
    const { personas } = await createFixture()
    const detail = await personas.get('psn_01ALPHA')
    expect(detail).toMatchObject({
      persona: '你是一位温柔的图书管理员，说话轻声细语。',
      revision: { id: 'prv_01REVA', notes: '首次发布' },
      review: { status: 'approved', summary: '内容合规。' },
    })
    expect(detail.review).not.toHaveProperty('model')
    expect(() => HostApiContracts.getCommunityPersona.response.parse(detail)).not.toThrow()
    await expect(personas.get('psn_MISSING')).rejects.toMatchObject({ status: 404, message: '人设不存在或尚未公开。' })
  })

  it('serves avatars only when they are real PNG, JPEG or WebP images', async () => {
    const { personas } = await createFixture()
    expect((await personas.avatar('psn_01ALPHA', 'abc123def456')).mediaType).toBe('image/png')
    expect(sniffPersonaAvatar(new TextEncoder().encode('<svg></svg>'))).toBeUndefined()
    expect(sniffPersonaAvatar(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffPersonaAvatar(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe(
      'image/webp',
    )
  })
})

describe('installCommunityPersona', () => {
  it('creates a new agent with a matching persona document, the community avatar and an install count', async () => {
    const { personas, community } = await createFixture()
    const { target, revisions, avatars } = createTarget()
    const result = await installCommunityPersona(personas, target, 'psn_01ALPHA', {
      target: 'new',
      expectedRevisionId: 'prv_01REVA',
      displayName: '图书管理员',
      model: { provider: 'fixture', model: 'fixture-model' },
      useAvatar: true,
    })
    expect(result).toEqual({
      agentId: 'agt_01installed',
      channelId: 'chn_01installed',
      currentRevisionId: 'arev_01created',
      avatar: 'applied',
    })
    const created = revisions.get(result.agentId)
    expect(created?.displayName).toBe('图书管理员')
    expect(created?.persona).toBe('你是一位温柔的图书管理员，说话轻声细语。')
    expect(created?.personaDocument && promptDocumentPlainText(created.personaDocument)).toBe(created?.persona)
    expect(created?.capabilities).toEqual({ subagents: true, fileTools: false })
    expect(avatars).toEqual(['agt_01installed'])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(community.requests.some((request) => request.url.pathname.endsWith('/installs'))).toBe(true)
  })

  it('replaces only the persona (and optionally the name) of an existing agent as a new revision', async () => {
    const { personas, community } = await createFixture()
    const { target, revisions, avatars, agentId } = createTarget()
    community.failAvatar()
    const result = await installCommunityPersona(personas, target, 'psn_01ALPHA', {
      target: 'replace',
      expectedRevisionId: 'prv_01REVA',
      agentId,
      expectedCurrentRevisionId: AgentRevisionIdSchema.parse('arev_01current'),
      useAvatar: true,
    })
    expect(result).toMatchObject({ agentId, channelId: null, currentRevisionId: 'arev_01next1', avatar: 'failed' })
    expect(revisions.get(agentId)).toMatchObject({
      displayName: '资料员',
      persona: '你是一位温柔的图书管理员，说话轻声细语。',
      model: { provider: 'fixture', model: 'fixture-model' },
      capabilities: { subagents: false, fileTools: true },
      dynamicClientApprovalPolicy: 'manual',
    })
    expect(avatars).toEqual([])
  })

  it('refuses stale persona revisions and stale agent revisions', async () => {
    const { personas } = await createFixture()
    const { target, agentId } = createTarget()
    await expect(
      installCommunityPersona(personas, target, 'psn_01ALPHA', {
        target: 'new',
        expectedRevisionId: 'prv_01OLDER',
        displayName: '图书管理员',
        model: { provider: 'fixture', model: 'fixture-model' },
        useAvatar: false,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'community-persona-changed' })
    await expect(
      installCommunityPersona(personas, target, 'psn_01ALPHA', {
        target: 'replace',
        expectedRevisionId: 'prv_01REVA',
        agentId,
        expectedCurrentRevisionId: AgentRevisionIdSchema.parse('arev_01stale'),
        displayName: '新名字',
        useAvatar: false,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'revision-conflict' })
  })
})

describe('CommunityPersonaService authoring', () => {
  it('requires sign-in, publishes with a verified avatar and remembers which agent it came from', async () => {
    const { personas, community, signIn } = await createFixture()
    const agentId = AgentIdSchema.parse('agt_01author')
    await expect(personas.mine()).rejects.toMatchObject({ code: 'community-signed-out' })
    await signIn()
    const input = HostApiContracts.publishCommunityPersona.parseRequest({
      agentId,
      name: '图书管理员',
      summary: '轻声细语，帮你找书。',
      description: '适合读书会。',
      tags: ['陪伴'],
      persona: '你是一位温柔的图书管理员。',
      avatar: { mediaType: 'image/png', base64: Buffer.from(PNG).toString('base64') },
    })
    const published = await personas.publish(input)
    expect(published).toMatchObject({ id: 'psn_01NEW', latestRevision: { reviewStatus: 'pending' } })
    const form = formOf(community.requests.at(-1)?.body)
    expect(form.get('tags')).toBe('["陪伴"]')
    expect(form.get('avatar')).toBeInstanceOf(Blob)
    expect(form.get('personaId')).toBeNull()
    expect(personas.agentLinks()).toEqual({ [agentId]: 'psn_01NEW' })

    await expect(
      personas.publish({ ...input, avatar: { mediaType: 'image/webp', base64: Buffer.from(PNG).toString('base64') } }),
    ).rejects.toMatchObject({ code: 'community-persona-avatar-invalid' })

    const mine = await personas.mine()
    expect(mine.items.map((item) => [item.id, item.status, item.latestRevision.reviewStatus])).toEqual([
      ['psn_01MINE', 'listed', 'flagged'],
      ['psn_01DRAFT', 'delisted', 'pending'],
    ])
    // 只返回仍在社区上的关联。
    expect(mine.agentLinks).toEqual({})
    await personas.publish(
      HostApiContracts.publishCommunityPersona.parseRequest({
        ...input,
        agentId,
        personaId: 'psn_01MINE',
        avatar: undefined,
      }),
    )
    expect(formOf(community.requests.at(-1)?.body).get('personaId')).toBe('psn_01MINE')
    expect((await personas.mine()).agentLinks).toEqual({ [agentId]: 'psn_01MINE' })
    expect(() => HostApiContracts.listCommunityMyPersonas.response.parse(mine)).not.toThrow()
  })
})
