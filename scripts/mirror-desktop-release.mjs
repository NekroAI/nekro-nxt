// Copies a published release's desktop installers to NekroAI's public download bucket (`nekro-nxt-dist`, served at
// https://dl.nekro.ai), so the desktop app and the community download page work where GitHub is hard to reach (#87).
// The bucket holds only public releases; community uploads stay in the community site's own private bucket. Runs
// after the GitHub release is published; without the R2 secrets it does nothing, and a failure here never undoes the
// GitHub release.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readProductRelease } from './product-release.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_BUCKET = 'nekro-nxt-dist'
/** Every NekroNXT file in the bucket sits under `nxt/`, so other NekroAI projects can share it. */
const PREFIX = 'nxt/desktop'

/** The folder one release's installers live in: the version for Stable, the commit for the rolling Preview. */
export function mirrorFolder(release) {
  return release.channel === 'stable' ? `v${release.version}` : release.commit
}

/** The manifest at `nxt/desktop/<channel>/manifest.json`; file paths are relative to it. */
export function mirrorManifest(release, receipts, { publishedAt, releaseUrl, githubDownload }) {
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
      githubUrl: `${githubDownload}/${receipt.artifact}`,
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

const INSTALLER = /^nekro-nxt(?:-preview)?-(mac|win|linux)-(arm64|x64)-v.+\.(?:dmg|exe|AppImage)$/u

/**
 * The release a channel's GitHub page serves now, as the mirror describes it: Stable by its tag, the rolling Preview
 * by the commit its notes name. `commitOfTag` resolves a Stable tag to its commit.
 */
export function publishedRelease(channel, published, commitOfTag) {
  if (channel === 'stable') {
    const version = published.tag_name.replace(/^v/u, '')
    return { channel, version, commit: commitOfTag(published.tag_name) }
  }
  const commit = /nxt-preview-commit:([0-9a-f]{40})/u.exec(published.body ?? '')?.[1]
  if (commit === undefined) throw new Error('预览版发布页缺少提交信息。')
  return { channel, version: (published.name ?? '').replace(/^NekroNXT Preview\s+/u, ''), commit }
}

/** Receipts for a GitHub release's installers, from the size and digest GitHub publishes for each asset. */
export function receiptsFromRelease(release, published) {
  return (published.assets ?? []).flatMap((asset) => {
    const match = INSTALLER.exec(asset.name)
    const sha256 = /^sha256:([a-f0-9]{64})$/u.exec(asset.digest ?? '')?.[1]
    if (match === null || sha256 === undefined) return []
    return [
      {
        format: 'nxt.desktop-artifact-receipt',
        channel: release.channel,
        platform: match[1],
        arch: match[2],
        releaseVersion: release.version,
        commit: release.commit,
        artifact: asset.name,
        bytes: asset.size,
        sha256,
      },
    ]
  })
}

const fileDigest = async (file) => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

/** Folders to delete: everything but the new release and the one the previous manifest pointed at. */
export function prunableFolders(folders, keep) {
  const kept = new Set(keep.filter((folder) => typeof folder === 'string'))
  return folders.filter((folder) => !kept.has(folder))
}

/** Runs an upload up to three times; a large multipart upload to R2 now and then fails as a whole. */
function retrying(label, upload) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return upload()
    } catch (error) {
      if (attempt >= 3) throw error
      console.log(`上传 ${label} 失败，重试第 ${attempt} 次：${error instanceof Error ? error.message : String(error)}`)
    }
  }
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
  const repository = process.env['GITHUB_REPOSITORY']
  if (!repository) throw new Error('缺少 GITHUB_REPOSITORY。')
  const fromGitHub = process.argv.includes('--from-github')
  const tagPath = (tag) => `/repos/${repository}/releases/tags/${tag}`
  let release
  let published
  let directory
  let receipts
  let downloads
  if (fromGitHub) {
    // Copies what the GitHub release serves right now, checking every file against GitHub's digest; for a sync that
    // the release workflow missed.
    published = JSON.parse(
      run('gh', ['api', channel === 'stable' ? `/repos/${repository}/releases/latest` : tagPath('preview')]),
    )
    release = publishedRelease(channel, published, (tag) =>
      run('gh', ['api', `/repos/${repository}/commits/${tag}`, '--jq', '.sha']),
    )
    receipts = receiptsFromRelease(release, published)
    if (receipts.length === 0) throw new Error('GitHub 发布页上没有带摘要的安装包。')
    downloads = await mkdtemp(path.join(os.tmpdir(), 'nekro-nxt-mirror-assets-'))
    directory = downloads
    for (const receipt of receipts) {
      run('gh', ['release', 'download', published.tag_name, '-R', repository, '-p', receipt.artifact, '-D', directory])
      if ((await fileDigest(path.join(directory, receipt.artifact))) !== receipt.sha256)
        throw new Error(`下载的 ${receipt.artifact} 与 GitHub 公布的摘要不一致。`)
    }
  } else {
    directory = path.resolve(repositoryRoot, option('--artifacts-dir') ?? '')
    release = await readProductRelease(repositoryRoot, channel)
    // Mirror only what GitHub now serves: a stale Preview candidate or an unpublished tag is skipped.
    published = JSON.parse(run('gh', ['api', tagPath(channel === 'stable' ? `v${release.version}` : 'preview')]))
    if (channel === 'preview' && !(published.body ?? '').includes(`nxt-preview-commit:${release.commit}`)) {
      console.log('GitHub 上的预览版已不是这个提交，跳过社区镜像。')
      return
    }
    const names = (await readdir(directory)).filter((name) => name.endsWith('.receipt.json'))
    receipts = releaseReceipts(
      release,
      await Promise.all(names.map(async (name) => JSON.parse(await readFile(path.join(directory, name), 'utf8')))),
    )
  }
  const tag = published.tag_name

  const bucket = process.env['R2_BUCKET'] || DEFAULT_BUCKET
  const env = {
    ...process.env,
    AWS_ACCESS_KEY_ID: process.env['R2_ACCESS_KEY_ID'],
    AWS_SECRET_ACCESS_KEY: process.env['R2_SECRET_ACCESS_KEY'],
    AWS_DEFAULT_REGION: 'auto',
    // R2 rejects the CRC checksums newer AWS CLIs add to multipart uploads (InvalidPart on completion).
    AWS_REQUEST_CHECKSUM_CALCULATION: 'WHEN_REQUIRED',
    AWS_RESPONSE_CHECKSUM_VALIDATION: 'WHEN_REQUIRED',
  }
  const endpoint = ['--endpoint-url', `https://${account}.r2.cloudflarestorage.com`]
  const aws = (args) => run('aws', [...args, ...endpoint], { env })
  const channelRoot = `s3://${bucket}/${PREFIX}/${channel}`
  const folder = mirrorFolder(release)

  for (const receipt of receipts) {
    const key = `${PREFIX}/${channel}/files/${folder}/${receipt.artifact}`
    retrying(receipt.artifact, () =>
      aws([
        's3',
        'cp',
        path.join(directory, receipt.artifact),
        `s3://${bucket}/${key}`,
        '--content-type',
        'application/octet-stream',
        // A folder never changes once written: Stable is named by version, Preview by commit.
        '--cache-control',
        'public, max-age=31536000, immutable',
        '--only-show-errors',
      ]),
    )
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
      githubDownload: `https://github.com/${repository}/releases/download/${tag}`,
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
    if (downloads !== undefined) await rm(downloads, { recursive: true, force: true })
  }
  console.log(`社区镜像已更新：${channel} ${release.version}（${receipts.length} 个安装包）。`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
