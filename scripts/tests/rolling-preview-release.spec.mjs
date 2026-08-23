import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertPreviewReceipt,
  expectedPreviewAssets,
  previewArtifactName,
  previewReleaseBody,
  previewReleaseTitle,
} from '../rolling-preview-release.mjs'

const distribution = { artifactSlug: 'nekro-nxt-preview' }
const release = {
  version: '1.4.0-preview.1750000000',
  releaseId: '1.4.0-preview.1750000000+0123456789ab',
  commit: '0123456789abcdef0123456789abcdef01234567',
}

test('rolling Preview derives the six public assets from the Product Release version', () => {
  assert.equal(
    previewArtifactName(distribution, release.version, 'mac'),
    'nekro-nxt-preview-mac-universal-v1.4.0-preview.1750000000.dmg',
  )
  assert.equal(
    previewArtifactName(distribution, release.version, 'win'),
    'nekro-nxt-preview-win-x64-v1.4.0-preview.1750000000-setup.exe',
  )
  assert.equal(
    previewArtifactName(distribution, release.version, 'linux'),
    'nekro-nxt-preview-linux-x64-v1.4.0-preview.1750000000.AppImage',
  )
  assert.equal(expectedPreviewAssets(distribution, release.version).length, 6)
})

test('rolling Preview accepts only receipts for the same commit and platform artifact', () => {
  const artifact = previewArtifactName(distribution, release.version, 'linux')
  const receipt = {
    format: 'nxt.desktop-artifact-receipt',
    version: 1,
    channel: 'preview',
    platform: 'linux',
    releaseVersion: release.version,
    releaseId: release.releaseId,
    commit: release.commit,
    artifact,
    sha256: 'a'.repeat(64),
  }
  assert.doesNotThrow(() => assertPreviewReceipt(receipt, release, 'linux', artifact))
  assert.throws(
    () => assertPreviewReceipt({ ...receipt, commit: 'f'.repeat(40) }, release, 'linux', artifact),
    /receipt/u,
  )
})

test('rolling Preview copy identifies its moving channel and immutable Product Release', () => {
  assert.equal(previewReleaseTitle(release), `NekroNxt Preview ${release.version}`)
  const body = previewReleaseBody(release, 'NekroAI/nekro-nxt')
  assert.match(body, /滚动预览版/u)
  assert.match(body, new RegExp(release.releaseId.replaceAll('+', '\\+'), 'u'))
  assert.match(body, /NekroAI\/nekro-nxt\/commit\/0123456789abcdef/u)
})
