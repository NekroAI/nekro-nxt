import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { readProductRelease, releaseVersionForChannel } from '../product-release.mjs'

const repositoryRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))

test('stable product Release binds Desktop, Host and DSH to the root version and current commit', async () => {
  const release = await readProductRelease(repositoryRoot, 'stable')
  assert.equal(release.format, 'nxt.product-release')
  assert.equal(release.channel, 'stable')
  assert.equal(release.version, release.baseVersion)
  assert.match(release.commit, /^[a-f0-9]{40}$/u)
  assert.equal(release.releaseId, `${release.version}+${release.commit.slice(0, 12)}`)
  assert.equal(release.dshVersion, '0.1.0-rc.6')
})

test('preview version is deterministic, derived from the root version and newer than its earlier preview', () => {
  assert.equal(releaseVersionForChannel('1.4.0', 'stable', 1_750_000_000), '1.4.0')
  assert.equal(releaseVersionForChannel('1.4.0', 'preview', 1_750_000_000), '1.4.0-preview.1750000000')
  assert.throws(() => releaseVersionForChannel('1.4.0-rc.1', 'preview', 1_750_000_000), /SemVer/u)
})
