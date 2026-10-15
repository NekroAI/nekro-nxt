import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { CommunityFeedbackCreateSchema, HostApiContracts } from '@nekro-nxt/contracts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { NekroRuntime } from '../src/bootstrap.js'
import { createNekroHostApi } from '../src/host-api.js'

it('serves the feedback journey through typed host routes, enforces consent and rejects model-supplied diagnostics', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nxt-host-feedback-'))
  const received: unknown[] = []
  const respond = (input: Parameters<typeof fetch>[0], init: RequestInit = {}): Response => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.pathname === '/api/v1/meta')
      return Response.json({ name: '样例社区', environment: 'staging', version: 'fixture', features: ['feedback'] })
    if (url.pathname === '/oauth/token')
      return Response.json({
        access_token: 'nxtc_at_fixture',
        refresh_token: 'nxtc_rt_fixture',
        token_type: 'Bearer',
        expires_in: 3600,
        user: { id: 'usr_fixture', handle: 'fixture-author', displayName: '样例作者', avatarUrl: null },
      })
    if (url.pathname === '/api/v1/feedback/changes') return Response.json({ events: [], cursor: 0, hasMore: false })
    if (url.pathname === '/api/v1/feedback' && init.method === 'POST') {
      const payload = CommunityFeedbackCreateSchema.parse(JSON.parse(typeof init.body === 'string' ? init.body : '{}'))
      received.push(payload)
      return Response.json({
        id: 'fbk_00000000000000000000000001',
        ref: 'FB-1',
        title: payload.title,
        kind: payload.kind,
        target: payload.target,
        status: 'new',
        fixedIn: null,
        affectedCount: 0,
        confirmedCount: 0,
        createdAt: 1000,
        updatedAt: 1000,
        access: 'owner',
        body: payload.body,
        diagnostics: payload.diagnostics,
      })
    }
    if (url.pathname === '/api/v1/feedback') return Response.json({ items: [], cursor: null })
    throw new Error(`Unexpected fixture request: ${url.pathname}`)
  }
  const remoteFetch: typeof fetch = (input, init) => Promise.resolve(respond(input, init))
  const runtime = await NekroRuntime.create({
    coreDatabasePath: path.join(directory, 'core.sqlite'),
    sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
    assetRoot: path.join(directory, 'assets'),
    extensionDataRoot: path.join(directory, 'extensions'),
    extensionCacheRoot: path.join(directory, 'cache'),
    community: { url: 'https://community.test', fetch: remoteFetch },
    feedbackEnvironment: { hostKind: 'desktop', releaseId: '0.5.0+0123456789ab' },
  })
  const context = new Context()
  await context.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  const api = createNekroHostApi(context.webServer, runtime)
  const base = `http://127.0.0.1:${api.port}`
  const request = (pathname: string, method = 'GET', body?: unknown) =>
    fetch(`${base}${pathname}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  try {
    const before = HostApiContracts.getCommunityFeedbackSettings.parseResponse(
      await (await request('/api/community/feedback/settings')).json(),
    )
    expect(before).toMatchObject({ enabled: false, supported: true, signedIn: false })
    expect((await request('/api/community/feedback/settings', 'PUT', { enabled: true, consent: true })).status).toBe(
      400,
    )
    const draft = HostApiContracts.createCommunityFeedbackDraft.parseResponse(
      await (
        await request('/api/community/feedback/drafts', 'POST', {
          kind: 'bug',
          target: 'nxt',
          title: '保存设置样例',
          body: `路径在 ${path.join('/', 'Users', 'fixture', 'private', 'log.txt')}。`,
        })
      ).json(),
    )
    expect(draft.body).toContain('<本机路径>')
    expect(
      (
        await request('/api/community/feedback/drafts', 'POST', {
          kind: 'bug',
          target: 'nxt',
          title: '不可信诊断',
          body: '样例',
          diagnostics: { apiKey: 'fixture' },
        })
      ).status,
    ).toBe(400)
    const started = HostApiContracts.startCommunityLogin.parseResponse(
      await (await request('/api/community/login', 'POST', { returnOrigin: base })).json(),
    )
    const state = new URL(started.authorizeUrl).searchParams.get('state')!
    expect((await request(`/community/callback?${new URLSearchParams({ state, code: 'fixture' })}`)).status).toBe(200)
    expect((await request('/api/community/feedback/settings', 'PUT', { enabled: true })).status).toBe(400)
    expect((await request('/api/community/feedback/settings', 'PUT', { enabled: true, consent: true })).status).toBe(
      200,
    )
    const preview = HostApiContracts.previewCommunityFeedbackPayload.parseResponse(
      await (await request(`/api/community/feedback/drafts/${draft.id}/preview`)).json(),
    )
    expect(preview.payload.diagnostics).toMatchObject({ hostKind: 'desktop', releaseChannel: 'stable' })
    const sent = HostApiContracts.sendCommunityFeedbackDraft.parseResponse(
      await (await request(`/api/community/feedback/drafts/${draft.id}/send`, 'POST', {})).json(),
    )
    expect(sent.state).toBe('sent')
    expect(received).toHaveLength(1)
    const snapshot = HostApiContracts.snapshot.parseResponse(await (await request('/api/snapshot')).json())
    expect(snapshot.communityFeedback).toMatchObject({ enabled: true, signedIn: true, pendingDrafts: 0 })
    expect((await request(`/api/community/feedback/drafts/${draft.id}`, 'DELETE')).status).toBe(400)
  } finally {
    api.dispose()
    await context.fiber.dispose()
    await runtime.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
