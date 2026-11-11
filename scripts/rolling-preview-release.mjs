import { publishedPreviewCommit } from './lib/preview-changes.mjs'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
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
import { copyImage, manifestDigest, serverImageDigest } from './lib/server-image.mjs'
import { androidArtifactName, assertAndroidReceipt } from './android-release.mjs'

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
let cancellationRequested = false

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

/** `2026-11-01 14:01`: when this Preview was built, in Beijing time; GitHub keeps the first publication date (#98). */
export function previewBuildTime(at) {
  return new Date(at + 8 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ')
}

export function previewReleaseBody(release, repository, distribution, serverDigest, builtAt = Date.now()) {
  const targets = new Map(
    previewArtifactTargets(distribution, release.version).map((target) => [
      `${target.platform}/${target.arch}`,
      target,
    ]),
  )
  const assetUrl = (name) => `https://github.com/${repository}/releases/download/${ROLLING_PREVIEW_TAG}/${name}`
  const downloadLink = (platform, arch, label) => {
    const target = targets.get(`${platform}/${arch}`)
    if (!target) throw new Error(`滚动预览版缺少下载目标：${platform}/${arch}`)
    return `[${label}](${assetUrl(target.artifactName)})`
  }
  const guide = (file) => `https://github.com/${repository}/blob/main/docs/guide/${file}`
  return [
    `<!-- nxt-preview-commit:${release.commit} -->`,
    ...(serverDigest ? [`<!-- nxt-preview-server:${serverDigest} -->`] : []),
    '> 这是 `main` 最新通过完整 CI 的滚动预览版；下一次成功构建会更新本页面。',
    `> 构建于 ${previewBuildTime(builtAt)}（北京时间），提交 [${release.commit.slice(0, 7)}](https://github.com/${repository}/commit/${release.commit})。GitHub 上方显示的日期是这个页面第一次发布的时间，不是这一版的构建时间。`,
    '',
    '## 客户端下载',
    '',
    '| 平台 | 适用设备 | 安装包 |',
    '| --- | --- | --- |',
    `| macOS | Apple Silicon（arm64） | ${downloadLink('mac', 'arm64', '下载 DMG')} |`,
    `| macOS | Intel（x64） | ${downloadLink('mac', 'x64', '下载 DMG')} |`,
    `| Windows | x64 | ${downloadLink('win', 'x64', '下载安装程序')} |`,
    `| Linux | x64 | ${downloadLink('linux', 'x64', '下载 AppImage')} |`,
    `| Android | Android 10 及以上 | [下载 APK](${assetUrl(androidArtifactName('preview', release.version))}) |`,
    '',
    `安装包的版本、文件大小和 SHA-256 已由发布流程核对。首次安装或遇到系统拦截时，请查看[桌面版安装说明](${guide('desktop.md')})。`,
    '',
    '## 手机',
    '',
    '- **Android 应用**：上表的 APK 是开发版，名为「NekroNXT 开发版」，可以和正式版同时安装，以后在应用里提示更新。在已登录的电脑或浏览器上打开「设置 → 登录与访问 → 连接安卓应用」，用应用扫码即可连接。',
    '- **iPhone、iPad 和其他设备（PWA）**：在浏览器里打开实例地址并登录，iPhone 和 iPad 在 Safari 点「分享 → 添加到主屏幕」，安卓的 Chrome 点菜单里的「安装应用」。添加到主屏幕需要受信任的 HTTPS 地址。',
    '',
    `手机在外面使用时，实例要能从公网访问。详见[手机使用说明](${guide('mobile.md')})。`,
    '',
    '## 服务端',
    '',
    `镜像：\`ghcr.io/${repository.toLowerCase()}:preview\`（amd64 / arm64）· [部署说明](${guide('server.md')})`,
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

export function assertServerPreviewReceipt(receipt, release, repository) {
  if (
    receipt?.commit !== release.commit ||
    receipt.releaseId !== release.releaseId ||
    receipt.image !== previewServerImage(repository, release.commit) ||
    !/^sha256:[a-f0-9]{64}$/u.test(receipt.digest ?? '')
  )
    throw new Error('Server Preview receipt 与当前提交或镜像摘要不一致。')
}

async function recordServerCandidate() {
  const repository = requireRepository()
  const { release } = await readContext()
  const image = previewServerImage(repository, release.commit)
  const digest = serverImageDigest(image)
  const receipt = { commit: release.commit, releaseId: release.releaseId, image, digest }
  assertServerPreviewReceipt(receipt, release, repository)
  const output = commandOption('--output')
  if (!output) throw new Error('Missing Server receipt output path.')
  await mkdir(path.dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify(receipt, null, 2) + '\n')
}

/** Keeps publication side effects in one serial owner, with compensation on failure. */
export async function publishPreviewTransaction({ isCurrent, upload, publish, rollback, cleanupCandidate }) {
  if (!(await isCurrent())) return false
  try {
    await upload()
    if (!(await isCurrent())) {
      await cleanupCandidate()
      return false
    }
    await publish()
    return true
  } catch (error) {
    const failures = [error]
    for (const compensate of [rollback, cleanupCandidate]) {
      try {
        await compensate()
      } catch (failure) {
        failures.push(failure)
      }
    }
    if (failures.length > 1) throw new AggregateError(failures, 'Preview 发布失败且恢复未全部完成。')
    throw error
  }
}

async function finalizeRollingRelease() {
  if (commandOption('--build-result') !== 'success') {
    console.log('平台候选未全部成功，保留当前 Preview。')
    return
  }
  const repository = requireRepository()
  const { release, distribution } = await readContext()
  const directoryInput = commandOption('--candidates-dir')
  if (!directoryInput) throw new Error('Missing complete Preview candidate directory.')
  const directory = path.resolve(repositoryRoot, directoryInput)
  const isCurrent = () =>
    !cancellationRequested && ghJson(['api', `/repos/${repository}/git/ref/heads/main`]).object?.sha === release.commit
  if (!isCurrent()) {
    console.log('过期候选不更新 Preview。')
    return
  }
  const previousRelease = readRollingRelease(repository)
  const previousCommit =
    previousRelease && !previousRelease.draft
      ? (publishedPreviewCommit(previousRelease) ?? readRollingTagCommit(repository))
      : undefined
  if (previousCommit === release.commit) {
    console.log('当前提交已有完整成功 Preview，保留原产物。')
    return
  }
  const targets = previewArtifactTargets(distribution, release.version)
  const receipts = new Map()
  // Verify every installer and its exact receipt before the first upload.
  for (const target of targets) {
    const artifact = path.join(directory, target.artifactName)
    const receipt = JSON.parse(await readFile(`${artifact}.receipt.json`, 'utf8'))
    assertPreviewReceipt(receipt, release, target.platform, target.artifactName, target.arch)
    assertArtifactIntegrity(receipt, await readArtifactIntegrity(artifact), target.artifactName)
    receipts.set(target.artifactName, receipt)
  }
  // The development APK rides on the same Preview; it is verified like the installers before anything is uploaded.
  const androidName = androidArtifactName('preview', release.version)
  const androidReceipt = JSON.parse(await readFile(path.join(directory, `${androidName}.receipt.json`), 'utf8'))
  assertAndroidReceipt(androidReceipt, { channel: 'preview', commit: release.commit, artifact: androidName })
  assertArtifactIntegrity(androidReceipt, await readArtifactIntegrity(path.join(directory, androidName)), androidName)
  const server = JSON.parse(await readFile(path.join(directory, 'server.receipt.json'), 'utf8'))
  assertServerPreviewReceipt(server, release, repository)
  const imageRepository = `ghcr.io/${repository.toLowerCase()}`
  const candidateImage = `${imageRepository}@${server.digest}`
  const rollingImage = `${imageRepository}:preview`
  if (serverImageDigest(candidateImage) !== server.digest) throw new Error('Server Preview 候选镜像摘要已变化。')
  let previousImage
  if (previousCommit) {
    const recordedDigest = /<!-- nxt-preview-server:(sha256:[a-f0-9]{64}) -->/u.exec(previousRelease.body ?? '')?.[1]
    previousImage = `${imageRepository}@${recordedDigest ?? manifestDigest(rollingImage)}`
    // Confirms the rollback target still exists before anything is published.
    manifestDigest(previousImage)
  }
  let publishing = false
  const expectedSet = new Set([...targets.map((target) => target.artifactName), androidName])
  const cleanupCandidate = () => {
    const current = readRollingRelease(repository)
    if (!current || publishedPreviewCommit(current) === release.commit) return
    deleteAssets(
      repository,
      (current.assets ?? []).filter((asset) => expectedSet.has(asset.name)),
    )
  }
  const published = await publishPreviewTransaction({
    isCurrent,
    upload: async () => {
      await ensureRollingRelease()
      for (const name of [...targets.map((target) => target.artifactName), androidName])
        runGh(['release', 'upload', ROLLING_PREVIEW_TAG, path.join(directory, name), '--clobber', '--repo', repository])
      const uploaded = readRollingRelease(repository)
      assertPreviewCandidateAssets(uploaded, release, distribution, (target) => receipts.get(target.artifactName))
      assertRemoteArtifactIntegrity(
        (uploaded.assets ?? []).find((asset) => asset.name === androidName),
        androidReceipt,
        androidName,
      )
    },
    publish: () => {
      publishing = true
      copyImage(candidateImage, [rollingImage])
      moveRollingTag(repository, release.commit)
      const current = readRollingRelease(repository)
      runGh([
        'api',
        '--method',
        'PATCH',
        `/repos/${repository}/releases/${current.id}`,
        '-f',
        `name=${previewReleaseTitle(release)}`,
        '-f',
        `body=${previewReleaseBody(release, repository, distribution, server.digest)}`,
        '-F',
        'draft=false',
        '-F',
        'prerelease=true',
      ])
    },
    rollback: () => {
      if (!publishing) return
      const failures = []
      if (previousImage) {
        try {
          copyImage(previousImage, [rollingImage])
        } catch (error) {
          failures.push(error)
        }
      }
      try {
        if (previousCommit) moveRollingTag(repository, previousCommit)
        const current = readRollingRelease(repository)
        if (current)
          runGh([
            'api',
            '--method',
            'PATCH',
            `/repos/${repository}/releases/${current.id}`,
            '-f',
            `name=${previousRelease?.name ?? 'Preview candidate'}`,
            '-f',
            `body=${previousRelease?.body ?? ''}`,
            '-F',
            `draft=${previousRelease?.draft ?? true}`,
            '-F',
            'prerelease=true',
          ])
      } catch (error) {
        failures.push(error)
      }
      if (failures.length) throw new AggregateError(failures, '恢复旧 Preview 失败。')
    },
    cleanupCandidate,
  })
  if (!published) {
    console.log('构建期间 main 已更新，候选已清理。')
    return
  }
  // Publication is complete. A stale-asset deletion failure must not roll back
  // to a release whose assets have already begun to be pruned.
  const current = readRollingRelease(repository)
  try {
    deleteAssets(
      repository,
      (current.assets ?? []).filter((asset) => !expectedSet.has(asset.name)),
    )
  } catch (error) {
    console.warn('Preview 已发布，旧附件清理稍后重试：', error)
  }
  console.log(`滚动 Preview 已发布：${release.version} (${release.commit.slice(0, 12)})`)
}

async function main() {
  const command = process.argv[2]
  if (command === 'finalize') return finalizeRollingRelease()
  if (command === 'record-server') return recordServerCandidate()
  throw new Error(`滚动预览版命令无效：${command ?? 'undefined'}`)
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined
if (invokedPath === fileURLToPath(import.meta.url)) {
  // Graceful cancellation lets the serial publisher finish compensation.
  process.on('SIGINT', () => {
    cancellationRequested = true
  })
  process.on('SIGTERM', () => {
    cancellationRequested = true
  })
  await main()
}
