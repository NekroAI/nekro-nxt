// The shared packages published to npm. Before a stable release they go out under the `next` dist-tag; the stable
// release points `latest` at the same versions (docs/09-正式发布与更新日志规范.md §6).
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

export const PUBLIC_PACKAGE_DIRECTORIES = ['packages/contracts', 'packages/extension-format', 'packages/extension-sdk']

/**
 * @param {string} repositoryRoot
 * @returns {Promise<{ name: string, version: string }[]>}
 */
export async function localPublicPackages(repositoryRoot) {
  return Promise.all(
    PUBLIC_PACKAGE_DIRECTORIES.map(async (directory) => {
      const manifest = JSON.parse(await readFile(path.join(repositoryRoot, directory, 'package.json'), 'utf8'))
      return { name: manifest.name, version: manifest.version }
    }),
  )
}

/**
 * @param {string} name
 * @returns {Record<string, string>} the package's dist-tags, empty when it has never been published
 */
export function npmDistTags(name) {
  const result = spawnSync('npm', ['view', name, 'dist-tags', '--json'], { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    if (/E404/u.test(result.stderr)) return {}
    throw new Error(`无法读取 ${name} 在 npm 上的 dist-tags：\n${result.stderr.trim()}`)
  }
  return JSON.parse(result.stdout)
}

/**
 * @param {{ readonly name: string, readonly version: string, readonly tags: Record<string, string> }[]} packages
 * @returns {string | undefined} why the stable release must wait, or undefined when every `latest` matches
 */
export function latestProblem(packages) {
  const behind = packages.filter(({ version, tags }) => tags['latest'] !== version)
  if (behind.length === 0) return undefined
  return [
    ...behind.map(
      ({ name, version, tags }) => `${name} 本地是 ${version}，npm 上的 latest 是 ${tags['latest'] ?? '（未发布）'}。`,
    ),
    '正式版要求共享包的 latest 指向本地版本：先运行 pnpm packages:promote。',
  ].join('\n')
}
