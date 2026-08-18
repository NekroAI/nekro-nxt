import type { ExtensionId, ExtensionRevisionId } from '@nekro-nxt/contracts'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { MaterializedExtensionRevision } from './types.js'

const getNodeErrorCode = (error: unknown): string | undefined => {
  if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'string') return undefined
  return error.code
}

const assertRelativeStoragePath = (value: string): void => {
  if (value.length === 0 || path.isAbsolute(value) || value.split(path.sep).includes('..')) {
    throw new TypeError(`Unsafe Extension storage path: ${value}`)
  }
}

const assertStorageIdentity = (value: string): void => {
  if (value.length === 0 || value === '.' || value === '..' || path.basename(value) !== value) {
    throw new TypeError(`Unsafe Extension storage identity: ${value}`)
  }
}

export class ExtensionSourceStore {
  readonly #root: string

  constructor(root: string) {
    if (!path.isAbsolute(root)) throw new TypeError('Extension source root must be absolute.')
    this.#root = root
  }

  revisionRelativePath(extensionId: ExtensionId, revisionId: ExtensionRevisionId): string {
    assertStorageIdentity(extensionId)
    assertStorageIdentity(revisionId)
    const relativePath = path.join('extensions', extensionId, 'revisions', revisionId)
    assertRelativeStoragePath(relativePath)
    return relativePath
  }

  /** Writes a complete temporary directory, then atomically publishes the immutable Revision directory. */
  async publish(
    extensionId: ExtensionId,
    revisionId: ExtensionRevisionId,
    materialized: MaterializedExtensionRevision,
  ): Promise<void> {
    const finalRelativePath = this.revisionRelativePath(extensionId, revisionId)
    const stagingRelativePath = path.join('staging', randomUUID())
    const staging = path.join(this.#root, stagingRelativePath)
    const final = path.join(this.#root, finalRelativePath)
    await mkdir(path.join(staging, 'source'), { recursive: true, mode: 0o700 })
    try {
      await Promise.all([
        writeFile(path.join(staging, 'manifest.json'), JSON.stringify(materialized.manifest, null, 2) + '\n', {
          encoding: 'utf8',
          mode: 0o600,
        }),
        ...(materialized.sources.host === undefined
          ? []
          : [writeFile(path.join(staging, 'source', 'host.ts'), materialized.sources.host, { mode: 0o600 })]),
        ...(materialized.sources.client === undefined
          ? []
          : [writeFile(path.join(staging, 'source', 'client.ts'), materialized.sources.client, { mode: 0o600 })]),
        writeFile(path.join(staging, 'content.sha256'), materialized.contentDigest + '\n', {
          encoding: 'utf8',
          mode: 0o600,
        }),
      ])
      await mkdir(path.dirname(final), { recursive: true, mode: 0o700 })
      try {
        await rename(staging, final)
      } catch (error) {
        const code = getNodeErrorCode(error)
        if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error
        const existing = (await readFile(path.join(final, 'content.sha256'), 'utf8')).trim()
        if (existing !== materialized.contentDigest) {
          throw new Error('Extension Revision directory already has other content.')
        }
      }
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }

  revisionSourceDirectory(extensionId: ExtensionId, revisionId: ExtensionRevisionId): string {
    const relativePath = this.revisionRelativePath(extensionId, revisionId)
    assertRelativeStoragePath(relativePath)
    return path.join(this.#root, relativePath)
  }
}
