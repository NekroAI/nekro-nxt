import type { Context } from '@deepseek-ai/cordis'
import { SpillLocator, SpillStore, type SaveTextSpill, type SpillRef } from '@deepseek-ai/dsh-spill'
import { saveTextFile, sessionDir } from '@deepseek-ai/dsh-spill-local'
import { chmod, mkdir, readdir, stat } from 'node:fs/promises'
import path from 'node:path'

export const SPILL_ARTIFACT_MAX_BYTES = 8 * 1024 * 1024
export const SPILL_SESSION_MAX_BYTES = 64 * 1024 * 1024
export const SPILL_HOST_MAX_BYTES = 2 * 1024 * 1024 * 1024

export type SpillQuotaKind = 'artifact' | 'session' | 'host'

export class SpillQuotaError extends Error {
  readonly code = 'SPILL_QUOTA_EXCEEDED'

  constructor(
    readonly quota: SpillQuotaKind,
    readonly limitBytes: number,
    readonly requestedBytes: number,
  ) {
    super(`Spill ${quota} quota exceeded: requested ${requestedBytes} bytes, limit ${limitBytes} bytes.`)
  }
}

const directoryBytes = async (directory: string): Promise<number> => {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
  let bytes = 0
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) bytes += await directoryBytes(entryPath)
    else if (entry.isFile()) bytes += (await stat(entryPath)).size
  }
  return bytes
}

/** DSH public SpillStore implementation with restart-safe, fail-closed disk quotas. */
export class QuotaLocalSpillStore extends SpillStore {
  readonly root: string
  private hostBytes: number | undefined
  private readonly sessionBytes = new Map<string, number>()
  private tail: Promise<void> = Promise.resolve()

  constructor(ctx: Context, config: { readonly root: string }) {
    super(ctx)
    if (!path.isAbsolute(config.root)) throw new TypeError('DSH Spill root must be absolute.')
    this.root = config.root
  }

  override saveText(input: SaveTextSpill): Promise<SpillRef> {
    const result = this.tail.then(() => this.saveTextWithinQuota(input))
    this.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async saveTextWithinQuota(input: SaveTextSpill): Promise<SpillRef> {
    const requestedBytes = Buffer.byteLength(input.content, 'utf8')
    if (requestedBytes > SPILL_ARTIFACT_MAX_BYTES) {
      throw new SpillQuotaError('artifact', SPILL_ARTIFACT_MAX_BYTES, requestedBytes)
    }
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await chmod(this.root, 0o700)

    this.hostBytes ??= await directoryBytes(this.root)
    const sessionId = input.owner.sessionId
    const currentSessionBytes =
      this.sessionBytes.get(sessionId) ?? (await directoryBytes(sessionDir(this.root, sessionId)))
    this.sessionBytes.set(sessionId, currentSessionBytes)
    if (currentSessionBytes + requestedBytes > SPILL_SESSION_MAX_BYTES) {
      throw new SpillQuotaError('session', SPILL_SESSION_MAX_BYTES, currentSessionBytes + requestedBytes)
    }
    if (this.hostBytes + requestedBytes > SPILL_HOST_MAX_BYTES) {
      throw new SpillQuotaError('host', SPILL_HOST_MAX_BYTES, this.hostBytes + requestedBytes)
    }

    const saved = await saveTextFile({
      root: this.root,
      sessionId,
      suggestedName: input.suggestedName,
      content: input.content,
    })
    this.hostBytes += saved.bytes
    this.sessionBytes.set(sessionId, currentSessionBytes + saved.bytes)
    return {
      locator: SpillLocator(saved.path),
      bytes: saved.bytes,
      retrievalHint:
        'This artifact is retained by NekroNxt. Use read or grep only when this Agent Revision has file tools enabled; otherwise ask the user to enable file tools before retrieval.',
    }
  }
}
