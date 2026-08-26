import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertPreviewCandidateAssets,
  assertPreviewReceipt,
  assertRemoteArtifactIntegrity,
  expectedPreviewAssets,
  previewArtifactName,
  previewArtifactTargets,
  previewReleaseBody,
  previewServerImage,
  previewReleaseTitle,
  previewUploadTargets,
  shouldDeletePreviewCandidateAssets,
} from '../rolling-preview-release.mjs'

const distribution = { artifactSlug: 'nekro-nxt-preview' }
const release = {
  version: '1.4.0-20250615-150640utc.g0123456789ab',
  releaseId: '1.4.0-20250615-150640utc.g0123456789ab+0123456789ab',
  commit: '0123456789abcdef0123456789abcdef01234567',
}

test('rolling Preview exposes only the four platform installers', () => {
  assert.equal(
    previewArtifactName(distribution, release.version, 'mac', 'arm64'),
    'nekro-nxt-preview-mac-arm64-v1.4.0-20250615-150640utc.g0123456789ab.dmg',
  )
  assert.equal(
    previewArtifactName(distribution, release.version, 'mac', 'x64'),
    'nekro-nxt-preview-mac-x64-v1.4.0-20250615-150640utc.g0123456789ab.dmg',
  )
  assert.equal(
    previewArtifactName(distribution, release.version, 'win'),
    'nekro-nxt-preview-win-x64-v1.4.0-20250615-150640utc.g0123456789ab-setup.exe',
  )
  assert.equal(
    previewArtifactName(distribution, release.version, 'linux'),
    'nekro-nxt-preview-linux-x64-v1.4.0-20250615-150640utc.g0123456789ab.AppImage',
  )
  assert.throws(() => previewArtifactName(distribution, release.version, 'mac'), /产物架构/u)
  const assets = expectedPreviewAssets(distribution, release.version)
  assert.equal(assets.length, 4)
  assert.deepEqual(
    assets.filter((name) => name.startsWith('nekro-nxt-preview-mac-')),
    [
      'nekro-nxt-preview-mac-arm64-v1.4.0-20250615-150640utc.g0123456789ab.dmg',
      'nekro-nxt-preview-mac-x64-v1.4.0-20250615-150640utc.g0123456789ab.dmg',
    ],
  )
})

test('rolling Preview upload plan includes both macOS artifacts', () => {
  assert.deepEqual(
    previewUploadTargets(distribution, release.version, 'mac').map(({ platform, arch, artifactName }) => ({
      platform,
      arch,
      artifactName,
    })),
    previewArtifactTargets(distribution, release.version)
      .filter(({ platform }) => platform === 'mac')
      .map(({ platform, arch, artifactName }) => ({ platform, arch, artifactName })),
  )
  assert.deepEqual(
    previewUploadTargets(distribution, release.version, 'mac').map(({ arch }) => arch),
    ['arm64', 'x64'],
  )
})

test('rolling Preview accepts only receipts for the same commit, platform artifact and arch', () => {
  const artifact = previewArtifactName(distribution, release.version, 'linux')
  const receipt = {
    format: 'nxt.desktop-artifact-receipt',
    version: 1,
    channel: 'preview',
    platform: 'linux',
    arch: 'x64',
    releaseVersion: release.version,
    releaseId: release.releaseId,
    commit: release.commit,
    artifact,
    bytes: 128,
    sha256: 'a'.repeat(64),
  }
  assert.doesNotThrow(() => assertPreviewReceipt(receipt, release, 'linux', artifact))
  assert.throws(
    () => assertPreviewReceipt({ ...receipt, commit: 'f'.repeat(40) }, release, 'linux', artifact),
    /receipt/u,
  )

  const macArtifact = previewArtifactName(distribution, release.version, 'mac', 'arm64')
  const macReceipt = { ...receipt, platform: 'mac', arch: 'arm64', artifact: macArtifact }
  assert.doesNotThrow(() => assertPreviewReceipt(macReceipt, release, 'mac', macArtifact, 'arm64'))
  assert.throws(() => assertPreviewReceipt(macReceipt, release, 'mac', macArtifact, 'x64'), /receipt/u)
  assert.throws(
    () => assertPreviewReceipt({ ...macReceipt, arch: 'x64' }, release, 'mac', macArtifact, 'arm64'),
    /receipt/u,
  )
  assert.throws(() => assertPreviewReceipt({ ...receipt, bytes: 0 }, release, 'linux', artifact), /receipt/u)
})

