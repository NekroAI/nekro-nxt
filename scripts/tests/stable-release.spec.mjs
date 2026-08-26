import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import desktopDistributions from '../../apps/desktop/distributions.json' with { type: 'json' }
import { artifactTarget } from '../product-release.mjs'
import { assertStableReceipt, stableReleaseBody } from '../stable-release-ci.mjs'
import {
  assertReleaseSource,
  assertRequestedVersion,
  parseStableVersion,
  releaseNotesBody,
  stableTag,
} from '../stable-release.mjs'

const release = {
  channel: 'stable',
  baseVersion: '1.4.0',
  version: '1.4.0',
  commit: '0123456789abcdef0123456789abcdef01234567',
  releaseId: '1.4.0+0123456789ab',
  dshVersion: '0.1.1-rc.2',
}
const repositoryRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))

test('stable release requires an explicit plain SemVer matching the root version', () => {
  assert.equal(parseStableVersion('1.4.0'), '1.4.0')
  assert.equal(stableTag('1.4.0'), 'v1.4.0')
  assert.equal(assertRequestedVersion('1.4.0', '1.4.0'), '1.4.0')
  for (const invalid of [undefined, '', 'v1.4.0', '1.4', '1.4.0-rc.1', '01.4.0']) {
    assert.throws(() => parseStableVersion(invalid), /X\.Y\.Z/u)
  }
  assert.throws(() => assertRequestedVersion('1.4.0', '1.4.1'), /不一致/u)
})

test('release notes keep only reviewed variable copy', () => {
  const notes =
    '# ✨ 本次更新\n\n## 🚀 主要变化\n\n- 频道切换会保留当前选择，实例连接失败时显示可以继续处理的原因和操作入口。'
  assert.match(releaseNotesBody(notes), /频道切换/u)
  for (const invalid of [
    '## 主要变化\n\n- 缺少标题。',
    '# ✨ 本次更新\n\n- 太短。',
    '# ✨ 本次更新\n\n<!-- 注释 -->\n- 频道切换会保留当前选择和状态。',
    '# ✨ 本次更新\n\n- 发布 1.4.0，频道切换会保留当前选择和状态。',
    '# ✨ 本次更新\n\n- 下载地址 https://example.invalid/release，频道切换会保留当前选择。',
    '# ✨ 本次更新\n\n- Release ID 和 SHA-256 会写进这里，频道切换会保留状态。',
  ]) {
    assert.throws(() => releaseNotesBody(invalid))
  }
})

test('stable release source must be clean main already proven by the rolling Preview', () => {
  const valid = {
    branch: 'main',
    status: '',
    head: release.commit,
    remoteMain: release.commit,
    previewCommit: release.commit,
  }
  assert.doesNotThrow(() => assertReleaseSource(valid))
  assert.throws(() => assertReleaseSource({ ...valid, branch: 'release' }), /main/u)
  assert.throws(() => assertReleaseSource({ ...valid, status: ' M package.json' }), /worktree/u)
  assert.throws(() => assertReleaseSource({ ...valid, remoteMain: 'f'.repeat(40) }), /origin\/main/u)
  assert.throws(() => assertReleaseSource({ ...valid, previewCommit: 'f'.repeat(40) }), /Preview/u)
})

test('stable receipt binds an installer to the exact Product Release', () => {
  const target = artifactTarget(desktopDistributions.stable, release.version, 'mac', 'arm64')
  const receipt = {
    format: 'nxt.desktop-artifact-receipt',
    version: 1,
    channel: 'stable',
    platform: target.platform,
    arch: target.arch,
    baseVersion: release.baseVersion,
    releaseVersion: release.version,
    releaseId: release.releaseId,
    commit: release.commit,
    artifact: target.artifactName,
    bytes: 256,
    sha256: 'a'.repeat(64),
  }
  assert.doesNotThrow(() => assertStableReceipt(receipt, release, target))
  assert.throws(() => assertStableReceipt({ ...receipt, commit: 'f'.repeat(40) }, release, target), /receipt/u)
  assert.throws(() => assertStableReceipt({ ...receipt, bytes: 0 }, release, target), /receipt/u)
})

test('stable Release body combines reviewed notes with generated distribution facts', () => {
  const body = stableReleaseBody(
    release,
    'NekroAI/nekro-nxt',
    desktopDistributions.stable,
    '## 主要变化\n\n- 频道切换会保留当前选择。\n\n![关于页面](../../assets/brand/release-images/current/about.png)',
    { contributors: ['KroMiose'], previousTag: 'v1.3.0' },
  )
  assert.match(body, /把 DeepSeek Harness 带到即时通讯/u)
  assert.match(body, /频道切换会保留当前选择/u)
  assert.match(
    body,
    /raw\.githubusercontent\.com\/NekroAI\/nekro-nxt\/0123456789abcdef0123456789abcdef01234567\/assets\/brand\/release-images\/current\/about\.png/u,
  )
  assert.doesNotMatch(body, /screenshots\/channel-conversation\.png/u)
  assert.doesNotMatch(body, /screenshots\/connections\.png/u)
  assert.doesNotMatch(body, /screenshots\/creator-workbench\.png/u)
  assert.doesNotMatch(body, /## 产品预览/u)
  assert.match(body, /## 🙌 贡献者\n\n- KroMiose/u)
  assert.match(body, /compare\/v1\.3\.0\.\.\.v1\.4\.0/u)
  assert.match(body, /## 📦 客户端下载/u)
  assert.match(body, /## 🐳 服务端部署/u)
  assert.match(body, /nekro-nxt-mac-arm64-v1\.4\.0\.dmg/u)
  assert.match(body, /ghcr\.io\/nekroai\/nekro-nxt:1\.4\.0/u)
  assert.match(body, /0\.1\.1-rc\.2/u)
  assert.match(body, /1\.4\.0\+0123456789ab/u)
  assert.match(body, /AGPL-3\.0-only/u)
  assert.doesNotMatch(body, /receipt\.json/u)

  const firstReleaseBody = stableReleaseBody(
    release,
    'NekroAI/nekro-nxt',
    desktopDistributions.stable,
    '## 主要变化\n\n- 首个正式版本提供完整产品能力。',
    { contributors: ['KroMiose'] },
  )
  assert.match(firstReleaseBody, /commits\/v1\.4\.0/u)
  assert.doesNotMatch(firstReleaseBody, /\/compare\//u)
})

test('stable publishing is triggered only by an explicit immutable version tag', async () => {
  const workflow = await readFile(path.join(repositoryRoot, '.github/workflows/release.yml'), 'utf8')
  const rootPackage = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'))
  assert.match(workflow, /tags:\s*\n\s*- 'v\*\.\*\.\*'/u)
  assert.doesNotMatch(workflow, /workflow_dispatch/u)
  assert.match(workflow, /pnpm desktop:stable --platform/u)
  assert.match(workflow, /stable-release-ci\.mjs publish/u)
  assert.equal(rootPackage.scripts.release, 'node scripts/stable-release.mjs')
})
