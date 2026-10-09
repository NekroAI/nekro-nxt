import { createHash } from 'node:crypto'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import {
  EXTENSION_ICON_MAX_BYTES,
  base64ToBytes,
  bytesToBase64,
  extensionIconContentType,
  extensionManifestSchema,
  materializeImportedRevision,
  parseExtensionImport,
  resourceContent,
  resourceDigest,
  revisionDigests,
  sha256Hex,
  validateExtensionIcon,
  verifyExtensionPackage,
} from '../src/index.js'

const HOST = 'export default 1\n'
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>'
const CSS = '.root { color: red; }\n'

const nodeSha = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')

/** 只含文件头与 IHDR 的虚构 PNG；校验只读文件头，不需要真实像素。 */
const png = (width: number, height: number, padding = 0): Uint8Array => {
  const bytes = new Uint8Array(33 + padding)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(bytes.buffer).setUint32(16, width)
  new DataView(bytes.buffer).setUint32(20, height)
  bytes.set([8, 6, 0, 0, 0], 24)
  return bytes
}

const riff = (chunk: string, body: number[]): Uint8Array => {
  const bytes = new Uint8Array(40)
  bytes.set(strToU8('RIFF'), 0)
  new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true)
  bytes.set(strToU8('WEBP'), 8)
  bytes.set(strToU8(chunk), 12)
  bytes.set(body, 20)
  return bytes
}

const webpVp8 = (width: number, height: number): Uint8Array =>
  riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, width & 255, width >> 8, height & 255, height >> 8])

const webpVp8l = (width: number, height: number): Uint8Array => {
  const bits = (width - 1) | ((height - 1) << 14)
  return riff('VP8L', [0x2f, bits & 255, (bits >> 8) & 255, (bits >> 16) & 255, (bits >>> 24) & 255])
}

const webpVp8x = (width: number, height: number): Uint8Array =>
  riff('VP8X', [
    0,
    0,
    0,
    0,
    (width - 1) & 255,
    ((width - 1) >> 8) & 255,
    (width - 1) >> 16,
    (height - 1) & 255,
    ((height - 1) >> 8) & 255,
    (height - 1) >> 16,
  ])

const agentManifest = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 7,
  extensionId: 'ext_01FORMATFIXTURE0000000000',
  revisionId: 'xrv_01FORMATFIXTURE0000000000',
  entrypoints: { host: 'source/host.ts' },
  permissions: { permissions: [], networkOrigins: [] },
  contributions: [{ kind: 'tool', name: 'forecast', description: '查询示例天气' }],
  ...overrides,
})

const buildPackage = (revisionManifest: Record<string, unknown>, assets: Record<string, Uint8Array>): Uint8Array => {
  const resources = Object.fromEntries(
    Object.entries(assets).map(([filePath, bytes]) => [filePath, resourceContent(filePath, bytes)]),
  )
  const { contentDigest, payloadDigest } = materializeImportedRevision({
    manifest: revisionManifest,
    sources: { host: HOST },
    resources,
  })
  const files: Record<string, Uint8Array> = {
    'revision/manifest.json': strToU8(JSON.stringify(revisionManifest)),
    'revision/source/host.ts': strToU8(HOST),
    ...Object.fromEntries(Object.entries(assets).map(([filePath, bytes]) => [`revision/${filePath}`, bytes])),
  }
  const transfer = {
    schemaVersion: 2,
    kind: 'nekro-nxt-extension',
    extension: {
      id: 'ext_01FORMATFIXTURE0000000000',
      slug: 'weather-fixture',
      displayName: '示例天气',
      description: '虚构的格式测试扩展。',
      createdAt: 1_790_000_000_000,
    },
    revision: {
      id: 'xrv_01FORMATFIXTURE0000000000',
      revisionNumber: 1,
      contentDigest,
      payloadDigest,
      createdAt: 1_790_000_000_000,
    },
    files: Object.entries(files).map(([filePath, content]) => ({
      path: filePath,
      size: content.byteLength,
      sha256: nodeSha(content),
    })),
    sourceVerification: null,
  }
  return zipSync({ 'manifest.json': strToU8(JSON.stringify(transfer)), ...files })
}

