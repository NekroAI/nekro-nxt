import {
  ExtensionRevisionIdSchema,
  type ExtensionId,
  type ExtensionRevisionId,
  type ExtensionRevisionProtection,
} from '@nekro-nxt/contracts'
import { lineageDepth, type ExtensionLineage, type Revision } from '@nekro-nxt/extension-runtime'
import type { ExtensionRevisionReleaseRecord, SqliteCoreRepository } from '@nekro-nxt/storage-sqlite'
import { z } from 'zod'

/** Lineage source a projection reads: the Manifest's when a Revision carries one, the database record otherwise. */
export interface LineageReader {
  lineageNode(revision: Revision): {
    readonly revisionId: ExtensionRevisionId
    readonly lineage?: ExtensionLineage | undefined
  }
}

export interface RevisionVersion {
  readonly revisionId: ExtensionRevisionId
  /** Generation on the line: the first Revision is 1. */
  readonly version: number
  /** `v3`, or `v3·2` for the second Revision of the same generation (a local fork). */
  readonly label: string
  readonly parentRevisionId?: ExtensionRevisionId
  readonly origin: Revision['origin']
  readonly dataVersion: number
  readonly releases: readonly ExtensionRevisionReleaseRecord[]
}

/**
 * Version labels of every Revision of one extension. Two machines label the same line the same way, because the
 * generation comes from the lineage; only a second Revision of a generation on this machine gets a variant number.
 */
export const extensionVersions = (
  repository: Pick<SqliteCoreRepository, 'listExtensionRevisions' | 'listExtensionRevisionReleases'>,
  lineage: LineageReader,
  extensionId: ExtensionId,
): ReadonlyMap<ExtensionRevisionId, RevisionVersion> => {
  const revisions = repository.listExtensionRevisions(extensionId)
  const releases = repository.listExtensionRevisionReleases(extensionId)
  const local = new Set<string>(revisions.map((revision) => revision.id))
  const byGeneration = new Map<number, number>()
  const result = new Map<ExtensionRevisionId, RevisionVersion>()
  for (const revision of [...revisions].sort((left, right) => left.createdAt - right.createdAt)) {
    const node = lineage.lineageNode(revision)
    const version = lineageDepth(node.lineage)
    const seen = (byGeneration.get(version) ?? 0) + 1
    byGeneration.set(version, seen)
    // A cleaned-up parent hands its children to the nearest earlier version still on this machine.
    const recorded = node.lineage?.parent ?? undefined
    const parent =
      [recorded, ...(node.lineage?.ancestry ?? [])].find((id) => id !== undefined && id !== null && local.has(id)) ??
      recorded
    result.set(revision.id, {
      revisionId: revision.id,
      version,
      label: seen === 1 ? `v${version}` : `v${version}·${seen}`,
      ...(parent === undefined || parent === null ? {} : { parentRevisionId: parent }),
      origin: revision.origin,
      dataVersion: revision.dataVersion,
      releases: releases.filter((release) => release.revisionId === revision.id),
    })
  }
  return result
}

export interface LineageGraphNode {
  readonly revisionId: ExtensionRevisionId
  readonly extensionId: ExtensionId
  readonly label: string
  readonly parentRevisionId?: ExtensionRevisionId
  readonly origin: Revision['origin']
  readonly createdAt: number
  readonly current: boolean
  readonly releaseNumbers: readonly number[]
  readonly kept: boolean
  readonly protectedBy?: ExtensionRevisionProtection
}

export interface LineageGraphLine {
  readonly extensionId: ExtensionId
  readonly displayName: string
  /** The Revision of another line this one was branched from. */
  readonly branchOf?: { readonly extensionId: ExtensionId; readonly revisionId: ExtensionRevisionId }
  readonly nodes: readonly LineageGraphNode[]
}

/**
 * Every line of the family an extension belongs to on this machine: walk up through branch origins to the oldest
 * line, then down through every local branch of a branch. Lines whose origin is not on this machine still show where
 * they came from.
 */
