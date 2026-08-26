import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DESKTOP_PLATFORMS,
  assertArtifactIntegrity,
  artifactTarget,
  artifactTargets,
  desktopArchitectures,
  readArtifactIntegrity,
  readProductRelease,
} from './product-release.mjs'

export const ROLLING_PREVIEW_TAG = 'preview'
export const PREVIEW_PLATFORMS = DESKTOP_PLATFORMS

export function previewServerImage(repository, commit) {
  if (!/^[^/]+\/[^/]+$/u.test(repository) || !/^[a-f0-9]{40}$/u.test(commit)) {
    throw new Error('滚动预览版服务端镜像参数无效。')
  }
  return `ghcr.io/${repository.toLowerCase()}:preview-${commit}`
}

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const desktopRoot = path.join(repositoryRoot, 'apps', 'desktop')

export function previewArtifactName(distribution, releaseVersion, platform, arch) {
  return artifactTarget(distribution, releaseVersion, platform, arch).artifactName
}

export function previewArtifactTargets(distribution, releaseVersion) {
  return artifactTargets(distribution, releaseVersion, 'all')
}

export function previewUploadTargets(distribution, releaseVersion, platform, arch) {
  const architectures = desktopArchitectures(platform)
  if (arch !== undefined) return [artifactTarget(distribution, releaseVersion, platform, arch)]
  return architectures.map((architecture) => artifactTarget(distribution, releaseVersion, platform, architecture))
}

export function expectedPreviewAssets(distribution, releaseVersion) {
  return previewArtifactTargets(distribution, releaseVersion).map(({ artifactName }) => artifactName)
}

export function assertPreviewReceipt(receipt, release, platform, artifactName, arch = 'x64') {
  if (
    receipt?.format !== 'nxt.desktop-artifact-receipt' ||
    receipt.version !== 1 ||
    receipt.channel !== 'preview' ||
    receipt.platform !== platform ||
    receipt.arch !== arch ||
    receipt.releaseVersion !== release.version ||
    receipt.releaseId !== release.releaseId ||
    receipt.commit !== release.commit ||
    receipt.artifact !== artifactName ||
    !Number.isSafeInteger(receipt.bytes) ||
    receipt.bytes <= 0 ||
    typeof receipt.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(receipt.sha256)
  ) {
    throw new Error(`滚动预览版 receipt 与当前 Product Release 不一致：${artifactName}`)
  }
}

export function assertRemoteArtifactIntegrity(asset, receipt, artifactName) {
  if (
    asset?.name !== artifactName ||
    !Number.isSafeInteger(asset.size) ||
    asset.size <= 0 ||
    asset.size !== receipt.bytes ||
    (asset.digest !== undefined && asset.digest !== null && asset.digest !== `sha256:${receipt.sha256}`)
  ) {
    throw new Error(`滚动预览版远端安装包与 receipt 完整性不一致：${artifactName}`)
  }
}

export function assertPreviewCandidateAssets(rollingRelease, release, distribution, readReceipt) {
  const targets = previewArtifactTargets(distribution, release.version)
  const expectedNames = expectedPreviewAssets(distribution, release.version)
  const assetsByName = new Map((rollingRelease.assets ?? []).map((asset) => [asset.name, asset]))
  for (const name of expectedNames) {
    if (!assetsByName.has(name)) throw new Error(`滚动预览版缺少候选附件：${name}`)
  }
  for (const target of targets) {
    const artifactAsset = assetsByName.get(target.artifactName)
    const receipt = readReceipt(target)
    assertPreviewReceipt(receipt, release, target.platform, target.artifactName, target.arch)
    assertRemoteArtifactIntegrity(artifactAsset, receipt, target.artifactName)
  }
}

export function shouldDeletePreviewCandidateAssets(previewTagCommit, candidateCommit) {
  if (typeof candidateCommit !== 'string' || !/^[a-f0-9]{40}$/u.test(candidateCommit)) {
    throw new Error('滚动预览版候选 commit 无效。')
  }
  return previewTagCommit !== candidateCommit
}

export function previewReleaseTitle(release) {
  return `NekroNXT Preview ${release.version}`
}

