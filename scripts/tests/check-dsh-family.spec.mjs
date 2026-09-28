import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { checkDshFamily } from '../check-dsh-family.mjs'
import { DSH_RUNTIME_RELEASE, expectedDshVersion } from '../lib/dsh-release.mjs'

const agent = '@deepseek-ai/dsh-agent'
const renderer = '@deepseek-ai/dsh-client-ui-renderer'
const transitive = '@deepseek-ai/dsh-tools'
const cordis = '@deepseek-ai/cordis'
const loader = '@deepseek-ai/cordis-plugin-loader'
const version = DSH_RUNTIME_RELEASE.dshVersion
const otherVersion = '0.0.0-fixture'
const releaseImport = "import { DSH_RUNTIME_RELEASE, expectedDshVersion } from '@nekro-nxt/dsh-compat/release'\n"

async function fixture(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'nxt-dsh-family-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const release = {
    ...DSH_RUNTIME_RELEASE,
    exceptions: {},
    packages: {
      [agent]: version,
      [renderer]: version,
      [cordis]: DSH_RUNTIME_RELEASE.cordisVersion,
      [loader]: DSH_RUNTIME_RELEASE.loaderVersion,
    },
  }
  const write = async (filename, value) => {
    const target = path.join(root, filename)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, typeof value === 'string' ? value : JSON.stringify(value))
  }
  const installed = (name, fields = {}, base = 'node_modules') =>
    write(`${base}/${name}/package.json`, {
      name,
      version: release.packages[name] ?? version,
      exports: { './package.json': './package.json' },
      ...fields,
    })
  const files = {
    'package.json': { private: true },
    'apps/server/package.json': {
      dependencies: {
        [agent]: version,
        [cordis]: release.cordisVersion,
        [loader]: release.loaderVersion,
        '@nekro-nxt/dsh-compat': 'workspace:*',
      },
    },
    'apps/web/package.json': { dependencies: { [renderer]: version } },
    'packages/extension-sdk/package.json': { dependencies: { '@nekro-nxt/dsh-compat': 'workspace:*' } },
    'apps/server/src/dsh-roster.ts':
      releaseImport +
      `export const HOST_DSH_PACKAGE_VERSIONS = DSH_RUNTIME_RELEASE.packages\nconst roster = [{ packageName: '${agent}' }]`,
    'packages/extension-sdk/src/index.ts':
      releaseImport + 'const reference = { dshVersion: DSH_RUNTIME_RELEASE.dshVersion }',
    'apps/web/src/dsh-dynamic-client.ts': `import renderer from '${renderer}/client?raw'`,
    'apps/web/src/dsh-client-bundles.d.ts': `declare module '${renderer}/client?raw'`,
    'packages/dsh-compat/src/client.ts': `export type { RootOwnerProps } from '${renderer}/client'`,
    'pnpm-lock.yaml': [...Object.entries(release.packages), [transitive, version]]
      .map(([name, value]) => `  '${name}@${value}': {}`)
      .join('\n'),
  }
  for (const [filename, value] of Object.entries(files)) await write(filename, value)
  for (const name of [...Object.keys(release.packages), transitive])
    await installed(name, name === agent ? { dependencies: { [transitive]: version } } : {})
  return { root, release, write, installed, files, check: () => checkDshFamily({ root, release }) }
}

async function failures(input, ...patterns) {
  const result = await input.check()
  assert.ok(result.failures.length > 0, 'Expected the gate to refuse inconsistent packages')
  for (const pattern of patterns) assert.match(result.failures.join('\n'), pattern)
  return result
}

test('validates declarations, central release consumers and reachable installed dependencies', async (context) => {
  const input = await fixture(context)
  const result = await input.check()
  assert.deepEqual(result.failures, [])
  assert.equal(result.explicit, 4)
  assert.equal(result.resolved, 5)
  assert.equal(result.installed, 5)
})

test('supports a Host-only roster derived through the shared version helper', async (context) => {
  const input = await fixture(context)
  await input.write(
    'apps/server/src/dsh-roster.ts',
    `
    import { expectedDshPackageVersion } from '@nekro-nxt/dsh-compat/release'
    const HOST_DSH_PACKAGES = ['${agent}', '${cordis}', '${loader}'] as const
    export const HOST_DSH_PACKAGE_VERSIONS = Object.fromEntries(
      HOST_DSH_PACKAGES.map((name) => { const version = expectedDshPackageVersion(name); return [name, version] }),
    )
  `,
  )
  assert.deepEqual((await input.check()).failures, [])
  const roster = await readFile(path.join(input.root, 'apps/server/src/dsh-roster.ts'), 'utf8')
  await input.write(
    'apps/server/src/dsh-roster.ts',
    roster.replace('= Object.fromEntries(', '= validate(Object.fromEntries(').replace('    )', '    ))'),
  )
  assert.deepEqual((await input.check()).failures, [])
  await input.write(
    'apps/server/src/dsh-roster.ts',
    (await readFile(path.join(input.root, 'apps/server/src/dsh-roster.ts'), 'utf8')).replace(`, '${loader}'`, ''),
  )
  await failures(input, /Host roster is missing Server dependency @deepseek-ai\/cordis-plugin-loader/u)
})

test('rejects release entries without consumers and declarations absent from the release', async (context) => {
  const input = await fixture(context)
  delete input.release.packages[renderer]
  input.release.packages['@deepseek-ai/dsh-unconsumed-fixture'] = version
  await failures(input, /not covered at this version/u, /dsh-unconsumed-fixture has no workspace consumer/u)
})

