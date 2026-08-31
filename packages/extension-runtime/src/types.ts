import type {
  AdapterClientSlotName,
  AgentClientSlotName,
  AgentId,
  DshPluginEntryId,
  ExtensionId,
  ExtensionRevisionId,
  HostPageContribution,
  HostUiKitComponentName,
  HostUiPageGeometryEvidence,
  HostUiPageEntry,
  HostUiPageInstanceId,
  HostUiPermissionDeclaration,
  JsonValue,
} from '@nekro-nxt/contracts'

export interface LocalExtension {
  readonly id: ExtensionId
  readonly scope: LocalExtensionScope
  readonly slug: string
  readonly displayName: string
  readonly description: string
  readonly createdByAgentId?: AgentId
  readonly createdAt: number
}

export type LocalExtensionScope = 'agent' | 'host-adapter' | 'host-ui'

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
  readonly permissions?: HostUiPermissionDeclaration
  readonly contributions?: readonly ExtensionContribution[]
  readonly resources?: Readonly<Record<string, string>>
  readonly clientCss?: { readonly path: string; readonly sha256: string }
}

export type ExtensionContribution =
  | { readonly kind: 'tool'; readonly name: string; readonly description: string }
  | { readonly kind: 'rpc'; readonly method: string }
  | {
      readonly kind: 'client-slot'
      readonly name: AgentClientSlotName
    }
  | HostAdapterContributionEvidence
  | HostClientSlotContributionEvidence
  | HostPageContribution

export interface HostAdapterContributionEvidence {
  readonly kind: 'adapter'
  readonly apiVersion: 1
  readonly key: string
  readonly descriptorDigest: string
}

export interface HostClientSlotContributionEvidence {
  readonly kind: 'host-client-slot'
  readonly name: AdapterClientSlotName
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
  readonly clientCss?: { readonly path: string; readonly sha256: string }
  readonly contributions: readonly [
    HostAdapterContributionEvidence,
    ...(HostClientSlotContributionEvidence | HostPageContribution)[],
  ]
}

export interface ExtensionManifestV4 {
  readonly schemaVersion: 4
  readonly scope: 'host-ui'
  readonly extensionId: ExtensionId
  readonly revisionId: ExtensionRevisionId
  readonly entrypoints:
    { readonly host: 'source/host.ts'; readonly client: 'source/client.ts' } | { readonly client: 'source/client.ts' }
  readonly clientCss?: { readonly path: string; readonly sha256: string }
  readonly permissions: HostUiPermissionDeclaration
  readonly contributions: readonly HostPageContribution[]
}

export type ExtensionManifest = ExtensionManifestV1 | ExtensionManifestV2 | ExtensionManifestV3 | ExtensionManifestV4

export interface ExtensionRevisionVerification {
  readonly revisionId: ExtensionRevisionId
  /** Exact DSH release used when this immutable verification evidence was produced. */
  readonly dshVersion: string
  readonly contractVersion: 'nekro-nxt-extension-v1' | 'nekro-nxt-extension-v2' | 'nekro-nxt-extension-v3'
  readonly scope?: 'host-adapter' | 'host-ui'
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
  readonly renderedSlots: readonly AgentClientSlotName[]
  readonly renderedPages?: readonly HostPageContribution[]
  readonly usedUiComponents?: readonly HostUiKitComponentName[]
  readonly pageGeometry?: readonly HostUiPageGeometryEvidence[]
  readonly permissions?: HostUiPermissionDeclaration
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
    readonly name: AdapterClientSlotName
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
  readonly resources?: Readonly<Record<string, string>>
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
  readonly clientCssEntry?: string
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

export interface HostUiRepository {
  /** Atomically publishes the Installation fact together with its permission grant and page directory. */
  commitHostInstallationState(input: {
    readonly installation: HostInstallation
    readonly hostUi?: {
      readonly grant: HostUiPermissionGrant
      readonly pages: readonly HostPageContribution[]
      readonly clientBuildKey: string
      readonly now: number
      readonly nextPageInstanceId: () => HostUiPageInstanceId
    }
  }): readonly HostUiPageEntry[]
  /** Atomically retracts an Installation, its extension-owned pages and its permission grant. */
  deleteHostInstallationState(input: { readonly extensionId: ExtensionId; readonly now: number }): void
  listHostUiPageEntries(): readonly HostUiPageEntry[]
  replaceHostUiExtensionPages(input: {
    readonly extensionId: ExtensionId
    readonly revisionId: ExtensionRevisionId
    readonly pages: readonly HostPageContribution[]
    readonly clientBuildKey: string
    readonly now: number
    readonly nextPageInstanceId: () => HostUiPageInstanceId
  }): readonly HostUiPageEntry[]
  deleteHostUiExtensionPages(extensionId: ExtensionId): void
  replaceHostUiDshPages(input: {
    readonly entryId: DshPluginEntryId
    readonly artifactDigest: string
    readonly pages: readonly HostPageContribution[]
    readonly clientBuildKey: string
    readonly now: number
    readonly nextPageInstanceId: () => HostUiPageInstanceId
  }): readonly HostUiPageEntry[]
  deleteHostUiDshPages(entryId: DshPluginEntryId): void
  getHostUiPreferencesRevision(): number
  updateHostUiPagePreferences(input: {
    readonly expectedRevision: number
    readonly entries: readonly { readonly pageInstanceId: HostUiPageInstanceId; readonly visible: boolean }[]
    readonly now: number
  }): number
  getHostUiPermissionGrant(ownerKey: string): HostUiPermissionGrant | undefined
  upsertHostUiPermissionGrant(grant: HostUiPermissionGrant): void
  deleteHostUiPermissionGrant(ownerKey: string): void
  getHostUiDiagnostic(pageInstanceId: HostUiPageInstanceId): HostUiDiagnostic | undefined
  upsertHostUiDiagnostic(diagnostic: HostUiDiagnostic): void
  deleteHostUiDiagnosticsForExtension(extensionId: ExtensionId): void
}

export interface HostUiPermissionGrant {
  readonly ownerKey: string
  readonly artifactDigest: string
  readonly permissionDigest: string
  readonly declaration: HostUiPermissionDeclaration
  readonly approvedAt: number
}

export interface HostUiDiagnostic {
  readonly pageInstanceId: HostUiPageInstanceId
  readonly status: 'ready' | 'load-failed' | 'navigation-failed' | 'rpc-failed' | 'restore-failed'
  readonly message?: string
  readonly observedAt: number
}
