import assert from 'node:assert/strict'
import test from 'node:test'
import { mirrorFolder, mirrorManifest, prunableFolders, releaseReceipts } from '../mirror-desktop-release.mjs'

const commit = '0123456789abcdef0123456789abcdef01234567'
const stable = { channel: 'stable', version: '0.8.0', commit }
const preview = { channel: 'preview', version: '0.8.0-20261101-010101utc.g0123456789ab', commit }

const receipt = (overrides = {}) => ({
  format: 'nxt.desktop-artifact-receipt',
  version: 1,
  channel: 'stable',
  platform: 'win',
  arch: 'x64',
  releaseVersion: '0.8.0',
  commit,
  artifact: 'nekro-nxt-win-x64-v0.8.0-setup.exe',
  bytes: 200,
  sha256: 'a'.repeat(64),
  ...overrides,
})

test('puts a Stable release under its version and the rolling Preview under its commit', () => {
  assert.equal(mirrorFolder(stable), 'v0.8.0')
  assert.equal(mirrorFolder(preview), commit)
})

test('describes every installer with a path relative to the manifest', () => {
  const manifest = mirrorManifest(stable, [receipt()], { publishedAt: 5, releaseUrl: 'https://example.com/r' })
  assert.deepEqual(manifest, {
    format: 'nxt.desktop-mirror',
    version: 1,
    channel: 'stable',
    releaseVersion: '0.8.0',
    commit,
    publishedAt: 5,
    releaseUrl: 'https://example.com/r',
    files: [
      {
        platform: 'win',
        arch: 'x64',
        name: 'nekro-nxt-win-x64-v0.8.0-setup.exe',
        size: 200,
        sha256: 'a'.repeat(64),
        path: 'files/v0.8.0/nekro-nxt-win-x64-v0.8.0-setup.exe',
      },
    ],
  })
})

test('mirrors only receipts of this exact build', () => {
  const kept = releaseReceipts(stable, [
    receipt(),
    receipt({ commit: 'f'.repeat(40) }),
    receipt({ channel: 'preview' }),
    receipt({ sha256: 'not-a-digest' }),
  ])
  assert.equal(kept.length, 1)
  assert.throws(() => releaseReceipts(stable, [receipt({ releaseVersion: '0.7.0' })]), /没有找到/u)
})

test('keeps the new release and the previous one, deletes the rest', () => {
  assert.deepEqual(prunableFolders(['v0.6.0', 'v0.7.0', 'v0.8.0'], ['v0.8.0', 'v0.7.0']), ['v0.6.0'])
  assert.deepEqual(prunableFolders(['v0.7.0', 'v0.8.0'], ['v0.8.0', undefined]), ['v0.7.0'])
})
