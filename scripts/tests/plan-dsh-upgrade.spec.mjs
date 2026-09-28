import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { parseUpgradeTarget, planDshUpgrade } from '../plan-dsh-upgrade.mjs'
import { DSH_RUNTIME_RELEASE } from '../lib/dsh-release.mjs'

const current = DSH_RUNTIME_RELEASE.dshVersion
const target = '9.0.0-rc.1'
const packageName = '@deepseek-ai/dsh-fixture'

async function fixture(context, files = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'nxt-dsh-upgrade-plan-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const declarations = {
    'package.json': { devDependencies: { [packageName]: current } },
    'apps/server/package.json': { dependencies: { [packageName]: current, 'unrelated-package': '1.0.0' } },
    'packages/fixture/package.json': { peerDependencies: { [packageName]: current } },
    ...files,
  }
  for (const [filename, value] of Object.entries(declarations)) {
    const destination = path.join(root, filename)
    await mkdir(path.dirname(destination), { recursive: true })
    await writeFile(destination, JSON.stringify(value))
  }
  return { root, release: { ...DSH_RUNTIME_RELEASE, packages: { [packageName]: current } }, declarations }
}

function registryStub(metadataByName) {
  const calls = []
  return {
    calls,
    fetch: async (url, options) => {
      const name = decodeURIComponent(new URL(url).pathname.slice(1))
      assert.equal(new URL(url).origin, 'https://registry.npmjs.org')
      assert.ok(options.signal instanceof globalThis.AbortSignal)
      assert.ok(Object.hasOwn(metadataByName, name), `Unexpected registry lookup: ${name}`)
      calls.push(name)
      const metadata = metadataByName[name]
      return new globalThis.Response(JSON.stringify(metadata), { status: metadata === null ? 404 : 200 })
    },
  }
}

test('requires an exact target and rejects missing, duplicate, range and unknown arguments', () => {
  assert.equal(parseUpgradeTarget(['--target', target]), target)
  for (const args of [
    [],
    ['--target'],
    [target],
    ['--target', '^1.0.0'],
    ['--target', 'latest'],
    ['--target', '1.0.0', '--target', target],
    ['--target', '01.2.3'],
    ['--other', target],
    ['--target', '1.0.0', '--write'],
  ]) {
    assert.throws(() => parseUpgradeTarget(args), /精确版本/u)
  }
})

test('reports peer and public entry changes once per package across all workspace consumers without writing', async (context) => {
  const input = await fixture(context)
  const stub = registryStub({
    [packageName]: {
      'dist-tags': { next: target, latest: current },
      versions: {
        [current]: {
          peerDependencies: { '@deepseek-ai/cordis': '~4.0.1' },
          exports: { '.': './old.js', './removed': './removed.js' },
        },
        [target]: {
          peerDependencies: { '@deepseek-ai/cordis': '~4.0.4', '@deepseek-ai/cordis-plugin-loader': '~1.0.5' },
          exports: { '.': './new.js', './added': './added.js' },
        },
      },
    },
  })
  const report = await planDshUpgrade({ ...input, target, fetch: stub.fetch })
  assert.deepEqual(stub.calls, [packageName])
  assert.equal(report.current, current)
  assert.equal(report.target, target)
  assert.equal(report.packages.length, 1)
  const entry = report.packages[0]
  assert.equal(entry.available, true)
  assert.equal(entry.baselineAvailable, true)
  assert.equal(entry.consumers.length, 3)
  assert.deepEqual(entry.peerChanges, [
    { key: '@deepseek-ai/cordis', before: '~4.0.1', after: '~4.0.4' },
    { key: '@deepseek-ai/cordis-plugin-loader', before: null, after: '~1.0.5' },
  ])
  assert.deepEqual(entry.exportChanges, [
    { key: '.', before: './old.js', after: './new.js' },
    { key: './added', before: null, after: './added.js' },
    { key: './removed', before: './removed.js', after: null },
  ])
  assert.ok(report.synchronize.includes('package.json'))
  assert.ok(report.synchronize.includes('packages/dsh-compat/src/release.json'))
  assert.ok(report.synchronize.includes('apps/web/src/dsh-client-bundles.d.ts'))
  for (const [filename, contents] of Object.entries(input.declarations)) {
    assert.deepEqual(JSON.parse(await readFile(path.join(input.root, filename), 'utf8')), contents)
  }
})

