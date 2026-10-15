import { describe, expect, it } from 'vitest'
import { layoutLineage, type LineageLine } from '../src/app/workshop/lineage-model.ts'

const node = (
  extensionId: string,
  revisionId: string,
  label: string,
  createdAt: number,
  extra: { readonly parentRevisionId?: string; readonly current?: boolean } = {},
) =>
  ({
    revisionId,
    extensionId,
    label,
    origin: 'authored',
    createdAt,
    current: extra.current ?? false,
    releaseNumbers: [],
    ...(extra.parentRevisionId === undefined ? {} : { parentRevisionId: extra.parentRevisionId }),
  }) as LineageLine['nodes'][number]

const where = (layout: ReturnType<typeof layoutLineage>, revisionId: string) => {
  const entry = layout.nodes.find((item) => item.node.revisionId === revisionId)
  return entry === undefined ? undefined : { column: entry.column, row: entry.row, lane: entry.lane }
}

describe('layoutLineage', () => {
  it('keeps the line to the version in use on one row and opens rows for forks and branches of branches', () => {
    const lines = [
      {
        extensionId: 'ext_A',
        displayName: '原版',
        nodes: [
          node('ext_A', 'xrv_A1', 'v1', 1),
          node('ext_A', 'xrv_A2', 'v2', 2, { parentRevisionId: 'xrv_A1' }),
          // A second save of generation 2 that is not in use: it forks below.
          node('ext_A', 'xrv_A2b', 'v2·2', 3, { parentRevisionId: 'xrv_A1' }),
          node('ext_A', 'xrv_A3', 'v3', 4, { parentRevisionId: 'xrv_A2', current: true }),
        ],
      },
      {
        extensionId: 'ext_B',
        displayName: '分支',
        branchOf: { extensionId: 'ext_A', revisionId: 'xrv_A2' },
        nodes: [node('ext_B', 'xrv_B1', 'v1', 5), node('ext_B', 'xrv_B2', 'v2', 6, { parentRevisionId: 'xrv_B1' })],
      },
      {
        extensionId: 'ext_C',
        displayName: '分支的分支',
        branchOf: { extensionId: 'ext_B', revisionId: 'xrv_B1' },
        nodes: [node('ext_C', 'xrv_C1', 'v1', 7)],
      },
    ] as unknown as LineageLine[]
    const layout = layoutLineage(lines)
    expect(where(layout, 'xrv_A1')).toEqual({ column: 0, row: 0, lane: 0 })
    expect(where(layout, 'xrv_A2')).toEqual({ column: 1, row: 0, lane: 0 })
    expect(where(layout, 'xrv_A3')).toEqual({ column: 2, row: 0, lane: 0 })
    expect(where(layout, 'xrv_A2b')?.row).toBeGreaterThan(0)
    expect(where(layout, 'xrv_B1')).toMatchObject({ column: 2, lane: 1 })
    expect(where(layout, 'xrv_B2')).toMatchObject({ column: 3, row: where(layout, 'xrv_B1')?.row })
    expect(where(layout, 'xrv_C1')).toMatchObject({ column: 3, lane: 2 })
    expect(new Set(layout.nodes.map((entry) => `${entry.column}:${entry.row}`)).size).toBe(layout.nodes.length)
    expect(layout.edges.filter((edge) => edge.kind === 'branch').map((edge) => edge.to.node.revisionId).sort()).toEqual([
      'xrv_B1',
      'xrv_C1',
    ])
    expect(layout.columns).toBe(4)
  })

  it('starts a separate tree for a line whose origin is not on this machine and for a missing parent', () => {
    const layout = layoutLineage([
      {
        extensionId: 'ext_D',
        displayName: '分支',
        branchOf: { extensionId: 'ext_GONE', revisionId: 'xrv_GONE' },
        nodes: [node('ext_D', 'xrv_D2', 'v2', 2, { parentRevisionId: 'xrv_NOTHERE' })],
      },
    ] as unknown as LineageLine[])
    expect(where(layout, 'xrv_D2')).toEqual({ column: 0, row: 0, lane: 0 })
    expect(layout.edges).toEqual([])
  })
})
