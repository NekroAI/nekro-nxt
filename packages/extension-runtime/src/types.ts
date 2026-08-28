import type { AgentId, ExtensionId, ExtensionRevisionId, JsonValue } from '@nekro-nxt/contracts'

export interface LocalExtension {
  readonly id: ExtensionId
  readonly scope: LocalExtensionScope
  readonly slug: string
  readonly displayName: string
  readonly description: string
  readonly createdByAgentId?: AgentId
  readonly createdAt: number
}

export type LocalExtensionScope = 'agent' | 'host-adapter'

export interface Revision {
  readonly id: ExtensionRevisionId
  readonly extensionId: ExtensionId
  readonly revisionNumber: number
  readonly contentDigest: string
  /** Stable digest of normalized code and contributions; excludes local Revision identities. */
  readonly payloadDigest: string
  readonly createdAt: number
}

/** The single currently mounted Revision for one Agent and Extension pair. */
export interface Activation {
  readonly agentId: AgentId
  readonly extensionId: ExtensionId
  readonly extensionRevisionId: ExtensionRevisionId
  readonly config: JsonValue
  readonly activatedAt: number
}

/** A selected in-memory DSH dynamic Package copied at the explicit save boundary. */
export interface DynamicPackageSnapshot {
  readonly name: string
  readonly purpose: string
  readonly hostCode?: string
  readonly clientCode?: string
  readonly contributions?: readonly ExtensionContribution[]
}

export type ExtensionContribution =
  | { readonly kind: 'tool'; readonly name: string; readonly description: string }
  | { readonly kind: 'rpc'; readonly method: string }
  | {
      readonly kind: 'client-slot'
      readonly name: 'agent.workbench.sections' | 'extension.details.panels'
    }
  | HostAdapterContributionEvidence
  | HostClientSlotContributionEvidence

export interface HostAdapterContributionEvidence {
  readonly kind: 'adapter'
  readonly apiVersion: 1
  readonly key: string
  readonly descriptorDigest: string
}

export interface HostClientSlotContributionEvidence {
  readonly kind: 'host-client-slot'
  readonly name: 'conversation.message.rich'
  readonly key: string
}

export interface ExtensionManifestV1 {
  readonly extensionId: ExtensionId
  readonly revisionId: ExtensionRevisionId
  readonly entrypoints:
    | { readonly host: 'source/host.ts'; readonly client: 'source/client.ts' }
    | { readonly host: 'source/host.ts' }
    | { readonly client: 'source/client.ts' }
}

export interface ExtensionManifestV2 extends ExtensionManifestV1 {
  readonly schemaVersion: 2
  readonly contributions: readonly ExtensionContribution[]
}

export interface ExtensionManifestV3 {
  readonly schemaVersion: 3
  readonly scope: 'host-adapter'
  readonly extensionId: ExtensionId
  readonly revisionId: ExtensionRevisionId
  readonly entrypoints:
    { readonly host: 'source/host.ts'; readonly client: 'source/client.ts' } | { readonly host: 'source/host.ts' }
  readonly contributions: readonly [HostAdapterContributionEvidence, ...HostClientSlotContributionEvidence[]]
}

export type ExtensionManifest = ExtensionManifestV1 | ExtensionManifestV2 | ExtensionManifestV3

export interface ExtensionRevisionVerification {
  readonly revisionId: ExtensionRevisionId
  /** Exact DSH release used when this immutable verification evidence was produced. */
  readonly dshVersion: string
  readonly contractVersion: 'nekro-nxt-extension-v1' | 'nekro-nxt-extension-v2'
  readonly scope?: 'host-adapter'
  readonly origin: {
    readonly episodeId: string
    readonly pluginId: string
    readonly packageId: string
    readonly pluginRunId: string
  }
  readonly verifiedAt: number
  readonly hostBuild: { readonly built: boolean; readonly buildKey: string }
  readonly clientBuild: { readonly built: boolean; readonly buildKey: string }
  readonly toolInvocations: readonly { readonly name: string; readonly succeeded: boolean }[]
  readonly rpcMethods: readonly string[]
  readonly renderedSlots: readonly ('agent.workbench.sections' | 'extension.details.panels')[]
  readonly adapter?: {
    readonly apiVersion: 1
    readonly key: string
    readonly descriptorDigest: string
    readonly registered: boolean
    readonly started: boolean
    readonly stopped: boolean
    readonly inboundCommitted: boolean
    readonly outboundReceipt: 'sent' | 'failed' | 'unknown'
  }
  readonly renderedHostSlots?: readonly {
    readonly name: 'conversation.message.rich'
    readonly key: string
  }[]
}

/** The single currently installed Host-scoped Revision for one Extension. */
export interface HostInstallation {
  readonly extensionId: ExtensionId
  readonly extensionRevisionId: ExtensionRevisionId
  readonly installedAt: number
}

export interface ExtensionClientDiagnostic {
  readonly agentId: AgentId
  readonly extensionId: ExtensionId
  readonly revisionId: ExtensionRevisionId
  readonly status: 'loaded' | 'failed'
  readonly message?: string
  readonly observedAt: number
}

export interface ExtensionRuntimeDiagnostic {
  readonly status: 'active' | 'restore-failed' | 'dispose-failed'
  readonly message?: string
  readonly observedAt: number
}

export interface MaterializedExtensionRevision {
  readonly manifest: ExtensionManifest
  readonly sources: { readonly host?: string; readonly client?: string }
  readonly contentDigest: string
  readonly payloadDigest: string
  readonly scope: LocalExtensionScope
}

export interface ExtensionBuildArtifact {
  readonly revisionId: ExtensionRevisionId
  readonly buildKey: string
  readonly directory: string
  readonly hostEntry?: string
  readonly clientEntry?: string
}

export interface ExtensionRepository {
  listExtensions(): readonly LocalExtension[]
  getExtension(id: ExtensionId): LocalExtension | undefined
  getExtensionBySlug(slug: string): LocalExtension | undefined
  listExtensionRevisions(extensionId?: ExtensionId): readonly Revision[]
  getExtensionRevision(id: ExtensionRevisionId): Revision | undefined
  getExtensionRevisionByPayloadDigest(extensionId: ExtensionId, payloadDigest: string): Revision | undefined
  nextExtensionRevisionNumber(extensionId: ExtensionId): number

  /** Atomically inserts a new immutable Revision and its LocalExtension when it is new. */
  saveExtensionRevision(input: {
    readonly extension: LocalExtension
    readonly revision: Revision
    readonly verification?: ExtensionRevisionVerification
  }): void
  /** Deletes one inactive Extension and all immutable Revisions in one database transaction. */
  deleteExtension(extensionId: ExtensionId): void
  getExtensionRevisionVerification(revisionId: ExtensionRevisionId): ExtensionRevisionVerification | undefined
  getExtensionClientDiagnostic(agentId: AgentId, extensionId: ExtensionId): ExtensionClientDiagnostic | undefined
  upsertExtensionClientDiagnostic(diagnostic: ExtensionClientDiagnostic): void

  getActivation(agentId: AgentId, extensionId: ExtensionId): Activation | undefined
  listActivations(agentId?: AgentId): readonly Activation[]
  upsertActivation(activation: Activation): void
  deleteActivation(agentId: AgentId, extensionId: ExtensionId): void

  getHostInstallation(extensionId: ExtensionId): HostInstallation | undefined
  listHostInstallations(): readonly HostInstallation[]
  upsertHostInstallation(installation: HostInstallation): void
  deleteHostInstallation(extensionId: ExtensionId): void
}
