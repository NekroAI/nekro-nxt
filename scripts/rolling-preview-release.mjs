import { spawnSync } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readProductRelease } from './product-release.mjs'

export const ROLLING_PREVIEW_TAG = 'preview'
export const PREVIEW_PLATFORMS = ['mac', 'win', 'linux']

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const desktopRoot = path.join(repositoryRoot, 'apps', 'desktop')

export function previewArtifactName(distribution, releaseVersion, platform) {
  if (platform === 'mac') return `${distribution.artifactSlug}-mac-universal-v${releaseVersion}.dmg`
  if (platform === 'win') return `${distribution.artifactSlug}-win-x64-v${releaseVersion}-setup.exe`
  if (platform === 'linux') return `${distribution.artifactSlug}-linux-x64-v${releaseVersion}.AppImage`
  throw new Error(`滚动预览版平台无效：${platform}`)
}

export function expectedPreviewAssets(distribution, releaseVersion) {
  return PREVIEW_PLATFORMS.flatMap((platform) => {
    const artifact = previewArtifactName(distribution, releaseVersion, platform)
    return [artifact, `${artifact}.receipt.json`]
  })
}

export function assertPreviewReceipt(receipt, release, platform, artifactName) {
  if (
    receipt?.format !== 'nxt.desktop-artifact-receipt' ||
    receipt.version !== 1 ||
    receipt.channel !== 'preview' ||
    receipt.platform !== platform ||
    receipt.releaseVersion !== release.version ||
    receipt.releaseId !== release.releaseId ||
    receipt.commit !== release.commit ||
    receipt.artifact !== artifactName ||
    typeof receipt.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(receipt.sha256)
  ) {
    throw new Error(`滚动预览版 receipt 与当前 Product Release 不一致：${artifactName}`)
  }
}

export function previewReleaseTitle(release) {
  return `NekroNxt Preview ${release.version}`
}

export function previewReleaseBody(release, repository) {
  return [
    '这是 `main` 最新通过完整 CI 与三端构建的滚动预览版。`preview` 标签和本页面会在下一次成功构建后前移。',
    '',
    `- 版本：\`${release.version}\``,
    `- Release ID：\`${release.releaseId}\``,
    `- Commit：[\`${release.commit.slice(0, 12)}\`](https://github.com/${repository}/commit/${release.commit})`,
    '',
    '当前安装包尚未签名；请同时下载对应平台的 `receipt.json` 核对 SHA-256。',
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

function readRollingRelease(repository) {
  const result = runGh(['api', releaseEndpoint(repository)], { allowFailure: true })
  if (result.status === 0) return JSON.parse(String(result.stdout))
  const diagnostic = `${String(result.stderr)}\n${String(result.stdout)}`
  if (/HTTP 404|Not Found/iu.test(diagnostic)) return undefined
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
  const { release } = await readContext()
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
      `body=${previewReleaseBody(release, repository)}`,
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

  const { release, distribution } = await readContext()
  const artifactName = previewArtifactName(distribution, release.version, platform)
  const artifact = path.join(desktopRoot, 'release', 'preview', artifactName)
  const receiptPath = `${artifact}.receipt.json`
  const [artifactStat, receiptText] = await Promise.all([stat(artifact), readFile(receiptPath, 'utf8')])
  if (!artifactStat.isFile()) throw new Error(`滚动预览版缺少安装包：${artifact}`)
  assertPreviewReceipt(JSON.parse(receiptText), release, platform, artifactName)

  runGh(['release', 'upload', ROLLING_PREVIEW_TAG, artifact, receiptPath, '--clobber', '--repo', repository], {
    stdio: 'inherit',
  })
}

function deleteAssets(repository, assets) {
  for (const asset of assets) {
    runGh(['api', '--method', 'DELETE', `/repos/${repository}/releases/assets/${asset.id}`, '--silent'])
  }
}

function candidateAssets(rollingRelease, names) {
  return (rollingRelease.assets ?? []).filter((asset) => names.has(asset.name))
}

function readRemoteReceipt(repository, asset) {
  const result = runGh([
    'api',
    '-H',
    'Accept: application/octet-stream',
    `/repos/${repository}/releases/assets/${asset.id}`,
  ])
  return JSON.parse(String(result.stdout))
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
    deleteAssets(repository, candidateAssets(rollingRelease, expectedSet))
    console.log(`三端构建结果为 ${buildResult}，已保留上一版 Preview 并清理本次候选附件。`)
    return
  }

  const assetsByName = new Map((rollingRelease.assets ?? []).map((asset) => [asset.name, asset]))
  for (const name of expectedNames) {
    if (!assetsByName.has(name)) throw new Error(`滚动预览版缺少候选附件：${name}`)
  }
  for (const platform of PREVIEW_PLATFORMS) {
    const artifactName = previewArtifactName(distribution, release.version, platform)
    const receiptAsset = assetsByName.get(`${artifactName}.receipt.json`)
    assertPreviewReceipt(readRemoteReceipt(repository, receiptAsset), release, platform, artifactName)
  }

  const remoteMain = ghJson(['api', `/repos/${repository}/git/ref/heads/main`]).object?.sha
  if (remoteMain !== release.commit) {
    deleteAssets(repository, candidateAssets(rollingRelease, expectedSet))
    console.log(`当前 commit ${release.commit} 已不是 main 最新 HEAD，候选附件已清理且不会回退 Preview。`)
    return
  }

  runGh([
    'api',
    '--method',
    'PATCH',
    `/repos/${repository}/git/refs/tags/${ROLLING_PREVIEW_TAG}`,
    '-f',
    `sha=${release.commit}`,
    '-F',
    'force=true',
  ])
  runGh([
    'api',
    '--method',
    'PATCH',
    `/repos/${repository}/releases/${rollingRelease.id}`,
    '-f',
    `name=${previewReleaseTitle(release)}`,
    '-f',
    `body=${previewReleaseBody(release, repository)}`,
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

async function main() {
  const command = process.argv[2]
  if (command === 'ensure') return ensureRollingRelease()
  if (command === 'upload') return uploadPlatformAssets()
  if (command === 'finalize') return finalizeRollingRelease()
  throw new Error(`滚动预览版命令无效：${command ?? 'undefined'}`)
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main()
}
