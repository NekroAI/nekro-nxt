import type { ExtensionRevisionId, ExtensionSaveOperationId } from '@nekro-nxt/contracts'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { MaterializedExtensionRevision } from './types.js'

const assertRelativeStoragePath = (value: string): void => {
  if (value.length === 0 || path.isAbsolute(value) || value.split(path.sep).includes('..')) {
    throw new TypeError(`Unsafe Extension storage path: ${value}`)
  }
}

export class ExtensionSourceStore {
  readonly #root: string

  constructor(root: string) {
    if (!path.isAbsolute(root)) throw new TypeError('Extension source root must be absolute.')
    this.#root = root
  }

  stagingRelativePath(operationId: ExtensionSaveOperationId): string {
    return path.join('staging', operationId)
  }

  revisionRelativePath(extensionId: string, revisionId: ExtensionRevisionId): string {
    return path.join('extensions', extensionId, 'revisions', revisionId)
  }

  async commit(
    stagingRelativePath: string,
    finalRelativePath: string,
    materialized: MaterializedExtensionRevision,
  ): Promise<void> {
    assertRelativeStoragePath(stagingRelativePath)
    assertRelativeStoragePath(finalRelativePath)
    const staging = path.join(this.#root, stagingRelativePath)
    const final = path.join(this.#root, finalRelativePath)
    await mkdir(path.dirname(staging), { recursive: true, mode: 0o700 })
    await rm(staging, { recursive: true, force: true })
    await mkdir(path.join(staging, 'source'), { recursive: true, mode: 0o700 })
    await Promise.all([
      writeFile(path.join(staging, 'manifest.json'), JSON.stringify(materialized.manifest, null, 2) + '\n', {
        encoding: 'utf8',
        mode: 0o600,
      }),
      writeFile(path.join(staging, 'source-input.json'), JSON.stringify(materialized.sourceInput, null, 2) + '\n', {
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
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' && (error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') {
        throw error
      }
      const existing = (await readFile(path.join(final, 'content.sha256'), 'utf8')).trim()
      if (existing !== materialized.contentDigest)
        throw new Error('Extension Revision directory already has other content.')
      await rm(staging, { recursive: true, force: true })
    }
  }

  async exists(relativePath: string): Promise<boolean> {
    assertRelativeStoragePath(relativePath)
    try {
      return (await stat(path.join(this.#root, relativePath))).isDirectory()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  async discardStaging(relativePath: string): Promise<void> {
    assertRelativeStoragePath(relativePath)
    if (!relativePath.startsWith(`staging${path.sep}`))
      throw new TypeError('Only an Extension staging path can be discarded.')
    await rm(path.join(this.#root, relativePath), { recursive: true, force: true })
  }

  async readContentDigest(relativePath: string): Promise<string> {
    assertRelativeStoragePath(relativePath)
    return (await readFile(path.join(this.#root, relativePath, 'content.sha256'), 'utf8')).trim()
  }

  absoluteRevisionPath(relativePath: string): string {
    assertRelativeStoragePath(relativePath)
    return path.join(this.#root, relativePath)
  }
}
