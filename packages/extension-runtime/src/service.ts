import { readFileSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  assertRevisionMatchesTransfer,
  extensionManifestSchema,
  lineageAfter,
  lineageOfBranch,
  manifestAdapter,
  resourceContent,
  type ExtensionLineage,
  type ExtensionManifest,
  type LineageNode,
} from '@nekro-nxt/extension-format'
import {
  ExtensionIdSchema,
  ExtensionRevisionIdSchema,
  type AgentId,
  type AuthoringTaskId,
  type ExtensionId,
  type ExtensionRevisionId,
} from '@nekro-nxt/contracts'
import { monotonicFactory } from 'ulid'
import { z } from 'zod'
import { materializeDynamicPackage, materializeImportedRevision, rematerializeRevision } from './materializer.js'
import type { ExtensionBuilder } from './builder.js'
import type { ExtensionSourceStore } from './source-store.js'
import type {
  DynamicPackageSnapshot,
  ExtensionBuildArtifact,
  MaterializedExtensionRevision,
  ExtensionRepository,
  ExtensionRevisionVerification,
  LocalExtension,
  Revision,
  RevisionOrigin,
} from './types.js'

/** Code, resources and Manifest of a stored Revision, read back from its immutable directory. */
export interface StoredRevisionContent {
  readonly manifest: ExtensionManifest
  readonly sources: { readonly host?: string; readonly client?: string }
  readonly resources: Readonly<Record<string, string>>
}

export interface ImportedRevisionVerificationInput {
  readonly extension: LocalExtension
  readonly revision: Revision
  readonly materialized: MaterializedExtensionRevision
  readonly artifact: ExtensionBuildArtifact
  readonly dshVersion: string
}

export type ImportedRevisionVerifier = (
  input: ImportedRevisionVerificationInput,
) => Promise<
  Omit<ExtensionRevisionVerification, 'revisionId' | 'verifiedAt' | 'hostBuild' | 'clientBuild' | 'dshVersion'>
>

const slugSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/)

const textSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500),
})

export class ExtensionService {
  #closing = false
  readonly #manifests = new Map<Revision['id'], { readonly digest: string; readonly manifest: ExtensionManifest }>()
  readonly #repository: ExtensionRepository
  readonly #sources: ExtensionSourceStore
  readonly #now: () => number
  readonly #nextUlid: () => string
  readonly #builder: ExtensionBuilder | undefined
  readonly #importVerifier: ImportedRevisionVerifier | undefined

  constructor(
    repository: ExtensionRepository,
    sources: ExtensionSourceStore,
    options: {
      readonly now?: () => number
      readonly nextUlid?: () => string
      readonly builder?: ExtensionBuilder
      readonly importVerifier?: ImportedRevisionVerifier
    } = {},
  ) {
    this.#repository = repository
    this.#sources = sources
    this.#now = options.now ?? Date.now
    this.#nextUlid = options.nextUlid ?? monotonicFactory()
    this.#builder = options.builder
    this.#importVerifier = options.importVerifier
  }