describe('base64 resources', () => {
  it('round-trips arbitrary bytes and matches Node', () => {
    for (const length of [0, 1, 2, 3, 4, 5, 255, 4096]) {
      const bytes = Uint8Array.from({ length }, (_, index) => (index * 37 + 11) % 256)
      const encoded = bytesToBase64(bytes)
      expect(encoded).toBe(Buffer.from(bytes).toString('base64'))
      expect(base64ToBytes(encoded)).toEqual(bytes)
    }
  })

  it('rejects non-canonical text so one icon has exactly one digest input', () => {
    expect(() => base64ToBytes('QQ')).toThrow()
    expect(() => base64ToBytes('QR==')).toThrow('规范')
    expect(() => base64ToBytes('QQ==\n')).toThrow()
    expect(() => base64ToBytes('Q Q==')).toThrow()
  })

  it('hashes binary icons by raw bytes and text resources by UTF-8', () => {
    const bytes = png(64, 64)
    expect(resourceDigest('assets/icon.png', bytesToBase64(bytes))).toBe(nodeSha(bytes))
    expect(resourceDigest('assets/icon.svg', SVG)).toBe(nodeSha(SVG))
    expect(resourceContent('assets/icon.webp', bytes)).toBe(bytesToBase64(bytes))
    expect(resourceContent('assets/icon.svg', strToU8(SVG))).toBe(SVG)
  })

  it('maps icon paths to content types', () => {
    expect(extensionIconContentType('assets/icon.png')).toBe('image/png')
    expect(extensionIconContentType('assets/icon.webp')).toBe('image/webp')
    expect(extensionIconContentType('assets/icon.svg')).toContain('image/svg+xml')
  })
})

describe('validateExtensionIcon', () => {
  const encode = (bytes: Uint8Array) => bytesToBase64(bytes)

  it('accepts square PNG and every WebP header between 64 and 512 pixels', () => {
    expect(() => validateExtensionIcon('assets/icon.png', encode(png(64, 64)))).not.toThrow()
    expect(() => validateExtensionIcon('assets/icon.png', encode(png(512, 512)))).not.toThrow()
    expect(() => validateExtensionIcon('assets/icon.webp', encode(webpVp8(128, 128)))).not.toThrow()
    expect(() => validateExtensionIcon('assets/icon.webp', encode(webpVp8l(256, 256)))).not.toThrow()
    expect(() => validateExtensionIcon('assets/icon.webp', encode(webpVp8x(300, 300)))).not.toThrow()
    expect(() => validateExtensionIcon('assets/icon.svg', SVG)).not.toThrow()
  })

  it('rejects wrong magic, non-square, out-of-range sizes and oversized files', () => {
    expect(() => validateExtensionIcon('assets/icon.png', encode(webpVp8(64, 64)))).toThrow('PNG')
    expect(() => validateExtensionIcon('assets/icon.webp', encode(png(64, 64)))).toThrow('WebP')
    expect(() => validateExtensionIcon('assets/icon.png', encode(png(64, 65)))).toThrow('正方形')
    expect(() => validateExtensionIcon('assets/icon.webp', encode(webpVp8l(100, 120)))).toThrow('正方形')
    expect(() => validateExtensionIcon('assets/icon.png', encode(png(32, 32)))).toThrow('64–512')
    expect(() => validateExtensionIcon('assets/icon.webp', encode(webpVp8x(1024, 1024)))).toThrow('64–512')
    expect(() => validateExtensionIcon('assets/icon.png', encode(png(128, 128, EXTENSION_ICON_MAX_BYTES)))).toThrow(
      '128 KiB',
    )
    expect(() => validateExtensionIcon('assets/icon.svg', '<svg><script/></svg>')).toThrow()
    expect(() => validateExtensionIcon('assets/logo.png', encode(png(64, 64)))).toThrow('路径')
  })
})

