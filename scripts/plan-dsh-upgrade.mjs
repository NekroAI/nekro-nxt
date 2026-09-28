import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DSH_RUNTIME_RELEASE } from './lib/dsh-release.mjs'

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const registry = 'https://registry.npmjs.org'
const sections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
const exactVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/u
const changes = (before = {}, after = {}) =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .sort()
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .map((key) => ({ key, before: before[key] ?? null, after: after[key] ?? null }))

// String and conditional root exports are valid Node package entry declarations.
const publicExports = (manifest) => {
  const value = manifest?.exports
  if (value === undefined) return manifest?.main ? { '.': manifest.main } : {}
  if (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).some((key) => key.startsWith('.'))
  )
    return value
  return { '.': value }
}

/** @param {unknown} value @returns {Record<string, unknown>} */
function metadataRecord(value, label) {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid npm metadata: ${label}`)
  }
  return Object.fromEntries(Object.entries(value))
}

export function parseUpgradeTarget(args) {
  if (args.length !== 2 || args[0] !== '--target' || !exactVersion.test(args[1])) {
    throw new Error('用法：pnpm dsh:plan-upgrade --target <精确版本>')
  }
  return args[1]
}

/** Only reads workspace declarations and registry metadata; never installs or modifies packages. */
export async function planDshUpgrade({
  target,
  root = repositoryRoot,
  release = DSH_RUNTIME_RELEASE,
  fetch: fetchMetadata = globalThis.fetch,
}) {
  if (!exactVersion.test(target ?? '')) throw new Error('升级目标必须是精确版本')
  const consumers = new Map()
  const filenames = [path.join(root, 'package.json')]
  for (const parent of ['apps', 'packages']) {
    for (const entry of await readdir(path.join(root, parent), { withFileTypes: true })) {
      if (entry.isDirectory()) filenames.push(path.join(root, parent, entry.name, 'package.json'))
    }
  }
  for (const filename of filenames) {
    let manifest
    try {
      manifest = JSON.parse(await readFile(filename, 'utf8'))
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue
      throw error
    }
    for (const section of sections) {
      for (const [name, version] of Object.entries(manifest[section] ?? {})) {
        if (!name.startsWith('@deepseek-ai/dsh-')) continue
        const list = consumers.get(name) ?? []
        list.push({ path: path.relative(root, filename), section, version })
        consumers.set(name, list)
      }
    }
  }
  const queue = [...consumers.keys()].sort()
  const packages = []
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      for (let name; (name = queue.shift());) {
        const response = await fetchMetadata(`${registry}/${encodeURIComponent(name)}`, {
          signal: globalThis.AbortSignal.timeout(30_000),
        })
        if (!response.ok && response.status !== 404) throw new Error(`${name} metadata HTTP ${response.status}`)
        const metadata = response.status === 404 ? {} : metadataRecord(await response.json(), name)
        const currentVersion = release.packages[name] ?? release.exceptions[name] ?? release.dshVersion
        const versions = metadataRecord(metadata.versions, `${name}.versions`)
        const current =
          versions[currentVersion] === undefined
            ? undefined
            : metadataRecord(versions[currentVersion], `${name}@${currentVersion}`)
        const next = versions[target] === undefined ? undefined : metadataRecord(versions[target], `${name}@${target}`)
        packages.push({
          name,
          currentVersion,
          target,
          available: !!next,
          baselineAvailable: !!current,
          consumers: consumers
            .get(name)
            .sort((a, b) => a.path.localeCompare(b.path, 'en') || a.section.localeCompare(b.section, 'en')),
          distTags: metadataRecord(metadata['dist-tags'], `${name}.dist-tags`),
          ...(next && current
            ? {
                peerChanges: changes(
                  metadataRecord(current.peerDependencies, `${name} current peers`),
                  metadataRecord(next.peerDependencies, `${name} target peers`),
                ),
                exportChanges: changes(publicExports(current), publicExports(next)),
              }
            : {}),
        })
      }
    }),
  )
  packages.sort((a, b) => a.name.localeCompare(b.name, 'en'))
  return {
    current: release.dshVersion,
    target,
    registry,
    release: `https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v${target}`,
    packages,
    synchronize: [
      ...new Set([...consumers.values()].flat().map((consumer) => consumer.path)),
      'packages/dsh-compat/src/release.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'apps/server/src/dsh-roster.ts',
      'packages/extension-sdk/src/index.ts',
      'apps/web/src/dsh-dynamic-client.ts',
      'apps/web/src/dsh-client-bundles.d.ts',
    ].sort(),
    review: [
      'Session compatibility and reset policy',
      'Settings/Profile conversion',
      'Extension ABI and client bundles',
      'Upgrade fixtures and recovery points',
    ],
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const report = await planDshUpgrade({ target: parseUpgradeTarget(process.argv.slice(2)) })
  console.log(JSON.stringify(report, null, 2))
  if (report.packages.some((entry) => !entry.available || !entry.baselineAvailable)) process.exitCode = 2
}