test('rejects stale exceptions and incorrect release family metadata', async (context) => {
  const input = await fixture(context)
  input.release.exceptions['@deepseek-ai/dsh-retired-fixture'] = otherVersion
  input.release.packages[agent] = otherVersion
  await failures(input, /release exception.*is stale/u, /invalid family version/u)
})

test('detects actual installed drift even when manifests and lockfile agree', async (context) => {
  const input = await fixture(context)
  await input.installed(agent, { version: otherVersion })
  await failures(input, /installed @deepseek-ai\/dsh-agent@0.0.0-fixture/u)
})

test('follows nested dependencies instead of accepting the root installation', async (context) => {
  const input = await fixture(context)
  await input.installed(transitive, { version: otherVersion }, `node_modules/${agent}/node_modules`)
  await failures(input, /dsh-agent.*→.*dsh-tools.*installed.*0.0.0-fixture/u)
})

test('ignores unused old pnpm cache entries', async (context) => {
  const input = await fixture(context)
  await input.installed(agent, { version: otherVersion }, 'node_modules/.pnpm/unused/node_modules')
  assert.deepEqual((await input.check()).failures, [])
})

test('refuses missing required installed packages', async (context) => {
  const input = await fixture(context)
  await rm(path.join(input.root, 'node_modules', renderer), { recursive: true })
  await failures(input, /dsh-client-ui-renderer.*installed package cannot be resolved/u)
})

test('validates transitive DSH, Cordis and Loader versions from the lockfile', async (context) => {
  const input = await fixture(context)
  await input.write(
    'pnpm-lock.yaml',
    input.files['pnpm-lock.yaml'] +
      `\n'${transitive}@${otherVersion}': {}\n'${cordis}@${otherVersion}': {}\n'${loader}@${otherVersion}': {}`,
  )
  await failures(
    input,
    /pnpm-lock.yaml resolves @deepseek-ai\/dsh-tools@0.0.0-fixture/u,
    /cordis@0.0.0-fixture/u,
    /cordis-plugin-loader@0.0.0-fixture/u,
  )
})

test('checks SDK version consumption and runtime dependency ownership', async (context) => {
  const input = await fixture(context)
  await input.write('packages/extension-sdk/src/index.ts', `const reference = { dshVersion: '${version}' }`)
  await input.write('packages/extension-sdk/package.json', {})
  await failures(input, /Extension SDK dshVersion must consume/u, /extension-sdk\/package.json must declare/u)
})

test('refuses removed Client bundles in source and in the dependency graph', async (context) => {
  const input = await fixture(context)
  await input.write(
    'apps/web/src/dsh-dynamic-client.ts',
    "import client from '@deepseek-ai/dsh-client-runtime/client?raw'",
  )
  await input.write('apps/web/src/dsh-client-bundles.d.ts', "declare module '@deepseek-ai/dsh-client-web-react'")
  await input.write(
    'pnpm-lock.yaml',
    input.files['pnpm-lock.yaml'] + `\n'@deepseek-ai/dsh-client-schema-form@${version}': {}`,
  )
  await failures(
    input,
    /still references retired Client package.*dsh-client-runtime/u,
    /still references retired Client package.*dsh-client-web-react/u,
    /Retired Client package.*dsh-client-schema-form/u,
    /must load the public UI renderer/u,
  )
})

test('pins reachable Include and Group framework peers through the same release manifest', async (context) => {
  const input = await fixture(context)
  const include = '@deepseek-ai/cordis-plugin-include'
  const group = '@deepseek-ai/cordis-plugin-group'
  for (const name of [include, group]) {
    input.release.packages[name] = DSH_RUNTIME_RELEASE.packages[name]
    assert.equal(expectedDshVersion(name), DSH_RUNTIME_RELEASE.packages[name])
  }
  await input.installed(loader, { dependencies: { [include]: input.release.packages[include] } })
  await input.installed(include, {
    version: input.release.packages[include],
    dependencies: { [group]: input.release.packages[group] },
  })
  await input.installed(group, { version: input.release.packages[group] })
  await input.write(
    'pnpm-lock.yaml',
    input.files['pnpm-lock.yaml'] +
      `\n'${include}@${input.release.packages[include]}': {}\n'${group}@${input.release.packages[group]}': {}`,
  )
  assert.deepEqual((await input.check()).failures, [])
  await input.installed(include, { version: otherVersion, dependencies: { [group]: input.release.packages[group] } })
  await failures(input, /installed @deepseek-ai\/cordis-plugin-include@0.0.0-fixture/u)
  await input.write(
    'pnpm-lock.yaml',
    input.files['pnpm-lock.yaml'] + `\n'${include}@${otherVersion}': {}\n'${group}@${otherVersion}': {}`,
  )
  await failures(
    input,
    /pnpm-lock.yaml resolves @deepseek-ai\/cordis-plugin-include@0.0.0-fixture/u,
    /cordis-plugin-group@0.0.0-fixture/u,
  )
})

test('rejects a framework manifest entry with no reachable installed consumer', async (context) => {
  const input = await fixture(context)
  input.release.packages['@deepseek-ai/cordis-plugin-group'] =
    DSH_RUNTIME_RELEASE.packages['@deepseek-ai/cordis-plugin-group']
  await failures(input, /framework package.*cordis-plugin-group has no reachable installed consumer/u)
})
