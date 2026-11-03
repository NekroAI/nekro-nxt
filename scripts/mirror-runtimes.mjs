// Copies the third-party runtimes NekroNXT downloads on request (附加功能) to NekroAI's public download bucket
// (`nekro-nxt-dist`, served at https://dl.nekro.ai/nxt), for places where GitHub is hard to reach. Every file is pinned
// in `runtime-mirror.json` by size and sha256 (the same pins as `apps/server/src/git-bash.ts`) and checked before upload; one already in the bucket at that size is
// left alone. The app checks the same pins again after downloading, so the mirror is never trusted on its own.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_BUCKET = 'nekro-nxt-dist'
/** Every NekroNXT file in the bucket sits under `nxt/`, so other NekroAI projects can share it. */
const PREFIX = 'nxt'

/**
 * The pinned files with where each one comes from and goes. Git for Windows versions are listed as Git version plus
 * build number, which name its release (`v<version>.windows.<build>`) and PortableGit (`<version>.<build>`).
 */
export async function readRuntimeMirror(file = path.join(repositoryRoot, 'scripts', 'runtime-mirror.json')) {
  const { gitForWindows } = JSON.parse(await readFile(file, 'utf8'))
  const { version, build } = gitForWindows
  if (!/^\d+\.\d+\.\d+$/u.test(version) || !Number.isSafeInteger(build))
    throw new Error('runtime-mirror.json 里 Git for Windows 的版本不完整。')
  const tag = `v${version}.windows.${build}`
  return gitForWindows.files.map((entry) => {
    if (
      !/^[\w-]+$/u.test(entry.variant ?? '') ||
      !Number.isSafeInteger(entry.bytes) ||
      !/^[a-f0-9]{64}$/u.test(entry.sha256 ?? '')
    )
      throw new Error(`runtime-mirror.json 里有一项不完整：${JSON.stringify(entry)}`)
    const name = `PortableGit-${version}.${build}-${entry.variant}.7z.exe`
    return {
      path: `runtimes/git-for-windows/${tag}/${name}`,
      url: `https://github.com/git-for-windows/git/releases/download/${tag}/${name}`,
      bytes: entry.bytes,
      sha256: entry.sha256,
    }
  })
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repositoryRoot, encoding: 'utf8', ...options })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.slice(0, 3).join(' ')} 失败：${(result.stderr ?? '').trim().slice(-500)}`)
  }
  return typeof result.stdout === 'string' ? result.stdout.trim() : ''
}

const sha256Of = (file) =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })

async function main() {
  const account = process.env['R2_ACCOUNT_ID']
  if (!account || !process.env['R2_ACCESS_KEY_ID'] || !process.env['R2_SECRET_ACCESS_KEY'])
    throw new Error('缺少 R2_ACCOUNT_ID、R2_ACCESS_KEY_ID 或 R2_SECRET_ACCESS_KEY。')
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
  const sizeInBucket = (key) => {
    try {
      return JSON.parse(aws(['s3api', 'head-object', '--bucket', bucket, '--key', key])).ContentLength
    } catch {
      return undefined
    }
  }

  const temporary = await mkdtemp(path.join(os.tmpdir(), 'nekro-nxt-runtimes-'))
  try {
    for (const entry of await readRuntimeMirror()) {
      const key = `${PREFIX}/${entry.path}`
      if (sizeInBucket(key) === entry.bytes) {
        console.log(`已在镜像上：${entry.path}`)
        continue
      }
      const file = path.join(temporary, path.basename(entry.path))
      run('curl', ['--fail', '--location', '--silent', '--show-error', '--retry', '3', '-o', file, entry.url])
      if ((await stat(file)).size !== entry.bytes || (await sha256Of(file)) !== entry.sha256)
        throw new Error(`${entry.url} 和固定的大小或校验值不一致，没有上传。`)
      aws([
        's3',
        'cp',
        file,
        `s3://${bucket}/${key}`,
        '--content-type',
        'application/octet-stream',
        // A pinned file never changes: a new version gets a new folder.
        '--cache-control',
        'public, max-age=31536000, immutable',
        '--only-show-errors',
      ])
      if (sizeInBucket(key) !== entry.bytes) throw new Error(`镜像上的 ${entry.path} 大小不一致。`)
      await rm(file)
      console.log(`已上传：${entry.path}`)
    }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
