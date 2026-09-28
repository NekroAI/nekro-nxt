import type { RuntimeCompatibilityDiagnostic } from '@nekro-nxt/contracts'

export interface ExtensionCompatibilityIdentity {
  readonly objectKind: 'extension' | 'adapter' | 'client-page'
  readonly objectId: string
  readonly objectVersion: string
  readonly configurationRevision: string
}

/** Evidence belongs to the host; the owner still performs real build/load/release operations. */
export interface ExtensionCompatibilityPort {
  read(identity: ExtensionCompatibilityIdentity): RuntimeCompatibilityDiagnostic | undefined
  record(
    identity: ExtensionCompatibilityIdentity,
    outcome: {
      readonly status: 'compatible' | 'isolated'
      readonly phase: 'restore' | 'dispose'
      readonly retryable: boolean
      readonly reason?: string
    },
  ): RuntimeCompatibilityDiagnostic
}
