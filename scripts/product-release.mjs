import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const readPackage = async (repositoryRoot, relativePath) =>
  JSON.parse(await readFile(path.join(repositoryRoot, relativePath, 'package.json'), 'utf8'))

const BASE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u

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

export function releaseVersionForChannel(baseVersion, channel, commitTimestamp) {
  if (!BASE_VERSION_PATTERN.test(baseVersion)) {
    throw new Error(`根 package.json 版本必须是无预发布后缀的 SemVer：${baseVersion}`)
  }
  if (channel === 'stable') return baseVersion
  if (!Number.isInteger(commitTimestamp) || commitTimestamp <= 0) {
    throw new Error(`Git commit 时间无效：${commitTimestamp}`)
  }
  return `${baseVersion}-preview.${commitTimestamp}`
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
    throw new Error('无法生成 NekroNxt 产品 Release 清单。')
  }
  const baseVersion = rootPackage.version
  const version = releaseVersionForChannel(baseVersion, channel, commitTimestamp)
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
