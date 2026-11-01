import type { HostApiResponse } from '@nekro-nxt/contracts'

export type LineageLine = HostApiResponse<'getExtensionLineage'>['lines'][number]
export type LineageNode = LineageLine['nodes'][number]

/** One row of the version timeline, newest first. */
export type TimelineRow =
  | { readonly kind: 'day'; readonly key: string; readonly label: string }
  | {
      readonly kind: 'node'
      readonly key: string
      readonly node: LineageNode
      /** Index of the node's line in the family, which picks its rail. */
      readonly lane: number
    }
  | {
      readonly kind: 'fold'
      readonly key: string
      readonly lane: number
      /** Newest first. */
      readonly nodes: readonly LineageNode[]
    }

export interface Timeline {
  readonly rows: readonly TimelineRow[]
  readonly lanes: number
  /** A branch's oldest row hangs off the version it was branched from. */
  readonly branches: readonly { readonly from: string; readonly to: string; readonly lane: number }[]
}

/** Versions that always get a row of their own: they are what people look for on the timeline. */
export const standsAlone = (node: LineageNode): boolean => node.current || node.protectedBy !== undefined

const MIN_FOLD = 2

const dayKey = (at: number) => {
  const date = new Date(at)
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

/** `今天`, `昨天`, `10月28日`, or with the year when it is not this year. */
export const dayLabel = (at: number, now: number): string => {
  if (dayKey(at) === dayKey(now)) return '今天'
  if (dayKey(at) === dayKey(now - 86_400_000)) return '昨天'
  const date = new Date(at)
  const day = `${date.getMonth() + 1}月${date.getDate()}日`
  return date.getFullYear() === new Date(now).getFullYear() ? day : `${date.getFullYear()}年${day}`
}

export const foldKey = (lane: number, newest: LineageNode) => `fold:${lane}:${newest.revisionId}`
export const nodeKey = (node: Pick<LineageNode, 'revisionId'>) => `node:${node.revisionId}`

/**
 * Lays the family out as one timeline, newest on top, each line on a rail of its own. The version in use, the newest
 * and oldest of each line, and every version something still needs keep their own row; runs of other versions fold
 * into one row until they are expanded. Days separate the rows.
 */
export function buildTimeline(
  lines: readonly LineageLine[],
  options: { readonly expanded: ReadonlySet<string>; readonly now: number },
): Timeline {
  type Item = Exclude<TimelineRow, { kind: 'day' }> & { readonly at: number }
  const items: Item[] = []
  const oldestOf = new Map<string, string>()
  lines.forEach((line, lane) => {
    const nodes = [...line.nodes].sort((left, right) => right.createdAt - left.createdAt)
    let run: LineageNode[] = []
    const flush = () => {
      const first = run[0]
      if (first !== undefined && run.length >= MIN_FOLD && !options.expanded.has(foldKey(lane, first)))
        items.push({ kind: 'fold', key: foldKey(lane, first), lane, nodes: run, at: first.createdAt })
      else for (const node of run) items.push({ kind: 'node', key: nodeKey(node), node, lane, at: node.createdAt })
      run = []
    }
    nodes.forEach((node, index) => {
      if (standsAlone(node) || index === 0 || index === nodes.length - 1) {
        flush()
        items.push({ kind: 'node', key: nodeKey(node), node, lane, at: node.createdAt })
      } else run.push(node)
    })
    flush()
    const oldest = nodes.at(-1)
    if (oldest !== undefined) oldestOf.set(line.extensionId, nodeKey(oldest))
  })
  items.sort((left, right) => right.at - left.at || left.lane - right.lane)

  const rows: TimelineRow[] = []
  let day: string | undefined
  for (const { at, ...item } of items) {
    if (dayKey(at) !== day) {
      day = dayKey(at)
      rows.push({ kind: 'day', key: `day:${day}`, label: dayLabel(at, options.now) })
    }
    rows.push(item)
  }

  const present = new Set(rows.map((row) => row.key))
  const branches = lines.flatMap((line, lane) => {
    const from = line.branchOf === undefined ? undefined : nodeKey(line.branchOf)
    const to = oldestOf.get(line.extensionId)
    return from !== undefined && to !== undefined && present.has(from) && present.has(to) ? [{ from, to, lane }] : []
  })
  return { rows, lanes: lines.length, branches }
}

/** Where a version came from, in a few words. */
export const originLabel: Record<LineageNode['origin'], string> = {
  authored: '智能体创造',
  file: '文件导入',
  community: '社区安装',
  branch: '分支创建',
}