test('rolling Preview finalize plan validates all four artifacts and remote size/digest', () => {
  const targets = previewArtifactTargets(distribution, release.version)
  const sha256 = 'b'.repeat(64)
  const receipts = new Map(
    targets.map((target) => [
      `${target.artifactName}.receipt.json`,
      {
        format: 'nxt.desktop-artifact-receipt',
        version: 1,
        channel: 'preview',
        platform: target.platform,
        arch: target.arch,
        releaseVersion: release.version,
        releaseId: release.releaseId,
        commit: release.commit,
        artifact: target.artifactName,
        bytes: 256,
        sha256,
      },
    ]),
  )
  const assets = targets.map((target, index) => ({
    id: index + 1,
    name: target.artifactName,
    size: 256,
    digest: `sha256:${sha256}`,
  }))
  const visited = []
  assert.doesNotThrow(() =>
    assertPreviewCandidateAssets({ assets }, release, distribution, (target) => {
      visited.push(`${target.platform}/${target.arch}`)
      return receipts.get(`${target.artifactName}.receipt.json`)
    }),
  )
  assert.deepEqual(visited, ['mac/arm64', 'mac/x64', 'win/x64', 'linux/x64'])

  const macArm64 = targets[0]
  const receipt = receipts.get(`${macArm64.artifactName}.receipt.json`)
  assert.throws(
    () => assertRemoteArtifactIntegrity({ name: macArm64.artifactName, size: 255 }, receipt, macArm64.artifactName),
    /完整性不一致/u,
  )
  assert.throws(
    () =>
      assertRemoteArtifactIntegrity(
        { name: macArm64.artifactName, size: 256, digest: `sha256:${'c'.repeat(64)}` },
        receipt,
        macArm64.artifactName,
      ),
    /完整性不一致/u,
  )
})

test('failed rerun preserves assets when preview tag already points at the candidate commit', () => {
  assert.equal(shouldDeletePreviewCandidateAssets(release.commit, release.commit), false)
  assert.equal(shouldDeletePreviewCandidateAssets('f'.repeat(40), release.commit), true)
  assert.equal(shouldDeletePreviewCandidateAssets(undefined, release.commit), true)
})

test('rolling Preview copy identifies its moving channel and immutable Product Release', () => {
  assert.equal(previewReleaseTitle(release), `NekroNXT Preview ${release.version}`)
  const body = previewReleaseBody(release, 'NekroAI/nekro-nxt', distribution)
  assert.match(body, /滚动预览版/u)
  assert.match(body, new RegExp(release.releaseId.replaceAll('+', '\\+'), 'u'))
  assert.match(body, /NekroAI\/nekro-nxt\/commit\/0123456789abcdef/u)
  assert.match(body, /ghcr\.io\/nekroai\/nekro-nxt:preview/u)
  assert.match(body, /SHA-256 已由发布流程核对/u)
  assert.match(body, /blob\/main\/docs\/guide\/desktop\.md/u)
  assert.doesNotMatch(body, /receipt\.json/u)
  assert.match(body, /\| macOS \| Apple Silicon（arm64） \| \[下载 DMG\]/u)
  assert.match(body, /\| macOS \| Intel（x64） \| \[下载 DMG\]/u)
  assert.match(body, /\| Windows \| x64 \| \[下载安装程序\]/u)
  assert.match(body, /\| Linux \| x64 \| \[下载 AppImage\]/u)
  assert.match(
    body,
    /releases\/download\/preview\/nekro-nxt-preview-mac-arm64-v1\.4\.0-20250615-150640utc\.g0123456789ab\.dmg/u,
  )
})

test('rolling Preview derives a lowercase commit-addressed Server candidate image', () => {
  assert.equal(
    previewServerImage('NekroAI/nekro-nxt', release.commit),
    `ghcr.io/nekroai/nekro-nxt:preview-${release.commit}`,
  )
})
