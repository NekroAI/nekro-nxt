// The shared packages published to npm. Before a stable release they go out under the `next` dist-tag; the stable
// release workflow points `latest` at the same versions (docs/09-正式发布与更新日志规范.md §6).
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
 * @param {string} name
 * @param {string} version
 * @returns {boolean} whether npm has this exact version, under any dist-tag
 */
export function npmHasVersion(name, version) {
  const result = spawnSync('npm', ['view', `${name}@${version}`, 'version'], { encoding: 'utf8' })
  if (result.error) throw result.error
  return result.status === 0 && result.stdout.trim() === version
}

/**
 * @param {{ readonly name: string, readonly version: string, readonly published: boolean }[]} packages
 * @returns {string | undefined} why the stable release must wait, or undefined when every local version is on npm
 */
export function unpublishedProblem(packages) {
  const missing = packages.filter(({ published }) => !published)
  if (missing.length === 0) return undefined
  return [
    `${missing.map(({ name, version }) => `${name}@${version}`).join('、')} 还没有发布到 npm。`,
    '正式版要求共享包的本地版本已经在 npm 上：先推送 packages-v* Tag，并在 npm 确认暂存。',
  ].join('\n')
}
