import { describe, expect, it } from 'vitest'
import { extensionManifestSchema, materializeImportedRevision } from '../src/index.js'

const manifest = (dict: Record<string, unknown>) => ({
  schemaVersion: 7,
  extensionId: 'ext_01AGENTCONFIGFIXTURE00000',
  revisionId: 'xrv_01AGENTCONFIGFIXTURE00000',
  entrypoints: { host: 'source/host.ts' },
  permissions: { permissions: [], networkOrigins: [] },
  contributions: [{ kind: 'tool', name: 'forecast', description: '查询示例天气' }],
  config: { agent: { schema: { type: 'object', dict } } },
})

const take = (dict: Record<string, unknown>) =>
  materializeImportedRevision({ manifest: manifest(dict), sources: { host: 'export default 1\n' } })

describe('agent configuration of a new revision', () => {
  it('refuses a required field without a default, since it can only be filled after enabling', () => {
    expect(() => take({ city: { type: 'string', meta: { required: true } } })).toThrow(
      'config.agent 的必填项要给默认值：city',
    )
  })

  it('accepts required fields with defaults and required credentials', () => {
    expect(() =>
      take({
        city: { type: 'string', meta: { required: true, default: '示例市' } },
        apiKey: { type: 'string', meta: { required: true, role: 'secret' } },
        note: { type: 'string', meta: {} },
      }),
    ).not.toThrow()
  })

  it('still reads a revision NekroNXT already has', () => {
    expect(
      extensionManifestSchema.safeParse(manifest({ city: { type: 'string', meta: { required: true } } })).success,
    ).toBe(true)
  })
})
