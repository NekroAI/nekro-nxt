import type { ExtensionId, ExtensionRevisionId } from '@nekro-nxt/contracts'
import { lineageDepth, type ExtensionLineage, type Revision } from '@nekro-nxt/extension-runtime'
import type { ExtensionRevisionReleaseRecord, SqliteCoreRepository } from '@nekro-nxt/storage-sqlite'

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
  const byGeneration = new Map<number, number>()
  const result = new Map<ExtensionRevisionId, RevisionVersion>()
  for (const revision of [...revisions].sort((left, right) => left.createdAt - right.createdAt)) {
    const node = lineage.lineageNode(revision)
    const version = lineageDepth(node.lineage)
    const seen = (byGeneration.get(version) ?? 0) + 1
    byGeneration.set(version, seen)
    const parent = node.lineage?.parent ?? undefined
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
    'listExtensions' | 'getExtension' | 'listExtensionRevisions' | 'listExtensionRevisionReleases' | 'getHostInstallation'
  >,
  lineage: LineageReader,
  extensionId: ExtensionId,
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
          releaseNumbers: version.releases.flatMap((release) =>
            release.releaseNumber === null ? [] : [release.releaseNumber],
          ),
        }
      }),
    }
  })
}
