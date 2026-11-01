import { describe, expect, it } from 'vitest'
import { HostApiContracts } from '@nekro-nxt/contracts'
import { buildTimeline, dayLabel, type LineageLine } from '../src/app/workshop/lineage-model.ts'

/** Fixture lines checked against the lineage response contract, so ids carry their brands. */
const family = (lines: readonly unknown[]): LineageLine[] =>
  HostApiContracts.getExtensionLineage.response.parse({ lines }).lines

const HOUR = 3_600_000
const NOW = new Date(2026, 10, 1, 18, 0).getTime()

const node = (
  extensionId: string,
  revisionId: string,
  createdAt: number,
  extra: { readonly current?: boolean; readonly protectedBy?: string } = {},
) => ({
  revisionId: `xrv_${revisionId}`,
  extensionId,
  label: revisionId,
  origin: 'authored',
  createdAt,
  current: extra.current ?? false,
  releaseNumbers: [],
  kept: extra.protectedBy === 'kept',
  ...(extra.protectedBy === undefined ? {} : { protectedBy: extra.protectedBy }),
})

const shape = (timeline: ReturnType<typeof buildTimeline>) =>
  timeline.rows.map((row) =>
    row.kind === 'day'
      ? row.label
      : row.kind === 'fold'
        ? `fold:${row.lane}:${row.nodes.map((item) => item.label).join(',')}`
        : `${row.lane}:${row.node.label}`,
  )

describe('buildTimeline', () => {
  const lines = family([
    {
      extensionId: 'ext_A',
      displayName: '原版',
      nodes: [
        node('ext_A', 'A1', NOW - 50 * HOUR, { protectedBy: 'released' }),
        node('ext_A', 'A2', NOW - 49 * HOUR),
        node('ext_A', 'A3', NOW - 48 * HOUR, { protectedBy: 'branch' }),
        node('ext_A', 'A4', NOW - 5 * HOUR),
        node('ext_A', 'A5', NOW - 4 * HOUR),
        node('ext_A', 'A6', NOW - 3 * HOUR),
        node('ext_A', 'A7', NOW - 1 * HOUR, { current: true, protectedBy: 'installed' }),
      ],
    },
    {
      extensionId: 'ext_B',
      displayName: '分支',
      branchOf: { extensionId: 'ext_A', revisionId: 'xrv_A3' },
      nodes: [node('ext_B', 'B1', NOW - 30 * HOUR), node('ext_B', 'B2', NOW - 2 * HOUR)],
    },
  ])

  it('folds runs of versions nothing needs, keeps the rest on their own rows and separates days', () => {
    const timeline = buildTimeline(lines, { expanded: new Set(), now: NOW })
    expect(shape(timeline)).toEqual([
      '今天',
      '0:A7',
      '1:B2',
      'fold:0:A6,A5,A4',
      '昨天',
      '1:B1',
      '10月30日',
      '0:A3',
      // A single version between two that stand alone is not worth a fold.
      '0:A2',
      '0:A1',
    ])
    expect(timeline.lanes).toBe(2)
    expect(timeline.branches).toEqual([{ from: 'node:xrv_A3', to: 'node:xrv_B1', lane: 1 }])
  })

  it('shows a fold version by version once it is expanded', () => {
    const timeline = buildTimeline(lines, { expanded: new Set(['fold:0:xrv_A6']), now: NOW })
    expect(shape(timeline).slice(0, 6)).toEqual(['今天', '0:A7', '1:B2', '0:A6', '0:A5', '0:A4'])
  })

  it('names days relative to today and adds the year only for other years', () => {
    expect(dayLabel(NOW - 2 * HOUR, NOW)).toBe('今天')
    expect(dayLabel(NOW - 24 * HOUR, NOW)).toBe('昨天')
    expect(dayLabel(new Date(2026, 9, 28).getTime(), NOW)).toBe('10月28日')
    expect(dayLabel(new Date(2025, 9, 28).getTime(), NOW)).toBe('2025年10月28日')
  })
})
