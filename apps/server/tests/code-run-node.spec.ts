import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CodeRunNode, type CodeRunNodeStatus } from '../src/code-run-node.ts'

const temporaryDirectories: string[] = []
const temporary = async (prefix: string) => {
  const directory = await mkdtemp(path.join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const key = `${process.platform}-${process.arch}`

/** A release archive whose `node` only prints a version, laid out like the official tarballs. */
const fakeRelease = async (nodeVersion: string) => {
  const work = await temporary('nekro-nxt-node-release-')
  const folder = 'node-v99.0.0-test'
  await mkdir(path.join(work, folder, 'bin'), { recursive: true })
  const executable = path.join(work, folder, 'bin', 'node')
  await writeFile(executable, `#!/bin/sh\necho ${nodeVersion}\n`)
  await chmod(executable, 0o755)
  const file = `${folder}.tar.gz`
  execFileSync('tar', ['-czf', path.join(work, file), '-C', work, folder])
  const bytes = await readFile(path.join(work, file))
  return {
    bytes,
    release: {
      version: '99.0.0',
      baseUrl: 'https://downloads.example.test/dist',
      artifacts: { [key]: { file, sha256: createHash('sha256').update(bytes).digest('hex') } },
    },
  }
}

const settled = (node: CodeRunNode) =>
  new Promise<CodeRunNodeStatus>((resolve) => {
    const check = () => {
      const status = node.status()
      if (status.download?.state !== 'downloading') {
        unsubscribe()
        resolve(status)
      }
    }
    const unsubscribe = node.subscribe(check)
  })

describe.skipIf(process.platform === 'win32')('Node for run_code', () => {
  beforeEach(async () => {
    // Only `tar` is reachable, so no Node on this machine's PATH answers for the desktop app. GNU tar runs `gzip`
    // from PATH for `.tar.gz`, so it comes along.
    const bin = await temporary('nekro-nxt-path-')
    for (const command of ['tar', 'gzip'])
      await symlink(
        execFileSync('sh', ['-c', `command -v ${command}`])
          .toString()
          .trim(),
        path.join(bin, command),
      )
    vi.stubEnv('PATH', bin)
  })

  it('uses the server process itself outside the desktop app', async () => {
    const node = new CodeRunNode({ root: await temporary('nekro-nxt-runtimes-'), embedded: false })
    await node.prepare()
    expect(node.status()).toEqual({ available: true, source: 'host', version: process.versions.node })
    expect(node.executable()).toEqual({})
  })

  it('downloads, verifies and unpacks the pinned release, then removes it again', async () => {
    const { bytes, release } = await fakeRelease('v24.21.0')
    const requested: string[] = []
    const root = await temporary('nekro-nxt-runtimes-')
    const node = new CodeRunNode({
      root,
      embedded: true,
      release,
      fetch: (url) => {
        requested.push(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url)
        return Promise.resolve(new Response(bytes, { headers: { 'content-length': String(bytes.length) } }))
      },
    })
    await node.prepare()
    expect(node.status()).toEqual({ available: false, download: { version: '99.0.0', state: 'idle' } })
    expect(node.executable()).toBeUndefined()

    const done = settled(node)
    expect(node.startDownload().download?.state).toBe('downloading')
    expect(await done).toEqual({ available: true, source: 'downloaded', version: '99.0.0' })
    expect(requested).toEqual([`https://downloads.example.test/dist/${release.artifacts[key]!.file}`])
    const executable = node.executable()?.executable
    expect(executable).toBe(path.join(root, '99.0.0', 'node-v99.0.0-test', 'bin', 'node'))
    await expect(access(executable!)).resolves.toBeUndefined()

    // A restart finds the download without fetching again.
    const restarted = new CodeRunNode({
      root,
      embedded: true,
      release,
      fetch: () => Promise.reject(new Error('offline')),
    })
    await restarted.prepare()
    expect(restarted.status()).toMatchObject({ available: true, source: 'downloaded' })

    expect(await node.removeDownloaded()).toEqual({ available: false, download: { version: '99.0.0', state: 'idle' } })
    await expect(access(path.join(root, '99.0.0'))).rejects.toThrow()
  })

  it('keeps nothing from a file whose checksum does not match, and allows a retry', async () => {
    const { bytes, release } = await fakeRelease('v24.21.0')
    const root = await temporary('nekro-nxt-runtimes-')
    let tampered = true
    const node = new CodeRunNode({
      root,
      embedded: true,
      release,
      fetch: () => Promise.resolve(new Response(tampered ? Buffer.concat([bytes, Buffer.from('x')]) : bytes)),
    })
    await node.prepare()
    let done = settled(node)
    node.startDownload()
    expect(await done).toEqual({
      available: false,
      download: { version: '99.0.0', state: 'failed', error: '下载的文件校验不通过，已丢弃。' },
    })
    await expect(access(path.join(root, '99.0.0'))).rejects.toThrow()

    tampered = false
    done = settled(node)
    node.startDownload()
    expect((await done).available).toBe(true)
  })

  it('rejects a downloaded Node older than the programs need and does not keep it', async () => {
    const { bytes, release } = await fakeRelease('v20.0.0')
    const root = await temporary('nekro-nxt-runtimes-')
    const node = new CodeRunNode({
      root,
      embedded: true,
      release,
      fetch: () => Promise.resolve(new Response(bytes)),
    })
    await node.prepare()
    const done = settled(node)
    node.startDownload()
    expect(await done).toMatchObject({
      available: false,
      download: { state: 'failed', error: '下载的 Node v20.0.0 版本过低。' },
    })
    await expect(access(path.join(root, '99.0.0'))).rejects.toThrow()
  })

  it('offers no download on a platform without a pinned build', async () => {
    const node = new CodeRunNode({ root: await temporary('nekro-nxt-runtimes-'), embedded: true, platform: 'aix' })
    await node.prepare()
    expect(node.status()).toEqual({ available: false })
    expect(() => node.startDownload()).toThrow('这台设备不能自动下载运行环境。')
  })
})
