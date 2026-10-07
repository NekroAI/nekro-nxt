import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  assertRevisionMatchesTransfer,
  extensionManifestSchema,
  type ExtensionManifest,
} from '@nekro-nxt/extension-format'
import { ExtensionIdSchema, ExtensionRevisionIdSchema, type AgentId, type ExtensionId } from '@nekro-nxt/contracts'
import { monotonicFactory } from 'ulid'
import { z } from 'zod'
import { materializeDynamicPackage, materializeImportedRevision } from './materializer.js'
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
} from './types.js'

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
    readonly createdByAgentId?: AgentId
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
    const materialized = materializeDynamicPackage({
      extensionId,
      revisionId,
      snapshot: input.snapshot,
    })
    if (existing && existing.scope !== materialized.scope) {
      throw new Error('An existing Extension cannot change scope across Revisions.')
    }
    if (existing?.scope === 'host-adapter') {
      const previousKey = this.#repository
        .listExtensionRevisions(existing.id)
        .map((revision) => this.#repository.getExtensionRevisionVerification(revision.id)?.adapter?.key)
        .find((key) => key !== undefined)
      const nextKey = input.verification?.adapter?.key
      if (previousKey !== undefined && nextKey !== previousKey) {
        throw new Error('A Host Adapter Extension cannot change adapter key across Revisions.')
      }
    }
    const duplicate = this.#repository.getExtensionRevisionByPayloadDigest(extensionId, materialized.payloadDigest)
    if (duplicate) return { extension: existing ?? this.#requireExtension(extensionId), revision: duplicate }
    const extension: LocalExtension = existing ?? {
      id: extensionId,
      scope: materialized.scope,
      slug,
      displayName: metadata.displayName,
      description: metadata.description,
      ...(input.createdByAgentId === undefined ? {} : { createdByAgentId: input.createdByAgentId }),
      createdAt: now,
    }
    const revision: Revision = {
      id: revisionId,
      extensionId,
      revisionNumber: this.#repository.nextExtensionRevisionNumber(extensionId),
      contentDigest: materialized.contentDigest,
      payloadDigest: materialized.payloadDigest,
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
      readonly scope: 'agent' | 'host-adapter' | 'host-ui'
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
      return {
        extension: this.#requireExtension(input.extension.id),
        revision: existingRevision,
        idempotent: true,
      }
    }
    const existingExtension = this.#repository.getExtension(input.extension.id)
    if (existingExtension && (existingExtension.scope !== input.extension.scope || existingExtension.slug !== slug)) {
      throw new Error('同一 Extension 身份不能改变 scope 或本地 slug。')
    }
    const slugOwner = this.#repository.getExtensionBySlug(slug)
    if (slugOwner && slugOwner.id !== input.extension.id) throw new Error(`Extension slug already exists: ${slug}`)
    const now = this.#timestamp()
    const extension: LocalExtension = existingExtension ?? {
      id: input.extension.id,
      scope: input.extension.scope,
      slug,
      displayName: metadata.displayName,
      description: metadata.description,
      createdAt: now,
    }
    const revision: Revision = {
      id: input.revision.id,
      extensionId: extension.id,
      revisionNumber: this.#repository.nextExtensionRevisionNumber(extension.id),
      contentDigest: materialized.contentDigest,
      payloadDigest: materialized.payloadDigest,
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
    return { extension, revision, idempotent: false }
  }

  /** Current-format Manifest of an immutable Revision; `undefined` when the source is missing or not V6. */
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

  dispose(): Promise<void> {
    this.#closing = true
    this.#manifests.clear()
    return Promise.resolve()
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