test('marks removed versions and unpublished packages unavailable', async (context) => {
  const missing = '@deepseek-ai/dsh-fixture-missing'
  const input = await fixture(context, { 'apps/web/package.json': { optionalDependencies: { [missing]: current } } })
  const stub = registryStub({
    [packageName]: { versions: { [current]: { exports: './index.js' } } },
    [missing]: null,
  })
  const report = await planDshUpgrade({ ...input, target, fetch: stub.fetch })
  assert.equal(report.packages.length, 2)
  assert.ok(report.packages.every((entry) => !entry.available))
  assert.ok(report.packages.every((entry) => !Object.hasOwn(entry, 'peerChanges')))
})

test('does not invent added APIs when the old version metadata is unavailable', async (context) => {
  const input = await fixture(context)
  const stub = registryStub({ [packageName]: { versions: { [target]: { exports: './new.js' } } } })
  const report = await planDshUpgrade({ ...input, target, fetch: stub.fetch })
  assert.equal(report.packages[0].available, true)
  assert.equal(report.packages[0].baselineAvailable, false)
  assert.equal(report.packages[0].exportChanges, undefined)
})

for (const [before, after, expected] of [
  [{ exports: './index.js' }, { exports: './new.js' }, { key: '.', before: './index.js', after: './new.js' }],
  [
    { exports: { import: './index.js' } },
    { exports: { import: './new.js' } },
    { key: '.', before: { import: './index.js' }, after: { import: './new.js' } },
  ],
  [{ main: './index.js' }, { exports: { '.': './new.js' } }, { key: '.', before: './index.js', after: './new.js' }],
]) {
  test(`normalizes public exports from ${JSON.stringify(before)}`, async (context) => {
    const input = await fixture(context)
    const stub = registryStub({ [packageName]: { versions: { [current]: before, [target]: after } } })
    const report = await planDshUpgrade({ ...input, target, fetch: stub.fetch })
    assert.deepEqual(report.packages[0].exportChanges, [expected])
  })
}

test('fails on registry outages instead of reporting packages removed', async (context) => {
  const input = await fixture(context)
  await assert.rejects(
    planDshUpgrade({ ...input, target, fetch: () => Promise.resolve(new globalThis.Response(null, { status: 503 })) }),
    /metadata HTTP 503/u,
  )
})

test('uses the release manifest for exception baselines and bounds parallel metadata reads', async (context) => {
  const names = Array.from({ length: 12 }, (_, index) => `@deepseek-ai/dsh-fixture-${index}`)
  const input = await fixture(context, {
    'apps/web/package.json': { dependencies: Object.fromEntries(names.map((name) => [name, current])) },
  })
  const exceptionVersion = '0.0.1-fixture'
  input.release.exceptions = { [packageName]: exceptionVersion }
  delete input.release.packages[packageName]
  let active = 0
  let peak = 0
  const fetch = async (url) => {
    active += 1
    peak = Math.max(peak, active)
    await setImmediate()
    active -= 1
    const name = decodeURIComponent(new URL(url).pathname.slice(1))
    return globalThis.Response.json({
      versions: { [name === packageName ? exceptionVersion : current]: {}, [target]: {} },
    })
  }
  const report = await planDshUpgrade({ ...input, target, fetch })
  assert.equal(report.packages.length, 13)
  assert.ok(peak <= 6)
  assert.ok(peak > 1)
  assert.equal(report.packages.find((entry) => entry.name === packageName).currentVersion, exceptionVersion)
  assert.deepEqual(
    report.packages.map((entry) => entry.name),
    [packageName, ...names].sort((a, b) => a.localeCompare(b, 'en')),
  )
})

for (const metadata of [[], { versions: [] }, { versions: { [target]: 'invalid manifest' } }]) {
  test(`fails closed on malformed registry metadata ${JSON.stringify(metadata)}`, async (context) => {
    const input = await fixture(context)
    const stub = registryStub({ [packageName]: metadata })
    await assert.rejects(planDshUpgrade({ ...input, target, fetch: stub.fetch }), /Invalid npm metadata/u)
  })
}
