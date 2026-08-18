import type { AgentId, ExtensionId, ExtensionRevisionId, JsonValue } from '@nekro-nxt/contracts'

export interface LocalExtension {
  readonly id: ExtensionId
  readonly slug: string
  readonly displayName: string
  readonly description: string
  readonly createdByAgentId?: AgentId
  readonly createdAt: number
}

export interface Revision {
  readonly id: ExtensionRevisionId
  readonly extensionId: ExtensionId
  readonly revisionNumber: number
  readonly contentDigest: string
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
}

export interface ExtensionManifest {
  readonly extensionId: ExtensionId
  readonly revisionId: ExtensionRevisionId
  readonly entrypoints:
    | { readonly host: 'source/host.ts'; readonly client: 'source/client.ts' }
    | { readonly host: 'source/host.ts' }
    | { readonly client: 'source/client.ts' }
}

export interface MaterializedExtensionRevision {
  readonly manifest: ExtensionManifest
  readonly sources: { readonly host?: string; readonly client?: string }
  readonly contentDigest: string
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
  nextExtensionRevisionNumber(extensionId: ExtensionId): number

  /** Atomically inserts a new immutable Revision and its LocalExtension when it is new. */
  saveExtensionRevision(input: { readonly extension: LocalExtension; readonly revision: Revision }): void

  getActivation(agentId: AgentId, extensionId: ExtensionId): Activation | undefined
  listActivations(agentId?: AgentId): readonly Activation[]
  upsertActivation(activation: Activation): void
  deleteActivation(agentId: AgentId, extensionId: ExtensionId): void
}
