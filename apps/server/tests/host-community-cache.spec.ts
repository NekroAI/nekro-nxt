import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { HostApiContracts } from '@nekro-nxt/contracts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { NekroRuntime } from '../src/bootstrap.js'
import { createNekroHostApi } from '../src/host-api.js'

const extension = {
  id: 'ext_01CACHE',
  provides: ['agent'],
  displayName: '示例天气',
  summary: '查询城市天气。',
  tags: [],
  publisher: { handle: 'demo-author', displayName: '示例作者', avatarUrl: null },
  latest: null,
  downloads: 0,
  updatedAt: 1_790_000_000_000,
}

const persona = {
  id: 'psn_01CACHE',
  name: '示例图书管理员',
  summary: '帮你找书。',
  tags: [],
  avatarUrl: null,
  official: false,
  publisher: { handle: 'demo-author', displayName: '示例作者', avatarUrl: null },
  installs: 0,
  updatedAt: 1_790_000_000_000,
}

it('serves community catalog reads from the instance cache, refreshes on request and falls back when offline', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nxt-host-community-cache-'))
  const requests: string[] = []
  let offline = false
  const respond = (input: Parameters<typeof fetch>[0]): Response => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.pathname === '/api/v1/meta')
      return Response.json({ name: '样例社区', environment: 'staging', version: 'x' })
    if (offline) throw new TypeError('fetch failed')
    requests.push(`${url.pathname}${url.search}`)
    if (url.pathname === '/api/v1/extensions') return Response.json({ items: [extension], nextCursor: null })
    if (url.pathname === '/api/v1/extensions/ext_01CACHE')
      return Response.json({ ...extension, description: '', sourceUrl: null, review: null })
    if (url.pathname === '/api/v1/personas') return Response.json({ items: [persona], nextCursor: null })
    if (url.pathname === '/api/v1/personas/psn_01CACHE')
      return Response.json({
        ...persona,
        description: '',
        persona: '你是一位图书管理员。',
        revision: { id: 'prv_01CACHE', notes: '', createdAt: 1 },
        review: null,
      })
    throw new Error(`Unexpected fixture request: ${url.pathname}`)
  }
  const remoteFetch: typeof fetch = (input) => {
    try {
      return Promise.resolve(respond(input))
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }
  const runtime = await NekroRuntime.create({
    coreDatabasePath: path.join(directory, 'core.sqlite'),
    sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
    assetRoot: path.join(directory, 'assets'),
    extensionDataRoot: path.join(directory, 'extensions'),
    extensionCacheRoot: path.join(directory, 'cache'),
    community: { url: 'https://community.test', fetch: remoteFetch },
  })
  const context = new Context()
  await context.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  const api = createNekroHostApi(context.webServer, runtime)
  const base = `http://127.0.0.1:${api.port}`
  const get = async (pathname: string) => {
    const response = await fetch(`${base}${pathname}`)
    return { status: response.status, body: (await response.json()) as unknown }
  }
  try {
    const list = HostApiContracts.listCommunityExtensions.parseResponse(
      (await get('/api/community/extensions?query=天气')).body,
    )
    expect(list).toMatchObject({ items: [{ id: 'ext_01CACHE' }], stale: false })
    await get('/api/community/extensions?query=天气')
    await get('/api/community/extensions/ext_01CACHE')
    await get('/api/community/extensions/ext_01CACHE')
    await get('/api/community/personas')
    await get('/api/community/personas')
    const detail = HostApiContracts.getCommunityPersona.parseResponse(
      (await get('/api/community/personas/psn_01CACHE')).body,
    )
    expect(detail).toMatchObject({ id: 'psn_01CACHE', stale: false })
    await get('/api/community/personas/psn_01CACHE')
    expect(requests).toEqual([
      '/api/v1/extensions?limit=30&q=%E5%A4%A9%E6%B0%94',
      '/api/v1/extensions/ext_01CACHE',
      '/api/v1/personas?limit=30',
      '/api/v1/personas/psn_01CACHE',
    ])

    const refreshed = HostApiContracts.listCommunityExtensions.parseResponse(
      (await get('/api/community/extensions?query=天气&refresh=1')).body,
    )
    expect(requests).toHaveLength(5)
    expect(refreshed.fetchedAt).toBeGreaterThanOrEqual(list.fetchedAt)

    offline = true
    const fallback = HostApiContracts.getCommunityExtension.parseResponse(
      (await get('/api/community/extensions/ext_01CACHE?refresh=1')).body,
    )
    expect(fallback).toMatchObject({ id: 'ext_01CACHE', stale: true })
    expect(await get('/api/community/extensions?query=other')).toMatchObject({
      status: 502,
      body: { error: { code: 'community-unreachable' } },
    })
  } finally {
    api.dispose()
    await context.fiber.dispose()
    await runtime.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
