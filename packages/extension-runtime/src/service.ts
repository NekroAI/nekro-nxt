import type {
  AgentId,
  DraftPackageId,
  ExtensionDraftId,
  ExtensionId,
  ExtensionRevisionId,
  ExtensionSaveOperationId,
} from '@nekro-nxt/contracts'
import { monotonicFactory } from 'ulid'
import { z } from 'zod'
import { materializeDynamicPackage } from './materializer.js'
import type { ExtensionSourceStore } from './source-store.js'
import type {
  DraftPackageRecord,
  ExtensionDraftRecord,
  ExtensionRepository,
  ExtensionRevisionRecord,
  LocalExtensionRecord,
} from './types.js'

const captureSchema = z
  .object({
    dshSessionId: z.string().min(1),
    dynamicPluginId: z.string().min(1),
    dynamicPackageId: z.string().min(1),
    name: z.string().trim().min(1).max(80),
    purpose: z.string().trim().min(1).max(500),
    hostCode: z
      .string()
      .max(1024 * 1024)
      .optional(),
    clientCode: z
      .string()
      .max(1024 * 1024)
      .optional(),
  })
  .strict()
  .refine(({ hostCode, clientCode }) => hostCode !== undefined || clientCode !== undefined, {
    message: 'A dynamic Package needs a Host or Client source half.',
  })

const slugSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/)

export class ExtensionService {
  readonly #repository: ExtensionRepository
  readonly #sources: ExtensionSourceStore
  readonly #now: () => number
  readonly #nextUlid: () => string

  constructor(
    repository: ExtensionRepository,
    sources: ExtensionSourceStore,
    options: { readonly now?: () => number; readonly nextUlid?: () => string } = {},
  ) {
    this.#repository = repository
    this.#sources = sources
    this.#now = options.now ?? Date.now
    this.#nextUlid = options.nextUlid ?? monotonicFactory()
  }

