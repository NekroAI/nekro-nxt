import { readFile, readdir, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DSH_RUNTIME_RELEASE } from './lib/dsh-release.mjs'

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const sections = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
const isFramework = (name) => /^@deepseek-ai\/cordis(?:-plugin-(?:loader|include|group))?$/u.test(name)
const isFamily = (name) => name.startsWith('@deepseek-ai/dsh-') || isFramework(name)
const errorCode = (error) => (error instanceof Error && 'code' in error ? error.code : undefined)
const retiredClientPackages = [
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-schema-form',
]
const expectedVersion = (release, name) => {
  if (name === '@deepseek-ai/cordis') return release.cordisVersion
  if (name === '@deepseek-ai/cordis-plugin-loader') return release.loaderVersion
  return isFramework(name) ? release.packages[name] : (release.exceptions[name] ?? release.dshVersion)
}

async function workspaceManifests(root) {
  const result = [path.join(root, 'package.json')]
  for (const parent of ['apps', 'packages']) {
    for (const entry of await readdir(path.join(root, parent), { withFileTypes: true })) {
      if (entry.isDirectory()) result.push(path.join(root, parent, entry.name, 'package.json'))
    }
  }
  return result
}

/** Read-only validation of declarations, the lockfile and the reachable installed graph. */
export async function checkDshFamily({ root = repositoryRoot, release = DSH_RUNTIME_RELEASE } = {}) {
  const failures = []
  const explicit = new Map()
  const manifests = new Map()
  const installedQueue = []
  const installedPaths = new Set()
  const installedByName = new Map()
  const lockVersions = new Map()
  const expected = (name) => expectedVersion(release, name)

  for (const filename of await workspaceManifests(root)) {
    let manifest
    try {
      manifest = JSON.parse(await readFile(filename, 'utf8'))
    } catch (error) {
      if (errorCode(error) === 'ENOENT') continue
      throw error
    }
    manifests.set(path.relative(root, filename), manifest)
    for (const section of sections) {
      for (const [name, version] of Object.entries(manifest[section] ?? {})) {
        if (!isFamily(name)) continue
        const owner = `${path.relative(root, filename)} ${section}.${name}`
        if (version !== expected(name)) failures.push(`${owner} must be ${expected(name)}, received ${version}`)
        if (release.packages[name] !== version)
          failures.push(`${owner} is not covered at this version by release.json packages`)
        const versions = explicit.get(name) ?? new Set()
        versions.add(version)
        explicit.set(name, versions)
        installedQueue.push({ name, anchor: filename, owner })
      }
    }
  }
  for (const [name, version] of Object.entries(release.packages)) {
    if (
      !isFamily(name) ||
      version !== expected(name) ||
      typeof version !== 'string' ||
      !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.test(version)
    )
      failures.push(`release.json packages.${name} has invalid family version ${version}`)
    if (!explicit.has(name) && !isFramework(name))
      failures.push(`release.json packages.${name} has no workspace consumer`)
  }
  for (const [name, versions] of explicit) {
    if (versions.size > 1) failures.push(`${name} has mixed explicit versions: ${[...versions].sort().join(', ')}`)
  }
  for (const [name, version] of Object.entries(release.exceptions)) {
    if (!explicit.has(name)) failures.push(`DSH release exception ${name}@${version} is stale and must be removed`)
  }

  const lockfile = await readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8')
  for (const match of lockfile.matchAll(
    /(@deepseek-ai\/(?:dsh-[^@:'\s]+|cordis(?:-plugin-(?:loader|include|group))?))@([^:'()\s]+)/gu,
  )) {
    const [, name, version] = match
    const versions = lockVersions.get(name) ?? new Set()
    versions.add(version)
    lockVersions.set(name, versions)
  }
  for (const [name, versions] of lockVersions) {
    for (const version of versions) {
      if (version !== expected(name))
        failures.push(`pnpm-lock.yaml resolves ${name}@${version}; expected ${expected(name)}`)
    }
  }
  for (const name of new Set([...explicit.keys(), ...Object.keys(release.packages)])) {
    if (!lockVersions.has(name)) failures.push(`pnpm-lock.yaml is missing ${name}`)
  }

  // Resolve from each actual consumer, including nested peer sets. Ignore stale,
  // unreachable .pnpm cache entries left over from an earlier installation.
  for (let index = 0; index < installedQueue.length; index += 1) {
    const { name, anchor, owner, optional } = installedQueue[index]
    let filename
    try {
      filename = await realpath(createRequire(anchor).resolve(`${name}/package.json`))
    } catch (error) {
      if (!optional || errorCode(error) !== 'MODULE_NOT_FOUND')
        failures.push(
          `${owner}: installed package cannot be resolved (${errorCode(error) ?? (error instanceof Error ? error.message : String(error))})`,
        )
      continue
    }
    if (installedPaths.has(filename)) continue
    installedPaths.add(filename)
    const installed = JSON.parse(await readFile(filename, 'utf8'))
    const instances = installedByName.get(name) ?? []
    instances.push({ path: filename, version: installed.version })
    installedByName.set(name, instances)
    if (installed.name !== name || installed.version !== expected(name)) {
      failures.push(`${owner}: installed ${installed.name}@${installed.version}; expected ${name}@${expected(name)}`)
    }
    if (!lockVersions.get(name)?.has(installed.version))
      failures.push(`${owner}: installed ${name}@${installed.version} is absent from pnpm-lock.yaml`)
    for (const dependency of new Set([
      ...Object.keys(installed.dependencies ?? {}),
      ...Object.keys(installed.peerDependencies ?? {}),
      ...Object.keys(installed.optionalDependencies ?? {}),
    ])) {
      if (!isFamily(dependency)) continue
      installedQueue.push({
        name: dependency,
        anchor: filename,
        owner: `${name}@${installed.version} → ${dependency}`,
        optional:
          dependency in (installed.optionalDependencies ?? {}) ||
          (!(dependency in (installed.dependencies ?? {})) &&
            installed.peerDependenciesMeta?.[dependency]?.optional === true),
      })
    }
  }

  for (const name of Object.keys(release.packages).filter(isFramework)) {
    if (!installedByName.has(name))
      failures.push(`release.json framework package ${name} has no reachable installed consumer`)
  }

  const source = async (relative) => {
    try {
      return await readFile(path.join(root, relative), 'utf8')
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
      failures.push(`${relative} is missing`)
      return ''
    }
  }
  const importsRelease = (text, symbol = 'DSH_RUNTIME_RELEASE') =>
    new RegExp(
      `import\\s*\\{[^}]*\\b${symbol}\\b[^}]*\\}\\s*from\\s*['"]@nekro-nxt\\/dsh-compat\\/release['"]`,
      'u',
    ).test(text)
  const hostSource = await source('apps/server/src/dsh-roster.ts')
  const directRelease =
    importsRelease(hostSource) && /\bHOST_DSH_PACKAGE_VERSIONS\s*=\s*DSH_RUNTIME_RELEASE\.packages\b/u.test(hostSource)
  const hostList = /\bHOST_DSH_PACKAGES\s*=\s*\[([\s\S]*?)\]\s*as const/u.exec(hostSource)
  const mappedRelease =
    importsRelease(hostSource, 'expectedDshPackageVersion') &&
    hostList &&
    /HOST_DSH_PACKAGE_VERSIONS\s*=[\s\S]*?Object\.fromEntries\(\s*HOST_DSH_PACKAGES\.map\(/u.test(hostSource) &&
    /expectedDshPackageVersion\(name\)/u.test(hostSource)
  if (!directRelease && !mappedRelease)
    failures.push('HOST_DSH_PACKAGE_VERSIONS must consume the shared runtime release')
  const server = manifests.get('apps/server/package.json')
  const hostNames = new Set([
    ...[...hostSource.matchAll(/packageName:\s*['"](@deepseek-ai\/[^'"]+)['"]/gu)].map((match) => match[1]),
    ...[...(hostList?.[1] ?? '').matchAll(/['"](@deepseek-ai\/[^'"]+)['"]/gu)].map((match) => match[1]),
  ])
  for (const name of hostNames) {
    if (server?.dependencies?.[name] !== expected(name) || release.packages[name] !== expected(name)) {
      failures.push(`Host roster ${name} must be declared in Server dependencies and release.json`)
    }
  }
  if (mappedRelease) {
    for (const name of Object.keys(server?.dependencies ?? {}).filter(isFamily)) {
      if (!hostNames.has(name)) failures.push(`Host roster is missing Server dependency ${name}`)
    }
  }
  const sdk = await source('packages/extension-sdk/src/index.ts')
  if (!importsRelease(sdk) || !/\bdshVersion:\s*DSH_RUNTIME_RELEASE\.dshVersion\b/u.test(sdk)) {
    failures.push('Extension SDK dshVersion must consume DSH_RUNTIME_RELEASE.dshVersion')
  }
  for (const filename of ['apps/server/package.json', 'packages/extension-sdk/package.json']) {
    if (!manifests.get(filename)?.dependencies?.['@nekro-nxt/dsh-compat']) {
      failures.push(`${filename} must declare its @nekro-nxt/dsh-compat runtime dependency`)
    }
  }
  for (const name of retiredClientPackages) {
    if (explicit.has(name) || lockVersions.has(name))
      failures.push(`Retired Client package ${name} must be removed from dependencies and lockfile`)
  }
  for (const filename of [
    'apps/web/src/dsh-dynamic-client.ts',
    'apps/web/src/dsh-client-bundles.d.ts',
    'packages/dsh-compat/src/client.ts',
  ]) {
    const client = await source(filename)
    for (const name of retiredClientPackages) {
      if (client.includes(name)) failures.push(`${filename} still references retired Client package ${name}`)
    }
    if (
      filename.endsWith('dsh-dynamic-client.ts') &&
      !client.includes('@deepseek-ai/dsh-client-ui-renderer/client?raw')
    ) {
      failures.push(`${filename} must load the public UI renderer Client bundle`)
    }
  }

  return {
    failures: [...new Set(failures)].sort(),
    explicit: explicit.size,
    resolved: lockVersions.size,
    installed: installedPaths.size,
    installedPackages: installedByName.size,
    duplicateInstances: [...installedByName]
      .filter(([, instances]) => instances.length > 1)
      .map(([name, instances]) => ({ name, instances })),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await checkDshFamily()
  if (result.failures.length > 0) {
    console.error(`DSH release-family check failed:\n- ${result.failures.join('\n- ')}`)
    process.exitCode = 1
  } else {
    console.log(
      `DSH release-family check passed (${DSH_RUNTIME_RELEASE.dshVersion}; ${result.explicit} explicit packages, ${result.resolved} resolved packages, ${result.installed} installed package instances).`,
    )
  }
}
