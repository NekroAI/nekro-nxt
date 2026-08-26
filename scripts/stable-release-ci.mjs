import { spawnSync } from 'node:child_process'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import desktopDistributions from '../apps/desktop/distributions.json' with { type: 'json' }
import {
  artifactTargets,
  assertArtifactIntegrity,
  readArtifactIntegrity,
  readProductRelease,
} from './product-release.mjs'
import { parseStableVersion, releaseNotesBody, stableTag } from './stable-release.mjs'

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

export function assertStableReceipt(receipt, release, target) {
  if (
    receipt?.format !== 'nxt.desktop-artifact-receipt' ||
    receipt.version !== 1 ||
    receipt.channel !== 'stable' ||
    receipt.platform !== target.platform ||
    receipt.arch !== target.arch ||
    receipt.baseVersion !== release.baseVersion ||
    receipt.releaseVersion !== release.version ||
    receipt.releaseId !== release.releaseId ||
    receipt.commit !== release.commit ||
    receipt.artifact !== target.artifactName ||
    !Number.isSafeInteger(receipt.bytes) ||
    receipt.bytes <= 0 ||
    typeof receipt.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(receipt.sha256)
  ) {
    throw new Error(`正式版 receipt 与 Product Release 不一致：${target.artifactName}`)
  }
}

export function stableReleaseBody(release, repository, distribution, variableNotes, history = {}) {
  const targets = artifactTargets(distribution, release.version, 'all')
  const target = (platform, arch) => targets.find((item) => item.platform === platform && item.arch === arch)
  const releaseImage = (fileName) =>
    `https://raw.githubusercontent.com/${repository}/${release.commit}/assets/brand/release-images/current/${fileName}`
  const renderedNotes = variableNotes.replace(
    /\.\.\/\.\.\/assets\/brand\/release-images\/current\/([a-z0-9-]+\.png)/gu,
    (_match, fileName) => releaseImage(fileName),
  )
  const tag = stableTag(release.version)
  const contributors = Array.isArray(history.contributors) ? history.contributors : []
  const contributorLines =
    contributors.length > 0 ? contributors.map((name) => `- ${name}`) : ['- NekroAI contributors']
  const changesUrl = history.previousTag
    ? `https://github.com/${repository}/compare/${history.previousTag}...${tag}`
    : `https://github.com/${repository}/commits/${tag}`
  const download = (platform, arch, label) => {
    const item = target(platform, arch)
    if (!item) throw new Error(`正式版缺少下载目标：${platform}/${arch}`)
    const url = `https://github.com/${repository}/releases/download/${stableTag(release.version)}/${item.artifactName}`
    return `[${label}](${url})`
  }
  return [
    '> 把 DeepSeek Harness 带到即时通讯。',
    '',
    renderedNotes,
    '',
    '## 📦 客户端下载',
    '',
    '| 平台 | 适用设备 | 安装包 |',
    '| --- | --- | --- |',
    `| macOS | Apple Silicon（arm64） | ${download('mac', 'arm64', '下载 DMG')} |`,
    `| macOS | Intel（x64） | ${download('mac', 'x64', '下载 DMG')} |`,
    `| Windows | x64 | ${download('win', 'x64', '下载安装程序')} |`,
    `| Linux | x64 | ${download('linux', 'x64', '下载 AppImage')} |`,
    '',
    `安装遇到系统拦截时，请查看[桌面版安装说明](https://github.com/${repository}/blob/main/docs/guide/desktop.md)。`,
    '',
    '## 🐳 服务端部署',
    '',
    '```bash',
    'docker run -d \\',
    '  --name nekro-nxt \\',
    '  --restart unless-stopped \\',
    '  -p 127.0.0.1:4960:4960 \\',
    "  -e NEKRO_MANAGEMENT_KEY='<管理密钥>' \\",
    "  -v '<持久化目录>:/data' \\",
    `  ghcr.io/${repository.toLowerCase()}:${release.version}`,
    '```',
    '',
    `[查看服务端部署、远程访问与备份说明](https://github.com/${repository}/blob/main/docs/guide/server.md)`,
    '',
    '## 🚀 开始使用',
    '',
    '1. 在「设置 → 模型供应商」配置 API Key 和模型；',
    '2. 创建智能体，设置人设、模型和授权能力；',
    '3. 先在内置频道对话，或添加即时通信账号、选择群聊并绑定智能体。',
    '',
    `[查看快速开始](https://github.com/${repository}/blob/main/docs/guide/getting-started.md)`,
    '',
    '## 🙌 贡献者',
    '',
    ...contributorLines,
    '',
    '## 🔗 完整变更',
    '',
    `[查看本次发布的完整提交记录](${changesUrl})`,
    '',
    '## ℹ️ 版本信息',
    '',
    `- NekroNXT：\`${release.version}\``,
    `- DSH：\`${release.dshVersion}\``,
    `- 软件许可证：\`AGPL-3.0-only\``,
    `- Release ID：\`${release.releaseId}\``,
    `- Commit：[\`${release.commit.slice(0, 12)}\`](https://github.com/${repository}/commit/${release.commit})`,
    '',
    `[问题反馈](https://github.com/${repository}/issues) · NekroAI 官方 QQ 群 \`636925153\``,
  ].join('\n')
}