export const lineageGraph = (
  repository: Pick<
    SqliteCoreRepository,
    | 'listExtensions'
    | 'getExtension'
    | 'listExtensionRevisions'
    | 'listExtensionRevisionReleases'
    | 'getHostInstallation'
    | 'listKeptExtensionRevisionIds'
  >,
  lineage: LineageReader,
  extensionId: ExtensionId,
  protections: (extensionId: ExtensionId) => ReadonlyMap<ExtensionRevisionId, ExtensionRevisionProtection> = () =>
    new Map(),
): readonly LineageGraphLine[] => {
  const extensions = repository.listExtensions()
  let root = repository.getExtension(extensionId)
  const visited = new Set<string>()
  while (root?.branchOf !== undefined && !visited.has(root.id)) {
    visited.add(root.id)
    const parent = repository.getExtension(root.branchOf.extensionId)
    if (!parent) break
    root = parent
  }
  if (!root) return []
  const family: (typeof extensions)[number][] = []
  const queue = [root]
  const included = new Set<string>()
  while (queue.length > 0) {
    const next = queue.shift()!
    if (included.has(next.id)) continue
    included.add(next.id)
    family.push(next)
    queue.push(...extensions.filter((candidate) => candidate.branchOf?.extensionId === next.id))
  }
  return family.map((extension) => {
    const versions = extensionVersions(repository, lineage, extension.id)
    const current = repository.getHostInstallation(extension.id)?.extensionRevisionId
    const kept = new Set(repository.listKeptExtensionRevisionIds(extension.id))
    const protectedBy = protections(extension.id)
    return {
      extensionId: extension.id,
      displayName: extension.displayName,
      ...(extension.branchOf === undefined ? {} : { branchOf: extension.branchOf }),
      nodes: repository.listExtensionRevisions(extension.id).map((revision) => {
        const version = versions.get(revision.id)!
        return {
          revisionId: revision.id,
          extensionId: extension.id,
          label: version.label,
          ...(version.parentRevisionId === undefined ? {} : { parentRevisionId: version.parentRevisionId }),
          origin: revision.origin,
          createdAt: revision.createdAt,
          current: revision.id === current,
          kept: kept.has(revision.id),
          ...(protectedBy.has(revision.id) ? { protectedBy: protectedBy.get(revision.id)! } : {}),
          releaseNumbers: version.releases.flatMap((release) =>
            release.releaseNumber === null ? [] : [release.releaseNumber],
          ),
        }
      }),
    }
  })
}

const RequestPayloadSchema = z
  .object({ action: z.object({ revisionId: ExtensionRevisionIdSchema.optional() }).passthrough().optional() })
  .passthrough()

/**
 * Why each version of one extension cannot be cleaned up; versions missing from the map can. The first reason in the
 * order people care about wins: in use, enabled for an agent, released, kept, then what other work still needs.
 */
export const revisionProtections = (
  repository: Pick<
    SqliteCoreRepository,
    | 'listExtensions'
    | 'listExtensionRevisionReleases'
    | 'getHostInstallation'
    | 'listActivations'
    | 'listKeptExtensionRevisionIds'
    | 'getOpenRevisionTask'
    | 'listExtensionRequests'
  >,
  latestSwitch: (
    extensionId: ExtensionId,
  ) => { readonly fromRevisionId: ExtensionRevisionId; readonly toRevisionId: ExtensionRevisionId } | undefined,
  extensionId: ExtensionId,
): ReadonlyMap<ExtensionRevisionId, ExtensionRevisionProtection> => {
  const result = new Map<ExtensionRevisionId, ExtensionRevisionProtection>()
  const mark = (revisionId: ExtensionRevisionId | undefined, reason: ExtensionRevisionProtection) => {
    if (revisionId !== undefined && !result.has(revisionId)) result.set(revisionId, reason)
  }
  mark(repository.getHostInstallation(extensionId)?.extensionRevisionId, 'installed')
  for (const activation of repository.listActivations())
    if (activation.extensionId === extensionId) mark(activation.extensionRevisionId, 'active')
  for (const release of repository.listExtensionRevisionReleases(extensionId)) mark(release.revisionId, 'released')
  for (const revisionId of repository.listKeptExtensionRevisionIds(extensionId)) mark(revisionId, 'kept')
  for (const extension of repository.listExtensions())
    if (extension.branchOf?.extensionId === extensionId) mark(extension.branchOf.revisionId, 'branch')
  const task = repository.getOpenRevisionTask(extensionId)
  mark(task?.baseRevisionId, 'revising')
  mark(task?.referenceRevisionId, 'revising')
  const switched = latestSwitch(extensionId)
  mark(switched?.fromRevisionId, 'undo')
  mark(switched?.toRevisionId, 'undo')
  for (const request of repository.listExtensionRequests({ status: 'pending' }))
    mark(RequestPayloadSchema.safeParse(request.payload).data?.action?.revisionId, 'request')
  return result
}

/** What blocks a cleanup, in the words of the error people see. */
export const protectionReason: Record<ExtensionRevisionProtection, string> = {
  installed: '正在使用',
  active: '有智能体启用',
  released: '发布到过社区',
  kept: '已保留',
  branch: '有分支从这里分出',
  revising: '智能体正在基于它修改',
  undo: '回到上一个版本要用到',
  request: '有待确认的请求用到它',
}
