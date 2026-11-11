// The Android app's release files (decision A7, apps/android). Two steps, both run by CI:
//
//   candidate <preview|stable> --apk <file> --out-dir <dir>
//     Names the APK for its channel and writes `<apk>.receipt.json` beside it: size, SHA-256, app version and the
//     SHA-256 of the signing certificate, which the download page publishes.
//   mirror <preview|stable> --artifacts-dir <dir>
//     Copies a published APK to the public download bucket (https://dl.nekro.ai) and writes
//     `nxt/android/<channel>/manifest.json`, which the app reads for in-app updates. Without the R2 secrets it does
//     nothing; a failure here never undoes the GitHub release.
//
// Preview APKs are the development app (package ai.nekro.nxt.dev, repository development key) and ride on the rolling
// Preview; stable APKs follow the NekroNXT `vX.Y.Z` release, signed in the `android-release` environment and published
// as their own `android-vX.Y.Z` release.
import { execFileSync } from 'node:child_process'
import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { prunableFolders, r2Aws, retrying } from './mirror-desktop-release.mjs'
import { readArtifactIntegrity, readProductRelease } from './product-release.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PREFIX = 'nxt/android'

/** `nekro-nxt-preview-android-v<product version>.apk` on the Preview, `nekro-nxt-android-v<app version>.apk` released. */
export function androidArtifactName(channel, version) {
  return channel === 'preview' ? `nekro-nxt-preview-android-v${version}.apk` : `nekro-nxt-android-v${version}.apk`
}

/** `0.1.0` → 1000; each part below 1000, so every release counts up for the installer. */
export function stableVersionCode(versionName) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(versionName)
  if (!match) throw new Error(`安卓版本号应为 x.y.z：${versionName}`)
  const [major, minor, patch] = match.slice(1).map(Number)
  return major * 1_000_000 + minor * 1_000 + patch
}

/**
 * SHA-256 of the certificate the APK is signed with, as lower-case hex, from `apksigner verify --print-certs`. (An APK
 * for Android 10 and later carries only v2/v3 signatures, which `keytool -printcert -jarfile` does not read.)
 */
export function certificateDigest(printed) {
  // Newer build tools name signers by their SDK range (`Signer (minSdkVersion=…)`) instead of `Signer #1`.
  const digests = new Set([...printed.matchAll(/certificate SHA-256 digest:\s*([0-9a-f]{64})/gu)].map((m) => m[1]))
  if (digests.size !== 1) throw new Error(`无法读取 APK 的签名证书。apksigner 输出：\n${printed.trim().slice(0, 2000)}`)
  return [...digests][0]
}

/** `apksigner` from the newest build tools of the Android SDK (ANDROID_HOME on CI runners). */
async function apksigner() {
  const sdk = process.env['ANDROID_HOME'] ?? process.env['ANDROID_SDK_ROOT']
  if (!sdk) throw new Error('缺少 ANDROID_HOME，找不到 apksigner。')
  const versions = (await readdir(path.join(sdk, 'build-tools'))).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  )
  const latest = versions.at(-1)
  if (latest === undefined) throw new Error('Android SDK 里没有 build-tools。')
  return path.join(sdk, 'build-tools', latest, 'apksigner')
}

export function assertAndroidReceipt(receipt, { channel, commit, artifact }) {
  if (
    receipt?.format !== 'nxt.android-artifact-receipt' ||
    receipt.version !== 1 ||
    receipt.channel !== channel ||
    receipt.commit !== commit ||
    receipt.artifact !== artifact ||
    !Number.isSafeInteger(receipt.bytes) ||
    receipt.bytes <= 0 ||
    !/^[a-f0-9]{64}$/u.test(receipt.sha256 ?? '') ||
    !/^[a-f0-9]{64}$/u.test(receipt.certificateSha256 ?? '') ||
    !Number.isSafeInteger(receipt.versionCode) ||
    typeof receipt.versionName !== 'string'
  ) {
    throw new Error(`安卓安装包 receipt 与当前发布不一致：${artifact}`)
  }
}

/** The folder one release's APK lives in: the version for Stable, the commit for the rolling Preview. */
export function androidMirrorFolder(receipt) {
  return receipt.channel === 'stable' ? `v${receipt.versionName}` : receipt.commit
}

/** `nxt/android/<channel>/manifest.json`; the file path is relative to it. */
export function androidMirrorManifest(receipt, { publishedAt, releaseUrl, githubUrl }) {
  return {
    format: 'nxt.android-mirror',
    version: 1,
    channel: receipt.channel,
    versionName: receipt.versionName,
    versionCode: receipt.versionCode,
    commit: receipt.commit,
    publishedAt,
    releaseUrl,
    certificateSha256: receipt.certificateSha256,
    file: {
      name: receipt.artifact,
      size: receipt.bytes,
      sha256: receipt.sha256,
      path: `files/${androidMirrorFolder(receipt)}/${receipt.artifact}`,
      githubUrl,
    },
  }
}

