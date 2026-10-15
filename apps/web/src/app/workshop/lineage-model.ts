import type { HostApiResponse } from '@nekro-nxt/contracts'

export type LineageLine = HostApiResponse<'getExtensionLineage'>['lines'][number]
export type LineageNode = LineageLine['nodes'][number]

export interface PlacedNode {
  readonly node: LineageNode
  /** Index of the node's line in the family, which picks its colour. */
  readonly lane: number
  /** Column = generation from the oldest version on this machine; row = track. */
  readonly column: number
  readonly row: number
}

export interface LineageEdge {
  readonly from: PlacedNode
  readonly to: PlacedNode
  /** `version` joins two versions of one extension; `branch` joins a branch to the version it started from. */
  readonly kind: 'version' | 'branch'
}

export interface LineageLayout {
  readonly nodes: readonly PlacedNode[]
  readonly edges: readonly LineageEdge[]
  readonly columns: number
  readonly rows: number
}

/**
 * Lays the family out as a tree that grows to the right: every version sits one column after its parent, the line
 * that leads to the version in use (or the newest one) keeps its parent's row, and every other child (a second save
 * of the same generation, or a branch) opens a row of its own below. A branch's first version hangs off the version
 * it was branched from; a line whose origin is not on this machine starts a tree of its own.
 */
export function layoutLineage(lines: readonly LineageLine[]): LineageLayout {
  const lane = new Map(lines.map((line, index) => [line.extensionId, index]))
  const byId = new Map(lines.flatMap((line) => line.nodes.map((node) => [node.revisionId, node] as const)))
  const branchOf = new Map(lines.map((line) => [line.extensionId, line.branchOf?.revisionId]))

  const parentOf = (node: LineageNode): { readonly id: string; readonly kind: LineageEdge['kind'] } | undefined => {
    if (node.parentRevisionId !== undefined && byId.has(node.parentRevisionId)) {
      return { id: node.parentRevisionId, kind: 'version' }
    }
    const origin = branchOf.get(node.extensionId)
    // Only the first version of a branch (the one without a parent on its own line) hangs off the origin.
    if (node.parentRevisionId === undefined && origin !== undefined && byId.has(origin)) {
      return { id: origin, kind: 'branch' }
    }
    return undefined
  }

  const children = new Map<string, LineageNode[]>()
  const roots: LineageNode[] = []
  for (const node of byId.values()) {
    const parent = parentOf(node)
    if (parent === undefined) roots.push(node)
    else children.set(parent.id, [...(children.get(parent.id) ?? []), node])
  }

  // How strongly a subtree continues its line: holding the version in use wins, then the newest save on that line.
  const weight = new Map<string, number>()
  const weigh = (node: LineageNode): number => {
    const known = weight.get(node.revisionId)
    if (known !== undefined) return known
    let best = node.current ? Number.POSITIVE_INFINITY : node.createdAt
    for (const child of children.get(node.revisionId) ?? []) {
      if (child.extensionId === node.extensionId) best = Math.max(best, weigh(child))
    }
    weight.set(node.revisionId, best)
    return best
  }
  const ordered = (node: LineageNode): LineageNode[] =>
    [...(children.get(node.revisionId) ?? [])].sort((left, right) => {
      const sameLeft = left.extensionId === node.extensionId ? 0 : 1
      const sameRight = right.extensionId === node.extensionId ? 0 : 1
      return sameLeft - sameRight || (sameLeft === 0 ? weigh(right) - weigh(left) : left.createdAt - right.createdAt)
    })

  const placed = new Map<string, PlacedNode>()
  const edges: LineageEdge[] = []
  let rows = 0
  let columns = 0
  const place = (node: LineageNode, column: number, row: number) => {
    const entry: PlacedNode = { node, lane: lane.get(node.extensionId) ?? 0, column, row }
    placed.set(node.revisionId, entry)
    columns = Math.max(columns, column + 1)
    ordered(node).forEach((child, index) => {
      const continues = index === 0 && child.extensionId === node.extensionId
      const childRow = continues ? row : rows++
      place(child, column + 1, childRow)
      const to = placed.get(child.revisionId)!
      edges.push({ from: entry, to, kind: parentOf(child)?.kind ?? 'version' })
    })
  }
  for (const root of [...roots].sort((left, right) => (lane.get(left.extensionId) ?? 0) - (lane.get(right.extensionId) ?? 0) || left.createdAt - right.createdAt)) {
    place(root, 0, rows++)
  }
  return { nodes: [...placed.values()], edges, columns, rows }
}

/** Where a version came from, in a few words. */
export const originLabel: Record<LineageNode['origin'], string> = {
  authored: '智能体创造',
  file: '文件导入',
  community: '社区安装',
  branch: '分支创建',
}
