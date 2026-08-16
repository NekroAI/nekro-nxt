import type {
  AgentActivationId,
  AgentId,
  DraftPackageId,
  ExtensionDraftId,
  ExtensionId,
  ExtensionRevisionId,
  ExtensionSaveOperationId,
  JsonValue,
} from '@nekro-nxt/contracts'

export interface ExtensionDraftRecord {
  readonly id: ExtensionDraftId
  readonly agentId: AgentId
  readonly sourceDshSessionId: string
  readonly sourceDynamicPluginId: string
  readonly displayName: string
  readonly description: string
  readonly state: 'open' | 'saved' | 'discarded'
  readonly createdAt: number
  readonly updatedAt: number
}

export interface DraftPackageRecord {
  readonly id: DraftPackageId
  readonly draftId: ExtensionDraftId
  readonly sourceDynamicPackageId: string
  readonly sequence: number
  readonly name: string
  readonly purpose: string
  readonly hostCode?: string
  readonly clientCode?: string
  readonly createdAt: number
}

export interface LocalExtensionRecord {
  readonly id: ExtensionId
  readonly slug: string
  readonly displayName: string
  readonly description: string
  readonly origin: 'local-created' | 'local-imported'
  readonly createdByAgentId?: AgentId
  readonly defaultRevisionId?: ExtensionRevisionId
  readonly createdAt: number
  readonly deletedAt?: number
}

export interface ExtensionRevisionRecord {
  readonly id: ExtensionRevisionId
  readonly extensionId: ExtensionId
  readonly revisionNumber: number
  readonly contentDigest: string
  readonly manifestSchemaVersion: 1
  readonly extensionApiVersion: '1'
  readonly sourceKind: 'dynamic-package' | 'local-source'
  readonly sourceDynamicPackageRef?: string
  readonly compatibleNekroNxtRange: string
  readonly compatibleDshRange: string
  readonly storageState: 'saving' | 'saved' | 'damaged' | 'quarantined'
  readonly lastBuildStatus?: 'succeeded' | 'failed'
  readonly lastValidationStatus?: 'succeeded' | 'failed'
  readonly createdAt: number
}

export interface ExtensionSaveOperationRecord {
  readonly id: ExtensionSaveOperationId
  readonly draftPackageId: DraftPackageId
  readonly extensionId: ExtensionId
  readonly revisionId: ExtensionRevisionId
  readonly stagingRelativePath: string
  readonly finalRelativePath: string
  readonly state: 'running' | 'completed' | 'failed'
  readonly errorSummary?: string
  readonly createdAt: number
  readonly completedAt?: number
}

export interface AgentActivationRecord {
  readonly id: AgentActivationId
  readonly agentId: AgentId
  readonly extensionId: ExtensionId
  readonly extensionRevisionId: ExtensionRevisionId
  readonly config: JsonValue
  readonly state: 'pending' | 'waiting-safe-switch' | 'active' | 'failed' | 'disabled'
  readonly runtimeKind: 'in-process'
  readonly createdAt: number
  readonly activatedAt?: number
  readonly disabledAt?: number
  readonly lastError?: string
}

export interface ExtensionManifestV1 {
  readonly schemaVersion: 1
  readonly extensionId: ExtensionId
  readonly revisionId: ExtensionRevisionId
  readonly name: string
  readonly apiVersion: '1'
  readonly entrypoints: { readonly host?: 'source/host.ts'; readonly client?: 'source/client.ts' }
  readonly contributions: readonly { readonly type: 'host' | 'client'; readonly id: string }[]
  readonly requestedCapabilities: readonly string[]
  readonly compatible: { readonly nekroNxt: string; readonly dsh: string }
}

export interface ExtensionSourceInputV1 {
  readonly schemaVersion: 1
  readonly sdk: '@nekro-nxt/extension-sdk@0.1.0'
  readonly builderProtocol: 'nekro-nxt-esbuild-v1'
  readonly allowedDependencies: readonly ['@nekro-nxt/extension-sdk']
}

export interface MaterializedExtensionRevision {
  readonly manifest: ExtensionManifestV1
  readonly sourceInput: ExtensionSourceInputV1
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
  findOpenDraft(agentId: AgentId, dshSessionId: string, dynamicPluginId: string): ExtensionDraftRecord | undefined
  createDraft(record: ExtensionDraftRecord): void
  getDraft(id: ExtensionDraftId): ExtensionDraftRecord | undefined
  appendDraftPackage(record: DraftPackageRecord): DraftPackageRecord
  getDraftPackage(id: DraftPackageId): DraftPackageRecord | undefined
  listDraftPackages(draftId: ExtensionDraftId): readonly DraftPackageRecord[]
  getExtension(id: ExtensionId): LocalExtensionRecord | undefined
  getExtensionBySlug(slug: string): LocalExtensionRecord | undefined
  getExtensionRevision(id: ExtensionRevisionId): ExtensionRevisionRecord | undefined
  listExtensionRevisions(storageState?: ExtensionRevisionRecord['storageState']): readonly ExtensionRevisionRecord[]
  nextExtensionRevisionNumber(extensionId: ExtensionId): number
  beginExtensionSave(input: {
    readonly extension: LocalExtensionRecord
    readonly revision: ExtensionRevisionRecord
    readonly operation: ExtensionSaveOperationRecord
  }): void
  completeExtensionSave(operationId: ExtensionSaveOperationId, completedAt: number): void
  failExtensionSave(operationId: ExtensionSaveOperationId, errorSummary: string, completedAt: number): void
  listRunningExtensionSaves(): readonly ExtensionSaveOperationRecord[]
  markExtensionRevisionStorageState(id: ExtensionRevisionId, state: 'saved' | 'damaged' | 'quarantined'): void
  markExtensionBuild(id: ExtensionRevisionId, status: 'succeeded' | 'failed'): void
  markExtensionValidation(id: ExtensionRevisionId, status: 'succeeded' | 'failed'): void
  createActivation(record: AgentActivationRecord): void
  getActivation(id: AgentActivationId): AgentActivationRecord | undefined
  listActiveActivations(agentId?: AgentId): readonly AgentActivationRecord[]
  getActiveActivation(agentId: AgentId, extensionId: ExtensionId): AgentActivationRecord | undefined
  markActivationWaiting(id: AgentActivationId): void
  commitActivationSwitch(id: AgentActivationId, replacedId: AgentActivationId | undefined, activatedAt: number): void
  failActivation(id: AgentActivationId, error: string): void
  disableActivation(id: AgentActivationId, disabledAt: number): void
}