function option(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function requireChannel() {
  const channel = process.argv[3]
  if (channel !== 'preview' && channel !== 'stable')
    throw new Error('用法：android-release.mjs <candidate|mirror> <preview|stable>')
  return channel
}

/** For Preview the product release names the APK; a stable release takes its version from the NekroNXT `v*` tag. */
async function releaseOf(channel) {
  if (channel === 'preview') {
    const release = await readProductRelease(repositoryRoot, 'preview')
    return { version: release.version, releaseId: release.releaseId, commit: release.commit }
  }
  const tag = process.env['GITHUB_REF_NAME'] ?? ''
  const version = /^v(\d+\.\d+\.\d+)$/u.exec(tag)?.[1]
  if (!version) throw new Error(`正式版需要从 vX.Y.Z 标签运行，当前是「${tag}」。`)
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim()
  return { version, commit }
}

async function candidate() {
  const channel = requireChannel()
  const apk = path.resolve(repositoryRoot, option('--apk') ?? '')
  const outDir = path.resolve(repositoryRoot, option('--out-dir') ?? '')
  const release = await releaseOf(channel)
  const artifact = androidArtifactName(channel, release.version)
  const target = path.join(outDir, artifact)
  await copyFile(apk, target)
  const { bytes, sha256 } = await readArtifactIntegrity(target)
  const printed = execFileSync(await apksigner(), ['verify', '--print-certs', target], { encoding: 'utf8' })
  const receipt = {
    format: 'nxt.android-artifact-receipt',
    version: 1,
    channel,
    releaseVersion: release.version,
    ...(release.releaseId === undefined ? {} : { releaseId: release.releaseId }),
    commit: release.commit,
    artifact,
    bytes,
    sha256,
    versionName: process.env['NXT_ANDROID_VERSION_NAME'] ?? release.version,
    versionCode: Number(process.env['NXT_ANDROID_VERSION_CODE']),
    certificateSha256: certificateDigest(printed),
  }
  assertAndroidReceipt(receipt, { channel, commit: release.commit, artifact })
  await writeFile(`${target}.receipt.json`, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  console.log(`${artifact}：${bytes} 字节，证书 SHA-256 ${receipt.certificateSha256}`)
}

async function mirror() {
  const channel = requireChannel()
  const account = process.env['R2_ACCOUNT_ID']
  if (!account || !process.env['R2_ACCESS_KEY_ID'] || !process.env['R2_SECRET_ACCESS_KEY']) {
    console.log('没有配置 R2 凭据，跳过安卓镜像。')
    return
  }
  const repository = process.env['GITHUB_REPOSITORY']
  if (!repository) throw new Error('缺少 GITHUB_REPOSITORY。')
  const directory = path.resolve(repositoryRoot, option('--artifacts-dir') ?? '')
  const receipts = []
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.apk.receipt.json')) continue
    const receipt = JSON.parse(await readFile(path.join(directory, name), 'utf8'))
    if (receipt?.format === 'nxt.android-artifact-receipt' && receipt.channel === channel) receipts.push(receipt)
  }
  if (receipts.length !== 1) throw new Error(`应有一个 ${channel} 安卓安装包，找到 ${receipts.length} 个。`)
  const receipt = receipts[0]
  const release = await releaseOf(channel)
  assertAndroidReceipt(receipt, {
    channel,
    commit: release.commit,
    artifact: androidArtifactName(channel, release.version),
  })
  const tag = channel === 'preview' ? 'preview' : `android-v${release.version}`
  const published = JSON.parse(
    execFileSync('gh', ['api', `/repos/${repository}/releases/tags/${tag}`], { encoding: 'utf8' }),
  )
  // Mirror only what GitHub now serves: a Preview that has moved on to another commit is skipped.
  if (channel === 'preview' && !(published.body ?? '').includes(`nxt-preview-commit:${release.commit}`)) {
    console.log('GitHub 上的预览版已不是这个提交，跳过安卓镜像。')
    return
  }

  const { aws, bucket } = r2Aws(account)
  const channelRoot = `s3://${bucket}/${PREFIX}/${channel}`
  const folder = androidMirrorFolder(receipt)
  const key = `${PREFIX}/${channel}/files/${folder}/${receipt.artifact}`
  retrying(receipt.artifact, () =>
    aws([
      's3',
      'cp',
      path.join(directory, receipt.artifact),
      `s3://${bucket}/${key}`,
      '--content-type',
      'application/vnd.android.package-archive',
      '--cache-control',
      'public, max-age=31536000, immutable',
      '--only-show-errors',
    ]),
  )
  const head = JSON.parse(aws(['s3api', 'head-object', '--bucket', bucket, '--key', key]))
  if (head.ContentLength !== receipt.bytes) throw new Error(`安卓镜像上的 ${receipt.artifact} 大小不一致。`)

  const temporary = await mkdtemp(path.join(os.tmpdir(), 'nekro-nxt-android-mirror-'))
  try {
    let previousFolder
    try {
      const previousFile = path.join(temporary, 'previous.json')
      aws(['s3', 'cp', `${channelRoot}/manifest.json`, previousFile, '--only-show-errors'])
      previousFolder = /^files\/([^/]+)\//u.exec(JSON.parse(await readFile(previousFile, 'utf8')).file?.path ?? '')?.[1]
    } catch {
      previousFolder = undefined
    }
    const manifestFile = path.join(temporary, 'manifest.json')
    const manifest = androidMirrorManifest(receipt, {
      publishedAt: Date.now(),
      releaseUrl: published.html_url ?? `https://github.com/${repository}/releases/tag/${tag}`,
      githubUrl: `https://github.com/${repository}/releases/download/${tag}/${receipt.artifact}`,
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
    // Keeps the previous APK too, so an update that started downloading before this one still finishes.
    const folders = aws(['s3', 'ls', `${channelRoot}/files/`])
      .split('\n')
      .map((line) => /PRE\s+(\S+)\/$/u.exec(line.trim())?.[1])
      .filter((name) => name !== undefined)
    for (const stale of prunableFolders(folders, [folder, previousFolder]))
      aws(['s3', 'rm', `${channelRoot}/files/${stale}/`, '--recursive', '--only-show-errors'])
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
  console.log(`安卓 ${channel} 已镜像：${receipt.artifact}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const step = process.argv[2]
  const run = step === 'candidate' ? candidate : step === 'mirror' ? mirror : undefined
  if (run === undefined) {
    console.error('用法：android-release.mjs <candidate|mirror> <preview|stable> …')
    process.exit(1)
  }
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
