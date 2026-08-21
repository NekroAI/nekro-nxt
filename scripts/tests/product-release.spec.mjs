import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { readProductRelease } from '../product-release.mjs'

const repositoryRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))

test('product Release binds Desktop, Host and DSH to the current commit', async () => {
  const release = await readProductRelease(repositoryRoot)
  assert.equal(release.format, 'nxt.product-release')
  assert.match(release.commit, /^[a-f0-9]{40}$/u)
  assert.equal(release.releaseId, `${release.version}+${release.commit.slice(0, 12)}`)
  assert.equal(release.dshVersion, '0.1.0-rc.6')
})