export function previewReleaseBody(release, repository, distribution) {
  const targets = new Map(
    previewArtifactTargets(distribution, release.version).map((target) => [
      `${target.platform}/${target.arch}`,
      target,
    ]),
  )
  const downloadLink = (platform, arch, label) => {
    const target = targets.get(`${platform}/${arch}`)
    if (!target) throw new Error(`滚动预览版缺少下载目标：${platform}/${arch}`)
    const url = `https://github.com/${repository}/releases/download/${ROLLING_PREVIEW_TAG}/${target.artifactName}`
    return `[${label}](${url})`
  }
  return [
    '> 这是 `main` 最新通过完整 CI 的滚动预览版；下一次成功构建会更新本页面。',
    '',
    '## 客户端下载',
    '',
    '| 平台 | 适用设备 | 安装包 |',
    '| --- | --- | --- |',
    `| macOS | Apple Silicon（arm64） | ${downloadLink('mac', 'arm64', '下载 DMG')} |`,
    `| macOS | Intel（x64） | ${downloadLink('mac', 'x64', '下载 DMG')} |`,
    `| Windows | x64 | ${downloadLink('win', 'x64', '下载安装程序')} |`,
    `| Linux | x64 | ${downloadLink('linux', 'x64', '下载 AppImage')} |`,
    '',
    '安装包的版本、文件大小和 SHA-256 已由发布流程核对。',
    '',
    '## 服务端',
    '',
    `镜像：\`ghcr.io/${repository.toLowerCase()}:preview\` · [部署说明](https://github.com/${repository}/blob/main/docs/guide/server.md)`,
    '',
    '## 版本信息',
    '',
    `- 版本：\`${release.version}\``,
    `- Release ID：\`${release.releaseId}\``,
    `- Commit：[\`${release.commit.slice(0, 12)}\`](https://github.com/${repository}/commit/${release.commit})`,
  ].join('\n')
}

function commandOption(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function requireRepository() {
  const repository = process.env['GITHUB_REPOSITORY']
  if (!repository || !/^[^/]+\/[^/]+$/u.test(repository)) {
    throw new Error('滚动预览版发布需要有效的 GITHUB_REPOSITORY。')
  }
  return repository
}

function runGh(args, options = {}) {
  const result = spawnSync('gh', args, {
    cwd: repositoryRoot,
    encoding: options.encoding ?? 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    stdio: options.stdio ?? 'pipe',
  })
  if (result.error) throw result.error
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      `gh ${args.join(' ')} 失败：${String(result.stderr || result.stdout || `exit ${result.status}`).trim()}`,
    )
  }
  return result
}

function ghJson(args) {
  const result = runGh(args)
  return JSON.parse(String(result.stdout))
}

function releaseEndpoint(repository) {
  return `/repos/${repository}/releases/tags/${ROLLING_PREVIEW_TAG}`
}

function moveRollingTag(repository, commit) {
  const refPath = `tags/${ROLLING_PREVIEW_TAG}`
  const existing = runGh(['api', `/repos/${repository}/git/ref/${refPath}`], { allowFailure: true })
  if (existing.status === 0) {
    runGh([
      'api',
      '--method',
      'PATCH',
      `/repos/${repository}/git/refs/${refPath}`,
      '-f',
      `sha=${commit}`,
      '-F',
      'force=true',
    ])
    return
  }
  const diagnostic = `${String(existing.stderr)}\n${String(existing.stdout)}`
  if (!/HTTP 404|Not Found/iu.test(diagnostic)) {
    throw new Error(`读取滚动预览版 tag 失败：${diagnostic.trim()}`)
  }
  runGh([
    'api',
    '--method',
    'POST',
    `/repos/${repository}/git/refs`,
    '-f',
    `ref=refs/tags/${ROLLING_PREVIEW_TAG}`,
    '-f',
    `sha=${commit}`,
  ])
}

function readRollingRelease(repository) {
  const result = runGh(['api', releaseEndpoint(repository)], { allowFailure: true })
  if (result.status === 0) return JSON.parse(String(result.stdout))
  const diagnostic = `${String(result.stderr)}\n${String(result.stdout)}`
  if (/HTTP 404|Not Found/iu.test(diagnostic)) {
    // GitHub's release-by-tag endpoint omits Draft releases even for an
    // authenticated caller. The list endpoint includes them, which is needed
    // for the first rolling Preview before it becomes public.
    const releases = ghJson(['api', `/repos/${repository}/releases?per_page=100`])
    if (!Array.isArray(releases)) throw new Error('GitHub Release 列表响应无效。')
    return releases.find((release) => release?.tag_name === ROLLING_PREVIEW_TAG)
  }
  throw new Error(`读取滚动预览版失败：${diagnostic.trim()}`)
}