function releaseHistory(release, tag) {
  const stableTags = run('git', ['tag', '--merged', release.commit, '--list', 'v*.*.*', '--sort=-v:refname'])
    .split('\n')
    .map((item) => item.trim())
    .filter((item) => /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(item))
  const previousTag = stableTags.find((item) => item !== tag)
  const range = previousTag ? `${previousTag}..${release.commit}` : release.commit
  const contributors = [
    ...new Set(
      run('git', ['log', '--format=%aN', range])
        .split('\n')
        .map((item) => item.trim())
        .filter((item) => item !== '' && !/(?:\[bot\]|dependabot|github-actions)/iu.test(item)),
    ),
  ].sort((left, right) => left.localeCompare(right, 'zh-CN'))
  return { previousTag, contributors }
}

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: options.stdio ?? 'pipe',
    env: process.env,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`${command} ${args[0] ?? ''} 执行失败${detail === '' ? '' : `：\n${detail}`}`)
  }
  return typeof result.stdout === 'string' ? result.stdout.trim() : ''
}

async function context() {
  const release = await readProductRelease(repositoryRoot, 'stable')
  const variableNotes = releaseNotesBody(await readFile(path.join(repositoryRoot, 'docs/releases/current.md'), 'utf8'))
  return { release, variableNotes, distribution: desktopDistributions.stable }
}

async function verifyTag() {
  const { release } = await context()
  const version = parseStableVersion(process.env['GITHUB_REF_NAME']?.replace(/^v/u, ''))
  const tag = stableTag(version)
  if (process.env['GITHUB_REF_NAME'] !== tag || release.version !== version) {
    throw new Error(`正式版 Tag、根版本与 Product Release 不一致：${process.env['GITHUB_REF_NAME']}/${release.version}`)
  }
  const tagCommit = run('git', ['rev-list', '-n', '1', `refs/tags/${tag}`])
  if (tagCommit !== release.commit) throw new Error('正式版 Tag 没有指向当前 Product Release commit。')
  run('git', ['fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main'])
  const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', release.commit, 'origin/main'], {
    cwd: repositoryRoot,
  })
  if (ancestor.status !== 0) throw new Error('正式版 Tag commit 不在 origin/main 历史中。')
  const outputFile = process.env['GITHUB_OUTPUT']
  if (outputFile) await appendFile(outputFile, `version=${version}\ntag=${tag}\ncommit=${release.commit}\n`, 'utf8')
  console.log(`正式版来源验证通过：${tag} (${release.commit.slice(0, 12)})`)
}

async function publish() {
  const optionIndex = process.argv.indexOf('--artifacts-dir')
  const artifactsInput = optionIndex >= 0 ? process.argv[optionIndex + 1] : undefined
  if (!artifactsInput) throw new Error('正式发布缺少 --artifacts-dir。')
  const artifactsRoot = path.resolve(repositoryRoot, artifactsInput)
  const repository = process.env['GITHUB_REPOSITORY']
  if (!repository || !/^[^/]+\/[^/]+$/u.test(repository)) throw new Error('正式发布缺少 GITHUB_REPOSITORY。')
  const { release, variableNotes, distribution } = await context()
  const tag = stableTag(release.version)
  const artifactFiles = []
  for (const target of artifactTargets(distribution, release.version, 'all')) {
    const artifact = path.join(artifactsRoot, target.artifactName)
    const receipt = JSON.parse(await readFile(`${artifact}.receipt.json`, 'utf8'))
    assertStableReceipt(receipt, release, target)
    assertArtifactIntegrity(receipt, await readArtifactIntegrity(artifact), target.artifactName)
    artifactFiles.push(artifact)
  }

  const candidateImage = `ghcr.io/${repository.toLowerCase()}:release-${release.commit}`
  const versionImage = `ghcr.io/${repository.toLowerCase()}:${release.version}`
  const latestImage = `ghcr.io/${repository.toLowerCase()}:latest`
  for (const args of [
    ['pull', candidateImage],
    ['tag', candidateImage, versionImage],
    ['push', versionImage],
    ['tag', candidateImage, latestImage],
    ['push', latestImage],
  ]) {
    run('docker', args, { stdio: 'inherit' })
  }

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'nekro-nxt-stable-release-'))
  try {
    const notesFile = path.join(temporaryRoot, 'release-notes.md')
    const history = releaseHistory(release, tag)
    await writeFile(
      notesFile,
      `${stableReleaseBody(release, repository, distribution, variableNotes, history)}\n`,
      'utf8',
    )
    run(
      'gh',
      [
        'release',
        'create',
        tag,
        ...artifactFiles,
        '--repo',
        repository,
        '--verify-tag',
        '--latest',
        '--title',
        `NekroNXT ${release.version}`,
        '--notes-file',
        notesFile,
      ],
      { stdio: 'inherit' },
    )
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }

  console.log(`NekroNXT ${release.version} 已发布。`)
}

async function main() {
  const command = process.argv[2]
  if (command === 'verify') return verifyTag()
  if (command === 'publish') return publish()
  throw new Error(`正式版 CI 命令无效：${command ?? 'undefined'}`)
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
