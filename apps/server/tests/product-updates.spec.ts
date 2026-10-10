import type { JsonValue } from '@nekro-nxt/contracts'
import { describe, expect, it } from 'vitest'
import { isNewerVersion, ProductUpdates, releaseIdentity } from '../src/product-updates.ts'

const settingsStore = () => {
  const rows = new Map<string, { value: JsonValue; revision: number }>()
  return {
    get: (key: string) => rows.get(key),
    put: (key: string, value: JsonValue) => {
      rows.set(key, { value, revision: (rows.get(key)?.revision ?? 0) + 1 })
    },
  }
}

const fakeGitHub = (routes: Record<string, unknown>) => {
  const requested: string[] = []
  const fetch = (url: string | URL | Request) => {
    const target = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
    requested.push(target)
    const key = Object.keys(routes).find((path) => target.endsWith(path))
    const body = key === undefined ? undefined : routes[key]
    return Promise.resolve(
      body === undefined ? new Response('not found', { status: 404 }) : Response.json(body, { status: 200 }),
    )
  }
  return { fetch, requested }
}

describe('product updates', () => {
  it('reads the channel from the release id', () => {
    expect(releaseIdentity('0.4.0+c920874da1ef')).toEqual({
      channel: 'stable',
      version: '0.4.0',
      commit: 'c920874da1ef',
    })
    expect(releaseIdentity('0.4.0-20261010-052101utc.gc920874da1ef+c920874da1ef')).toEqual({
      channel: 'preview',
      version: '0.4.0-20261010-052101utc.gc920874da1ef',
      commit: 'c920874da1ef',
    })
    expect(releaseIdentity('@nekro-nxt/server@0.4.0').channel).toBe('development')
    expect(isNewerVersion('0.10.0', '0.9.3')).toBe(true)
    expect(isNewerVersion('v0.4.0', '0.4.0')).toBe(false)
    expect(isNewerVersion('0.3.9', '0.4.0')).toBe(false)
  })

  it('compares a Stable build with the latest Stable release only', async () => {
    const github = fakeGitHub({
      '/releases/latest': {
        tag_name: 'v0.4.1',
        html_url: 'https://github.com/NekroAI/nekro-nxt/releases/tag/v0.4.1',
        published_at: '2026-10-12T08:00:00Z',
      },
    })
    const updates = new ProductUpdates({
      releaseId: '0.4.0+c920874da1ef',
      repository: 'NekroAI/nekro-nxt',
      settings: settingsStore(),
      fetch: github.fetch,
      now: () => 1000,
    })
    await expect(updates.check()).resolves.toMatchObject({
      channel: 'stable',
      currentVersion: '0.4.0',
      state: 'available',
      latest: { version: '0.4.1', url: 'https://github.com/NekroAI/nekro-nxt/releases/tag/v0.4.1' },
      checkedAt: 1000,
    })
    expect(github.requested).toEqual(['https://api.github.com/repos/NekroAI/nekro-nxt/releases/latest'])
  })

  it('compares a Preview build with the rolling preview release by commit', async () => {
    const preview = (commit: string) =>
      fakeGitHub({
        '/releases/tags/preview': {
          name: 'NekroNXT Preview 0.4.0-20261011-010101utc.gabcdef123456',
          html_url: 'https://github.com/NekroAI/nekro-nxt/releases/tag/preview',
          body: `<!-- nxt-preview-commit:${commit} -->\n正文`,
        },
      })
    const build = (fetch: typeof globalThis.fetch) =>
      new ProductUpdates({
        releaseId: '0.4.0-20261010-052101utc.gc920874da1ef+c920874da1ef',
        repository: 'NekroAI/nekro-nxt',
        settings: settingsStore(),
        fetch,
      })

    await expect(build(preview('c920874da1ef92af20ffbf00632653840472fe57').fetch).check()).resolves.toMatchObject({
      channel: 'preview',
      state: 'up-to-date',
    })
    await expect(build(preview('abcdef1234567890abcdef1234567890abcdef12').fetch).check()).resolves.toMatchObject({
      state: 'available',
      latest: { version: '0.4.0-20261011-010101utc.gabcdef123456', commit: 'abcdef1' },
    })
  })

  it('reports a failed check without losing a known update, and never checks a development build', async () => {
    let online = true
    const github = fakeGitHub({ '/releases/latest': { tag_name: 'v0.5.0', html_url: 'https://example.com/r' } })
    const updates = new ProductUpdates({
      releaseId: '0.4.0+c920874da1ef',
      repository: 'NekroAI/nekro-nxt',
      settings: settingsStore(),
      fetch: (url) => (online ? github.fetch(url) : Promise.reject(new Error('offline'))),
    })
    await updates.check()
    online = false
    await expect(updates.check()).resolves.toMatchObject({ state: 'available', error: 'offline' })

    const fresh = new ProductUpdates({
      releaseId: '0.4.0+c920874da1ef',
      repository: 'NekroAI/nekro-nxt',
      settings: settingsStore(),
      fetch: () => Promise.reject(new Error('offline')),
    })
    await expect(fresh.check()).resolves.toMatchObject({ state: 'failed' })

    const development = fakeGitHub({})
    const local = new ProductUpdates({
      releaseId: '@nekro-nxt/server@0.4.0',
      repository: 'NekroAI/nekro-nxt',
      settings: settingsStore(),
      fetch: development.fetch,
    })
    await expect(local.check()).resolves.toMatchObject({ channel: 'development', state: 'unsupported' })
    expect(development.requested).toEqual([])
  })

  it('keeps the automatic check setting', () => {
    const settings = settingsStore()
    const updates = new ProductUpdates({ releaseId: '0.4.0+c920874da1ef', repository: 'NekroAI/nekro-nxt', settings })
    expect(updates.status().autoCheck).toBe(true)
    expect(updates.setAutoCheck(false).autoCheck).toBe(false)
    expect(new ProductUpdates({ releaseId: '0.4.0+c920874da1ef', repository: 'x/y', settings }).autoCheck).toBe(false)
    updates.dispose()
  })
})
