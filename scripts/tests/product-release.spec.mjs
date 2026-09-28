import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  assertCleanGitStatus,
  readDshReleaseVersion,
  readProductRelease,
  releaseVersionForChannel,
} from '../product-release.mjs'

import { DSH_RUNTIME_RELEASE } from '../lib/dsh-release.mjs'

const repositoryRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))

test('stable product Release binds Desktop, Host and DSH to the root version and current commit', async () => {
  const release = await readProductRelease(repositoryRoot, 'stable')
  assert.equal(release.format, 'nxt.product-release')
  assert.equal(release.channel, 'stable')
  assert.equal(release.version, release.baseVersion)
  assert.match(release.commit, /^[a-f0-9]{40}$/u)
  assert.equal(release.releaseId, `${release.version}+${release.commit.slice(0, 12)}`)
  assert.equal(release.dshVersion, DSH_RUNTIME_RELEASE.dshVersion)
})

test('preview version is deterministic, derived from the root version and newer than its earlier preview', () => {
  assert.equal(releaseVersionForChannel('1.4.0', 'stable', 1_750_000_000), '1.4.0')
  const firstCommit = '0123456789abcdef0123456789abcdef01234567'
  const secondCommit = 'fedcba9876543210fedcba9876543210fedcba98'
  assert.equal(
    releaseVersionForChannel('1.4.0', 'preview', 1_750_000_000, firstCommit),
    '1.4.0-20250615-150640utc.g0123456789ab',
  )
  assert.notEqual(
    releaseVersionForChannel('1.4.0', 'preview', 1_750_000_000, firstCommit),
    releaseVersionForChannel('1.4.0', 'preview', 1_750_000_000, secondCommit),
  )
  assert.throws(() => releaseVersionForChannel('1.4.0-rc.1', 'preview', 1_750_000_000, firstCommit), /SemVer/u)
  assert.throws(() => releaseVersionForChannel('1.4.0', 'preview', 1_750_000_000), /commit/u)
})

test('product Release rejects a dirty worktree before assigning the HEAD identity', () => {
  assert.doesNotThrow(() => assertCleanGitStatus(''))
  assert.throws(() => assertCleanGitStatus(' M apps/server/src/main.ts\n'), /worktree 干净/u)
  assert.throws(() => assertCleanGitStatus('?? local-file\n'), /worktree 干净/u)
})

test('Docker build context excludes every repository credential pattern', async () => {
  const entries = new Set(
    (await readFile(path.join(repositoryRoot, '.dockerignore'), 'utf8'))
      .split(/\r?\n/u)
      .map((entry) => entry.trim())
      .filter(Boolean),
  )
  for (const pattern of [
    '.env',
    '.env.*',
    '.npmrc',
    '*.pem',
    '*.p12',
    '*.pfx',
    '*.mobileprovision',
    'credentials*.json',
    'secrets',
  ]) {
    assert.ok(entries.has(pattern), `Docker ignore 缺少敏感模式：${pattern}`)
  }
})

test('Server image carries the software license and reserved-brand notice', async () => {
  const dockerfile = await readFile(path.join(repositoryRoot, 'Dockerfile'), 'utf8')
  assert.match(
    dockerfile,
    /COPY --from=build --chown=root:root \/workspace\/LICENSE \/workspace\/NOTICE \/opt\/nekro\//u,
  )
})

async function runtimeFixture(context, runtimeRelease, agentVersion) {
  const root = await mkdtemp(path.join(tmpdir(), 'nxt-product-release-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, 'packages/dsh-compat/src'), { recursive: true })
  await mkdir(path.join(root, 'apps/server'), { recursive: true })
  await writeFile(path.join(root, 'packages/dsh-compat/src/release.json'), JSON.stringify(runtimeRelease))
  await writeFile(
    path.join(root, 'apps/server/package.json'),
    JSON.stringify({ dependencies: { '@deepseek-ai/dsh-agent': agentVersion } }),
  )
  return root
}

test('artifact DSH identity comes from the candidate repository manifest, without a legacy SQLite dependency', async (context) => {
  const version = '9.0.0-fixture'
  const runtime = { ...DSH_RUNTIME_RELEASE, dshVersion: version, packages: { '@deepseek-ai/dsh-agent': version } }
  const root = await runtimeFixture(context, runtime, version)
  assert.equal(await readDshReleaseVersion(root), version)
})

test('artifact identity refuses a Server dependency that differs from the central release', async (context) => {
  const root = await runtimeFixture(context, DSH_RUNTIME_RELEASE, '0.0.0-fixture')
  await assert.rejects(readDshReleaseVersion(root), /清单无效或与 Server 依赖不一致/u)
})

for (const replacement of [{ format: 'unknown' }, { version: 2 }, { dshVersion: 'next' }, { packages: {} }]) {
  test(`artifact identity rejects invalid runtime release metadata ${JSON.stringify(replacement)}`, async (context) => {
    const root = await runtimeFixture(
      context,
      { ...DSH_RUNTIME_RELEASE, ...replacement },
      DSH_RUNTIME_RELEASE.dshVersion,
    )
    await assert.rejects(readDshReleaseVersion(root), /清单无效/u)
  })
}
