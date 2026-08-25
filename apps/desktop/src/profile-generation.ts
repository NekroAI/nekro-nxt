export type ProfileGenerationReason = 'switch' | 'update' | 'reauthenticate' | 'remove' | 'dispose'

export interface ProfileGenerationToken {
  readonly profileId: string
  readonly generation: number
  readonly reason?: ProfileGenerationReason
}

/** Owns profile mutation generations so asynchronous results can only commit to the profile version they observed. */
export class ProfileGenerationRegistry {
  readonly #generations = new Map<string, number>()

  register(profileId: string): void {
    if (!this.#generations.has(profileId)) this.#generations.set(profileId, 0)
  }

  current(profileId: string): number {
    return this.#generations.get(profileId) ?? 0
  }

  capture(profileId: string): ProfileGenerationToken {
    return { profileId, generation: this.current(profileId) }
  }

  advance(profileId: string, reason: ProfileGenerationReason): ProfileGenerationToken {
    const generation = this.current(profileId) + 1
    this.#generations.set(profileId, generation)
    return { profileId, generation, reason }
  }

  isCurrent(token: ProfileGenerationToken): boolean {
    return this.#generations.get(token.profileId) === token.generation
  }

  remove(profileId: string): void {
    this.#generations.delete(profileId)
  }

  clear(): void {
    this.#generations.clear()
  }
}
