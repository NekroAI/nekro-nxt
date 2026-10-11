import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, open, rm } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

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
