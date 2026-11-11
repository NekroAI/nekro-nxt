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

test('reads the signing certificate digest apksigner prints', () => {
  const digest = 'd3d4bcefd6781d1672314a5d7b2a74c4078245214d1525349397a5b5f8bcb107'
  const printed = `Signer #1 certificate DN: CN=NekroNXT Development\nSigner #1 certificate SHA-256 digest: ${digest}\nSigner #1 certificate SHA-1 digest: 00\n`
  assert.equal(certificateDigest(printed), digest)
  // Newer build tools label signers by SDK range; the same key listed twice is still one certificate.
  const ranged = `Signer (minSdkVersion=24, maxSdkVersion=32) certificate SHA-256 digest: ${digest}\nSigner (minSdkVersion=33, maxSdkVersion=2147483647) certificate SHA-256 digest: ${digest}\n`
  assert.equal(certificateDigest(ranged), digest)
  assert.throws(() => certificateDigest('no certificate'), /签名证书/u)
  // Two signers would leave the published fingerprint ambiguous.
  assert.throws(
    () => certificateDigest(`${printed}Signer #2 certificate SHA-256 digest: ${'e'.repeat(64)}\n`),
    /签名证书/u,
  )
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
