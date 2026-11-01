import { createHash } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import type { JsonValue } from '@nekro-nxt/contracts'
import { AddonRegistry, mediaAddon, syncProgramEnvironment, type AddonSettingsStore } from '../src/addons.ts'
import { findSystemMediaPrograms, MediaFfmpeg, type MediaRelease } from '../src/media-ffmpeg.ts'

const temporaryDirectories: string[] = []
const temporary = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-media-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const memorySettings = (): AddonSettingsStore => {
  const values = new Map<string, JsonValue>()
  let revision = 0
  return {
    get: (key) => {
      const value = values.get(key)
      return value === undefined ? undefined : { value, revision }
    },
    put: (key, value) => {
      values.set(key, value)
      revision += 1
    },
  }
}

/** A fake device: `files` exist, and those listed in `versions` run. */
const device = (files: readonly string[], versions: Readonly<Record<string, string>> = {}) => ({
  isFile: (file: string) => Promise.resolve(files.includes(file)),
  versionOf: (file: string) => Promise.resolve(versions[file] ?? (files.includes(file) ? '7.1-fixture' : undefined)),
})

describe('finding the ffmpeg this device has', () => {
  it('takes a folder holding both programs, searching PATH before the usual install folders', async () => {
    const found = await findSystemMediaPrograms({
      platform: 'darwin',
      pathEnv: '/usr/bin:/fixture/bin',
      searchDirectories: ['/opt/homebrew/bin'],
      ...device(['/usr/bin/ffmpeg', '/fixture/bin/ffprobe', '/opt/homebrew/bin/ffmpeg', '/opt/homebrew/bin/ffprobe'], {
        '/opt/homebrew/bin/ffmpeg': '8.0-fixture',
      }),
    })
    expect(found).toEqual({
      ffmpeg: '/opt/homebrew/bin/ffmpeg',
      ffprobe: '/opt/homebrew/bin/ffprobe',
      version: '8.0-fixture',
    })
  })

  it('pairs programs from different folders when no folder holds both', async () => {
    const found = await findSystemMediaPrograms({
      platform: 'linux',
      pathEnv: '/usr/bin',
      searchDirectories: ['/usr/local/bin'],
      ...device(['/usr/bin/ffmpeg', '/usr/local/bin/ffprobe']),
    })
    expect(found).toMatchObject({ ffmpeg: '/usr/bin/ffmpeg', ffprobe: '/usr/local/bin/ffprobe' })
  })

  it('needs both programs, and only ones that run', async () => {
    expect(
      await findSystemMediaPrograms({
        platform: 'linux',
        pathEnv: '/usr/bin',
        searchDirectories: [],
        ...device(['/usr/bin/ffmpeg']),
      }),
    ).toBeUndefined()
    expect(
      await findSystemMediaPrograms({
        platform: 'linux',
        pathEnv: '/usr/bin',
        searchDirectories: [],
        isFile: () => Promise.resolve(true),
        versionOf: () => Promise.resolve(undefined),
      }),
    ).toBeUndefined()
  })

  it('looks for .exe files along a Windows PATH', async () => {
    const found = await findSystemMediaPrograms({
      platform: 'win32',
      pathEnv: 'C:\\Windows;C:\\ffmpeg\\bin',
      searchDirectories: [],
      ...device(['C:\\ffmpeg\\bin\\ffmpeg.exe', 'C:\\ffmpeg\\bin\\ffprobe.exe']),
    })
    expect(found).toMatchObject({ ffmpeg: 'C:\\ffmpeg\\bin\\ffmpeg.exe', ffprobe: 'C:\\ffmpeg\\bin\\ffprobe.exe' })
  })
})

const script = (name: string) => Buffer.from(`#!/bin/sh\necho "${name} version 6.1.1-fixture"\n`)

/** A pinned release of two gzip-compressed scripts; `corrupt` breaks the checksum of ffprobe. */
const fixtureRelease = (options: { readonly corrupt?: boolean } = {}) => {
  const bodies = { ffmpeg: gzipSync(script('ffmpeg')), ffprobe: gzipSync(script('ffprobe')) }
  const artifact = (name: 'ffmpeg' | 'ffprobe') => ({
    file: `${name}-linux-x64.gz`,
    bytes: bodies[name].length,
    sha256: createHash('sha256')
      .update(options.corrupt === true && name === 'ffprobe' ? Buffer.from('other') : bodies[name])
      .digest('hex'),
  })
  const release: MediaRelease = {
    version: 'b6.1.1',
    sources: [(file) => `https://primary.test/${file}`, (file) => `https://mirror.test/${file}`],
    builds: { 'linux-x64': 'linux-x64', 'win32-arm64': 'linux-x64' },
    artifacts: { 'linux-x64': { ffmpeg: artifact('ffmpeg'), ffprobe: artifact('ffprobe') } },
  }
  const requests: string[] = []
  const fetch = (url: string | URL | Request) => {
    const text = url instanceof Request ? url.url : url.toString()
    requests.push(text)
    // The first source is down; the mirror serves the files.
    if (text.startsWith('https://primary.test/')) return Promise.resolve(new Response('offline', { status: 503 }))
    const name = text.includes('ffprobe') ? 'ffprobe' : 'ffmpeg'
    return Promise.resolve(new Response(bodies[name]))
  }
  return { release, fetch, requests }
}

const settle = async (media: MediaFfmpeg) => {
  while (media.download()?.state === 'downloading') await new Promise((resolve) => setTimeout(resolve, 10))
}

