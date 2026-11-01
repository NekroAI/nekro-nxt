import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Where a pinned download stands; `idle` before it starts and after it succeeded. */
export interface RuntimeDownloadState {
  readonly state: 'idle' | 'downloading' | 'failed'
  readonly receivedBytes?: number
  readonly totalBytes?: number
  readonly error?: string
}

export interface RuntimeDownloadProgress {
  readonly receivedBytes: number
  readonly totalBytes?: number
}

/**
 * Downloads one archive, checks it against the published checksum and unpacks it into `destination`. A file that
 * fails the check is discarded and nothing is unpacked.
 */
export const downloadAndUnpack = async (input: {
  readonly url: string
  readonly sha256: string
  readonly archive: string
  readonly destination: string
  readonly fetch?: typeof fetch
  readonly onProgress?: (progress: RuntimeDownloadProgress) => void
}): Promise<void> => {
  const response = await (input.fetch ?? fetch)(input.url)
  if (!response.ok || response.body === null) throw new Error(`下载失败（HTTP ${response.status}）。`)
  const total = Number(response.headers.get('content-length') ?? 0) || undefined
  const hash = createHash('sha256')
  let received = 0
  let reported = 0
  const reader = response.body.getReader()
  await mkdir(path.dirname(input.archive), { recursive: true })
  const file = await open(input.archive, 'w')
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      hash.update(value)
      await file.write(value)
      received += value.length
      // Report about every 2 MB so the page moves without flooding it.
      if (received - reported >= 2 * 1024 * 1024) {
        reported = received
        input.onProgress?.({ receivedBytes: received, ...(total === undefined ? {} : { totalBytes: total }) })
      }
    }
  } finally {
    await file.close()
  }
  if (hash.digest('hex') !== input.sha256) throw new Error('下载的文件校验不通过，已丢弃。')
  await mkdir(input.destination, { recursive: true })
  // macOS, Linux and Windows 10+ all ship a `tar` that reads both .tar.gz and .zip.
  await run('tar', ['-xf', input.archive, '-C', input.destination])
  await rm(input.archive)
}

/** A file pinned by size and sha256, with the sources tried in order. */
export interface PinnedDownload {
  readonly target: string
  readonly bytes: number
  readonly sha256: string
  readonly urls: readonly string[]
}

/** Whether `target` already holds the pinned file. */
export const pinnedFileVerified = async (target: string, bytes: number, sha256: string): Promise<boolean> => {
  try {
    if ((await stat(target)).size !== bytes) return false
    return (
      createHash('sha256')
        .update(await readFile(target))
        .digest('hex') === sha256
    )
  } catch {
    return false
  }
}

/** Tries each source in turn; the file appears at `target` only after its size and hash match. */
export const downloadPinnedFile = async (
  entry: PinnedDownload,
  options: { readonly fetch?: typeof fetch; readonly onProgress?: (received: number) => void } = {},
): Promise<void> => {
  await mkdir(path.dirname(entry.target), { recursive: true })
  const failures: string[] = []
  for (const url of entry.urls) {
    const staging = `${entry.target}.${randomUUID()}.part`
    try {
      const response = await (options.fetch ?? fetch)(url, { signal: AbortSignal.timeout(10 * 60 * 1000) })
      if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status}`)
      const hash = createHash('sha256')
      let received = 0
      const file = await open(staging, 'w')
      try {
        const reader = response.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          received += value.byteLength
          if (received > entry.bytes) throw new Error('文件比预期大')
          hash.update(value)
          await file.write(value)
          options.onProgress?.(received)
        }
      } finally {
        await file.close()
      }
      if (received !== entry.bytes || hash.digest('hex') !== entry.sha256) throw new Error('校验不通过')
      await rename(staging, entry.target)
      return
    } catch (error) {
      await rm(staging, { force: true })
      failures.push(`${new URL(url).host}：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`${path.basename(entry.target)} 下载失败（${failures.join('；')}）`)
}
