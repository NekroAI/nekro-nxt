import {
  AgentIdSchema,
  ExtensionIdSchema,
  ExtensionRevisionIdSchema,
  type AgentId,
  type ExtensionId,
  type ExtensionRevisionId,
  type JsonValue,
} from '@nekro-nxt/contracts'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  ExtensionActivationCoordinator,
  ExtensionBuilder,
  ExtensionService,
  ExtensionSourceStore,
  materializeDynamicPackage,
  type Activation,
  type ExtensionActivationHost,
  type ExtensionBuildArtifact,
  type ExtensionClientDiagnostic,
  type ExtensionRepository,
  type ExtensionRevisionVerification,
  type LocalExtension,
  type MountedExtension,
  type Revision,
} from '../src/index.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const agentId = (value: string): AgentId => AgentIdSchema.parse(`agt_${value}`)
const extensionId = (value: string): ExtensionId => ExtensionIdSchema.parse(`ext_${value}`)
const revisionId = (value: string): ExtensionRevisionId => ExtensionRevisionIdSchema.parse(`xrv_${value}`)

const manifestRevisionSchema = z
  .object({
    schemaVersion: z.literal(2),
    extensionId: ExtensionIdSchema,
    revisionId: ExtensionRevisionIdSchema,
    entrypoints: z
      .object({ host: z.literal('source/host.ts'), client: z.literal('source/client.ts') })
      .strict()
      .or(z.object({ host: z.literal('source/host.ts') }).strict())
      .or(z.object({ client: z.literal('source/client.ts') }).strict()),
    contributions: z.array(z.unknown()),
  })
  .strict()
const buildCacheSchema = z
  .object({
    revisionId: ExtensionRevisionIdSchema,
    buildKey: z.string().regex(/^[a-f0-9]{64}$/),
    hostEntry: z.literal('host.mjs').optional(),
    clientEntry: z.literal('client.mjs').optional(),
  })
  .strict()

class MemoryExtensionRepository implements ExtensionRepository {
  readonly extensions = new Map<ExtensionId, LocalExtension>()
  readonly revisions = new Map<ExtensionRevisionId, Revision>()
  readonly verifications = new Map<ExtensionRevisionId, ExtensionRevisionVerification>()
  readonly activations = new Map<string, Activation>()
  readonly clientDiagnostics = new Map<string, ExtensionClientDiagnostic>()
  beforeSave?: (input: { readonly extension: LocalExtension; readonly revision: Revision }) => void
  failActivationUpsert = false
  failActivationDelete = false

  getExtension(id: ExtensionId): LocalExtension | undefined {
    return this.extensions.get(id)
  }

  listExtensions(): readonly LocalExtension[] {
    return [...this.extensions.values()]
  }

  getExtensionBySlug(slug: string): LocalExtension | undefined {
    return [...this.extensions.values()].find((extension) => extension.slug === slug)
  }

  getExtensionRevision(id: ExtensionRevisionId): Revision | undefined {
    return this.revisions.get(id)
  }

  listExtensionRevisions(id?: ExtensionId): readonly Revision[] {
    return [...this.revisions.values()].filter((revision) => id === undefined || revision.extensionId === id)
  }

  nextExtensionRevisionNumber(id: ExtensionId): number {
    return (
      Math.max(
        0,
        ...[...this.revisions.values()].filter((revision) => revision.extensionId === id).map((r) => r.revisionNumber),
      ) + 1
    )
  }

  saveExtensionRevision(input: {
    readonly extension: LocalExtension
    readonly revision: Revision
    readonly verification?: ExtensionRevisionVerification
  }): void {
    this.beforeSave?.(input)
    if (this.revisions.has(input.revision.id)) throw new Error('Revision already exists.')
    this.extensions.set(input.extension.id, input.extension)
    this.revisions.set(input.revision.id, input.revision)
    if (input.verification) this.verifications.set(input.revision.id, input.verification)
  }

  getExtensionRevisionVerification(id: ExtensionRevisionId): ExtensionRevisionVerification | undefined {
    return this.verifications.get(id)
  }

