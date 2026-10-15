import { describe, expect, it } from 'vitest'
import { ExtensionIdSchema, ExtensionRevisionIdSchema } from '@nekro-nxt/contracts'
import {
  EXTENSION_LINEAGE_MAX_ANCESTRY,
  extensionManifestSchema,
  isFastForward,
  lineageAfter,
  lineageDepth,
  lineageOfBranch,
  lineageRelation,
  revisionDigests,
  type LineageNode,
} from '../src/index.js'

const rev = (n: number) => ExtensionRevisionIdSchema.parse(`xrv_01LINEAGE${String(n).padStart(16, '0')}`)

/** A straight line v1 → … → vN, returned as nodes in order. */
const line = (count: number, offset = 0): LineageNode[] => {
  const nodes: LineageNode[] = [{ revisionId: rev(offset + 1), lineage: { parent: null, ancestry: [] } }]
  for (let index = 1; index < count; index += 1) {
    nodes.push({ revisionId: rev(offset + index + 1), lineage: lineageAfter(nodes.at(-1)!) })
  }
  return nodes
}

const manifest = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 7,
  extensionId: 'ext_01LINEAGEFIXTURE000000000',
  revisionId: rev(99),
  entrypoints: { host: 'source/host.ts' },
  permissions: { permissions: [], networkOrigins: [] },
  contributions: [{ kind: 'tool', name: 'roll', description: '掷骰子' }],
  ...overrides,
})

describe('lineage helpers', () => {
  it('numbers versions by depth and keeps the newest ancestors first', () => {
    const nodes = line(3)
    expect(nodes.map((node) => lineageDepth(node.lineage))).toEqual([1, 2, 3])
    expect(nodes[2]!.lineage).toEqual({ parent: rev(2), ancestry: [rev(2), rev(1)] })
  })

  it('drops the oldest ancestors past the limit', () => {
    const nodes = line(EXTENSION_LINEAGE_MAX_ANCESTRY + 5)
    const last = nodes.at(-1)!.lineage!
    expect(last.ancestry).toHaveLength(EXTENSION_LINEAGE_MAX_ANCESTRY)
    expect(last.ancestry[0]).toBe(last.parent)
    expect(last.ancestry).not.toContain(rev(1))
  })

  it('tells fast-forward, divergence and unrelated lines apart', () => {
    const [v1, v2, v3] = line(3)
    const fork: LineageNode = { revisionId: rev(50), lineage: lineageAfter(v2!) }
    expect(lineageRelation(v3!, v3!)).toBe('same')
    expect(lineageRelation(v2!, v3!)).toBe('remote-ahead')
    expect(lineageRelation(v3!, v1!)).toBe('local-ahead')
    expect(lineageRelation(fork, v3!)).toBe('diverged')
    expect(lineageRelation(line(2, 200)[1]!, v3!)).toBe('unrelated')
    expect(isFastForward(v3!, v2!)).toBe(true)
    expect(isFastForward(fork, v3!)).toBe(false)
  })

  it('starts a branch as a new line that remembers its origin, and branches keep it', () => {
    const [, v2] = line(2)
    const branch = lineageOfBranch({
      extensionId: ExtensionIdSchema.parse('ext_01ORIGIN0000000000000000'),
      revisionId: v2!.revisionId,
    })
    expect(branch).toEqual({
      parent: null,
      ancestry: [],
      branchOf: { extensionId: 'ext_01ORIGIN0000000000000000', revisionId: v2!.revisionId },
    })
    expect(lineageAfter({ revisionId: rev(60), lineage: branch }).branchOf).toEqual(branch.branchOf)
  })
})

describe('manifest lineage and data version', () => {
  it('needs the governance SDK level and a consistent ancestry', () => {
    const lineage = { parent: rev(1), ancestry: [rev(1)] }
    expect(extensionManifestSchema.safeParse(manifest({ lineage })).success).toBe(false)
    expect(extensionManifestSchema.safeParse(manifest({ lineage, requires: { sdk: 10 } })).success).toBe(true)
    expect(
      extensionManifestSchema.safeParse(
        manifest({ lineage: { parent: rev(1), ancestry: [rev(2)] }, requires: { sdk: 10 } }),
      ).success,
    ).toBe(false)
    expect(
      extensionManifestSchema.safeParse(
        manifest({ lineage: { parent: rev(99), ancestry: [rev(99)] }, requires: { sdk: 10 } }),
      ).success,
    ).toBe(false)
    expect(extensionManifestSchema.safeParse(manifest({ dataVersion: 2 })).success).toBe(false)
    expect(extensionManifestSchema.safeParse(manifest({ dataVersion: 2, requires: { sdk: 10 } })).success).toBe(true)
  })

  it('counts the data version as behaviour but not the lineage', () => {
    const base = extensionManifestSchema.parse(manifest({ requires: { sdk: 10 } }))
    const digest = (value: Record<string, unknown>) =>
      revisionDigests({ manifest: extensionManifestSchema.parse(value), sources: { host: 'x\n' }, resources: {} })
    const plain = digest(base)
    const withLineage = digest({ ...base, lineage: { parent: rev(1), ancestry: [rev(1)] } })
    const withData = digest({ ...base, dataVersion: 2 })
    expect(withLineage.payloadDigest).toBe(plain.payloadDigest)
    expect(withLineage.contentDigest).not.toBe(plain.contentDigest)
    expect(withData.payloadDigest).not.toBe(plain.payloadDigest)
  })

  it('accepts administrator commands only at the governance level', () => {
    const command = { kind: 'command', name: 'purge', description: '清空', minimumPermission: 'admin' }
    expect(
      extensionManifestSchema.safeParse(manifest({ contributions: [command], requires: { sdk: 9 } })).success,
    ).toBe(false)
    expect(
      extensionManifestSchema.safeParse(manifest({ contributions: [command], requires: { sdk: 10 } })).success,
    ).toBe(true)
  })
})