async function readContext() {
  const [release, distributions] = await Promise.all([
    readProductRelease(repositoryRoot, 'preview'),
    readFile(path.join(desktopRoot, 'distributions.json'), 'utf8').then(JSON.parse),
  ])
  return {
    release,
    distribution: distributions.preview,
  }
}

async function ensureRollingRelease() {
  const repository = requireRepository()
  const { release, distribution } = await readContext()
  const existing = readRollingRelease(repository)
  if (existing) {
    if (!existing.prerelease || existing.tag_name !== ROLLING_PREVIEW_TAG || existing.immutable) {
      throw new Error('现有 preview Release 不是可更新的滚动 Prerelease。')
    }
    return
  }

  const created = runGh(
    [
      'api',
      '--method',
      'POST',
      `/repos/${repository}/releases`,
      '-f',
      `tag_name=${ROLLING_PREVIEW_TAG}`,
      '-f',
      `target_commitish=${release.commit}`,
      '-f',
      `name=${previewReleaseTitle(release)}`,
      '-f',
      `body=${previewReleaseBody(release, repository, distribution)}`,
      '-F',
      'draft=true',
      '-F',
      'prerelease=true',
    ],
    { allowFailure: true },
  )
  if (created.status === 0) return

  // Two main pushes can finish CI together. Treat another run creating the
  // same rolling Prerelease first as success, but preserve every other API
  // failure so authentication and repository errors remain visible.
  const concurrent = readRollingRelease(repository)
  if (concurrent?.prerelease && concurrent.tag_name === ROLLING_PREVIEW_TAG && !concurrent.immutable) return
  throw new Error(`创建滚动预览版失败：${String(created.stderr || created.stdout || `exit ${created.status}`).trim()}`)
}

async function uploadPlatformAssets() {
  const repository = requireRepository()
  const platform = commandOption('--platform')
  if (typeof platform !== 'string' || !PREVIEW_PLATFORMS.includes(platform)) {
    throw new Error(`滚动预览版平台无效：${platform ?? 'undefined'}`)
  }
  const archOption = commandOption('--arch')

  const { release, distribution } = await readContext()
  const targets = previewUploadTargets(distribution, release.version, platform, archOption)
  for (const target of targets) {
    const artifactName = target.artifactName
    const artifact = path.join(desktopRoot, 'release', 'preview', artifactName)
    const receiptPath = `${artifact}.receipt.json`
    const [integrity, receiptText] = await Promise.all([readArtifactIntegrity(artifact), readFile(receiptPath, 'utf8')])
    const receipt = JSON.parse(receiptText)
    assertPreviewReceipt(receipt, release, target.platform, artifactName, target.arch)
    assertArtifactIntegrity(receipt, integrity, artifactName)

    runGh(['release', 'upload', ROLLING_PREVIEW_TAG, artifact, '--clobber', '--repo', repository], {
      stdio: 'inherit',
    })
  }
}

function deleteAssets(repository, assets) {
  for (const asset of assets) {
    runGh(['api', '--method', 'DELETE', `/repos/${repository}/releases/assets/${asset.id}`, '--silent'])
  }
}

function readRollingTagCommit(repository) {
  const result = runGh(['api', `/repos/${repository}/git/ref/tags/${ROLLING_PREVIEW_TAG}`], { allowFailure: true })
  if (result.status === 0) {
    const commit = JSON.parse(String(result.stdout)).object?.sha
    if (typeof commit !== 'string' || !/^[a-f0-9]{40}$/u.test(commit)) {
      throw new Error('滚动预览版 tag 响应缺少有效 commit。')
    }
    return commit
  }
  const diagnostic = `${String(result.stderr)}\n${String(result.stdout)}`
  if (/HTTP 404|Not Found/iu.test(diagnostic)) return undefined
  throw new Error(`读取滚动预览版 tag 失败：${diagnostic.trim()}`)
}

function candidateAssets(rollingRelease, names) {
  return (rollingRelease.assets ?? []).filter((asset) => names.has(asset.name))
}

