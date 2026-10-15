import type { ExtensionId, ExtensionRevisionId } from '@nekro-nxt/contracts'
import { EXTENSION_LINEAGE_MAX_ANCESTRY, type ExtensionLineage } from './manifest.js'

/** A Revision as far as lineage is concerned: its id and the lineage its Manifest carries (none for old packages). */
export interface LineageNode {
  readonly revisionId: ExtensionRevisionId
  readonly lineage?: ExtensionLineage | undefined
}

/** Lineage of a new Revision made from `parent` on the same extension line. */
export const lineageAfter = (parent: LineageNode): ExtensionLineage => ({
  parent: parent.revisionId,
  ancestry: [parent.revisionId, ...(parent.lineage?.ancestry ?? [])].slice(0, EXTENSION_LINEAGE_MAX_ANCESTRY),
  ...(parent.lineage?.branchOf === undefined ? {} : { branchOf: parent.lineage.branchOf }),
})

/** Lineage of the first Revision of a branch: a new line that records where it was branched from. */
export const lineageOfBranch = (origin: {
  readonly extensionId: ExtensionId
  readonly revisionId: ExtensionRevisionId
}): ExtensionLineage => ({
  parent: null,
  ancestry: [],
  branchOf: { extensionId: origin.extensionId, revisionId: origin.revisionId },
})

/** The version number people see: the first Revision of a line is 1 and every generation adds one. */
export const lineageDepth = (lineage: ExtensionLineage | undefined): number => (lineage?.ancestry.length ?? 0) + 1

/**
 * How a local Revision relates to a remote one (usually the community's newest release) on the same line.
 * `remote-ahead`: the remote descends from the local one, so updating is a fast-forward. `local-ahead`: the local one
 * descends from the remote, so publishing is a fast-forward. `diverged`: both moved on since a shared ancestor.
 * `unrelated`: no shared Revision within the recorded ancestry.
 */
export type LineageRelation = 'same' | 'remote-ahead' | 'local-ahead' | 'diverged' | 'unrelated'

export const lineageRelation = (local: LineageNode, remote: LineageNode): LineageRelation => {
  if (local.revisionId === remote.revisionId) return 'same'
  const remoteAncestry = remote.lineage?.ancestry ?? []
  const localAncestry = local.lineage?.ancestry ?? []
  if (remoteAncestry.includes(local.revisionId)) return 'remote-ahead'
  if (localAncestry.includes(remote.revisionId)) return 'local-ahead'
  const remoteSet = new Set(remoteAncestry)
  return localAncestry.some((id) => remoteSet.has(id)) ? 'diverged' : 'unrelated'
}

/** Whether publishing `candidate` after `latest` keeps the public line linear. */
export const isFastForward = (candidate: LineageNode, latest: LineageNode): boolean =>
  candidate.revisionId === latest.revisionId || (candidate.lineage?.ancestry ?? []).includes(latest.revisionId)
