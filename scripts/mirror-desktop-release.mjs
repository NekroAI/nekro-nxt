// Copies a published release's desktop installers to the community site's R2 bucket, so the desktop app can update
// where GitHub is hard to reach (#87). Runs after the GitHub release is published; without the R2 secrets it does
// nothing, and a failure here never undoes the GitHub release.
import { spawnSync } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readProductRelease } from './product-release.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_BUCKET = 'nekro-nxt-community-packages'
const PREFIX = 'desktop'

/** The folder one release's installers live in: the version for Stable, the commit for the rolling Preview. */
export function mirrorFolder(release) {
  return release.channel === 'stable' ? `v${release.version}` : release.commit
}

/** The manifest NekroNXT reads from `/api/v1/desktop/<channel>/manifest`; file paths are relative to it. */
export function mirrorManifest(release, receipts, { publishedAt, releaseUrl }) {
  const folder = mirrorFolder(release)
  return {
    format: 'nxt.desktop-mirror',
    version: 1,
    channel: release.channel,
    releaseVersion: release.version,
    commit: release.commit,
    publishedAt,
    releaseUrl,
    files: receipts.map((receipt) => ({
      platform: receipt.platform,
      arch: receipt.arch,
      name: receipt.artifact,
      size: receipt.bytes,
      sha256: receipt.sha256,
      path: `files/${folder}/${receipt.artifact}`,
    })),
  }
}

/** Receipts of this release's installers; anything from another build in the folder is ignored. */
export function releaseReceipts(release, candidates) {
  const receipts = candidates.filter(
    (receipt) =>
      receipt?.format === 'nxt.desktop-artifact-receipt' &&
      receipt.channel === release.channel &&
      receipt.commit === release.commit &&
      receipt.releaseVersion === release.version &&
      typeof receipt.artifact === 'string' &&
      Number.isSafeInteger(receipt.bytes) &&
      receipt.bytes > 0 &&
      /^[a-f0-9]{64}$/u.test(receipt.sha256 ?? ''),
  )
  if (receipts.length === 0) throw new Error('没有找到这个版本的安装包 receipt。')
  return receipts
}

/** Folders to delete: everything but the new release and the one the previous manifest pointed at. */
export function prunableFolders(folders, keep) {
  const kept = new Set(keep.filter((folder) => typeof folder === 'string'))
  return folders.filter((folder) => !kept.has(folder))
}

function option(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repositoryRoot, encoding: 'utf8', ...options })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.slice(0, 3).join(' ')} 失败：${(result.stderr ?? '').trim().slice(-500)}`)
  }
  return typeof result.stdout === 'string' ? result.stdout.trim() : ''
}

async function main() {
  const channel = process.argv[2]
  if (channel !== 'stable' && channel !== 'preview')
    throw new Error('用法：mirror-desktop-release.mjs <stable|preview>')
  const account = process.env['R2_ACCOUNT_ID']
  if (!account || !process.env['R2_ACCESS_KEY_ID'] || !process.env['R2_SECRET_ACCESS_KEY']) {
    console.log('没有配置 R2 凭据，跳过社区镜像。')
    return
  }
  const directory = path.resolve(repositoryRoot, option('--artifacts-dir') ?? '')
  const repository = process.env['GITHUB_REPOSITORY']
  if (!repository) throw new Error('缺少 GITHUB_REPOSITORY。')
  const release = await readProductRelease(repositoryRoot, channel)

  // Mirror only what GitHub now serves: a stale Preview candidate or an unpublished tag is skipped.
  const tag = channel === 'stable' ? `v${release.version}` : 'preview'
  const published = JSON.parse(run('gh', ['api', `/repos/${repository}/releases/tags/${tag}`]))
  if (channel === 'preview' && !(published.body ?? '').includes(`nxt-preview-commit:${release.commit}`)) {
    console.log('GitHub 上的预览版已不是这个提交，跳过社区镜像。')
    return
  }

  const names = (await readdir(directory)).filter((name) => name.endsWith('.receipt.json'))
  const receipts = releaseReceipts(
    release,
    await Promise.all(names.map(async (name) => JSON.parse(await readFile(path.join(directory, name), 'utf8')))),
  )

  const bucket = process.env['R2_BUCKET'] || DEFAULT_BUCKET
  const env = {
    ...process.env,
    AWS_ACCESS_KEY_ID: process.env['R2_ACCESS_KEY_ID'],
    AWS_SECRET_ACCESS_KEY: process.env['R2_SECRET_ACCESS_KEY'],
    AWS_DEFAULT_REGION: 'auto',
  }
  const endpoint = ['--endpoint-url', `https://${account}.r2.cloudflarestorage.com`]
  const aws = (args) => run('aws', [...args, ...endpoint], { env })
  const channelRoot = `s3://${bucket}/${PREFIX}/${channel}`
  const folder = mirrorFolder(release)

  for (const receipt of receipts) {
    const key = `${PREFIX}/${channel}/files/${folder}/${receipt.artifact}`
    aws(['s3', 'cp', path.join(directory, receipt.artifact), `s3://${bucket}/${key}`, '--only-show-errors'])
    const head = JSON.parse(aws(['s3api', 'head-object', '--bucket', bucket, '--key', key]))
    if (head.ContentLength !== receipt.bytes) throw new Error(`社区镜像上的 ${receipt.artifact} 大小不一致。`)
  }

  const temporary = await mkdtemp(path.join(os.tmpdir(), 'nekro-nxt-mirror-'))
  try {
    const previousFile = path.join(temporary, 'previous.json')
    let previousFolder
    try {
      aws(['s3', 'cp', `${channelRoot}/manifest.json`, previousFile, '--only-show-errors'])
      previousFolder = /^files\/([^/]+)\//u.exec(
        JSON.parse(await readFile(previousFile, 'utf8')).files?.[0]?.path ?? '',
      )?.[1]
    } catch {
      previousFolder = undefined
    }
    const manifestFile = path.join(temporary, 'manifest.json')
    const manifest = mirrorManifest(release, receipts, {
      publishedAt: Date.now(),
      releaseUrl: published.html_url ?? `https://github.com/${repository}/releases/tag/${tag}`,
    })
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    aws([
      's3',
      'cp',
      manifestFile,
      `${channelRoot}/manifest.json`,
      '--content-type',
      'application/json',
      '--cache-control',
      'no-cache',
      '--only-show-errors',
    ])

    // Keeps the previous release too, so a download that started before this one still finishes.
    const listing = aws(['s3', 'ls', `${channelRoot}/files/`])
    const folders = listing
      .split('\n')
      .map((line) => /PRE\s+(\S+)\/$/u.exec(line.trim())?.[1])
      .filter((name) => name !== undefined)
    for (const stale of prunableFolders(folders, [folder, previousFolder]))
      aws(['s3', 'rm', `${channelRoot}/files/${stale}/`, '--recursive', '--only-show-errors'])
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
  console.log(`社区镜像已更新：${channel} ${release.version}（${receipts.length} 个安装包）。`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