function cleanupPreviewCandidateAssets(repository, rollingRelease, names, candidateCommit, reason) {
  const previewTagCommit = readRollingTagCommit(repository)
  if (!shouldDeletePreviewCandidateAssets(previewTagCommit, candidateCommit)) {
    console.log(`${reason}；preview tag 已指向当前 commit，保留已发布附件。`)
    return
  }
  deleteAssets(repository, candidateAssets(rollingRelease, names))
  console.log(`${reason}；已清理本次候选附件。`)
}

async function finalizeRollingRelease() {
  const repository = requireRepository()
  const buildResult = commandOption('--build-result')
  if (typeof buildResult !== 'string' || !['success', 'failure', 'cancelled', 'skipped'].includes(buildResult)) {
    throw new Error(`滚动预览版构建结果无效：${buildResult ?? 'undefined'}`)
  }

  const { release, distribution } = await readContext()
  const expectedNames = expectedPreviewAssets(distribution, release.version)
  const expectedSet = new Set(expectedNames)
  let rollingRelease = readRollingRelease(repository)
  if (!rollingRelease) throw new Error('滚动预览版不存在，无法收敛平台构建。')

  if (buildResult !== 'success') {
    cleanupPreviewCandidateAssets(
      repository,
      rollingRelease,
      expectedSet,
      release.commit,
      `预览构建结果为 ${buildResult}`,
    )
    return
  }

  const receiptsDirectoryInput = commandOption('--receipts-dir')
  if (typeof receiptsDirectoryInput !== 'string' || receiptsDirectoryInput.trim() === '') {
    throw new Error('滚动预览版最终校验缺少内部 receipt 目录。')
  }
  const receiptsDirectory = path.resolve(repositoryRoot, receiptsDirectoryInput)
  const receipts = new Map()
  for (const target of previewArtifactTargets(distribution, release.version)) {
    const receiptPath = path.join(receiptsDirectory, `${target.artifactName}.receipt.json`)
    receipts.set(target.artifactName, JSON.parse(await readFile(receiptPath, 'utf8')))
  }
  assertPreviewCandidateAssets(rollingRelease, release, distribution, (target) => receipts.get(target.artifactName))

  const remoteMain = ghJson(['api', `/repos/${repository}/git/ref/heads/main`]).object?.sha
  if (remoteMain !== release.commit) {
    cleanupPreviewCandidateAssets(
      repository,
      rollingRelease,
      expectedSet,
      release.commit,
      `当前 commit ${release.commit} 已不是 main 最新 HEAD，不会回退 Preview`,
    )
    return
  }

  moveRollingTag(repository, release.commit)
  runGh([
    'api',
    '--method',
    'PATCH',
    `/repos/${repository}/releases/${rollingRelease.id}`,
    '-f',
    `name=${previewReleaseTitle(release)}`,
    '-f',
    `body=${previewReleaseBody(release, repository, distribution)}`,
    '-F',
    'draft=false',
    '-F',
    'prerelease=true',
  ])

  rollingRelease = readRollingRelease(repository)
  deleteAssets(
    repository,
    (rollingRelease.assets ?? []).filter((asset) => !expectedSet.has(asset.name)),
  )
  console.log(`滚动 Preview 已发布：${release.version} (${release.commit.slice(0, 12)})`)
}

async function promoteServerImage() {
  const repository = requireRepository()
  const { release } = await readContext()
  const remoteMain = ghJson(['api', `/repos/${repository}/git/ref/heads/main`]).object?.sha
  if (remoteMain !== release.commit) {
    console.log(`当前 commit ${release.commit} 已不是 main 最新 HEAD，不会更新服务端 Preview 镜像。`)
    return
  }

  const candidate = previewServerImage(repository, release.commit)
  const rolling = `ghcr.io/${repository.toLowerCase()}:${ROLLING_PREVIEW_TAG}`
  for (const args of [
    ['pull', candidate],
    ['tag', candidate, rolling],
    ['push', rolling],
  ]) {
    const result = spawnSync('docker', args, { cwd: repositoryRoot, stdio: 'inherit' })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`docker ${args[0]} 执行失败：${args.at(-1)}`)
  }
  console.log(`服务端 Preview 镜像已发布：${rolling}`)
}

async function main() {
  const command = process.argv[2]
  if (command === 'ensure') return ensureRollingRelease()
  if (command === 'upload') return uploadPlatformAssets()
  if (command === 'finalize') return finalizeRollingRelease()
  if (command === 'promote-server-image') return promoteServerImage()
  throw new Error(`滚动预览版命令无效：${command ?? 'undefined'}`)
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main()
}
