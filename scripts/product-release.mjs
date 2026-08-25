import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const readPackage = async (repositoryRoot, relativePath) =>
  JSON.parse(await readFile(path.join(repositoryRoot, relativePath, 'package.json'), 'utf8'))

const BASE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u

export const DESKTOP_PLATFORMS = Object.freeze(['mac', 'win', 'linux'])

const PLATFORM_ARCHITECTURES = Object.freeze({
  mac: Object.freeze(['arm64', 'x64']),
  win: Object.freeze(['x64']),
  linux: Object.freeze(['x64']),
})

function assertPlatform(platform) {
  if (!DESKTOP_PLATFORMS.includes(platform)) {
    throw new Error(`Desktop 产物平台无效：${platform ?? 'undefined'}`)
  }
}

export function desktopPlatforms(target) {
  if (target === 'all') return [...DESKTOP_PLATFORMS]
  assertPlatform(target)
  return [target]
}

export function desktopArchitectures(platform) {
  assertPlatform(platform)
  return [...PLATFORM_ARCHITECTURES[platform]]
}

export function electronBuilderArguments(platform) {
  return [`--${platform}`, ...desktopArchitectures(platform).map((arch) => `--${arch}`)]
}

export function desktopArchitecture(platform, arch) {
  const architectures = desktopArchitectures(platform)
  const resolvedArch = arch ?? (architectures.length === 1 ? architectures[0] : undefined)
  if (resolvedArch === undefined || !architectures.includes(resolvedArch)) {
    throw new Error(`Desktop 产物架构无效：${platform}/${arch ?? 'undefined'}`)
  }
  return resolvedArch
}

export function receiptTargets(target) {
  return desktopPlatforms(target).flatMap((platform) =>
    desktopArchitectures(platform).map((arch) => ({ platform, arch })),
  )
}

export function artifactTarget(distribution, releaseVersion, platform, arch) {
  if (typeof distribution?.artifactSlug !== 'string' || distribution.artifactSlug.length === 0) {
    throw new Error('Desktop 产物缺少 artifactSlug。')
  }
  if (typeof releaseVersion !== 'string' || releaseVersion.length === 0) {
    throw new Error('Desktop 产物缺少 Release 版本。')
  }

  const resolvedArch = desktopArchitecture(platform, arch)
  const artifactName =
    platform === 'mac'
      ? `${distribution.artifactSlug}-mac-${resolvedArch}-v${releaseVersion}.dmg`
      : platform === 'win'
        ? `${distribution.artifactSlug}-win-x64-v${releaseVersion}-setup.exe`
        : `${distribution.artifactSlug}-linux-x64-v${releaseVersion}.AppImage`

  return { platform, arch: resolvedArch, artifactName }
}

export function artifactTargets(distribution, releaseVersion, target) {
  return receiptTargets(target).map(({ platform, arch }) =>
    artifactTarget(distribution, releaseVersion, platform, arch),
  )
}

export async function readArtifactIntegrity(filename) {
  const artifactStat = await stat(filename)
  if (!artifactStat.isFile() || !Number.isSafeInteger(artifactStat.size) || artifactStat.size <= 0) {
    throw new Error(`Desktop 安装包不是非空文件：${filename}`)
  }

  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filename)) hash.update(chunk)
  return { bytes: artifactStat.size, sha256: hash.digest('hex') }
}

export function assertArtifactIntegrity(receipt, integrity, artifactName) {
  if (
    !Number.isSafeInteger(receipt?.bytes) ||
    receipt.bytes <= 0 ||
    typeof receipt.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(receipt.sha256) ||
    !Number.isSafeInteger(integrity?.bytes) ||
    integrity.bytes <= 0 ||
    typeof integrity.sha256 !== 'string' ||
    receipt.bytes !== integrity.bytes ||
    receipt.sha256 !== integrity.sha256
  ) {
    throw new Error(`Desktop 安装包与 receipt 完整性不一致：${artifactName}`)
  }
}

export function assertCleanGitStatus(status) {
  if (typeof status !== 'string' || status.trim() !== '') {
    throw new Error('Product Release 构建要求 Git worktree 干净，确保 releaseId 对应准确源码。')
  }
}

export function assertCleanWorktree(repositoryRoot) {
  const status = execFileSync('git', ['status', '--porcelain'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  })
  assertCleanGitStatus(status)
}

export function parseReleaseChannel(input) {
  if (input === 'preview' || input === 'stable') return input
  throw new Error(`Desktop Release channel 无效：${input ?? 'undefined'}`)
}

export function releaseVersionForChannel(baseVersion, channel, commitTimestamp, commit) {
  if (!BASE_VERSION_PATTERN.test(baseVersion)) {
    throw new Error(`根 package.json 版本必须是无预发布后缀的 SemVer：${baseVersion}`)
  }
  if (channel === 'stable') return baseVersion
  if (!Number.isInteger(commitTimestamp) || commitTimestamp <= 0) {
    throw new Error(`Git commit 时间无效：${commitTimestamp}`)
  }
  if (typeof commit !== 'string' || !/^[a-f0-9]{40}$/u.test(commit)) {
    throw new Error(`Git commit 无效：${commit ?? 'undefined'}`)
  }
  const date = new Date(commitTimestamp * 1_000)
  const digits = (value) => String(value).padStart(2, '0')
  const readableBuildTime = `${date.getUTCFullYear()}${digits(date.getUTCMonth() + 1)}${digits(date.getUTCDate())}-${digits(date.getUTCHours())}${digits(date.getUTCMinutes())}${digits(date.getUTCSeconds())}utc`
  return `${baseVersion}-${readableBuildTime}.g${commit.slice(0, 12)}`
}

export async function readProductRelease(
  repositoryRoot,
  channelInput = process.env['NEKRO_DESKTOP_CHANNEL'] ?? 'stable',
) {
  const channel = parseReleaseChannel(channelInput)
  const [rootPackage, serverPackage] = await Promise.all([
    readPackage(repositoryRoot, '.'),
    readPackage(repositoryRoot, 'apps/server'),
  ])
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim()
  const commitTimestamp = Number(
    execFileSync('git', ['show', '-s', '--format=%ct', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim(),
  )
  const dshVersion = serverPackage.dependencies?.['@deepseek-ai/dsh-session-persistence-sqlite']
  if (typeof rootPackage.version !== 'string' || typeof dshVersion !== 'string' || !/^[a-f0-9]{40}$/u.test(commit)) {
    throw new Error('无法生成 NekroNXT 产品 Release 清单。')
  }
  const baseVersion = rootPackage.version
  const version = releaseVersionForChannel(baseVersion, channel, commitTimestamp, commit)
  return {
    format: 'nxt.product-release',
    channel,
    baseVersion,
    version,
    commit,
    releaseId: `${version}+${commit.slice(0, 12)}`,
    dshVersion,
  }
}
