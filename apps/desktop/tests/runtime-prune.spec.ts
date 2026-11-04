import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  packageMatchesTarget,
  prebuildIsForeign,
  pruneServerRuntime,
  runtimeTarget,
} from '../scripts/prune-server-runtime.mjs'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const writePackage = async (directory: string, manifest: Record<string, unknown>, files: string[] = []) => {
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'package.json'), JSON.stringify(manifest))
  for (const file of files) {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true })
    await writeFile(path.join(directory, file), 'binary')
  }
}

const exists = async (filename: string) => (await stat(filename).catch(() => undefined)) !== undefined

const fixtureRuntime = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'nxt-runtime-prune-'))
  roots.push(root)
  const modules = path.join(root, 'node_modules')
  const platformPackage = (name: string, os: string, cpu: string, libc?: string) =>
    writePackage(path.join(modules, ...name.split('/')), {
      name,
      os: [os],
      cpu: [cpu],
      ...(libc ? { libc: [libc] } : {}),
    })
  await platformPackage('@img/sharp-darwin-arm64', 'darwin', 'arm64')
  await platformPackage('@img/sharp-darwin-x64', 'darwin', 'x64')
  await platformPackage('@img/sharp-linux-x64', 'linux', 'x64', 'glibc')
  await platformPackage('@img/sharp-linuxmusl-x64', 'linux', 'x64', 'musl')
  await platformPackage('@img/sharp-win32-x64', 'win32', 'x64')
  await platformPackage('@esbuild/win32-arm64', 'win32', 'arm64')
  await writePackage(path.join(modules, '@img', 'colour'), { name: '@img/colour' })
  await writePackage(path.join(modules, 'better-sqlite3'), { name: 'better-sqlite3' }, [
    'prebuilds/darwin-arm64.node',
    'prebuilds/darwin-x64.node',
    'prebuilds/linux-x64.node',
    'prebuilds/linuxmusl-x64.node',
    'prebuilds/win32-x64.node',
    'deps/sqlite3/sqlite3.c',
    'lib/index.js',
  ])
  await writePackage(path.join(modules, 'node-pty'), { name: 'node-pty' }, [
    'prebuilds/darwin-arm64/pty.node',
    'prebuilds/linux-x64/pty.node',
    'prebuilds/win32-x64/conpty.node',
    'prebuilds/win32-arm64/conpty.node',
    'third_party/conpty/1.0/win10-x64/conpty.dll',
  ])
  // 嵌套依赖里的平台包也要处理。
  await writePackage(path.join(modules, '@nekro-nxt', 'extension-runtime'), { name: '@nekro-nxt/extension-runtime' })
  await platformPackage('@nekro-nxt/extension-runtime/node_modules/@esbuild/linux-x64', 'linux', 'x64')
  await platformPackage('@nekro-nxt/extension-runtime/node_modules/@esbuild/darwin-arm64', 'darwin', 'arm64')
  return { root, modules }
}

describe('Desktop server runtime pruning', () => {
  it('follows npm os/cpu/libc semantics', () => {
    const mac = runtimeTarget('mac')
    const linux = runtimeTarget('linux')
    expect(packageMatchesTarget({}, mac)).toBe(true)
    expect(packageMatchesTarget({ os: ['darwin'], cpu: ['x64'] }, mac)).toBe(true)
    expect(packageMatchesTarget({ os: ['win32'] }, mac)).toBe(false)
    expect(packageMatchesTarget({ os: ['!win32'] }, mac)).toBe(true)
    expect(packageMatchesTarget({ os: ['!darwin'] }, mac)).toBe(false)
    expect(packageMatchesTarget({ os: ['linux'], cpu: ['arm64'] }, linux)).toBe(false)
    expect(packageMatchesTarget({ os: ['linux'], cpu: ['x64'], libc: ['musl'] }, linux)).toBe(false)
    expect(packageMatchesTarget({ os: ['linux'], cpu: ['x64'], libc: ['glibc'] }, linux)).toBe(true)
    expect(prebuildIsForeign('linuxmusl-x64.node', linux)).toBe(true)
    expect(prebuildIsForeign('linux-x64', linux)).toBe(false)
    expect(prebuildIsForeign('napi-v6', linux)).toBe(false)
  })

  it('keeps both macOS architectures and drops everything mac cannot load', async () => {
    const { modules } = await fixtureRuntime()
    await pruneServerRuntime(path.dirname(modules), 'mac')
    expect((await readdir(path.join(modules, '@img'))).sort()).toEqual([
      'colour',
      'sharp-darwin-arm64',
      'sharp-darwin-x64',
    ])
    expect(await exists(path.join(modules, '@esbuild', 'win32-arm64'))).toBe(false)
    expect((await readdir(path.join(modules, 'better-sqlite3', 'prebuilds'))).sort()).toEqual([
      'darwin-arm64.node',
      'darwin-x64.node',
    ])
    expect(await exists(path.join(modules, 'better-sqlite3', 'deps'))).toBe(false)
    expect(await exists(path.join(modules, 'better-sqlite3', 'lib', 'index.js'))).toBe(true)
    expect(await readdir(path.join(modules, 'node-pty', 'prebuilds'))).toEqual(['darwin-arm64'])
    expect(await exists(path.join(modules, 'node-pty', 'third_party'))).toBe(false)
    expect(await readdir(path.join(modules, '@nekro-nxt', 'extension-runtime', 'node_modules', '@esbuild'))).toEqual([
      'darwin-arm64',
    ])
  })

  it('keeps the Windows conpty files and only win32-x64 binaries', async () => {
    const { modules } = await fixtureRuntime()
    const { removed, bytes } = await pruneServerRuntime(path.dirname(modules), 'win')
    expect(await readdir(path.join(modules, 'node-pty', 'prebuilds'))).toEqual(['win32-x64'])
    expect(await exists(path.join(modules, 'node-pty', 'third_party', 'conpty'))).toBe(true)
    expect(await readdir(path.join(modules, 'better-sqlite3', 'prebuilds'))).toEqual(['win32-x64.node'])
    expect(await readdir(path.join(modules, '@img'))).toEqual(expect.arrayContaining(['sharp-win32-x64']))
    expect(await exists(path.join(modules, '@img', 'sharp-linux-x64'))).toBe(false)
    expect(removed).toContain(path.join('node_modules', '@esbuild', 'win32-arm64'))
    expect(bytes).toBeGreaterThan(0)
  })

  it('keeps glibc and drops musl on Linux', async () => {
    const { modules } = await fixtureRuntime()
    await pruneServerRuntime(path.dirname(modules), 'linux')
    expect((await readdir(path.join(modules, '@img'))).sort()).toEqual(['colour', 'sharp-linux-x64'])
    expect(await readdir(path.join(modules, 'better-sqlite3', 'prebuilds'))).toEqual(['linux-x64.node'])
    expect(await readdir(path.join(modules, '@nekro-nxt', 'extension-runtime', 'node_modules', '@esbuild'))).toEqual([
      'linux-x64',
    ])
  })
})