  getExtensionClientDiagnostic(agent: AgentId, extension: ExtensionId): ExtensionClientDiagnostic | undefined {
    return this.clientDiagnostics.get(this.#key(agent, extension))
  }

  upsertExtensionClientDiagnostic(diagnostic: ExtensionClientDiagnostic): void {
    this.clientDiagnostics.set(this.#key(diagnostic.agentId, diagnostic.extensionId), diagnostic)
  }

  getActivation(agent: AgentId, extension: ExtensionId): Activation | undefined {
    return this.activations.get(this.#key(agent, extension))
  }

  listActivations(agent?: AgentId): readonly Activation[] {
    return [...this.activations.values()].filter((activation) => agent === undefined || activation.agentId === agent)
  }

  upsertActivation(activation: Activation): void {
    if (this.failActivationUpsert) throw new Error('Activation transaction failed.')
    this.activations.set(this.#key(activation.agentId, activation.extensionId), activation)
  }

  deleteActivation(agent: AgentId, extension: ExtensionId): void {
    if (this.failActivationDelete) throw new Error('Activation delete failed.')
    if (!this.activations.delete(this.#key(agent, extension))) throw new Error('Activation does not exist.')
    this.clientDiagnostics.delete(this.#key(agent, extension))
  }

  #key(agent: AgentId, extension: ExtensionId): string {
    return `${agent}\0${extension}`
  }
}

class FakeActivationHost implements ExtensionActivationHost {
  readonly mounted = new Map<string, ExtensionRevisionId>()
  readonly mountCalls: ExtensionRevisionId[] = []
  readonly disposedRevisions: ExtensionRevisionId[] = []
  readonly safeAgents: AgentId[] = []
  failRevisionId?: ExtensionRevisionId
  readonly failRevisionIds = new Set<ExtensionRevisionId>()
  failDisposeRevisionId?: ExtensionRevisionId
  safeGate?: Promise<void>

  waitUntilSafe(agent: AgentId): Promise<void> {
    this.safeAgents.push(agent)
    return this.safeGate ?? Promise.resolve()
  }

  mount(
    agent: AgentId,
    revision: Revision,
    artifact: ExtensionBuildArtifact,
    config: JsonValue,
  ): Promise<MountedExtension> {
    void artifact
    void config
    this.mountCalls.push(revision.id)
    if (revision.id === this.failRevisionId || this.failRevisionIds.has(revision.id)) throw new Error('Mount failed.')
    const key = `${agent}\0${revision.extensionId}`
    this.mounted.set(key, revision.id)
    return Promise.resolve({
      evidence: { hostLoaded: true, clientBuilt: false, details: [] },
      dispose: () => {
        this.disposedRevisions.push(revision.id)
        if (this.failDisposeRevisionId === revision.id) return Promise.reject(new Error('Dispose failed.'))
        if (this.mounted.get(key) === revision.id) this.mounted.delete(key)
        return Promise.resolve()
      },
    })
  }
}

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolver) => {
    resolve = resolver
  })
  return { promise, resolve }
}

const localExtension = (id: ExtensionId): LocalExtension => ({
  id,
  slug: 'test-extension',
  displayName: '测试扩展',
  description: '测试启停。',
  createdAt: 1,
})

const revision = (id: ExtensionRevisionId, extension: ExtensionId, number: number): Revision => ({
  id,
  extensionId: extension,
  revisionNumber: number,
  contentDigest: `digest-${number}`,
  createdAt: number,
})

const activationCoordinator = (
  repository: MemoryExtensionRepository,
  host: FakeActivationHost,
  now: () => number = () => 100,
): ExtensionActivationCoordinator =>
  new ExtensionActivationCoordinator(
    repository,
    { revisionSourceDirectory: (item) => `/source/${item.id}` },
    {
      build: ({ revisionId: id, contentDigest }) =>
        Promise.resolve({
          revisionId: id,
          buildKey: contentDigest,
          directory: `/cache/${id}`,
        }),
    },
    host,
    { now },
  )

const materialize = (hostCode: string) =>
  materializeDynamicPackage({
    extensionId: extensionId('test'),
    revisionId: revisionId('test'),
    snapshot: {
      name: '构建探针',
      purpose: '验证受控构建。',
      hostCode,
    },
  })

describe('Extension save', () => {
  it('publishes a complete source directory before atomically saving LocalExtension and Revision', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-extension-save-'))
    temporaryDirectories.push(directory)
    const repository = new MemoryExtensionRepository()
    const sources = new ExtensionSourceStore(path.join(directory, 'data'))
    repository.beforeSave = ({ extension, revision }) => {
      const sourceDirectory = sources.revisionSourceDirectory(extension.id, revision.id)
      expect(existsSync(sourceDirectory)).toBe(true)
      expect(existsSync(path.join(sourceDirectory, 'manifest.json'))).toBe(true)
      expect(existsSync(path.join(sourceDirectory, 'content.sha256'))).toBe(true)
      expect(existsSync(path.join(sourceDirectory, 'source', 'host.ts'))).toBe(true)
      expect(existsSync(path.join(sourceDirectory, 'source-input.json'))).toBe(false)
    }
    const ids = ['extension', 'revision'].values()
    const service = new ExtensionService(repository, sources, {
      now: () => 10,
      nextUlid: () => ids.next().value ?? 'unexpected-extra-id',
    })

    const saved = await service.saveDynamicPackage({
      snapshot: { name: '问候', purpose: '问候工具', hostCode: 'return { apply() {} }' },
      slug: 'greeting-extension',
      displayName: '问候扩展',
      description: '提供问候。',
      createdByAgentId: agentId('creator'),
    })

    expect(repository.getExtension(saved.extension.id)).toEqual(saved.extension)
    expect(repository.getExtensionRevision(saved.revision.id)).toEqual(saved.revision)
    expect(repository.listExtensions()).toEqual([saved.extension])
    expect(repository.listExtensionRevisions(saved.extension.id)).toEqual([saved.revision])
    const manifest = manifestRevisionSchema.parse(
      JSON.parse(await readFile(path.join(service.revisionSourceDirectory(saved.revision), 'manifest.json'), 'utf8')),
    )
    const sourceDirectory = service.revisionSourceDirectory(saved.revision)
    expect(manifest.revisionId).toBe(saved.revision.id)
    expect(manifest).toEqual({
      schemaVersion: 2,
      extensionId: saved.extension.id,
      revisionId: saved.revision.id,
      entrypoints: { host: 'source/host.ts' },
      contributions: [],
    })
    expect(existsSync(path.join(sourceDirectory, 'source-input.json'))).toBe(false)
    expect((await readdir(sourceDirectory)).sort()).toEqual(['content.sha256', 'manifest.json', 'source'])
    expect((await readdir(path.join(sourceDirectory, 'source'))).sort()).toEqual(['host.ts'])
  })

  it('reuses an existing Extension as a metadata no-op while appending its next Revision', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-extension-existing-'))
    temporaryDirectories.push(directory)
    const repository = new MemoryExtensionRepository()
    const existing = localExtension(extensionId('existing'))
    const previousRevision = revision(revisionId('existingPrevious'), existing.id, 1)
    repository.saveExtensionRevision({ extension: existing, revision: previousRevision })
    const sources = new ExtensionSourceStore(path.join(directory, 'data'))
    const service = new ExtensionService(repository, sources, {
      now: () => 42,
      nextUlid: () => 'nextRevision',
    })

    const saved = await service.saveDynamicPackage({
      extensionId: existing.id,
      snapshot: { name: '新版本', purpose: '沿用已有扩展。', clientCode: 'return {}' },
      slug: existing.slug,
      displayName: '忽略的新名称',
      description: '忽略的新描述',
    })

    expect(saved.extension).toBe(existing)
    expect(repository.listExtensions()).toEqual([existing])
    expect(saved.revision).toMatchObject({
      extensionId: existing.id,
      id: revisionId('nextRevision'),
      revisionNumber: 2,
      createdAt: 42,
    })
    expect(existsSync(service.revisionSourceDirectory(saved.revision))).toBe(true)
  })

  it('rejects an existing slug change and a new slug collision before publishing or committing', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-extension-slug-'))
    temporaryDirectories.push(directory)
    const repository = new MemoryExtensionRepository()
    const existing = localExtension(extensionId('slugExisting'))
    const owner = { ...localExtension(extensionId('slugOwner')), slug: 'taken-slug' }
    repository.extensions.set(existing.id, existing)
    repository.extensions.set(owner.id, owner)
    const service = new ExtensionService(repository, new ExtensionSourceStore(path.join(directory, 'data')))

    await expect(
      service.saveDynamicPackage({
        extensionId: existing.id,
        snapshot: { name: '改名', purpose: '不应改变标识。', hostCode: 'return {}' },
        slug: 'new-slug',
        displayName: '改名扩展',
        description: '',
      }),
    ).rejects.toThrow('An existing Extension slug cannot be changed by a Revision.')
    await expect(
      service.saveDynamicPackage({
        snapshot: { name: '冲突', purpose: '不应发布。', hostCode: 'return {}' },
        slug: owner.slug,
        displayName: '冲突扩展',
        description: '',
      }),
    ).rejects.toThrow(`Extension slug already exists: ${owner.slug}`)
    expect(repository.listExtensionRevisions()).toEqual([])
    expect(await readdir(path.join(directory, 'data')).catch(() => [])).toEqual([])
  })

  it('rejects an unsafe clock before allocating IDs or writing Extension data', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-extension-clock-'))
    temporaryDirectories.push(directory)
    const repository = new MemoryExtensionRepository()
    const service = new ExtensionService(repository, new ExtensionSourceStore(path.join(directory, 'data')), {
      now: () => Number.MAX_SAFE_INTEGER + 1,
      nextUlid: () => {
        throw new Error('ID generator should not run after clock validation.')
      },
    })

    await expect(
      service.saveDynamicPackage({
        snapshot: { name: '时钟', purpose: '拒绝非法时间。', hostCode: 'return {}' },
        slug: 'clock-extension',
        displayName: '时钟扩展',
        description: '',
      }),
    ).rejects.toThrow('Clock must return a non-negative integer.')
    expect(repository.listExtensions()).toEqual([])
    expect(repository.listExtensionRevisions()).toEqual([])
    expect(await readdir(path.join(directory, 'data')).catch(() => [])).toEqual([])
  })

