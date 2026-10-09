import {
  RuntimeCompatibilityDiagnosticSchema,
  parseJsonValue,
  type RuntimeCompatibilityDiagnostic,
} from '@nekro-nxt/contracts'
import { DSH_RUNTIME_FINGERPRINT } from '@nekro-nxt/dsh-compat/release'
import { createHash } from 'node:crypto'
import type { SqliteCoreRepository } from '@nekro-nxt/storage-sqlite'

type Identity = Pick<
  RuntimeCompatibilityDiagnostic,
  'objectKind' | 'objectId' | 'objectVersion' | 'configurationRevision'
>

/** Owner-scoped compatibility evidence; installation and enablement remain separate facts. */
export class RuntimeCompatibilityRegistry {
  readonly #repository: SqliteCoreRepository
  readonly #current = new Map<string, RuntimeCompatibilityDiagnostic>()
  constructor(repository: SqliteCoreRepository) {
    this.#repository = repository
  }

  #key(identity: Identity): string {
    return `runtime-compatibility:${createHash('sha256')
      .update(
        JSON.stringify([
          identity.objectKind,
          identity.objectId,
          identity.objectVersion,
          identity.configurationRevision,
          DSH_RUNTIME_FINGERPRINT,
        ]),
      )
      .digest('hex')}`
  }

  read(identity: Identity): RuntimeCompatibilityDiagnostic | undefined {
    const key = this.#key(identity)
    const parsed = RuntimeCompatibilityDiagnosticSchema.safeParse(this.#repository.getSystemSetting(key)?.value)
    const value = parsed.success ? parsed.data : undefined
    if (value) this.#current.set(`${identity.objectKind}:${identity.objectId}:${identity.configurationRevision}`, value)
    return value
  }

  record(
    identity: Identity,
    outcome: Pick<RuntimeCompatibilityDiagnostic, 'status' | 'phase' | 'retryable'> & { readonly reason?: string },
  ): RuntimeCompatibilityDiagnostic {
    const diagnostic = RuntimeCompatibilityDiagnosticSchema.parse({
      ...identity,
      ...outcome,
      runtimeFingerprint: DSH_RUNTIME_FINGERPRINT,
      checkedAt: Date.now(),
    })
    const key = this.#key(identity)
    const current = this.#repository.getSystemSetting(key)
    this.#repository.putSystemSetting(key, parseJsonValue(diagnostic), current?.revision, diagnostic.checkedAt)
    this.#current.set(`${identity.objectKind}:${identity.objectId}:${identity.configurationRevision}`, diagnostic)
    return diagnostic
  }

  list(): readonly RuntimeCompatibilityDiagnostic[] {
    return [...this.#current.values()]
  }

  /** Only current product relationships appear in the UI; historical evidence remains queryable. */
  listCurrent(): readonly RuntimeCompatibilityDiagnostic[] {
    const agents = this.#repository.listAgents()
    const activations = this.#repository.listActivations()
    const installations = this.#repository.listHostInstallations()
    return [...this.#current.values()].filter((diagnostic) => {
      if (diagnostic.objectKind === 'agent') {
        return agents.some(
          ({ definition, revision }) =>
            definition.id === diagnostic.objectId &&
            revision.id === diagnostic.objectVersion &&
            JSON.stringify(revision.model) === diagnostic.configurationRevision,
        )
      }
      if (diagnostic.objectKind === 'extension') {
        // The host instance is keyed by its host config, each agent attachment by agent and agent config.
        return (
          installations.some(
            (installation) =>
              installation.extensionId === diagnostic.objectId &&
              installation.extensionRevisionId === diagnostic.objectVersion &&
              JSON.stringify(['host', installation.config]) === diagnostic.configurationRevision,
          ) ||
          activations.some(
            (activation) =>
              activation.extensionId === diagnostic.objectId &&
              activation.extensionRevisionId === diagnostic.objectVersion &&
              JSON.stringify([activation.agentId, activation.config]) === diagnostic.configurationRevision,
          )
        )
      }
      if (diagnostic.objectKind === 'adapter' || diagnostic.objectKind === 'client-page') {
        return installations.some(
          (installation) =>
            installation.extensionId === diagnostic.objectId &&
            installation.extensionRevisionId === diagnostic.objectVersion,
        )
      }
      return true
    })
  }
}
