import { lstat, readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { desktopArchitectures } from '../../../scripts/product-release.mjs'

const NODE_PLATFORMS = Object.freeze({ mac: 'darwin', win: 'win32', linux: 'linux' })

/** The os/cpu/libc a Desktop platform's installers run on; Linux Desktop only ships glibc. */
export function runtimeTarget(platform) {
  const os = NODE_PLATFORMS[platform]
  if (!os) throw new Error(`Server runtime 目标平台无效：${platform ?? 'undefined'}`)
  return { os, cpus: desktopArchitectures(platform), libc: os === 'linux' ? 'glibc' : undefined }
}

// npm 语义：有正向条目时必须命中其一，`!x` 条目命中则排除。
const allows = (field, value) => {
  if (!Array.isArray(field) || field.length === 0) return true
  if (field.includes(`!${value}`)) return false
  const positive = field.filter((entry) => typeof entry === 'string' && !entry.startsWith('!'))
  return positive.length === 0 || positive.includes(value)
}

/** Whether a package's os/cpu/libc declaration can load on the target; packages without one always can. */
export function packageMatchesTarget(manifest, target) {
  if (!allows(manifest.os, target.os)) return false
  if (!target.cpus.some((cpu) => allows(manifest.cpu, cpu))) return false
  return target.libc === undefined || allows(manifest.libc, target.libc)
}

const PREBUILD_NAME = /^(darwin|linux|linuxmusl|win32)-(x64|arm64|ia32|arm)(?:\.node)?$/u

/** Whether an entry of a package's prebuilds/ directory is for another platform; unknown names are kept. */
export function prebuildIsForeign(name, target) {
  const match = PREBUILD_NAME.exec(name)
  if (!match) return false
  const [, os, cpu] = match
  const nodeOs = os === 'linuxmusl' ? 'linux' : os
  if (nodeOs !== target.os || !target.cpus.includes(cpu)) return true
  return os === 'linuxmusl' && target.libc === 'glibc'
}

// 只在构建源码时需要、运行时从不加载的包内目录。
const packageExtras = (platform) => ({
  'better-sqlite3': ['deps'],
  // conpty DLL 只在 Windows 上由 node-pty 加载。
  'node-pty': platform === 'win' ? [] : ['third_party'],
})

const readManifest = async (directory) => {
  try {
    return JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
}

const sizeOf = async (target) => {
  const entry = await lstat(target)
  if (!entry.isDirectory()) return entry.size
  let total = 0
  for (const child of await readdir(target)) total += await sizeOf(path.join(target, child))
  return total
}

/**
 * Remove what the target platform can never load from a deployed runtime: optional platform
 * packages for other os/cpu/libc, foreign files under prebuilds/, and native build sources.
 * Returns the removed paths (relative to runtimeRoot) and their total size in bytes.
 */
export async function pruneServerRuntime(runtimeRoot, platform) {
  const target = runtimeTarget(platform)
  const extras = packageExtras(platform)
  /** @type {string[]} */
  const removed = []
  let bytes = 0
  const remove = async (absolute) => {
    bytes += await sizeOf(absolute)
    await rm(absolute, { recursive: true, force: true })
    removed.push(path.relative(runtimeRoot, absolute))
  }

  const visitPackage = async (directory, manifest) => {
    if (!packageMatchesTarget(manifest, target)) {
      await remove(directory)
      return
    }
    const prebuilds = path.join(directory, 'prebuilds')
    if ((await lstat(prebuilds).catch(() => undefined))?.isDirectory()) {
      for (const name of await readdir(prebuilds)) {
        if (prebuildIsForeign(name, target)) await remove(path.join(prebuilds, name))
      }
    }
    for (const relative of extras[manifest.name] ?? []) {
      const extra = path.join(directory, relative)
      if (await lstat(extra).catch(() => undefined)) await remove(extra)
    }
    await visitNodeModules(path.join(directory, 'node_modules'))
  }

  const visitNodeModules = async (nodeModules) => {
    const entries = await readdir(nodeModules, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const directory = path.join(nodeModules, entry.name)
      const children = entry.name.startsWith('@')
        ? (await readdir(directory, { withFileTypes: true }))
            .filter((child) => child.isDirectory())
            .map((child) => path.join(directory, child.name))
        : [directory]
      for (const child of children) {
        const manifest = await readManifest(child)
        if (manifest) await visitPackage(child, manifest)
      }
    }
  }

  await visitNodeModules(path.join(runtimeRoot, 'node_modules'))
  return { removed, bytes }
}
