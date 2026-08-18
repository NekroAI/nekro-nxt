import assert from 'node:assert/strict'
import test from 'node:test'

import { compareCounts, countsFromFindings } from '../lib/quality-baseline.mjs'

test('quality baselines count findings by rule and exact file', () => {
  assert.deepEqual(
    countsFromFindings([
      { rule: 'unsafe', file: 'packages/a/src/a.ts' },
      { rule: 'unsafe', file: 'packages/a/src/a.ts' },
      { rule: 'unsafe', file: 'packages/b/src/b.ts' },
      { rule: 'sql', file: 'packages/a/src/a.ts' },
    ]),
    {
      sql: { 'packages/a/src/a.ts': 1 },
      unsafe: { 'packages/a/src/a.ts': 2, 'packages/b/src/b.ts': 1 },
    },
  )
})

test('quality baselines allow decreases but reject new files and increases', () => {
  const baseline = { unsafe: { 'packages/a/src/a.ts': 2 } }
  assert.deepEqual(compareCounts({ unsafe: { 'packages/a/src/a.ts': 1 } }, baseline), [])
  assert.deepEqual(compareCounts({ unsafe: { 'packages/a/src/a.ts': 3 } }, baseline), [
    { rule: 'unsafe', file: 'packages/a/src/a.ts', count: 3, allowed: 2 },
  ])
  assert.deepEqual(compareCounts({ unsafe: { 'packages/new/src/index.ts': 1 } }, baseline), [
    { rule: 'unsafe', file: 'packages/new/src/index.ts', count: 1, allowed: 0 },
  ])
})
