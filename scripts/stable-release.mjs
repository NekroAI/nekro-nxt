import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const repository = 'NekroAI/nekro-nxt'
const stableVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u

export function parseStableVersion(input) {
  if (typeof input !== 'string' || !stableVersionPattern.test(input)) {
    throw new Error(`正式发布版本必须是 X.Y.Z，且不能带 v 或预发布后缀：${input ?? 'undefined'}`)
  }
  return input
}

export function stableTag(versionInput) {
  return `v${parseStableVersion(versionInput)}`
}

export function assertRequestedVersion(requestedInput, packageVersion) {
  const requested = parseStableVersion(requestedInput)
  const current = parseStableVersion(packageVersion)
  if (requested !== current) {
    throw new Error(`指定版本 ${requested} 与根 package.json 版本 ${current} 不一致。`)
  }
  return requested
}

export function releaseNotesBody(markdown) {
  if (typeof markdown !== 'string') throw new Error('正式版更新内容必须是 Markdown 文本。')
  const normalized = markdown.replaceAll('\r\n', '\n').trim()
  const lines = normalized.split('\n')
  if (lines[0]?.trim() !== '# ✨ 本次更新') {
    throw new Error('docs/releases/current.md 必须以“# ✨ 本次更新”开头。')
  }
  const body = lines.slice(1).join('\n').trim()
  if (body.length < 40) throw new Error('正式版更新内容过短，请写清用户能看到的变化。')
  const forbidden = [
    { pattern: /<!--|-->/u, label: '模板注释' },
    { pattern: /https?:\/\//iu, label: '下载或文档链接' },
    { pattern: /(?:^|[^\d])v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:$|[^\d])/mu, label: '版本号' },
    { pattern: /\bRelease ID\b|\bCommit\b|SHA-256|ghcr\.io/iu, label: '固定发布信息' },
    { pattern: /<[^>\n]+>/u, label: '待替换占位符' },
  ]
  for (const rule of forbidden) {
    if (rule.pattern.test(body)) throw new Error(`正式版更新内容不能包含${rule.label}。`)
  }
  return body
}

export function assertReleaseSource({ branch, status, head, remoteMain, previewCommit }) {
  if (branch !== 'main') throw new Error(`正式发布只能从 main 执行，当前分支是 ${branch || 'detached HEAD'}。`)
  if (typeof status !== 'string' || status.trim() !== '') throw new Error('正式发布要求 Git worktree 干净。')
  if (!/^[a-f0-9]{40}$/u.test(head)) throw new Error(`当前 Git commit 无效：${head}`)
  if (head !== remoteMain) throw new Error('当前提交不是 origin/main 最新提交，请先同步并推送 main。')
  if (head !== previewCommit) {
    throw new Error('当前提交尚未通过完整 Preview 发布，请等待 preview Tag 指向当前提交。')
  }
}

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: options.stdio ?? 'pipe',
    env: process.env,
  })
  if (result.error) throw result.error
  if (result.status !== 0 && !options.allowFailure) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`${command} ${args[0] ?? ''} 执行失败${detail === '' ? '' : `：\n${detail}`}`)
  }
  return result
}

const output = (command, args) => run(command, args).stdout.trim()

function assertTagAvailable(tag) {
  const local = run('git', ['rev-parse', '--quiet', '--verify', `refs/tags/${tag}`], { allowFailure: true })
  if (local.status === 0) throw new Error(`本地 Tag 已存在：${tag}`)

  const remote = run('git', ['ls-remote', '--exit-code', '--tags', 'origin', `refs/tags/${tag}`], {
    allowFailure: true,
  })
  if (remote.status === 0) throw new Error(`远端 Tag 已存在：${tag}`)
  if (remote.status !== 2) throw new Error(`无法确认远端 Tag 是否可用：${tag}`)

  const release = run('gh', ['api', `/repos/${repository}/releases/tags/${tag}`], { allowFailure: true })
  if (release.status === 0) throw new Error(`GitHub Release 已存在：${tag}`)
  const diagnostic = [release.stdout, release.stderr].filter(Boolean).join('\n')
  if (!diagnostic.includes('HTTP 404')) throw new Error(`无法确认 GitHub Release 是否可用：${tag}`)
}

async function waitForReleaseWorkflow(tag, head) {
  let workflow
  for (let attempt = 0; attempt < 18; attempt += 1) {
    const result = run(
      'gh',
      [
        'run',
        'list',
        '--workflow',
        'release.yml',
        '--branch',
        tag,
        '--limit',
        '10',
        '--json',
        'databaseId,headSha,url',
      ],
      { allowFailure: true },
    )
    if (result.status === 0) {
      const runs = JSON.parse(result.stdout)
      workflow = runs.find((runItem) => runItem?.headSha === head)
      if (workflow) break
    }
    await delay(5_000)
  }
  if (!workflow) {
    console.log(`Tag 已推送。GitHub Actions 尚未返回运行记录，请稍后查看 https://github.com/${repository}/actions`)
    return
  }
  console.log(`正式发布工作流：${workflow.url}`)
  run('gh', ['run', 'watch', String(workflow.databaseId), '--exit-status', '--interval', '10'], { stdio: 'inherit' })
  const release = run('gh', ['release', 'view', tag, '--repo', repository, '--json', 'url'], { allowFailure: true })
  if (release.status === 0) console.log(`正式版已发布：${JSON.parse(release.stdout).url}`)
}

async function main() {
  const requestedInput = process.argv[2]
  if (process.argv.length !== 3) throw new Error('用法：pnpm release <X.Y.Z>')

  const rootPackage = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'))
  const version = assertRequestedVersion(requestedInput, rootPackage.version)
  const tag = stableTag(version)
  const notes = releaseNotesBody(await readFile(path.join(repositoryRoot, 'docs/releases/current.md'), 'utf8'))

  run('git', [
    'fetch',
    '--quiet',
    'origin',
    '+refs/heads/main:refs/remotes/origin/main',
    '+refs/tags/preview:refs/tags/preview',
  ])
  const branch = output('git', ['branch', '--show-current'])
  const status = output('git', ['status', '--porcelain'])
  const head = output('git', ['rev-parse', 'HEAD'])
  const remoteMain = output('git', ['rev-parse', 'origin/main'])
  const previewCommit = output('git', ['rev-list', '-n', '1', 'refs/tags/preview'])
  assertReleaseSource({ branch, status, head, remoteMain, previewCommit })
  assertTagAvailable(tag)

  console.log(`\n准备发布 NekroNXT ${version}`)
  console.log(`Tag：${tag}`)
  console.log(`Commit：${head}`)
  console.log('\n下面是将写入正式 Release 的本次更新内容：\n')
  console.log(notes)
  console.log('')

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('正式发布需要用户在交互终端中审查更新内容并确认版本。')
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  const answer = (await prompt.question(`确认以上内容已经由你审查。输入 ${version} 推送正式版 Tag：`)).trim()
  prompt.close()
  if (answer !== version) throw new Error('输入的版本号不一致，已取消正式发布。')

  run('git', ['tag', '-a', tag, '-m', `NekroNXT ${version}`, head])
  run('git', ['push', 'origin', `refs/tags/${tag}`], { stdio: 'inherit' })
  await waitForReleaseWorkflow(tag, head)
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
