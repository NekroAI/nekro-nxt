import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url))

/** Package manifests own names, production dependencies and source exports. */
export function workspaceProjects(root = workspaceRoot) {
  return ['apps', 'packages']
    .flatMap((group) =>
      readdirSync(path.join(root, group), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .flatMap((entry) => {
          const directory = path.join(root, group, entry.name)
          const manifestPath = path.join(directory, 'package.json')
          return existsSync(manifestPath)
            ? [{ group, directory, manifestPath, manifest: JSON.parse(readFileSync(manifestPath, 'utf8')) }]
            : []
        }),
    )
    .sort((left, right) => left.directory.localeCompare(right.directory))
}

/** @returns {Record<string, string>} */
export function sourceAliases(projects = workspaceProjects()) {
  /** @type {Array<[string, string]>} */
  const aliases = []
  for (const project of projects) {
    if (project.group !== 'packages') continue
    for (const [subpath, entry] of Object.entries(project.manifest.exports ?? {})) {
      if (entry === null || typeof entry !== 'object' || !('source' in entry) || typeof entry.source !== 'string')
        throw new Error(`${project.manifest.name}${subpath}: missing source export`)
      const target = path.resolve(project.directory, entry.source)
      if (!target.startsWith(project.directory + path.sep) || !existsSync(target))
        throw new Error(`Invalid source export: ${target}`)
      aliases.push([project.manifest.name + (subpath === '.' ? '' : subpath.slice(1)), target])
    }
  }
  // Resolve explicit subpaths before the root package alias in bundlers.
  return Object.fromEntries(aliases.sort(([left], [right]) => right.length - left.length))
}
