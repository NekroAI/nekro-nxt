import type { JsonValue } from '@nekro-nxt/contracts'
import { describe, expect, it } from 'vitest'
import { downloadMirror, isNewerVersion, ProductUpdates, releaseIdentity } from '../src/product-updates.ts'

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
        updated_at: '2026-10-13T08:00:00Z',
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
      latest: {
        version: '0.4.1',
        url: 'https://github.com/NekroAI/nekro-nxt/releases/tag/v0.4.1',
        publishedAt: Date.parse('2026-10-12T08:00:00Z'),
      },
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

  it.each(['2026-10-11T11:51:45Z', null, 'invalid-date'])(
    'uses the rolling preview update date or omits it: %s',
    async (updatedAt) => {
      const github = fakeGitHub({
        '/releases/tags/preview': {
          name: 'NekroNXT Preview 0.5.0-20261011-114253utc.g222222222222',
          body: '<!-- nxt-preview-commit:2222222222222222222222222222222222222222 -->',
          published_at: '2026-08-23T08:11:31Z',
          updated_at: updatedAt,
        },
      })
      const updates = new ProductUpdates({
        releaseId: '0.4.0-20261010-052101utc.g111111111111+111111111111',
        repository: 'example/fixture',
        settings: settingsStore(),
        fetch: github.fetch,
      })
      const status = await updates.check()
      expect(status.state).toBe('available')
      expect(status.latest?.publishedAt).toBe(updatedAt?.startsWith('2026') ? Date.parse(updatedAt) : undefined)
    },
  )

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

  it('lists checked installers and puts the community mirror ahead of GitHub for the same release', async () => {
    const sha = (digit: string) => digit.repeat(64)
    const sources = fakeGitHub({
      '/releases/latest': {
        tag_name: 'v0.8.0',
        html_url: 'https://github.com/NekroAI/nekro-nxt/releases/tag/v0.8.0',
        assets: [
          {
            name: 'nekro-nxt-win-x64-v0.8.0-setup.exe',
            size: 200,
            digest: `sha256:${sha('a')}`,
            browser_download_url: 'https://github.com/dl/nekro-nxt-win-x64-v0.8.0-setup.exe',
          },
          {
            name: 'nekro-nxt-mac-arm64-v0.8.0.dmg',
            size: 300,
            digest: `sha256:${sha('b')}`,
            browser_download_url: 'https://github.com/dl/nekro-nxt-mac-arm64-v0.8.0.dmg',
          },
          // No published digest: it cannot be checked after download, so it is not offered.
          {
            name: 'nekro-nxt-linux-x64-v0.8.0.AppImage',
            size: 400,
            browser_download_url: 'https://github.com/dl/nekro-nxt-linux-x64-v0.8.0.AppImage',
          },
          { name: 'notes.txt', size: 1, digest: `sha256:${sha('c')}`, browser_download_url: 'https://github.com/dl/n' },
        ],
      },
      '/nxt/desktop/stable/manifest.json': {
        format: 'nxt.desktop-mirror',
        version: 1,
        channel: 'stable',
        releaseVersion: '0.8.0',
        commit: 'abcdef1234567890abcdef1234567890abcdef12',
        publishedAt: 5,
        releaseUrl: 'https://github.com/NekroAI/nekro-nxt/releases/tag/v0.8.0',
        files: [
          {
            platform: 'win',
            arch: 'x64',
            name: 'nekro-nxt-win-x64-v0.8.0-setup.exe',
            size: 200,
            sha256: sha('a'),
            path: 'files/v0.8.0/nekro-nxt-win-x64-v0.8.0-setup.exe',
            githubUrl: 'https://github.com/dl/nekro-nxt-win-x64-v0.8.0-setup.exe',
          },
          // Disagrees with GitHub on the content: only GitHub's copy is offered.
          {
            platform: 'mac',
            arch: 'arm64',
            name: 'nekro-nxt-mac-arm64-v0.8.0.dmg',
            size: 300,
            sha256: sha('d'),
            path: 'files/v0.8.0/nekro-nxt-mac-arm64-v0.8.0.dmg',
          },
        ],
      },
    })
    const updates = new ProductUpdates({
      releaseId: '0.7.0+c920874da1ef',
      repository: 'NekroAI/nekro-nxt',
      mirror: 'https://downloads.example/nxt',
      settings: settingsStore(),
      fetch: sources.fetch,
    })
    const status = await updates.check()
    expect(status.latest?.downloads).toEqual([
      {
        platform: 'win',
        arch: 'x64',
        name: 'nekro-nxt-win-x64-v0.8.0-setup.exe',
        size: 200,
        sha256: sha('a'),
        urls: [
          'https://downloads.example/nxt/desktop/stable/files/v0.8.0/nekro-nxt-win-x64-v0.8.0-setup.exe',
          'https://github.com/dl/nekro-nxt-win-x64-v0.8.0-setup.exe',
        ],
      },
      {
        platform: 'mac',
        arch: 'arm64',
        name: 'nekro-nxt-mac-arm64-v0.8.0.dmg',
        size: 300,
        sha256: sha('b'),
        urls: ['https://github.com/dl/nekro-nxt-mac-arm64-v0.8.0.dmg'],
      },
    ])
  })

  it('finds a Preview update through the mirror when GitHub cannot be reached', async () => {
    const mirror = fakeGitHub({
      '/nxt/desktop/preview/manifest.json': {
        format: 'nxt.desktop-mirror',
        version: 1,
        channel: 'preview',
        releaseVersion: '0.8.0-20261101-010101utc.g2222222222',
        commit: '2222222222222222222222222222222222222222',
        publishedAt: 9,
        releaseUrl: 'https://github.com/NekroAI/nekro-nxt/releases/tag/preview',
        files: [
          {
            platform: 'linux',
            arch: 'x64',
            name: 'nekro-nxt-preview-linux-x64-v0.8.0.AppImage',
            size: 10,
            sha256: 'e'.repeat(64),
            path: 'files/2222222222222222222222222222222222222222/nekro-nxt-preview-linux-x64-v0.8.0.AppImage',
          },
        ],
      },
    })
    const updates = new ProductUpdates({
      releaseId: '0.8.0-20261031-010101utc.g111111111111+111111111111',
      repository: 'NekroAI/nekro-nxt',
      mirror: 'https://downloads.example/nxt',
      settings: settingsStore(),
      fetch: (url) =>
        (url instanceof Request ? url.url : url.toString()).startsWith('https://api.github.com')
          ? Promise.reject(new Error('offline'))
          : mirror.fetch(url),
    })
    await expect(updates.check()).resolves.toMatchObject({
      state: 'available',
      latest: {
        version: '0.8.0-20261101-010101utc.g2222222222',
        commit: '2222222',
        downloads: [
          {
            platform: 'linux',
            urls: [expect.stringContaining('downloads.example/nxt/desktop/preview/files/') as unknown],
          },
        ],
      },
    })
  })

  it('reads the mirror from the environment', () => {
    expect(downloadMirror(undefined)).toEqual({ mirror: 'https://dl.nekro.ai/nxt' })
    expect(downloadMirror('https://mirror.example/nxt')).toEqual({ mirror: 'https://mirror.example/nxt' })
    expect(downloadMirror('off')).toEqual({})
    expect(downloadMirror(' ')).toEqual({})
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
