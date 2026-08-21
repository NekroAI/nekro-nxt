import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import {
  DSH_CORDIS_VERSION,
  DSH_LOADER_VERSION,
  DSH_RELEASE_EXCEPTIONS,
  DSH_RELEASE_VERSION,
  expectedDshVersion,
} from './lib/dsh-release.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const failures = []
const explicit = new Map()

const workspaceManifests = async () => {
  const result = [path.join(root, 'package.json')]
  for (const parent of ['apps', 'packages']) {
    for (const entry of await readdir(path.join(root, parent), { withFileTypes: true })) {
      if (entry.isDirectory()) result.push(path.join(root, parent, entry.name, 'package.json'))
    }
  }
  return result
}

for (const filename of await workspaceManifests()) {
  let manifest
  try {
    manifest = JSON.parse(await readFile(filename, 'utf8'))
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue
    throw error
  }
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, version] of Object.entries(manifest[section] ?? {})) {
      if (!name.startsWith('@deepseek-ai/dsh-')) continue
      const expected = expectedDshVersion(name)
      if (version !== expected) {
        failures.push(`${path.relative(root, filename)} ${section}.${name} must be ${expected}, received ${version}`)
      }
      const versions = explicit.get(name) ?? new Set()
      versions.add(version)
      explicit.set(name, versions)
    }
  }
}

for (const [name, versions] of explicit) {
  if (versions.size > 1) failures.push(`${name} has mixed explicit versions: ${[...versions].sort().join(', ')}`)
}

const lockfile = await readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8')
const lockVersions = new Map()
for (const match of lockfile.matchAll(/@deepseek-ai\/dsh-([^@:'\s]+)@([^:'()\s]+)/gu)) {
  const name = `@deepseek-ai/dsh-${match[1]}`
  const version = match[2]
  const versions = lockVersions.get(name) ?? new Set()
  versions.add(version)
  lockVersions.set(name, versions)
}
for (const [name, versions] of lockVersions) {
  const expected = expectedDshVersion(name)
  for (const version of versions) {
    if (version !== expected) failures.push(`pnpm-lock.yaml resolves ${name}@${version}; expected ${expected}`)
  }
}

const hostSource = await readFile(path.join(root, 'apps/server/src/index.ts'), 'utf8')
const rosterMatch = /const HOST_DSH_PACKAGE_VERSIONS = \{(?<body>[\s\S]*?)\n\} as const/u.exec(hostSource)
if (!rosterMatch?.groups?.body) {
  failures.push('HOST_DSH_PACKAGE_VERSIONS could not be located.')
} else {
  const roster = new Map()
  for (const match of rosterMatch.groups.body.matchAll(/'(?<name>@deepseek-ai\/[^']+)': '(?<version>[^']+)'/gu)) {
    if (match.groups?.name !== undefined && match.groups.version !== undefined) {
      roster.set(match.groups.name, match.groups.version)
    }
  }
  const server = JSON.parse(await readFile(path.join(root, 'apps/server/package.json'), 'utf8'))
  for (const [name, version] of roster) {
    const expected = name === '@deepseek-ai/cordis' ? DSH_CORDIS_VERSION : expectedDshVersion(name)
    if (version !== expected)
      failures.push(`HOST_DSH_PACKAGE_VERSIONS ${name} must be ${expected}, received ${version}`)
    if (server.dependencies?.[name] !== version) {
      failures.push(`HOST_DSH_PACKAGE_VERSIONS ${name}@${version} differs from apps/server/package.json`)
    }
  }
}

for (const [needle, expected] of [
  ['@deepseek-ai/cordis', DSH_CORDIS_VERSION],
  ['@deepseek-ai/cordis-plugin-loader', DSH_LOADER_VERSION],
]) {
  const versionPattern = new RegExp(`${needle.replaceAll('/', '\\/')}@([^:'()\\s]+)`, 'gu')
  for (const match of lockfile.matchAll(versionPattern)) {
    if (match[1] !== expected) failures.push(`pnpm-lock.yaml resolves ${needle}@${match[1]}; expected ${expected}`)
  }
}

for (const [name, version] of DSH_RELEASE_EXCEPTIONS) {
  if (!explicit.has(name)) failures.push(`DSH release exception ${name}@${version} is stale and must be removed.`)
}

if (failures.length > 0) {
  console.error(`DSH release-family check failed:\n- ${failures.join('\n- ')}`)
  process.exitCode = 1
} else {
  console.log(
    `DSH release-family check passed (${DSH_RELEASE_VERSION}; ${explicit.size} explicit packages, ${lockVersions.size} resolved packages, ${DSH_RELEASE_EXCEPTIONS.size} documented rc.7 adapters).`,
  )
}
