import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { assertCleanGitStatus, readProductRelease, releaseVersionForChannel } from '../product-release.mjs'

const repositoryRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))

test('stable product Release binds Desktop, Host and DSH to the root version and current commit', async () => {
  const release = await readProductRelease(repositoryRoot, 'stable')
  assert.equal(release.format, 'nxt.product-release')
  assert.equal(release.channel, 'stable')
  assert.equal(release.version, release.baseVersion)
  assert.match(release.commit, /^[a-f0-9]{40}$/u)
  assert.equal(release.releaseId, `${release.version}+${release.commit.slice(0, 12)}`)
  assert.equal(release.dshVersion, '0.1.1-rc.2')
})

test('preview version is deterministic, derived from the root version and newer than its earlier preview', () => {
  assert.equal(releaseVersionForChannel('1.4.0', 'stable', 1_750_000_000), '1.4.0')
  assert.equal(releaseVersionForChannel('1.4.0', 'preview', 1_750_000_000), '1.4.0-preview.1750000000')
  assert.throws(() => releaseVersionForChannel('1.4.0-rc.1', 'preview', 1_750_000_000), /SemVer/u)
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
