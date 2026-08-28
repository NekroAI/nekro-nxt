import { ExtensionIdSchema, ExtensionRevisionIdSchema, type AgentId, type ExtensionId } from '@nekro-nxt/contracts'
import { monotonicFactory } from 'ulid'
import { z } from 'zod'
import { materializeDynamicPackage, materializeImportedRevision } from './materializer.js'
import type { ExtensionBuilder } from './builder.js'
import type { ExtensionSourceStore } from './source-store.js'
import type {
  DynamicPackageSnapshot,
  ExtensionBuildArtifact,
  ExtensionRepository,
  ExtensionRevisionVerification,
  LocalExtension,
  Revision,
} from './types.js'

const slugSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/)

const textSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500),
})

export class ExtensionService {
  readonly #repository: ExtensionRepository
  readonly #sources: ExtensionSourceStore
  readonly #now: () => number
  readonly #nextUlid: () => string
  readonly #builder: ExtensionBuilder | undefined

  constructor(
    repository: ExtensionRepository,
    sources: ExtensionSourceStore,
    options: {
      readonly now?: () => number
      readonly nextUlid?: () => string
      readonly builder?: ExtensionBuilder
    } = {},
  ) {
    this.#repository = repository
    this.#sources = sources
    this.#now = options.now ?? Date.now
    this.#nextUlid = options.nextUlid ?? monotonicFactory()
    this.#builder = options.builder
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
      readonly scope: 'agent' | 'host-adapter'
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
    readonly localSlug?: string
  }): Promise<{ readonly extension: LocalExtension; readonly revision: Revision; readonly idempotent: boolean }> {
    const slug = slugSchema.parse(input.localSlug ?? input.extension.slug)
    const metadata = textSchema.parse(input.extension)
    const materialized = materializeImportedRevision({ manifest: input.manifest, sources: input.sources })
    if (
      materialized.manifest.extensionId !== input.extension.id ||
      materialized.manifest.revisionId !== input.revision.id
    ) {
      throw new Error('导入扩展的 Manifest 身份与传输清单不一致。')
    }
    if (materialized.scope !== input.extension.scope) throw new Error('导入扩展的 scope 与 Manifest 不一致。')
    if (
      materialized.contentDigest !== input.revision.contentDigest ||
      materialized.payloadDigest !== input.revision.payloadDigest
    ) {
      throw new Error('导入扩展的内容摘要不一致。')
    }
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
    await this.#builder.build({
      extensionId: extension.id,
      revisionId: revision.id,
      contentDigest: revision.contentDigest,
      sourceDirectory: this.#sources.revisionSourceDirectory(extension.id, revision.id),
    })
    this.#repository.saveExtensionRevision({ extension, revision })
    return { extension, revision, idempotent: false }
  }

  #requireExtension(extensionId: ExtensionId): LocalExtension {
    const extension = this.#repository.getExtension(extensionId)
    if (!extension) throw new Error(`Unknown Extension: ${extensionId}`)
    return extension
  }

  revisionSourceDirectory(revision: Revision): string {
    return this.#sources.revisionSourceDirectory(revision.extensionId, revision.id)
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
