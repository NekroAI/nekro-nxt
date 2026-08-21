import { ExtensionIdSchema, ExtensionRevisionIdSchema, type AgentId, type ExtensionId } from '@nekro-nxt/contracts'
import { monotonicFactory } from 'ulid'
import { z } from 'zod'
import { materializeDynamicPackage } from './materializer.js'
import type { ExtensionBuilder } from './builder.js'
import type { ExtensionSourceStore } from './source-store.js'
import type {
  DynamicPackageSnapshot,
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
    const extension: LocalExtension = existing ?? {
      id: extensionId,
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

  revisionSourceDirectory(revision: Revision): string {
    return this.#sources.revisionSourceDirectory(revision.extensionId, revision.id)
  }

  #timestamp(): number {
    const value = this.#now()
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Clock must return a non-negative integer.')
    return value
  }
}