describe('manifest icon', () => {
  it('only accepts the three icon paths', () => {
    const icon = (iconPath: string) => ({ icon: { path: iconPath, sha256: 'a'.repeat(64) } })
    for (const iconPath of ['assets/icon.svg', 'assets/icon.png', 'assets/icon.webp']) {
      expect(extensionManifestSchema.safeParse(agentManifest(icon(iconPath))).success).toBe(true)
    }
    for (const iconPath of ['assets/icon.gif', 'assets/logo.png', 'icon.png']) {
      expect(extensionManifestSchema.safeParse(agentManifest(icon(iconPath))).success).toBe(false)
    }
  })

  it('pins V7 digests for packages without an icon', () => {
    expect(
      revisionDigests({
        manifest: extensionManifestSchema.parse(agentManifest()),
        sources: { host: HOST },
        resources: {},
      }),
    ).toEqual({
      contentDigest: 'd894a918eef437096d08e4049b22288fb852c2adc086c91cd64781aa29bc79ba',
      payloadDigest: '25eede4c9c92f61111859374496dd9919ddf99f8ceb20102cb3eb796aa189da4',
    })
    const page = {
      schemaVersion: 7,
      extensionId: 'ext_01FORMATFIXTURE0000000000',
      revisionId: 'xrv_01FORMATFIXTURE0000000000',
      entrypoints: { client: 'source/client.ts' },
      clientCss: { path: 'assets/page.module.css', sha256: sha256Hex(CSS) },
      permissions: { permissions: [], networkOrigins: [] },
      contributions: [
        {
          kind: 'host-page',
          entryId: 'board',
          objectPane: 'hidden',
          startPath: '',
          title: '示例看板',
          icon: { kind: 'svg', path: 'assets/board.svg', sha256: sha256Hex(SVG) },
        },
      ],
    }
    expect(
      materializeImportedRevision({
        manifest: page,
        sources: { client: HOST },
        resources: { 'assets/page.module.css': CSS, 'assets/board.svg': SVG },
      }).contentDigest,
    ).toBe('c54df6a32fbfbaf7dc75b4e49bfa2f88bb8e0950c4f41a99a4519483fe2eced7')
  })

  it('covers the icon in both digests', () => {
    const base = materializeImportedRevision({ manifest: agentManifest(), sources: { host: HOST }, resources: {} })
    const withIcon = materializeImportedRevision({
      manifest: agentManifest({ icon: { path: 'assets/icon.svg', sha256: sha256Hex(SVG) } }),
      sources: { host: HOST },
      resources: { 'assets/icon.svg': SVG },
    })
    expect(withIcon.contentDigest).not.toBe(base.contentDigest)
    expect(withIcon.payloadDigest).not.toBe(base.payloadDigest)
    expect(withIcon.manifest.icon?.path).toBe('assets/icon.svg')
  })

  it('rejects icons that are missing, undeclared, tampered or invalid', () => {
    const bytes = png(96, 96)
    const declared = agentManifest({ icon: { path: 'assets/icon.png', sha256: nodeSha(bytes) } })
    expect(() => materializeImportedRevision({ manifest: declared, sources: { host: HOST }, resources: {} })).toThrow(
      '资源文件与 Manifest 声明不一致',
    )
    expect(() =>
      materializeImportedRevision({
        manifest: agentManifest(),
        sources: { host: HOST },
        resources: { 'assets/icon.png': bytesToBase64(bytes) },
      }),
    ).toThrow('资源文件与 Manifest 声明不一致')
    expect(() =>
      materializeImportedRevision({
        manifest: declared,
        sources: { host: HOST },
        resources: { 'assets/icon.png': bytesToBase64(png(96, 96, 1)) },
      }),
    ).toThrow('资源摘要不一致')
    expect(() =>
      materializeImportedRevision({
        manifest: declared,
        sources: { host: HOST },
        resources: { 'assets/icon.png': 'not base64!' },
      }),
    ).toThrow('资源编码无效')
    const small = png(16, 16)
    expect(() =>
      materializeImportedRevision({
        manifest: agentManifest({ icon: { path: 'assets/icon.png', sha256: nodeSha(small) } }),
        sources: { host: HOST },
        resources: { 'assets/icon.png': bytesToBase64(small) },
      }),
    ).toThrow('64–512')
  })
})

describe('packages with an icon', () => {
  it('stores raw PNG bytes in the zip and base64 in memory', () => {
    const bytes = png(128, 128, 64)
    const archive = buildPackage(agentManifest({ icon: { path: 'assets/icon.png', sha256: nodeSha(bytes) } }), {
      'assets/icon.png': bytes,
    })
    expect(unzipSync(archive)['revision/assets/icon.png']).toEqual(bytes)
    const parsed = parseExtensionImport(archive)
    expect(parsed.resources['assets/icon.png']).toBe(bytesToBase64(bytes))
    const verified = verifyExtensionPackage(archive)
    expect(verified.revision.manifest.icon).toEqual({ path: 'assets/icon.png', sha256: nodeSha(bytes) })
    expect(verified.revision.resources?.['assets/icon.png']).toBe(bytesToBase64(bytes))
  })

  it('accepts SVG and WebP icons', () => {
    const svg = strToU8(SVG)
    expect(
      verifyExtensionPackage(
        buildPackage(agentManifest({ icon: { path: 'assets/icon.svg', sha256: nodeSha(svg) } }), {
          'assets/icon.svg': svg,
        }),
      ).revision.resources?.['assets/icon.svg'],
    ).toBe(SVG)
    const webp = webpVp8x(200, 200)
    expect(() =>
      verifyExtensionPackage(
        buildPackage(agentManifest({ icon: { path: 'assets/icon.webp', sha256: nodeSha(webp) } }), {
          'assets/icon.webp': webp,
        }),
      ),
    ).not.toThrow()
  })
})
