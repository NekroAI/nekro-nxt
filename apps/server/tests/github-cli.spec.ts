import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GithubCli, type GithubCliStatus } from '../src/github-cli.ts'

const temporaryDirectories: string[] = []
const temporary = async (prefix: string) => {
  const directory = await mkdtemp(path.join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const key = `${process.platform}-${process.arch}`
const none = () => Promise.resolve(undefined)

/** A release archive laid out like the official ones: one folder holding `bin/gh`. */
const fakeRelease = async () => {
  const work = await temporary('nekro-nxt-gh-release-')
  const folder = 'gh_99.0.0_test'
  await mkdir(path.join(work, folder, 'bin'), { recursive: true })
  const executable = path.join(work, folder, 'bin', 'gh')
  await writeFile(executable, '#!/bin/sh\necho "gh version 99.0.0"\n')
  await chmod(executable, 0o755)
  const file = `${folder}.tar.gz`
  execFileSync('tar', ['-czf', path.join(work, file), '-C', work, folder])
  const bytes = await readFile(path.join(work, file))
  return {
    bytes,
    release: {
      version: '99.0.0',
      baseUrl: 'https://downloads.example.test/gh',
      artifacts: { [key]: { file, sha256: createHash('sha256').update(bytes).digest('hex') } },
    },
  }
}

const settled = (cli: GithubCli) =>
  new Promise<GithubCliStatus>((resolve) => {
    const check = () => {
      const status = cli.status()
      if (status.download?.state !== 'downloading') {
        unsubscribe()
        resolve(status)
      }
    }
    const unsubscribe = cli.subscribe(check)
  })

describe.skipIf(process.platform === 'win32')('GitHub CLI', () => {
  it('uses a gh the machine already has and leaves PATH alone', async () => {
    const cli = new GithubCli({
      root: await temporary('nekro-nxt-gh-'),
      findSystem: () => Promise.resolve({ executable: '/usr/local/bin/gh', version: '2.90.0' }),
    })
    await cli.prepare()
    expect(cli.status()).toEqual({ available: true, source: 'system', version: '2.90.0' })
    expect(cli.executable()).toBe('/usr/local/bin/gh')
    expect(cli.directoryForPath()).toBeUndefined()
  })

  it('downloads, verifies and unpacks the pinned release, then removes it again', async () => {
    const { bytes, release } = await fakeRelease()
    const requested: string[] = []
    const root = await temporary('nekro-nxt-gh-')
    const cli = new GithubCli({
      root,
      release,
      findSystem: none,
      fetch: (url) => {
        requested.push(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url)
        return Promise.resolve(new Response(bytes, { headers: { 'content-length': String(bytes.length) } }))
      },
    })
    await cli.prepare()
    expect(cli.status()).toEqual({ available: false, download: { version: '99.0.0', state: 'idle' } })
    expect(cli.executable()).toBeUndefined()

    const done = settled(cli)
    expect(cli.startDownload().download?.state).toBe('downloading')
    expect(await done).toEqual({ available: true, source: 'downloaded', version: '99.0.0' })
    expect(requested).toEqual([`https://downloads.example.test/gh/${release.artifacts[key]!.file}`])
    const executable = cli.executable()!
    expect(executable).toBe(path.join(root, '99.0.0', 'gh_99.0.0_test', 'bin', 'gh'))
    expect(cli.directoryForPath()).toBe(path.dirname(executable))
    await expect(access(executable)).resolves.toBeUndefined()

    // A restart finds the download without fetching again.
    const restarted = new GithubCli({
      root,
      release,
      findSystem: none,
      fetch: () => Promise.reject(new Error('offline')),
    })
    await restarted.prepare()
    expect(restarted.status()).toMatchObject({ available: true, source: 'downloaded' })

    expect(await cli.removeDownloaded()).toEqual({ available: false, download: { version: '99.0.0', state: 'idle' } })
    await expect(access(path.join(root, '99.0.0'))).rejects.toThrow()
  })

  it('keeps nothing from a file whose checksum does not match', async () => {
    const { bytes, release } = await fakeRelease()
    const root = await temporary('nekro-nxt-gh-')
    const cli = new GithubCli({
      root,
      release,
      findSystem: none,
      fetch: () => Promise.resolve(new Response(Buffer.concat([bytes, Buffer.from('x')]))),
    })
    await cli.prepare()
    const done = settled(cli)
    cli.startDownload()
    const status = await done
    expect(status.available).toBe(false)
    expect(status.download).toMatchObject({ state: 'failed', error: '下载的文件校验不通过，已丢弃。' })
    await expect(access(path.join(root, '99.0.0'))).rejects.toThrow()
  })

  it('says so when this platform has no release to download', async () => {
    const cli = new GithubCli({
      root: await temporary('nekro-nxt-gh-'),
      findSystem: none,
      release: { version: '1.0.0', baseUrl: 'https://x.test', artifacts: {} },
    })
    await cli.prepare()
    expect(cli.status()).toEqual({ available: false })
    expect(() => cli.startDownload()).toThrow('这台设备不能自动下载 GitHub CLI。')
  })
})
