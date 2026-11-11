import assert from 'node:assert/strict'
import test from 'node:test'
import {
  androidArtifactName,
  androidMirrorManifest,
  assertAndroidReceipt,
  certificateDigest,
  stableVersionCode,
} from '../android-release.mjs'

const commit = 'a'.repeat(40)
const receipt = {
  format: 'nxt.android-artifact-receipt',
  version: 1,
  channel: 'stable',
  releaseVersion: '0.1.0',
  commit,
  artifact: 'nekro-nxt-android-v0.1.0.apk',
  bytes: 2_400_000,
  sha256: 'b'.repeat(64),
  versionName: '0.1.0',
  versionCode: 1_000,
  certificateSha256: 'c'.repeat(64),
}

test('names APKs per channel and counts stable versions up', () => {
  assert.equal(
    androidArtifactName('preview', '0.9.0-20261111.gabc'),
    'nekro-nxt-preview-android-v0.9.0-20261111.gabc.apk',
  )
  assert.equal(androidArtifactName('stable', '0.1.0'), 'nekro-nxt-android-v0.1.0.apk')
  assert.equal(stableVersionCode('0.1.0'), 1_000)
  assert.ok(stableVersionCode('1.0.0') > stableVersionCode('0.999.999'))
  assert.throws(() => stableVersionCode('0.1'), /x\.y\.z/u)
})

test('reads the signing certificate digest keytool prints', () => {
  const pair = Array.from({ length: 32 }, (_, index) => index.toString(16).padStart(2, '0').toUpperCase())
  const printed = `Signer #1:\n\nCertificate fingerprints:\n\t SHA1: 00\n\t SHA256: ${pair.join(':')}\n`
  assert.equal(certificateDigest(printed), pair.join('').toLowerCase())
  assert.throws(() => certificateDigest('no certificate'), /签名证书/u)
})

test('accepts only the receipt of this release and builds a manifest the app resolves', () => {
  assertAndroidReceipt(receipt, { channel: 'stable', commit, artifact: receipt.artifact })
  assert.throws(() =>
    assertAndroidReceipt(
      { ...receipt, commit: 'd'.repeat(40) },
      { channel: 'stable', commit, artifact: receipt.artifact },
    ),
  )
  assert.throws(() =>
    assertAndroidReceipt(
      { ...receipt, certificateSha256: 'x' },
      { channel: 'stable', commit, artifact: receipt.artifact },
    ),
  )
  const manifest = androidMirrorManifest(receipt, {
    publishedAt: 1,
    releaseUrl: 'https://github.com/NekroAI/nekro-nxt/releases/tag/android-v0.1.0',
    githubUrl: 'https://github.com/NekroAI/nekro-nxt/releases/download/android-v0.1.0/nekro-nxt-android-v0.1.0.apk',
  })
  assert.equal(manifest.format, 'nxt.android-mirror')
  assert.equal(manifest.versionCode, 1_000)
  assert.equal(manifest.file.path, 'files/v0.1.0/nekro-nxt-android-v0.1.0.apk')
  assert.equal(manifest.certificateSha256, 'c'.repeat(64))
  assert.equal(
    androidMirrorManifest({ ...receipt, channel: 'preview' }, { publishedAt: 1, releaseUrl: '', githubUrl: '' }).file
      .path,
    `files/${commit}/nekro-nxt-android-v0.1.0.apk`,
  )
})
