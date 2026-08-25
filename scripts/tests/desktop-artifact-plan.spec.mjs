import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import desktopDistributions from '../../apps/desktop/distributions.json' with { type: 'json' }
import {
  assertArtifactIntegrity,
  artifactTarget,
  desktopArchitectures,
  electronBuilderArguments,
  readArtifactIntegrity,
  receiptTargets,
} from '../product-release.mjs'

const repositoryRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))

test('macOS production plan is exactly arm64 and x64 without Universal', () => {
  assert.deepEqual(desktopArchitectures('mac'), ['arm64', 'x64'])
  assert.deepEqual(electronBuilderArguments('mac'), ['--mac', '--arm64', '--x64'])
  assert.deepEqual(receiptTargets('mac'), [
    { platform: 'mac', arch: 'arm64' },
    { platform: 'mac', arch: 'x64' },
  ])
  assert.equal(JSON.stringify(receiptTargets('all')).includes('universal'), false)
})

test('Stable and Preview artifact plans produce the exact public filenames', () => {
  const stableVersion = '1.4.0'
  const previewVersion = '1.4.0-20250615-150640utc.g0123456789ab'
  assert.equal(
    artifactTarget(desktopDistributions.stable, stableVersion, 'mac', 'arm64').artifactName,
    'nekro-nxt-mac-arm64-v1.4.0.dmg',
  )
  assert.equal(
    artifactTarget(desktopDistributions.stable, stableVersion, 'mac', 'x64').artifactName,
    'nekro-nxt-mac-x64-v1.4.0.dmg',
  )
  assert.equal(
    artifactTarget(desktopDistributions.preview, previewVersion, 'mac', 'arm64').artifactName,
    'nekro-nxt-preview-mac-arm64-v1.4.0-20250615-150640utc.g0123456789ab.dmg',
  )
  assert.equal(
    artifactTarget(desktopDistributions.preview, previewVersion, 'mac', 'x64').artifactName,
    'nekro-nxt-preview-mac-x64-v1.4.0-20250615-150640utc.g0123456789ab.dmg',
  )
  assert.equal(
    artifactTarget(desktopDistributions.preview, previewVersion, 'win').artifactName,
    'nekro-nxt-preview-win-x64-v1.4.0-20250615-150640utc.g0123456789ab-setup.exe',
  )
  assert.equal(
    artifactTarget(desktopDistributions.preview, previewVersion, 'linux').artifactName,
    'nekro-nxt-preview-linux-x64-v1.4.0-20250615-150640utc.g0123456789ab.AppImage',
  )
})

test('receipt writer rejects macOS without an explicit architecture before reading build output', () => {
  const result = spawnSync(
    process.execPath,
    ['apps/desktop/scripts/write-artifact-receipt.mjs', '--channel', 'preview', '--platform', 'mac'],
    { cwd: repositoryRoot, encoding: 'utf8' },
  )
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Desktop 产物架构无效：mac\/undefined/u)
})

test('local artifact integrity requires matching positive bytes and SHA-256', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'nekro-nxt-artifact-integrity-'))
  try {
    const artifact = path.join(temporaryRoot, 'fixture.dmg')
    const contents = Buffer.from('synthetic desktop artifact fixture')
    await writeFile(artifact, contents)
    const integrity = await readArtifactIntegrity(artifact)
    const expectedHash = createHash('sha256').update(contents).digest('hex')
    assert.deepEqual(integrity, { bytes: contents.length, sha256: expectedHash })
    assert.doesNotThrow(() => assertArtifactIntegrity(integrity, integrity, 'fixture.dmg'))
    assert.throws(() => assertArtifactIntegrity({ ...integrity, bytes: 0 }, integrity, 'fixture.dmg'), /完整性不一致/u)
    assert.throws(
      () => assertArtifactIntegrity({ ...integrity, sha256: 'f'.repeat(64) }, integrity, 'fixture.dmg'),
      /完整性不一致/u,
    )
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})
