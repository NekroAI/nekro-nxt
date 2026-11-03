import { createHash } from 'node:crypto'
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { gitBashAddon } from '../src/addons.ts'
import { GIT_BASH_RELEASE, GitBash, gitBashMirrorPath, gitRootCandidates } from '../src/git-bash.ts'
import type { RuntimeDownloadState } from '../src/runtime-download.ts'
import { readRuntimeMirror } from '../../../scripts/mirror-runtimes.mjs'

const temporaryDirectories: string[] = []
const temporary = async (prefix: string) => {
  const directory = await mkdtemp(path.join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const none = () => Promise.resolve(undefined)

const settled = (gitBash: GitBash) =>
  new Promise<RuntimeDownloadState | undefined>((resolve) => {
    const check = () => {
      const download = gitBash.download()
      if (download?.state !== 'downloading') {
        unsubscribe()
        resolve(download)
      }
    }
    const unsubscribe = gitBash.subscribe(check)
  })

/** Lays out what PortableGit unpacks to: `bin\bash.exe` and `bin\git.exe`, here shell scripts. */
const fakeUnpack = async (_archive: string, destination: string) => {
  await mkdir(path.join(destination, 'bin'), { recursive: true })
  for (const name of ['bash.exe', 'git.exe']) {
    const program = path.join(destination, 'bin', name)
    await writeFile(program, '#!/bin/sh\necho "git version 99.1.0.windows.1"\n')
    await chmod(program, 0o755)
  }
}

describe('finding Git for Windows', () => {
  it('follows git.exe on PATH to its installation and never bash.exe', () => {
    expect(
      gitRootCandidates(
        [
          'C:\\Program Files\\Git\\cmd\\git.exe',
          'D:\\Tools\\Git\\mingw64\\bin\\git.exe',
          'E:\\PortableGit\\bin\\git.exe',
          'C:\\Somewhere\\git.exe',
        ],
        { ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\Fixture\\AppData\\Local' },
      ),
    ).toEqual([
      'C:\\Program Files\\Git',
      'D:\\Tools\\Git',
      'E:\\PortableGit',
      'C:\\Users\\Fixture\\AppData\\Local\\Programs\\Git',
    ])
  })
})

describe('the pinned PortableGit', () => {
  it('is listed for the download mirror with the same size and checksum', async () => {
    const pinned = z
      .array(z.object({ path: z.string(), url: z.string(), bytes: z.number(), sha256: z.string() }))
      .parse(await readRuntimeMirror())
    const gitBash = new GitBash({ root: '/unused' })
    for (const artifact of Object.values(GIT_BASH_RELEASE.artifacts)) {
      expect(pinned).toContainEqual({
        path: gitBashMirrorPath(GIT_BASH_RELEASE, artifact.file),
        url: gitBash.sources(artifact.file)[0],
        bytes: artifact.bytes,
        sha256: artifact.sha256,
      })
    }
  })

  it('tries the mirror before GitHub, and GitHub only when the mirror is off', () => {
    const file = GIT_BASH_RELEASE.artifacts['win32-x64']!.file
    const github = `https://github.com/git-for-windows/git/releases/download/${GIT_BASH_RELEASE.tag}/${file}`
    expect(new GitBash({ root: '/unused' }).sources(file)).toEqual([github])
    expect(new GitBash({ root: '/unused', mirror: 'https://dl.example.test/nxt/' }).sources(file)).toEqual([
      `https://dl.example.test/nxt/runtimes/git-for-windows/${GIT_BASH_RELEASE.tag}/${file}`,
      github,
    ])
  })
})

describe.skipIf(process.platform === 'win32')('downloading Git and Bash', () => {
  it('falls back to GitHub, checks the file, unpacks it and removes it again', async () => {
    const archive = Buffer.from('fixture portable git')
    const release = {
      version: '99.1.0',
      tag: 'v99.1.0.windows.1',
      artifacts: {
        'win32-x64': {
          file: 'PortableGit-fixture.7z.exe',
          bytes: archive.length,
          sha256: createHash('sha256').update(archive).digest('hex'),
        },
      },
    }
    const root = await temporary('nekro-nxt-git-')
    const requested: string[] = []
    const gitBash = new GitBash({
      root,
      arch: 'x64',
      release,
      mirror: 'https://dl.example.test/nxt',
      findSystem: none,
      unpack: fakeUnpack,
      fetch: (url) => {
        const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
        requested.push(href)
        return Promise.resolve(
          href.startsWith('https://dl.example.test/') ? new Response('gone', { status: 404 }) : new Response(archive),
        )
      },
    })
    await gitBash.prepare()
    const addon = gitBashAddon(gitBash, root)
    expect(addon.providers.map((provider) => provider.state()?.state)).toEqual([undefined, 'not-installed'])

    const done = settled(gitBash)
    gitBash.startDownload()
    expect(await done).toEqual({ state: 'idle' })
    expect(requested.map((url) => new URL(url).host)).toEqual(['dl.example.test', 'github.com'])
    const bash = path.join(root, '99.1.0', 'bin', 'bash.exe')
    expect(gitBash.downloaded()).toEqual({
      root: path.join(root, '99.1.0'),
      bash,
      git: path.join(root, '99.1.0', 'bin', 'git.exe'),
      version: '99.1.0',
    })
    expect(addon.providers[1]?.state()?.state).toBe('installed')
    expect(addon.providers[1]?.program?.('bash')).toBe(bash)

    await gitBash.removeDownloaded()
    expect(gitBash.downloaded()).toBeUndefined()
    await expect(access(bash)).rejects.toThrow()
  })

  it('keeps nothing when the file does not match the pin', async () => {
    const root = await temporary('nekro-nxt-git-')
    const gitBash = new GitBash({
      root,
      arch: 'x64',
      release: {
        version: '99.1.0',
        tag: 'v99.1.0.windows.1',
        artifacts: { 'win32-x64': { file: 'PortableGit-fixture.7z.exe', bytes: 4, sha256: '0'.repeat(64) } },
      },
      findSystem: none,
      unpack: fakeUnpack,
      fetch: () => Promise.resolve(new Response('evil')),
    })
    await gitBash.prepare()
    const done = settled(gitBash)
    gitBash.startDownload()
    expect((await done)?.state).toBe('failed')
    expect(gitBash.downloaded()).toBeUndefined()
    await expect(access(path.join(root, '99.1.0'))).rejects.toThrow()
  })

  it('uses a Git for Windows the device already has', async () => {
    const gitBash = new GitBash({
      root: await temporary('nekro-nxt-git-'),
      findSystem: () =>
        Promise.resolve({
          root: 'C:\\Program Files\\Git',
          bash: 'C:\\Program Files\\Git\\bin\\bash.exe',
          git: 'C:\\Program Files\\Git\\bin\\git.exe',
          version: '2.47.1',
        }),
    })
    await gitBash.prepare()
    const system = gitBashAddon(gitBash, '/unused').providers[0]
    expect(system?.state()).toEqual({ state: 'available', source: 'system', version: '2.47.1', removable: false })
    expect(system?.program?.('bash')).toBe('C:\\Program Files\\Git\\bin\\bash.exe')
    expect(system?.program?.('git')).toBe('C:\\Program Files\\Git\\bin\\git.exe')
  })
})
