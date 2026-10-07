import { createHash } from 'node:crypto'
import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import {
  canonicalJson,
  extensionManifestSchema,
  revisionDigests,
  sha256Hex,
  verifyExtensionPackage,
} from '../src/index.js'

const HOST = `import { defineHostExtension } from '@nekro-nxt/extension-sdk'

export default defineHostExtension(async ({ harness }) => {
  harness.tool('forecast', async () => ({ city: '示例市', weather: '晴' }))
})
`

const manifest = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 6,
  scope: 'agent',
  extensionId: 'ext_01FORMATFIXTURE0000000000',
  revisionId: 'xrv_01FORMATFIXTURE0000000000',
  entrypoints: { host: 'source/host.ts' },
  permissions: { permissions: [], networkOrigins: [] },
  contributions: [{ kind: 'tool', name: 'forecast', description: '查询示例天气' }],
  ...overrides,
})

const buildPackage = (
  options: {
    readonly manifest?: Record<string, unknown>
    readonly host?: string
    readonly transfer?: (value: Record<string, unknown>) => Record<string, unknown>
  } = {},
): Uint8Array => {
  const revisionManifest = options.manifest ?? manifest()
  const host = options.host ?? HOST
  const digests = revisionDigests({
    manifest: extensionManifestSchema.parse(manifest()),
    sources: { host: HOST },
    resources: {},
  })
  const files: Record<string, Uint8Array> = {
    'revision/manifest.json': strToU8(JSON.stringify(revisionManifest)),
    'revision/source/host.ts': strToU8(host),
  }
  const transfer: Record<string, unknown> = {
    schemaVersion: 1,
    kind: 'nekro-nxt-extension',
    extension: {
      id: 'ext_01FORMATFIXTURE0000000000',
      scope: 'agent',
      slug: 'weather-fixture',
      displayName: '示例天气',
      description: '虚构的格式测试扩展。',
      createdAt: 1_790_000_000_000,
    },
    revision: {
      id: 'xrv_01FORMATFIXTURE0000000000',
      revisionNumber: 1,
      ...digests,
      createdAt: 1_790_000_000_000,
    },
    files: Object.entries(files).map(([path, content]) => ({
      path,
      size: content.byteLength,
      sha256: sha256Hex(content),
    })),
    sourceVerification: null,
  }
  return zipSync({
    'manifest.json': strToU8(JSON.stringify(options.transfer ? options.transfer(transfer) : transfer)),
    ...files,
  })
}

describe('sha256Hex', () => {
  it('matches Node for text and bytes, so existing digests stay valid', () => {
    for (const value of ['', 'abc', '示例天气 🌤', 'a\r\nb\n'.repeat(1000)]) {
      expect(sha256Hex(value)).toBe(createHash('sha256').update(value).digest('hex'))
    }
    const bytes = Uint8Array.from({ length: 4096 }, (_, index) => (index * 31) % 256)
    expect(sha256Hex(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'))
  })
})

describe('canonicalJson', () => {
  it('orders object keys at every level and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: null } })).toBe('{"a":{"c":null,"d":[2,1]},"b":1}')
  })
})

describe('verifyExtensionPackage', () => {
  it('accepts a package whose manifest, sources and digests agree', () => {
    const verified = verifyExtensionPackage(buildPackage())
    expect(verified.transfer.extension.slug).toBe('weather-fixture')
    expect(verified.revision.scope).toBe('agent')
    expect(verified.revision.sources.host).toBe(HOST)
  })

  it('normalizes line endings before hashing', () => {
    const windows = HOST.replaceAll('\n', '\r\n')
    expect(() => verifyExtensionPackage(buildPackage({ host: windows }))).not.toThrow()
  })

  it('rejects packages NekroNXT would refuse to import', () => {
    expect(() => verifyExtensionPackage(buildPackage({ host: `${HOST}// 改动\n` }))).toThrow('内容摘要不一致')
    expect(() =>
      verifyExtensionPackage(buildPackage({ manifest: manifest({ revisionId: 'xrv_01OTHER0000000000000000000' }) })),
    ).toThrow('身份')
    expect(() =>
      verifyExtensionPackage(
        buildPackage({
          transfer: (value) => ({ ...value, extension: { ...Object(value['extension']), scope: 'host-ui' } }),
        }),
      ),
    ).toThrow('scope')
    expect(() => verifyExtensionPackage(buildPackage({ manifest: manifest({ unknownField: true }) }))).toThrow()
    expect(() => verifyExtensionPackage(new Uint8Array([1, 2, 3]))).toThrow()
  })
})