describe.skipIf(process.platform === 'win32')('downloading ffmpeg', () => {
  it('downloads both programs from the next source, checks and unpacks them, and removes them again', async () => {
    const root = await temporary()
    const { release, fetch, requests } = fixtureRelease()
    const media = new MediaFfmpeg({
      root,
      platform: 'linux',
      arch: 'x64',
      release,
      fetch,
      pathEnv: '',
      searchDirectories: [],
    })
    await media.prepare()
    const registry = new AddonRegistry([mediaAddon(media)], { settings: memorySettings() })
    await registry.prepare()
    expect(registry.status('media').providers.map(({ id, state }) => [id, state])).toEqual([
      ['download', 'not-installed'],
    ])
    expect(registry.status('media').providers[0]?.resources.downloadBytes).toBe(
      release.artifacts['linux-x64']!.ffmpeg.bytes + release.artifacts['linux-x64']!.ffprobe.bytes,
    )

    registry.install('media', 'download')
    await settle(media)
    expect(requests).toEqual([
      'https://primary.test/ffmpeg-linux-x64.gz',
      'https://mirror.test/ffmpeg-linux-x64.gz',
      'https://primary.test/ffprobe-linux-x64.gz',
      'https://mirror.test/ffprobe-linux-x64.gz',
    ])
    const ffmpeg = path.join(root, 'b6.1.1', 'ffmpeg')
    expect((await stat(ffmpeg)).mode & 0o777).toBe(0o755)
    expect(registry.status('media')).toMatchObject({ state: 'installed', selected: 'download' })
    expect(registry.status('media').providers[0]).toMatchObject({ version: '6.1.1-fixture', removable: true })
    expect(registry.active('media')?.program('ffprobe')).toBe(path.join(root, 'b6.1.1', 'ffprobe'))

    await registry.remove('media', 'download')
    expect(registry.status('media').state).toBe('not-installed')
    await expect(stat(path.join(root, 'b6.1.1'))).rejects.toThrow()
  })

  it('keeps nothing when a file fails its checksum', async () => {
    const root = await temporary()
    const { release, fetch } = fixtureRelease({ corrupt: true })
    const media = new MediaFfmpeg({
      root,
      platform: 'linux',
      arch: 'x64',
      release,
      fetch,
      pathEnv: '',
      searchDirectories: [],
    })
    await media.prepare()
    media.startDownload()
    await settle(media)
    expect(media.download()).toMatchObject({ state: 'failed' })
    expect(media.download()?.error).toContain('校验不通过')
    expect(media.downloaded()).toBeUndefined()
    await expect(stat(path.join(root, 'b6.1.1'))).rejects.toThrow()
  })

  it('points the declared variables at the download while it is installed, and leaves ones set beforehand', async () => {
    const root = await temporary()
    const { release, fetch } = fixtureRelease()
    const media = new MediaFfmpeg({
      root,
      platform: 'linux',
      arch: 'x64',
      release,
      fetch,
      pathEnv: '',
      searchDirectories: [],
    })
    const registry = new AddonRegistry([mediaAddon(media)], { settings: memorySettings() })
    await registry.prepare()
    const env: NodeJS.ProcessEnv = { DSH_FFPROBE_PATH: '/opt/fixture/ffprobe' }
    const stop = syncProgramEnvironment(registry, env)
    expect(env).toEqual({ DSH_FFPROBE_PATH: '/opt/fixture/ffprobe' })
    registry.install('media', 'download')
    await settle(media)
    expect(env).toEqual({
      FFMPEG_PATH: path.join(root, 'b6.1.1', 'ffmpeg'),
      DSH_FFMPEG_PATH: path.join(root, 'b6.1.1', 'ffmpeg'),
      FFPROBE_PATH: path.join(root, 'b6.1.1', 'ffprobe'),
      DSH_FFPROBE_PATH: '/opt/fixture/ffprobe',
    })
    await registry.remove('media', 'download')
    expect(env).toEqual({ DSH_FFPROBE_PATH: '/opt/fixture/ffprobe' })
    stop()
  })

  it('uses the x64 build on Windows on ARM and has nothing to download elsewhere', () => {
    const { release } = fixtureRelease()
    const arm = new MediaFfmpeg({ root: '/fixture', platform: 'win32', arch: 'arm64', release })
    expect(arm.download()).toEqual({ state: 'idle' })
    expect(arm.licenseUrl).toBe(
      'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/linux-x64.LICENSE',
    )
    const other = new MediaFfmpeg({ root: '/fixture', platform: 'freebsd', arch: 'x64', release })
    expect(other.download()).toBeUndefined()
    expect(() => other.startDownload()).toThrow()
  })
})

describe('programs of the current providers', () => {
  const systemMedia = async () => {
    const media = new MediaFfmpeg({
      root: '/fixture/runtimes/media',
      platform: 'linux',
      pathEnv: '/usr/bin',
      searchDirectories: [],
      ...device(['/usr/bin/ffmpeg', '/usr/bin/ffprobe']),
    })
    const registry = new AddonRegistry([mediaAddon(media)], { settings: memorySettings() })
    await registry.prepare()
    return registry
  }

  it('lists the programs with the variables DSH plugins read them from', async () => {
    const registry = await systemMedia()
    expect(registry.programs().map(({ name, path: file, env, source }) => ({ name, file, env, source }))).toEqual([
      { name: 'ffmpeg', file: '/usr/bin/ffmpeg', env: ['FFMPEG_PATH', 'DSH_FFMPEG_PATH'], source: 'system' },
      { name: 'ffprobe', file: '/usr/bin/ffprobe', env: ['FFPROBE_PATH', 'DSH_FFPROBE_PATH'], source: 'system' },
    ])
  })

  it('clears the variables it set when it stops', async () => {
    const registry = await systemMedia()
    const env: NodeJS.ProcessEnv = {}
    const stop = syncProgramEnvironment(registry, env)
    expect(env['FFMPEG_PATH']).toBe('/usr/bin/ffmpeg')
    stop()
    expect(env).toEqual({})
  })
})