  captureDynamicPackage(
    agentId: AgentId,
    input: z.input<typeof captureSchema>,
  ): {
    readonly draft: ExtensionDraftRecord
    readonly package: DraftPackageRecord
  } {
    const parsed = captureSchema.parse(input)
    let draft = this.#repository.findOpenDraft(agentId, parsed.dshSessionId, parsed.dynamicPluginId)
    const now = this.#timestamp()
    if (!draft) {
      draft = {
        id: this.#id<ExtensionDraftId>('xdr'),
        agentId,
        sourceDshSessionId: parsed.dshSessionId,
        sourceDynamicPluginId: parsed.dynamicPluginId,
        displayName: parsed.name,
        description: parsed.purpose,
        state: 'open',
        createdAt: now,
        updatedAt: now,
      }
      this.#repository.createDraft(draft)
    }
    const record: DraftPackageRecord = {
      id: this.#id<DraftPackageId>('xdp'),
      draftId: draft.id,
      sourceDynamicPackageId: parsed.dynamicPackageId,
      sequence: this.#repository.listDraftPackages(draft.id).length + 1,
      name: parsed.name,
      purpose: parsed.purpose,
      ...(parsed.hostCode === undefined ? {} : { hostCode: parsed.hostCode }),
      ...(parsed.clientCode === undefined ? {} : { clientCode: parsed.clientCode }),
      createdAt: now,
    }
    return { draft, package: this.#repository.appendDraftPackage(record) }
  }

  async saveDraftPackage(input: {
    readonly draftPackageId: DraftPackageId
    readonly slug: string
    readonly displayName: string
    readonly description: string
    readonly requestedCapabilities?: readonly string[]
    readonly extensionId?: ExtensionId
  }): Promise<{ readonly extension: LocalExtensionRecord; readonly revision: ExtensionRevisionRecord }> {
    const draftPackage = this.#repository.getDraftPackage(input.draftPackageId)
    if (!draftPackage) throw new Error(`Unknown DraftPackage: ${input.draftPackageId}`)
    const draft = this.#repository.getDraft(draftPackage.draftId)
    if (!draft || draft.state !== 'open') throw new Error('Draft is not open for saving.')
    const slug = slugSchema.parse(input.slug)
    const existing = input.extensionId ? this.#repository.getExtension(input.extensionId) : undefined
    if (input.extensionId && !existing) throw new Error(`Unknown Extension: ${input.extensionId}`)
    const slugOwner = this.#repository.getExtensionBySlug(slug)
    if (slugOwner && slugOwner.id !== existing?.id) throw new Error(`Extension slug already exists: ${slug}`)
    const now = this.#timestamp()
    const extensionId = existing?.id ?? this.#id<ExtensionId>('ext')
    const revisionId = this.#id<ExtensionRevisionId>('xrv')
    const materialized = materializeDynamicPackage({
      extensionId,
      revisionId,
      draftPackage,
      displayName: input.displayName,
      ...(input.requestedCapabilities === undefined ? {} : { requestedCapabilities: input.requestedCapabilities }),
    })
    const extension: LocalExtensionRecord = existing ?? {
      id: extensionId,
      slug,
      displayName: input.displayName.trim(),
      description: input.description.trim(),
      origin: 'local-created',
      createdByAgentId: draft.agentId,
      createdAt: now,
    }
    const revision: ExtensionRevisionRecord = {
      id: revisionId,
      extensionId,
      revisionNumber: this.#repository.nextExtensionRevisionNumber(extensionId),
      contentDigest: materialized.contentDigest,
      manifestSchemaVersion: 1,
      extensionApiVersion: '1',
      sourceKind: 'dynamic-package',
      sourceDynamicPackageRef: `${draft.sourceDshSessionId}/${draft.sourceDynamicPluginId}/${draftPackage.sourceDynamicPackageId}`,
      compatibleNekroNxtRange: '^0.1.0',
      compatibleDshRange: '^0.1.0-rc.6',
      storageState: 'saving',
      createdAt: now,
    }
    const operationId = this.#id<ExtensionSaveOperationId>('xop')
    const stagingRelativePath = this.#sources.stagingRelativePath(operationId)
    const finalRelativePath = this.#sources.revisionRelativePath(extensionId, revisionId)
    this.#repository.beginExtensionSave({
      extension,
      revision,
      operation: {
        id: operationId,
        draftPackageId: draftPackage.id,
        extensionId,
        revisionId,
        stagingRelativePath,
        finalRelativePath,
        state: 'running',
        createdAt: now,
      },
    })
    try {
      await this.#sources.commit(stagingRelativePath, finalRelativePath, materialized)
      this.#repository.completeExtensionSave(operationId, this.#timestamp())
      return {
        extension: this.#repository.getExtension(extensionId)!,
        revision: this.#repository.getExtensionRevision(revisionId)!,
      }
    } catch (error) {
      this.#repository.failExtensionSave(
        operationId,
        error instanceof Error ? error.message : String(error),
        this.#timestamp(),
      )
      throw error
    }
  }

  async recoverSaves(): Promise<{ readonly completed: number; readonly failed: number; readonly damaged: number }> {
    let completed = 0
    let failed = 0
    let damaged = 0
    for (const operation of this.#repository.listRunningExtensionSaves()) {
      if (await this.#sources.exists(operation.finalRelativePath)) {
        const revision = this.#repository.getExtensionRevision(operation.revisionId)
        const digest = await this.#sources.readContentDigest(operation.finalRelativePath).catch(() => undefined)
        if (revision && digest === revision.contentDigest) {
          this.#repository.completeExtensionSave(operation.id, this.#timestamp())
          completed += 1
        } else {
          this.#repository.failExtensionSave(
            operation.id,
            'Committed Revision source digest is invalid.',
            this.#timestamp(),
          )
          this.#repository.markExtensionRevisionStorageState(operation.revisionId, 'quarantined')
          failed += 1
        }
      } else {
        await this.#sources.discardStaging(operation.stagingRelativePath)
        this.#repository.failExtensionSave(
          operation.id,
          'Interrupted before Revision source commit.',
          this.#timestamp(),
        )
        failed += 1
      }
    }
    for (const revision of this.#repository.listExtensionRevisions('saved')) {
      const relativePath = this.#sources.revisionRelativePath(revision.extensionId, revision.id)
      if (!(await this.#sources.exists(relativePath))) {
        this.#repository.markExtensionRevisionStorageState(revision.id, 'damaged')
        damaged += 1
        continue
      }
      const digest = await this.#sources.readContentDigest(relativePath).catch(() => undefined)
      if (digest !== revision.contentDigest) {
        this.#repository.markExtensionRevisionStorageState(revision.id, 'quarantined')
        damaged += 1
      }
    }
    return { completed, failed, damaged }
  }

  revisionSourceDirectory(revision: ExtensionRevisionRecord): string {
    return this.#sources.absoluteRevisionPath(this.#sources.revisionRelativePath(revision.extensionId, revision.id))
  }

  #id<T extends string>(prefix: string): T {
    return `${prefix}_${this.#nextUlid()}` as T
  }

  #timestamp(): number {
    const value = this.#now()
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Clock must return a non-negative integer.')
    return value
  }
}