  it('does not commit a Revision when the source filesystem cannot stage files', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-extension-fs-failure-'))
    temporaryDirectories.push(directory)
    const repository = new MemoryExtensionRepository()
    const dataRoot = path.join(directory, 'data')
    await mkdir(dataRoot, { recursive: true })
    await writeFile(path.join(dataRoot, 'staging'), 'not a directory', 'utf8')
    const service = new ExtensionService(repository, new ExtensionSourceStore(dataRoot), { now: () => 1 })

    await expect(
      service.saveDynamicPackage({
        snapshot: { name: '文件失败', purpose: '文件系统失败时不提交。', clientCode: 'return {}' },
        slug: 'filesystem-failure',
        displayName: '文件失败扩展',
        description: '',
      }),
    ).rejects.toThrow()
    expect(repository.listExtensions()).toEqual([])
    expect(repository.listExtensionRevisions()).toEqual([])
  })
})

describe('Extension Activation lifecycle', () => {
  it('keeps the previous database Activation and restores its mount when a new Revision fails', async () => {
    const repository = new MemoryExtensionRepository()
    const extension = localExtension(extensionId('rollback'))
    const oldRevision = revision(revisionId('old'), extension.id, 1)
    const nextRevision = revision(revisionId('next'), extension.id, 2)
    repository.saveExtensionRevision({ extension, revision: oldRevision })
    repository.saveExtensionRevision({ extension, revision: nextRevision })
    const previous: Activation = {
      agentId: agentId('one'),
      extensionId: extension.id,
      extensionRevisionId: oldRevision.id,
      config: { version: 1 },
      activatedAt: 1,
    }
    repository.upsertActivation(previous)
    const host = new FakeActivationHost()
    const coordinator = activationCoordinator(repository, host)
    expect(await coordinator.restore()).toEqual({ restored: 1, failed: 0 })
    host.failRevisionId = nextRevision.id

    await expect(
      coordinator.activate({
        agentId: previous.agentId,
        extensionId: extension.id,
        revisionId: nextRevision.id,
        config: { version: 2 },
      }),
    ).rejects.toThrow('Mount failed.')

    expect(repository.getActivation(previous.agentId, extension.id)).toEqual(previous)
    expect(host.mounted.get(`${previous.agentId}\0${extension.id}`)).toBe(oldRevision.id)
  })

  it('restores the old mount if the Activation repository transaction fails', async () => {
    const repository = new MemoryExtensionRepository()
    const extension = localExtension(extensionId('transaction'))
    const oldRevision = revision(revisionId('transactionOld'), extension.id, 1)
    const nextRevision = revision(revisionId('transactionNext'), extension.id, 2)
    repository.saveExtensionRevision({ extension, revision: oldRevision })
    repository.saveExtensionRevision({ extension, revision: nextRevision })
    const previous: Activation = {
      agentId: agentId('transaction'),
      extensionId: extension.id,
      extensionRevisionId: oldRevision.id,
      config: {},
      activatedAt: 1,
    }
    repository.upsertActivation(previous)
    const host = new FakeActivationHost()
    const coordinator = activationCoordinator(repository, host)
    await coordinator.restore()
    repository.failActivationUpsert = true
    host.failDisposeRevisionId = nextRevision.id

    await expect(
      coordinator.activate({
        agentId: previous.agentId,
        extensionId: extension.id,
        revisionId: nextRevision.id,
      }),
    ).rejects.toThrow('Activation transaction failed.')
    expect(repository.getActivation(previous.agentId, extension.id)).toEqual(previous)
    expect(host.mounted.get(`${previous.agentId}\0${extension.id}`)).toBe(oldRevision.id)
  })

  it('activates a first Revision with defaults and cleanly switches to the next Revision', async () => {
    const repository = new MemoryExtensionRepository()
    const extension = localExtension(extensionId('switch'))
    const firstRevision = revision(revisionId('switchFirst'), extension.id, 1)
    const nextRevision = revision(revisionId('switchNext'), extension.id, 2)
    repository.saveExtensionRevision({ extension, revision: firstRevision })
    repository.saveExtensionRevision({ extension, revision: nextRevision })
    const host = new FakeActivationHost()
    const coordinator = activationCoordinator(repository, host)

    const first = await coordinator.activate({
      agentId: agentId('switcher'),
      extensionId: extension.id,
      revisionId: firstRevision.id,
    })
    expect(first).toMatchObject({
      extensionRevisionId: firstRevision.id,
      config: {},
      activatedAt: 100,
    })
    expect(host.mounted.get(`${first.agentId}\0${extension.id}`)).toBe(firstRevision.id)

    const next = await coordinator.activate({
      agentId: first.agentId,
      extensionId: extension.id,
      revisionId: nextRevision.id,
      config: { mode: 'next' },
    })
    expect(next).toMatchObject({ extensionRevisionId: nextRevision.id, config: { mode: 'next' } })
    expect(repository.getActivation(first.agentId, extension.id)).toEqual(next)
    expect(host.disposedRevisions).toEqual([firstRevision.id])
    expect(host.mounted.get(`${first.agentId}\0${extension.id}`)).toBe(nextRevision.id)
  })

  it('serializes concurrent switches for one Agent and Extension pair', async () => {
    const repository = new MemoryExtensionRepository()
    const extension = localExtension(extensionId('serialized'))
    const firstRevision = revision(revisionId('serializedFirst'), extension.id, 1)
    const nextRevision = revision(revisionId('serializedNext'), extension.id, 2)
    repository.saveExtensionRevision({ extension, revision: firstRevision })
    repository.saveExtensionRevision({ extension, revision: nextRevision })
    const host = new FakeActivationHost()
    const coordinator = activationCoordinator(repository, host)

    const [first, next] = await Promise.all([
      coordinator.activate({ agentId: agentId('serialized'), extensionId: extension.id, revisionId: firstRevision.id }),
      coordinator.activate({ agentId: agentId('serialized'), extensionId: extension.id, revisionId: nextRevision.id }),
    ])

    expect(first.extensionRevisionId).toBe(firstRevision.id)
    expect(next.extensionRevisionId).toBe(nextRevision.id)
    expect(repository.getActivation(agentId('serialized'), extension.id)?.extensionRevisionId).toBe(nextRevision.id)
    expect(host.disposedRevisions).toEqual([firstRevision.id])
  })

  it('rejects unavailable Revisions and invalid activation clocks before committing an Activation', async () => {
    const repository = new MemoryExtensionRepository()
    const extension = localExtension(extensionId('validation'))
    const otherExtension = localExtension(extensionId('otherOwner'))
    const ownedRevision = revision(revisionId('owned'), extension.id, 1)
    const otherRevision = revision(revisionId('otherOwned'), otherExtension.id, 1)
    repository.saveExtensionRevision({ extension, revision: ownedRevision })
    repository.saveExtensionRevision({ extension: otherExtension, revision: otherRevision })
    const host = new FakeActivationHost()
    const coordinator = activationCoordinator(repository, host)

    await expect(
      coordinator.activate({
        agentId: agentId('validation'),
        extensionId: extension.id,
        revisionId: revisionId('missing'),
      }),
    ).rejects.toThrow('Activation requires a Revision owned by the selected Extension.')
    await expect(
      coordinator.activate({
        agentId: agentId('validation'),
        extensionId: extension.id,
        revisionId: otherRevision.id,
      }),
    ).rejects.toThrow('Activation requires a Revision owned by the selected Extension.')

    const badClockCoordinator = activationCoordinator(repository, new FakeActivationHost(), () => 1.5)
    await expect(
      badClockCoordinator.activate({
        agentId: agentId('badclock'),
        extensionId: extension.id,
        revisionId: ownedRevision.id,
      }),
    ).rejects.toThrow('Clock must return a non-negative integer.')
    expect(repository.getActivation(agentId('badclock'), extension.id)).toBeUndefined()
  })

  it('starts and stops the same Extension independently for multiple Agents', async () => {
    const repository = new MemoryExtensionRepository()
    const extension = localExtension(extensionId('shared'))
    const currentRevision = revision(revisionId('shared'), extension.id, 1)
    repository.saveExtensionRevision({ extension, revision: currentRevision })
    const firstAgent = agentId('first')
    const secondAgent = agentId('second')
    const host = new FakeActivationHost()
    const coordinator = activationCoordinator(repository, host)

    await coordinator.activate({ agentId: firstAgent, extensionId: extension.id, revisionId: currentRevision.id })
    await coordinator.activate({ agentId: secondAgent, extensionId: extension.id, revisionId: currentRevision.id })
    expect(repository.listActivations()).toHaveLength(2)
    expect(host.mounted).toHaveLength(2)

    await coordinator.disable(firstAgent, extension.id)
    expect(repository.getActivation(firstAgent, extension.id)).toBeUndefined()
    expect(repository.getActivation(secondAgent, extension.id)?.extensionRevisionId).toBe(currentRevision.id)
    expect(host.mounted.has(`${firstAgent}\0${extension.id}`)).toBe(false)
    expect(host.mounted.get(`${secondAgent}\0${extension.id}`)).toBe(currentRevision.id)
  })

  it('restores only valid committed Activations and counts failed restores without inventing state', async () => {
    const repository = new MemoryExtensionRepository()
    const firstExtension = localExtension(extensionId('restoreFirst'))
    const secondExtension = localExtension(extensionId('restoreSecond'))
    const validRevision = revision(revisionId('restoreValid'), firstExtension.id, 1)
    const failingRevision = revision(revisionId('restoreFail'), firstExtension.id, 2)
    repository.saveExtensionRevision({ extension: firstExtension, revision: validRevision })
    repository.saveExtensionRevision({ extension: firstExtension, revision: failingRevision })
    repository.upsertActivation({
      agentId: agentId('restorevalid'),
      extensionId: firstExtension.id,
      extensionRevisionId: validRevision.id,
      config: {},
      activatedAt: 1,
    })
    repository.upsertActivation({
      agentId: agentId('restorefail'),
      extensionId: firstExtension.id,
      extensionRevisionId: failingRevision.id,
      config: {},
      activatedAt: 1,
    })
    repository.upsertActivation({
      agentId: agentId('restoremissing'),
      extensionId: secondExtension.id,
      extensionRevisionId: revisionId('restoreMissing'),
      config: {},
      activatedAt: 1,
    })
    const host = new FakeActivationHost()
    host.failRevisionId = failingRevision.id
    const coordinator = activationCoordinator(repository, host)

    expect(await coordinator.restore()).toEqual({ restored: 1, failed: 2 })
    expect(await coordinator.restore()).toEqual({ restored: 0, failed: 2 })
    expect(host.mounted.get(`${agentId('restorevalid')}\0${firstExtension.id}`)).toBe(validRevision.id)
  })

  it('rejects disabling an inactive pair and restores its mount when deletion fails', async () => {
    const repository = new MemoryExtensionRepository()
    const extension = localExtension(extensionId('disable'))
    const currentRevision = revision(revisionId('disableCurrent'), extension.id, 1)
    repository.saveExtensionRevision({ extension, revision: currentRevision })
    const inactiveAgent = agentId('disableinactive')
    const committedOnlyAgent = agentId('disablecommitted')
    repository.upsertActivation({
      agentId: committedOnlyAgent,
      extensionId: extension.id,
      extensionRevisionId: currentRevision.id,
      config: {},
      activatedAt: 1,
    })
    const host = new FakeActivationHost()
    const coordinator = activationCoordinator(repository, host)

    await expect(coordinator.disable(inactiveAgent, extension.id)).rejects.toThrow(
      `Extension is not active for Agent: ${extension.id}`,
    )
    await coordinator.disable(committedOnlyAgent, extension.id)
    expect(repository.getActivation(committedOnlyAgent, extension.id)).toBeUndefined()

    await coordinator.activate({
      agentId: agentId('disablefailingdelete'),
      extensionId: extension.id,
      revisionId: currentRevision.id,
    })
    repository.failActivationDelete = true
    await expect(coordinator.disable(agentId('disablefailingdelete'), extension.id)).rejects.toThrow(
      'Activation delete failed.',
    )
    expect(repository.getActivation(agentId('disablefailingdelete'), extension.id)).toBeDefined()
    expect(host.mounted.get(`${agentId('disablefailingdelete')}\0${extension.id}`)).toBe(currentRevision.id)
  })

  it('waits for in-flight transitions during concurrent dispose and rejects later work', async () => {
    const repository = new MemoryExtensionRepository()
    const extension = localExtension(extensionId('dispose'))
    const currentRevision = revision(revisionId('disposeCurrent'), extension.id, 1)
    repository.saveExtensionRevision({ extension, revision: currentRevision })
    const host = new FakeActivationHost()
    const gate = deferred<void>()
    host.safeGate = gate.promise
    const coordinator = activationCoordinator(repository, host)
    const activationPromise = coordinator.activate({
      agentId: agentId('disposeagent'),
      extensionId: extension.id,
      revisionId: currentRevision.id,
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(host.safeAgents).toEqual([agentId('disposeagent')])

    const firstDispose = coordinator.dispose()
    const secondDispose = coordinator.dispose()
    gate.resolve()
    await expect(activationPromise).resolves.toMatchObject({ extensionRevisionId: currentRevision.id })
    await Promise.all([firstDispose, secondDispose])

    expect(host.disposedRevisions).toEqual([currentRevision.id])
    await expect(
      coordinator.activate({
        agentId: agentId('disposeagent'),
        extensionId: extension.id,
        revisionId: currentRevision.id,
      }),
    ).rejects.toThrow('Extension Activation coordinator is disposed.')
    await expect(coordinator.restore()).rejects.toThrow('Extension Activation coordinator is disposed.')
  })

  it('surfaces an AggregateError when a failed switch cannot restore its previous mount', async () => {
    const repository = new MemoryExtensionRepository()
    const extension = localExtension(extensionId('aggregate'))
    const oldRevision = revision(revisionId('aggregateOld'), extension.id, 1)
    const nextRevision = revision(revisionId('aggregateNext'), extension.id, 2)
    repository.saveExtensionRevision({ extension, revision: oldRevision })
    repository.saveExtensionRevision({ extension, revision: nextRevision })
    const host = new FakeActivationHost()
    const coordinator = activationCoordinator(repository, host)
    const agent = agentId('aggregateagent')
    await coordinator.activate({ agentId: agent, extensionId: extension.id, revisionId: oldRevision.id })
    host.failRevisionIds.add(oldRevision.id)
    host.failRevisionIds.add(nextRevision.id)

    await expect(
      coordinator.activate({ agentId: agent, extensionId: extension.id, revisionId: nextRevision.id }),
    ).rejects.toThrow('Activation failed and the previous mount could not be restored.')
    expect(repository.getActivation(agent, extension.id)?.extensionRevisionId).toBe(oldRevision.id)
  })
})

describe('Extension source store', () => {
  it('treats a duplicate immutable publish as a no-op and rejects conflicting content', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-extension-source-'))
    temporaryDirectories.push(directory)
    const sourceStore = new ExtensionSourceStore(path.join(directory, 'data'))
    const first = materialize('return { version: 1 }')

    await sourceStore.publish(first.manifest.extensionId, first.manifest.revisionId, first)
    await sourceStore.publish(first.manifest.extensionId, first.manifest.revisionId, first)
    const sourceDirectory = sourceStore.revisionSourceDirectory(first.manifest.extensionId, first.manifest.revisionId)
    expect(await readFile(path.join(sourceDirectory, 'content.sha256'), 'utf8')).toBe(`${first.contentDigest}\n`)

    const conflict = materialize('return { version: 2 }')
    await expect(
      sourceStore.publish(conflict.manifest.extensionId, conflict.manifest.revisionId, conflict),
    ).rejects.toThrow('Extension Revision directory already has other content.')
    expect(await readFile(path.join(sourceDirectory, 'content.sha256'), 'utf8')).toBe(`${first.contentDigest}\n`)
    expect(await readdir(path.join(directory, 'data', 'staging'))).toEqual([])
  })

  it('rejects relative source roots', () => {
    expect(() => new ExtensionSourceStore('relative-root')).toThrow('Extension source root must be absolute.')
  })
})

describe('Extension materialization and build policy', () => {
  it('normalizes the same immutable source input to the same digest and entrypoint manifest', () => {
    const first = materialize('return { apply() {} }\r\n')
    const second = materialize('return { apply() {} }\n')
    expect(first.contentDigest).toBe(second.contentDigest)
    expect(first.sources.host).toContain("from '@nekro-nxt/extension-sdk'")
    expect(first.manifest).toEqual({
      schemaVersion: 2,
      extensionId: extensionId('test'),
      revisionId: revisionId('test'),
      entrypoints: { host: 'source/host.ts' },
      contributions: [],
    })
    expect(first).not.toHaveProperty('sourceInput')
  })

  it('builds Host-only, Client-only, and dual-entrypoint revisions through the public artifact contract', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-extension-entrypoints-'))
    temporaryDirectories.push(directory)
    const sourceStore = new ExtensionSourceStore(path.join(directory, 'data'))
    const builder = new ExtensionBuilder(path.join(directory, 'cache'))
    const variants = [
      { name: 'hostonly', snapshot: { name: 'Host', purpose: 'Host 构建。', hostCode: 'return {}' } },
      { name: 'clientonly', snapshot: { name: 'Client', purpose: 'Client 构建。', clientCode: 'return {}' } },
      {
        name: 'dual',
        snapshot: { name: '双入口', purpose: '双入口构建。', hostCode: 'return {}', clientCode: 'return {}' },
      },
    ] as const

    for (const variant of variants) {
      const materialized = materializeDynamicPackage({
        extensionId: extensionId(variant.name),
        revisionId: revisionId(variant.name),
        snapshot: variant.snapshot,
      })
      await sourceStore.publish(materialized.manifest.extensionId, materialized.manifest.revisionId, materialized)
      const artifact = await builder.build({
        extensionId: materialized.manifest.extensionId,
        revisionId: materialized.manifest.revisionId,
        contentDigest: materialized.contentDigest,
        sourceDirectory: sourceStore.revisionSourceDirectory(
          materialized.manifest.extensionId,
          materialized.manifest.revisionId,
        ),
      })

      expect(artifact.revisionId).toBe(materialized.manifest.revisionId)
      expect(artifact.hostEntry === undefined).toBe(!('hostCode' in variant.snapshot))
      expect(artifact.clientEntry === undefined).toBe(!('clientCode' in variant.snapshot))
      if (artifact.hostEntry) expect(existsSync(artifact.hostEntry)).toBe(true)
      if (artifact.clientEntry) expect(existsSync(artifact.clientEntry)).toBe(true)

      if (variant.name !== 'hostonly') {
        await writeFile(
          path.join(artifact.directory, 'build.json'),
          JSON.stringify({ revisionId: artifact.revisionId, buildKey: artifact.buildKey, hostEntry: 'host.mjs' }),
          'utf8',
        )
        await expect(
          builder.build({
            extensionId: materialized.manifest.extensionId,
            revisionId: materialized.manifest.revisionId,
            contentDigest: materialized.contentDigest,
            sourceDirectory: sourceStore.revisionSourceDirectory(
              materialized.manifest.extensionId,
              materialized.manifest.revisionId,
            ),
          }),
        ).resolves.toEqual(artifact)
      }
    }
  })

  it('requires an absolute build cache root', () => {
    expect(() => new ExtensionBuilder('relative-cache-root')).toThrow('Extension build cache root must be absolute.')
  })

  it('validates materialized identities before constructing the revision payload', () => {
    expect(() =>
      materializeDynamicPackage({
        extensionId: ExtensionIdSchema.parse('../outside'),
        revisionId: revisionId('test'),
        snapshot: {
          name: '构建探针',
          purpose: '验证严格物化。',
          hostCode: 'return { apply() {} }',
        },
      }),
    ).toThrow('ExtensionId has an invalid format')
  })

  it('rejects malformed or structurally invalid source manifests before building', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-extension-manifest-'))
    temporaryDirectories.push(directory)
    const sourceStore = new ExtensionSourceStore(path.join(directory, 'data'))
    const materialized = materialize('return { apply() {} }')
    await sourceStore.publish(materialized.manifest.extensionId, materialized.manifest.revisionId, materialized)
    const sourceDirectory = sourceStore.revisionSourceDirectory(
      materialized.manifest.extensionId,
      materialized.manifest.revisionId,
    )
    const manifestPath = path.join(sourceDirectory, 'manifest.json')
    const cache = path.join(directory, 'cache')
    const buildInput = {
      extensionId: materialized.manifest.extensionId,
      revisionId: materialized.manifest.revisionId,
      contentDigest: materialized.contentDigest,
      sourceDirectory,
    }

    await expect(
      new ExtensionBuilder(cache).build({ ...buildInput, extensionId: extensionId('other') }),
    ).rejects.toThrow('Extension Manifest identity does not match build input.')

    await writeFile(
      manifestPath,
      JSON.stringify({ ...materialized.manifest, revisionId: revisionId('otherRevision') }),
      'utf8',
    )
    await expect(new ExtensionBuilder(cache).build(buildInput)).rejects.toThrow(
      'Extension Manifest revision does not match build input.',
    )

    await writeFile(manifestPath, '{', 'utf8')
    await expect(new ExtensionBuilder(cache).build(buildInput)).rejects.toBeInstanceOf(SyntaxError)

    await writeFile(
      manifestPath,
      JSON.stringify({
        ...materialized.manifest,
        schemaVersion: 1,
        apiVersion: '1',
        compatible: { nekroNxt: '^0.1.0', dsh: '^0.1.1-rc.2' },
        requestedCapabilities: [],
        contributions: [],
        name: '过早预留',
      }),
      'utf8',
    )
    await expect(new ExtensionBuilder(cache).build(buildInput)).rejects.toMatchObject({ name: 'ZodError' })
    expect(await readdir(cache).catch(() => [])).toEqual([])
  })

  it('rebuilds malformed and structurally invalid cache manifests', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-extension-cache-'))
    temporaryDirectories.push(directory)
    const sourceStore = new ExtensionSourceStore(path.join(directory, 'data'))
    const materialized = materialize('return { apply() {} }')
    await sourceStore.publish(materialized.manifest.extensionId, materialized.manifest.revisionId, materialized)
    const buildInput = {
      extensionId: materialized.manifest.extensionId,
      revisionId: materialized.manifest.revisionId,
      contentDigest: materialized.contentDigest,
      sourceDirectory: sourceStore.revisionSourceDirectory(
        materialized.manifest.extensionId,
        materialized.manifest.revisionId,
      ),
    }
    const builder = new ExtensionBuilder(path.join(directory, 'cache'))
    const artifact = await builder.build(buildInput)
    const cacheManifestPath = path.join(artifact.directory, 'build.json')
    expect(buildCacheSchema.parse(JSON.parse(await readFile(cacheManifestPath, 'utf8')))).toEqual({
      revisionId: materialized.manifest.revisionId,
      buildKey: artifact.buildKey,
      hostEntry: 'host.mjs',
    })

    await expect(builder.build(buildInput)).resolves.toEqual(artifact)

    await writeFile(
      cacheManifestPath,
      JSON.stringify({ revisionId: materialized.manifest.revisionId, buildKey: '0'.repeat(64) }),
      'utf8',
    )
    await expect(builder.build(buildInput)).resolves.toEqual(artifact)

    await writeFile(cacheManifestPath, '{', 'utf8')
    await expect(builder.build(buildInput)).resolves.toEqual(artifact)

    await writeFile(cacheManifestPath, JSON.stringify({ ...artifact, unexpected: true }), 'utf8')
    await expect(builder.build(buildInput)).resolves.toEqual(artifact)

    await writeFile(
      cacheManifestPath,
      JSON.stringify({ revisionId: materialized.manifest.revisionId, buildKey: artifact.buildKey }),
      'utf8',
    )
    await expect(builder.build(buildInput)).resolves.toEqual(artifact)

    const hostEntry = artifact.hostEntry
    if (hostEntry === undefined) throw new Error('Expected the Host build artifact to have an entrypoint.')
    await rm(hostEntry)
    await expect(builder.build(buildInput)).resolves.toEqual(artifact)
    expect(existsSync(hostEntry)).toBe(true)
  })

  it('rejects undeclared bare imports and leaves no committed cache artifact', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-extension-policy-'))
    temporaryDirectories.push(directory)
    const sourceStore = new ExtensionSourceStore(path.join(directory, 'data'))
    const materialized = materialize("return await import('node:fs')")
    await sourceStore.publish(materialized.manifest.extensionId, materialized.manifest.revisionId, materialized)
    const cache = path.join(directory, 'cache')
    await expect(
      new ExtensionBuilder(cache).build({
        revisionId: materialized.manifest.revisionId,
        contentDigest: materialized.contentDigest,
        sourceDirectory: sourceStore.revisionSourceDirectory(
          materialized.manifest.extensionId,
          materialized.manifest.revisionId,
        ),
      }),
    ).rejects.toThrow('Extension import is not allowed: node:fs')
    expect(await readdir(cache).catch(() => [])).toEqual([])
  })

  it('cleans the temporary build and preserves unrelated cache siblings after an entrypoint failure', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-extension-build-cleanup-'))
    temporaryDirectories.push(directory)
    const sourceStore = new ExtensionSourceStore(path.join(directory, 'data'))
    const materialized = materialize('return {}')
    await sourceStore.publish(materialized.manifest.extensionId, materialized.manifest.revisionId, materialized)
    const sourceDirectory = sourceStore.revisionSourceDirectory(
      materialized.manifest.extensionId,
      materialized.manifest.revisionId,
    )
    const hostPath = path.join(sourceDirectory, 'source', 'host.ts')
    await rm(hostPath)
    await mkdir(hostPath)
    const cache = path.join(directory, 'cache')
    const revisionCacheDirectory = path.join(cache, materialized.manifest.revisionId)
    await mkdir(path.join(revisionCacheDirectory, 'keep'), { recursive: true })

    await expect(
      new ExtensionBuilder(cache).build({
        extensionId: materialized.manifest.extensionId,
        revisionId: materialized.manifest.revisionId,
        contentDigest: materialized.contentDigest,
        sourceDirectory,
      }),
    ).rejects.toThrow('Extension entrypoint is not a file: host')
    expect(await readdir(revisionCacheDirectory)).toEqual(['keep'])
  })

  it('rejects parent-traversal storage identities', () => {
    const sourceStore = new ExtensionSourceStore('/tmp/nekro-nxt-extension-path-policy')
    expect(() =>
      sourceStore.revisionSourceDirectory(ExtensionIdSchema.parse('../outside'), revisionId('safe')),
    ).toThrow('ExtensionId has an invalid format')
  })
})