  async saveDynamicPackage(input: {
    readonly snapshot: DynamicPackageSnapshot
    readonly slug: string
    readonly displayName: string
    readonly description: string
    readonly extensionId?: ExtensionId
    /**
     * Revision the new one is made from when it joins an existing extension; defaults to the newest Revision of that
     * extension. Ignored for a new extension.
     */
    readonly parentRevisionId?: ExtensionRevisionId
    readonly createdByAgentId?: AgentId
    readonly authoringTaskId?: AuthoringTaskId
    readonly verification?: Omit<
      ExtensionRevisionVerification,
      'revisionId' | 'verifiedAt' | 'hostBuild' | 'clientBuild'
    >
  }): Promise<{ readonly extension: LocalExtension; readonly revision: Revision }> {
    if (this.#closing) throw new Error('扩展服务正在关闭。')
    const slug = slugSchema.parse(input.slug)
    const metadata = textSchema.parse({ displayName: input.displayName, description: input.description })
    const existing = input.extensionId ? this.#repository.getExtension(input.extensionId) : undefined
    if (input.extensionId && !existing) throw new Error(`Unknown Extension: ${input.extensionId}`)
    if (existing && existing.slug !== slug)
      throw new Error('An existing Extension slug cannot be changed by a Revision.')
    const slugOwner = this.#repository.getExtensionBySlug(slug)
    if (slugOwner && slugOwner.id !== existing?.id) throw new Error(`Extension slug already exists: ${slug}`)

    const now = this.#timestamp()
    const extensionId = existing?.id ?? ExtensionIdSchema.parse(`ext_${this.#nextUlid()}`)
    const revisionId = ExtensionRevisionIdSchema.parse(`xrv_${this.#nextUlid()}`)
    const lineage: ExtensionLineage = existing
      ? lineageAfter(this.#lineageNode(this.#parentFor(existing.id, input.parentRevisionId)))
      : { parent: null, ancestry: [] }
    const materialized = materializeDynamicPackage({
      extensionId,
      revisionId,
      snapshot: input.snapshot,
      lineage,
    })
    if (existing) this.#assertAdapterKeyKept(existing.id, materialized.manifest)
    const duplicate = this.#repository.getExtensionRevisionByPayloadDigest(extensionId, materialized.payloadDigest)
    if (duplicate) return { extension: existing ?? this.#requireExtension(extensionId), revision: duplicate }
    const extension: LocalExtension = {
      ...(existing ?? {
        id: extensionId,
        slug,
        displayName: metadata.displayName,
        description: metadata.description,
        ...(input.createdByAgentId === undefined ? {} : { createdByAgentId: input.createdByAgentId }),
        createdAt: now,
      }),
      provides: materialized.provides,
    }
    const revision: Revision = {
      ...this.#revisionFields(materialized.manifest),
      id: revisionId,
      extensionId,
      revisionNumber: this.#repository.nextExtensionRevisionNumber(extensionId),
      contentDigest: materialized.contentDigest,
      payloadDigest: materialized.payloadDigest,
      origin: 'authored',
      ...(input.authoringTaskId === undefined ? {} : { authoringTaskId: input.authoringTaskId }),
      createdAt: now,
    }

    // Filesystem and SQLite cannot share a transaction. Publish the immutable source first so the
    // repository can never expose a Revision whose source directory is only partially written.
    await this.#sources.publish(extensionId, revisionId, materialized)
    const artifact =
      this.#builder === undefined
        ? undefined
        : await this.#builder.build({
            extensionId,
            revisionId,
            contentDigest: revision.contentDigest,
            sourceDirectory: this.#sources.revisionSourceDirectory(extensionId, revisionId),
          })
    if (input.verification && artifact === undefined) {
      throw new Error('Extension verification requires a configured Builder.')
    }
    // A Revision that claims verification must have run as saved: the dynamic run verified the preview wrapping, not
    // this materialized artifact. Use the import verifier before the Revision becomes visible; a failure leaves only
    // an unreferenced source directory, which the publish order already tolerates.
    if (input.verification && artifact !== undefined && this.#importVerifier) {
      await this.#importVerifier({
        extension,
        revision,
        materialized,
        artifact,
        dshVersion: input.verification?.dshVersion ?? 'unknown',
      })
    }
    const verification =
      input.verification === undefined || artifact === undefined
        ? undefined
        : {
            ...input.verification,
            revisionId,
            verifiedAt: now,
            hostBuild: { built: artifact.hostEntry !== undefined, buildKey: artifact.buildKey },
            clientBuild: { built: artifact.clientEntry !== undefined, buildKey: artifact.buildKey },
          }
    this.#repository.saveExtensionRevision({
      extension,
      revision,
      ...(verification === undefined ? {} : { verification }),
    })
    return { extension, revision }
  }

  async importRevision(input: {
    readonly extension: {
      readonly id: ExtensionId
      readonly slug: string
      readonly displayName: string
      readonly description: string
    }
    readonly revision: {
      readonly id: ReturnType<typeof ExtensionRevisionIdSchema.parse>
      readonly contentDigest: string
      readonly payloadDigest: string
    }
    readonly manifest: unknown
    readonly sources: { readonly host?: string; readonly client?: string }
    readonly resources?: Readonly<Record<string, string>>
    readonly localSlug?: string
    readonly dshVersion?: string
    /** `community` for a community install; a file import otherwise. */
    readonly origin?: Extract<RevisionOrigin, 'file' | 'community'>
  }): Promise<{ readonly extension: LocalExtension; readonly revision: Revision; readonly idempotent: boolean }> {
    if (this.#closing) throw new Error('扩展服务正在关闭。')
    const slug = slugSchema.parse(input.localSlug ?? input.extension.slug)
    const metadata = textSchema.parse(input.extension)
    const materialized = materializeImportedRevision({
      manifest: input.manifest,
      sources: input.sources,
      ...(input.resources === undefined ? {} : { resources: input.resources }),
    })
    assertRevisionMatchesTransfer({ extension: input.extension, revision: input.revision }, materialized)
    const existingRevision = this.#repository.getExtensionRevision(input.revision.id)
    if (existingRevision) {
      if (
        existingRevision.extensionId !== input.extension.id ||
        existingRevision.contentDigest !== materialized.contentDigest ||
        existingRevision.payloadDigest !== materialized.payloadDigest
      ) {
        throw new Error('相同 Extension/Revision 身份已存在，但内容不同；不会覆盖本地版本。')
      }
      // Importing the newest Revision again still refreshes the name and description it carries.
      const newest = this.#repository.nextExtensionRevisionNumber(input.extension.id) - 1
      if (existingRevision.revisionNumber === newest) {
        this.#repository.updateExtensionDetails(input.extension.id, {
          displayName: metadata.displayName,
          description: metadata.description,
        })
      }
      return {
        extension: this.#requireExtension(input.extension.id),
        revision: existingRevision,
        idempotent: true,
      }
    }
    const existingExtension = this.#repository.getExtension(input.extension.id)
    if (existingExtension && existingExtension.slug !== slug) throw new Error('同一 Extension 身份不能改变本地 slug。')
    if (existingExtension) this.#assertAdapterKeyKept(existingExtension.id, materialized.manifest)
    const slugOwner = this.#repository.getExtensionBySlug(slug)
    if (slugOwner && slugOwner.id !== input.extension.id) throw new Error(`Extension slug already exists: ${slug}`)
    const now = this.#timestamp()
    const branchOf = materialized.manifest.lineage?.branchOf
    const extension: LocalExtension = {
      ...(existingExtension ?? {
        id: input.extension.id,
        slug,
        createdAt: now,
        ...(branchOf === undefined ? {} : { branchOf }),
      }),
      displayName: metadata.displayName,
      description: metadata.description,
      provides: materialized.provides,
    }
    // A package written before lineage existed is treated as the next version of what this machine already has.
    const newest = existingExtension ? this.#repository.listExtensionRevisions(existingExtension.id).at(-1) : undefined
    const inferred =
      materialized.manifest.lineage === undefined && newest !== undefined
        ? lineageAfter(this.#lineageNode(newest))
        : undefined
    const revision: Revision = {
      ...this.#revisionFields(materialized.manifest, inferred),
      id: input.revision.id,
      extensionId: extension.id,
      revisionNumber: this.#repository.nextExtensionRevisionNumber(extension.id),
      contentDigest: materialized.contentDigest,
      payloadDigest: materialized.payloadDigest,
      origin: input.origin ?? 'file',
      createdAt: now,
    }
    await this.#sources.publish(extension.id, revision.id, materialized)
    if (!this.#builder) throw new Error('导入扩展需要配置本机构建器。')
    const artifact = await this.#builder.build({
      extensionId: extension.id,
      revisionId: revision.id,
      contentDigest: revision.contentDigest,
      sourceDirectory: this.#sources.revisionSourceDirectory(extension.id, revision.id),
    })
    if (!this.#importVerifier) throw new Error('导入扩展需要配置本机 Runtime 验证器。')
    const verified = await this.#importVerifier({
      extension,
      revision,
      materialized,
      artifact,
      dshVersion: input.dshVersion ?? 'unknown',
    })
    const verification: ExtensionRevisionVerification = {
      ...verified,
      revisionId: revision.id,
      dshVersion: input.dshVersion ?? 'unknown',
      verifiedAt: now,
      hostBuild: { built: artifact.hostEntry !== undefined, buildKey: artifact.buildKey },
      clientBuild: { built: artifact.clientEntry !== undefined, buildKey: artifact.buildKey },
    }
    this.#repository.saveExtensionRevision({
      extension,
      revision,
      verification,
    })
    // Saving keeps an existing extension's stored details; the imported package names the extension it updates.
    if (existingExtension) {
      this.#repository.updateExtensionDetails(extension.id, {
        displayName: extension.displayName,
        description: extension.description,
      })
    }
    return { extension, revision, idempotent: false }
  }

  /** Current-format Manifest of an immutable Revision; `undefined` when the source is missing or not V7. */
  revisionManifest(revision: Revision): ExtensionManifest | undefined {
    const cached = this.#manifests.get(revision.id)
    if (cached?.digest === revision.contentDigest) return cached.manifest
    try {
      const value: unknown = JSON.parse(
        readFileSync(path.join(this.revisionSourceDirectory(revision), 'manifest.json'), 'utf8'),
      )
      const parsed = extensionManifestSchema.safeParse(value)
      if (!parsed.success) return undefined
      this.#manifests.set(revision.id, { digest: revision.contentDigest, manifest: parsed.data })
      return parsed.data
    } catch {
      return undefined
    }
  }

  revisionFormat(revision: Revision): 'current' | 'unavailable' {
    return this.revisionManifest(revision) === undefined ? 'unavailable' : 'current'
  }

  /**
   * Saves a copy of `source` as the first Revision of a new extension that records where it was branched from. The
   * branch runs the same import verification as any other new Revision, under its own identity.
   */
  async createBranch(input: {
    readonly source: Revision
    readonly slug: string
    readonly displayName: string
    readonly description: string
    readonly createdByAgentId?: AgentId
    readonly dshVersion?: string
  }): Promise<{ readonly extension: LocalExtension; readonly revision: Revision }> {
    if (this.#closing) throw new Error('扩展服务正在关闭。')
    const slug = slugSchema.parse(input.slug)
    const metadata = textSchema.parse({ displayName: input.displayName, description: input.description })
    if (this.#repository.getExtensionBySlug(slug)) throw new Error(`Extension slug already exists: ${slug}`)
    const content = await this.readRevisionContent(input.source)
    const now = this.#timestamp()
    const extensionId = ExtensionIdSchema.parse(`ext_${this.#nextUlid()}`)
    const revisionId = ExtensionRevisionIdSchema.parse(`xrv_${this.#nextUlid()}`)
    const materialized = rematerializeRevision({
      content,
      extensionId,
      revisionId,
      lineage: lineageOfBranch({ extensionId: input.source.extensionId, revisionId: input.source.id }),
    })
    const extension: LocalExtension = {
      id: extensionId,
      slug,
      displayName: metadata.displayName,
      description: metadata.description,
      provides: materialized.provides,
      ...(input.createdByAgentId === undefined ? {} : { createdByAgentId: input.createdByAgentId }),
      branchOf: { extensionId: input.source.extensionId, revisionId: input.source.id },
      createdAt: now,
    }
    const revision: Revision = {
      ...this.#revisionFields(materialized.manifest),
      id: revisionId,
      extensionId,
      revisionNumber: 1,
      contentDigest: materialized.contentDigest,
      payloadDigest: materialized.payloadDigest,
      origin: 'branch',
      createdAt: now,
    }
    await this.#sources.publish(extensionId, revisionId, materialized)
    if (!this.#builder) throw new Error('创建分支需要配置本机构建器。')
    const artifact = await this.#builder.build({
      extensionId,
      revisionId,
      contentDigest: revision.contentDigest,
      sourceDirectory: this.#sources.revisionSourceDirectory(extensionId, revisionId),
    })
    if (!this.#importVerifier) throw new Error('创建分支需要配置本机 Runtime 验证器。')
    const verified = await this.#importVerifier({
      extension,
      revision,
      materialized,
      artifact,
      dshVersion: input.dshVersion ?? 'unknown',
    })
    this.#repository.saveExtensionRevision({
      extension,
      revision,
      verification: {
        ...verified,
        revisionId,
        dshVersion: input.dshVersion ?? 'unknown',
        verifiedAt: now,
        hostBuild: { built: artifact.hostEntry !== undefined, buildKey: artifact.buildKey },
        clientBuild: { built: artifact.clientEntry !== undefined, buildKey: artifact.buildKey },
      },
    })
    return { extension, revision }
  }

  /** Manifest, normalized sources and resources of a stored Revision. */
  async readRevisionContent(revision: Revision): Promise<StoredRevisionContent> {
    const directory = this.revisionSourceDirectory(revision)
    const manifest = extensionManifestSchema.parse(JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')))
    const readOptional = async (file: string): Promise<string | undefined> => {
      try {
        return await readFile(path.join(directory, 'source', file), 'utf8')
      } catch {
        return undefined
      }
    }
    const [host, client] = await Promise.all([readOptional('host.ts'), readOptional('client.ts')])
    const resources: Record<string, string> = {}
    const walk = async (relative: string): Promise<void> => {
      let entries
      try {
        entries = await readdir(path.join(directory, relative), { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const child = path.posix.join(relative, entry.name)
        if (entry.isDirectory()) await walk(child)
        else resources[child] = resourceContent(child, await readFile(path.join(directory, child)))
      }
    }
    await walk('assets')
    return {
      manifest,
      sources: { ...(host === undefined ? {} : { host }), ...(client === undefined ? {} : { client }) },
      resources,
    }
  }

  /** Lineage of a stored Revision: its Manifest's when it carries one, the database record otherwise. */
  lineageNode(revision: Revision): LineageNode {
    return this.#lineageNode(revision)
  }

  #lineageNode(revision: Revision): LineageNode {
    const manifest = this.revisionManifest(revision)
    if (manifest?.lineage !== undefined) return { revisionId: revision.id, lineage: manifest.lineage }
    const extension = this.#repository.getExtension(revision.extensionId)
    return {
      revisionId: revision.id,
      lineage: {
        parent: revision.parentRevisionId ?? null,
        ancestry: [...revision.ancestry],
        ...(extension?.branchOf === undefined ? {} : { branchOf: extension.branchOf }),
      },
    }
  }

  #parentFor(extensionId: ExtensionId, parentRevisionId: ExtensionRevisionId | undefined): Revision {
    if (parentRevisionId !== undefined) {
      const parent = this.#repository.getExtensionRevision(parentRevisionId)
      if (parent?.extensionId !== extensionId) throw new Error('基线版本不属于这个扩展。')
      return parent
    }
    const newest = this.#repository.listExtensionRevisions(extensionId).at(-1)
    if (newest === undefined) throw new Error(`Extension has no Revision: ${extensionId}`)
    return newest
  }

  /** Lineage and data version columns of a Revision, from its Manifest or an inferred lineage. */
  #revisionFields(
    manifest: ExtensionManifest,
    inferred?: ExtensionLineage,
  ): Pick<Revision, 'ancestry' | 'dataVersion'> & { parentRevisionId?: ExtensionRevisionId } {
    const lineage = manifest.lineage ?? inferred
    return {
      ...(lineage?.parent ? { parentRevisionId: lineage.parent } : {}),
      ancestry: lineage?.ancestry ?? [],
      dataVersion: manifest.dataVersion ?? 1,
    }
  }

  dispose(): Promise<void> {
    this.#closing = true
    this.#manifests.clear()
    return Promise.resolve()
  }

  /** An Extension keeps its adapter key across Revisions; connections and channels are keyed by it. */
  #assertAdapterKeyKept(extensionId: ExtensionId, next: ExtensionManifest): void {
    const nextKey = manifestAdapter(next)?.key
    for (const revision of this.#repository.listExtensionRevisions(extensionId)) {
      const manifest = this.revisionManifest(revision)
      if (manifest === undefined) continue
      const previousKey = manifestAdapter(manifest)?.key
      if (previousKey !== undefined && previousKey !== nextKey) {
        throw new Error('同一个扩展的适配器 key 不能在版本之间改变。')
      }
    }
  }

  #requireExtension(extensionId: ExtensionId): LocalExtension {
    const extension = this.#repository.getExtension(extensionId)
    if (!extension) throw new Error(`Unknown Extension: ${extensionId}`)
    return extension
  }

  revisionSourceDirectory(revision: Revision): string {
    return this.#sources.revisionSourceDirectory(revision.extensionId, revision.id)
  }

  currentBuildKey(revision: Revision): string {
    if (!this.#builder) throw new Error('Extension Builder is unavailable.')
    return this.#builder.buildKey(revision.contentDigest)
  }

  async buildRevision(revision: Revision): Promise<ExtensionBuildArtifact> {
    if (!this.#builder) throw new Error('Extension Builder is unavailable.')
    return this.#builder.build({
      extensionId: revision.extensionId,
      revisionId: revision.id,
      contentDigest: revision.contentDigest,
      sourceDirectory: this.revisionSourceDirectory(revision),
    })
  }

  stageExtensionDeletion(extensionId: ExtensionId): Promise<string> {
    if (!this.#repository.getExtension(extensionId))
      return Promise.reject(new Error(`Unknown Extension: ${extensionId}`))
    return this.#sources.stageExtensionDeletion(extensionId)
  }

  restoreStagedExtension(extensionId: ExtensionId, trash: string): Promise<void> {
    return this.#sources.restoreStagedExtension(extensionId, trash)
  }

  async deleteRevisionCaches(revisions: readonly Revision[]): Promise<void> {
    if (!this.#builder) return
    await this.#builder.deleteRevisionCaches(revisions.map((revision) => revision.id))
  }

  #timestamp(): number {
    const value = this.#now()
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Clock must return a non-negative integer.')
    return value
  }
}
