import { randomBytes } from 'node:crypto'
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'

const REFERENCE_PATTERN = /^credential:local:([a-f0-9]{32})$/u

const isNodeError = (error: unknown, code: string): error is NodeJS.ErrnoException =>
  error instanceof Error && 'code' in error && error.code === code

/**
 * Host-owned local credential store. Core records receive only opaque references;
 * secret bytes stay in one private data-root directory and one file per reference.
 * POSIX modes are enforced where the platform supports them; Windows keeps the
 * inherited ACL instead of calling unsupported directory-handle operations.
 */
export class LocalCredentialStore {
  readonly #root: string
  readonly #platform: NodeJS.Platform

  constructor(root: string, options: { readonly platform?: NodeJS.Platform } = {}) {
    if (!path.isAbsolute(root)) throw new TypeError('Credential store root must be absolute.')
    this.#root = path.resolve(root)
    this.#platform = options.platform ?? process.platform
  }

  async save(secret: string): Promise<string> {
    if (!secret.trim()) throw new TypeError('Credential secret must not be empty.')
    await this.#prepareRoot()
    const id = randomBytes(16).toString('hex')
    const reference = `credential:local:${id}`
    const target = this.#path(reference)
    const staging = `${target}.${randomBytes(8).toString('hex')}.staging`
    const file = await open(staging, 'wx', 0o600)
    try {
      await file.writeFile(secret, { encoding: 'utf8' })
      await file.sync()
    } catch (error) {
      await file.close()
      await rm(staging, { force: true })
      throw error
    }
    await file.close()
    try {
      await rename(staging, target)
    } catch (error) {
      await rm(staging, { force: true })
      throw error
    }
    if (this.#platform !== 'win32') {
      try {
        const directory = await open(this.#root, 'r')
        try {
          await directory.sync()
        } finally {
          await directory.close()
        }
      } catch (error) {
        await rm(target, { force: true })
        throw error
      }
    }
    return reference
  }

  async resolve(reference: string): Promise<string> {
    const target = this.#path(reference)
    let info
    try {
      info = await lstat(target)
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) throw new Error('Credential reference is unavailable.')
      throw error
    }
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error('Credential reference does not resolve to a regular file.')
    const secret = await readFile(target, 'utf8')
    if (!secret) throw new Error('Credential reference resolved to an empty secret.')
    return secret
  }

  async delete(reference: string): Promise<void> {
    await rm(this.#path(reference), { force: true })
  }

  async has(reference: string): Promise<boolean> {
    try {
      await this.resolve(reference)
      return true
    } catch (error) {
      if (error instanceof Error && error.message === 'Credential reference is unavailable.') return false
      throw error
    }
  }

  async #prepareRoot(): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 })
    const info = await lstat(this.#root)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error('Credential store root must be a real directory.')
    }
    if (this.#platform !== 'win32') {
      const directory = await open(this.#root, 'r')
      try {
        await directory.chmod(0o700)
      } finally {
        await directory.close()
      }
    }
  }

  #path(reference: string): string {
    const match = REFERENCE_PATTERN.exec(reference)
    if (!match) throw new TypeError('Invalid local credential reference.')
    return path.join(this.#root, `${match[1]}.secret`)
  }
}
