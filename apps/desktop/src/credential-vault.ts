import { safeStorage } from 'electron'
import { parseJsonValue } from '@nekro-nxt/contracts'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { SerialTaskQueue } from './serial-task-queue.js'

interface VaultEnvelope {
  readonly format: 'nxt.desktop-credential-vault'
  readonly version: 1
  readonly values: Readonly<Record<string, string>>
}

export interface DeviceCredential {
  readonly deviceId: string
  readonly deviceSecret: string
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

export class CredentialVault {
  readonly #filePath: string
  readonly #mutations = new SerialTaskQueue()
  #values: Record<string, string>

  private constructor(filePath: string, values: Record<string, string>) {
    this.#filePath = filePath
    this.#values = values
  }

  static async open(filePath: string): Promise<CredentialVault> {
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
    try {
      const parsed: unknown = parseJsonValue(JSON.parse(await readFile(filePath, 'utf8')))
      if (
        !isRecord(parsed) ||
        parsed['format'] !== 'nxt.desktop-credential-vault' ||
        parsed['version'] !== 1 ||
        !isRecord(parsed['values'])
      ) {
        throw new Error('设备凭据文件无效。')
      }
      const values: Record<string, string> = {}
      for (const [key, value] of Object.entries(parsed['values'])) {
        if (typeof value !== 'string') throw new Error('设备凭据文件无效。')
        values[key] = value
      }
      return new CredentialVault(filePath, values)
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined
      if (code !== 'ENOENT') await rename(filePath, `${filePath}.recovery-${Date.now()}`)
      return new CredentialVault(filePath, {})
    }
  }

  canPersist(): boolean {
    if (!safeStorage.isEncryptionAvailable()) return false
    return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'
  }

  get(reference: string): DeviceCredential | undefined {
    const encrypted = this.#values[reference]
    if (encrypted === undefined || !safeStorage.isEncryptionAvailable()) return undefined
    try {
      const parsed: unknown = parseJsonValue(JSON.parse(safeStorage.decryptString(Buffer.from(encrypted, 'base64'))))
      return isRecord(parsed) && typeof parsed['deviceId'] === 'string' && typeof parsed['deviceSecret'] === 'string'
        ? { deviceId: parsed['deviceId'], deviceSecret: parsed['deviceSecret'] }
        : undefined
    } catch {
      return undefined
    }
  }

  async put(credential: DeviceCredential): Promise<string | undefined> {
    if (!this.canPersist()) return undefined
    return this.#mutations.run(async () => {
      const reference = randomUUID()
      const previous = this.#values
      this.#values = {
        ...previous,
        [reference]: safeStorage.encryptString(JSON.stringify(credential)).toString('base64'),
      }
      try {
        await this.#save()
      } catch (error) {
        this.#values = previous
        throw error
      }
      return reference
    })
  }

  async remove(reference: string): Promise<void> {
    await this.#mutations.run(async () => {
      if (!(reference in this.#values)) return
      const previous = this.#values
      const next = { ...previous }
      delete next[reference]
      this.#values = next
      try {
        await this.#save()
      } catch (error) {
        this.#values = previous
        throw error
      }
    })
  }

  async #save(): Promise<void> {
    const envelope: VaultEnvelope = { format: 'nxt.desktop-credential-vault', version: 1, values: this.#values }
    const temporary = `${this.#filePath}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    await rename(temporary, this.#filePath)
  }
}
