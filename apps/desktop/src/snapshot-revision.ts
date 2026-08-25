/** Advances a monotonic revision only when the serialized presentation actually changes. */
export class SnapshotRevisionClock {
  #revision = 0
  #signature: string | undefined

  get revision(): number {
    return this.#revision
  }

  commit(presentation: unknown): number | undefined {
    const signature = JSON.stringify(presentation)
    if (signature === this.#signature) return undefined
    this.#signature = signature
    this.#revision += 1
    return this.#revision
  }
}
