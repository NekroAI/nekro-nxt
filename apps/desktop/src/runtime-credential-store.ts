import type { DeviceCredential } from './credential-vault.js'

/** Keeps decrypted device credentials only for the lifetime of one Desktop manager. */
export class RuntimeCredentialStore {
  readonly #credentials = new Map<string, DeviceCredential>()
  #disposed = false

  get size(): number {
    return this.#credentials.size
  }

  get(profileId: string): DeviceCredential | undefined {
    return this.#disposed ? undefined : this.#credentials.get(profileId)
  }

  set(profileId: string, credential: DeviceCredential): void {
    if (this.#disposed) throw new Error('Desktop 运行时凭据仓已经停止。')
    this.#credentials.set(profileId, credential)
  }

  delete(profileId: string): void {
    if (!this.#disposed) this.#credentials.delete(profileId)
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#credentials.clear()
  }
}
