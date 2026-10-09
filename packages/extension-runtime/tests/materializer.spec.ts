import { configSchema, ExtensionIdSchema, ExtensionRevisionIdSchema } from '@nekro-nxt/contracts'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  materializeDynamicPackage,
  materializeImportedRevision,
  type DynamicPackageSnapshot,
  verifyExtensionPackage,
} from '../src/index.js'

import { createStylesArchive } from './fixtures/host-ui-styles-archive.js'
import { stylesCss } from './fixtures/host-ui-styles.js'

const page = {
  kind: 'host-page',
  entryId: 'overview',
  title: '项目面板',
  icon: { kind: 'host-icon', name: 'layout-dashboard' },
  objectPane: 'hidden',
  startPath: '',
} as const
const adapter = { kind: 'adapter' as const, apiVersion: 2 as const, key: 'example', descriptorDigest: 'a'.repeat(64) }
const tool = { kind: 'tool' as const, name: 'lookup', description: '查询示例数据' }
const css = '.panel { color: var(--nxt-text-primary); }\n'
const cssDigest = createHash('sha256').update(css).digest('hex')

const materialize = (snapshot: Partial<DynamicPackageSnapshot>) =>
  materializeDynamicPackage({
    extensionId: ExtensionIdSchema.parse('ext_materializer'),
    revisionId: ExtensionRevisionIdSchema.parse('xrv_materializer'),
    snapshot: { name: '物化探针', purpose: '验证动态包规则。', ...snapshot },
  })

describe('materializeDynamicPackage', () => {
  it('combines agent and host contributions without scope and derives provides', () => {
    const saved = materialize({ hostCode: 'return {}', clientCode: 'return {}', contributions: [adapter, tool, page] })
    expect(saved.manifest.schemaVersion).toBe(7)
    expect(saved.manifest).not.toHaveProperty('scope')
    expect(saved.provides).toEqual(['agent', 'page', 'adapter'])
    const imported = materializeImportedRevision({ manifest: saved.manifest, sources: saved.sources })
    expect(imported.provides).toEqual(saved.provides)
    expect(imported.contentDigest).toBe(saved.contentDigest)
  })

  it('requires source halves used by contributions and a Client for CSS', () => {
    expect(() => materialize({ clientCode: 'return {}', contributions: [adapter, page] })).toThrow('需要 Host 源码')
    expect(() => materialize({ hostCode: 'return {}', contributions: [page] })).toThrow('界面贡献需要 Client 源码')
    expect(() =>
      materialize({
        hostCode: 'return {}',
        contributions: [tool],
        clientCss: { path: 'assets/panel.module.css', sha256: cssDigest },
      }),
    ).toThrow('Client CSS 需要同时提交 Client 源码')
  })

  it('carries layered permissions and config into the Manifest', () => {
    const permissions = {
      permissions: [],
      networkOrigins: [],
      host: { storage: {} },
      agent: { history: { read: true as const } },
    }
    const config = {
      host: { schema: configSchema.object({ endpoint: configSchema.string('地址') }) },
      agent: { schema: configSchema.object({ city: configSchema.string('城市') }) },
    }
    const saved = materialize({ hostCode: 'return {}', contributions: [tool], permissions, config })
    expect(saved.manifest.permissions).toEqual(permissions)
    expect(saved.manifest.config).toEqual(config)
    expect(materializeImportedRevision({ manifest: saved.manifest, sources: saved.sources }).contentDigest).toBe(
      saved.contentDigest,
    )
  })

  it('generates a valid transfer v2 archive from the V7 styles fixture', () => {
    const { archive, extensionId, revisionId } = createStylesArchive('FORMAT')
    const verified = verifyExtensionPackage(archive)
    expect(verified.transfer.schemaVersion).toBe(2)
    expect(verified.transfer.extension).not.toHaveProperty('scope')
    expect(verified.revision.manifest).toMatchObject({ schemaVersion: 7, extensionId, revisionId })
    expect(verified.revision.provides).toEqual(['page'])
    expect(verified.revision.resources?.['assets/probe.module.css']).toBe(stylesCss)
  })

  it('checks declared resources against the files and their digests', () => {
    const withCss = { clientCode: 'return {}', contributions: [page] }
    const clientCss = { path: 'assets/panel.module.css', sha256: cssDigest }
    expect(() => materialize({ ...withCss, clientCss })).toThrow('资源文件与 Manifest 声明不一致')
    expect(() => materialize({ ...withCss, clientCss, resources: { 'assets/other.module.css': css } })).toThrow(
      '动态扩展缺少资源',
    )
    expect(() =>
      materialize({ ...withCss, clientCss, resources: { 'assets/panel.module.css': `${css}/* 改动 */\n` } }),
    ).toThrow('动态扩展资源摘要不一致')
    const ok = materialize({ ...withCss, clientCss, resources: { 'assets/panel.module.css': css } })
    expect(ok.provides).toEqual(['page'])
  })

  it('carries an extension icon into the Manifest and validates it like an import', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>'
    const icon = { path: 'assets/icon.svg' as const, sha256: createHash('sha256').update(svg).digest('hex') }
    const saved = materialize({
      hostCode: 'return {}',
      contributions: [tool],
      icon,
      resources: { 'assets/icon.svg': svg },
    })
    expect(saved.manifest.icon).toEqual(icon)
    const imported = materializeImportedRevision({
      manifest: saved.manifest,
      sources: saved.sources,
      resources: { 'assets/icon.svg': svg },
    })
    expect(imported.contentDigest).toBe(saved.contentDigest)
    expect(() => materialize({ hostCode: 'return {}', contributions: [tool], icon })).toThrow(
      '资源文件与 Manifest 声明不一致',
    )
    expect(() =>
      materialize({
        hostCode: 'return {}',
        contributions: [tool],
        icon,
        resources: { 'assets/icon.svg': '<svg viewBox="0 0 24 24"><script/></svg>' },
      }),
    ).toThrow('动态扩展资源摘要不一致')
  })

  it('produces digests that an import of the same content reproduces', () => {
    const saved = materialize({ hostCode: 'return {}', contributions: [tool] })
    const imported = materializeImportedRevision({ manifest: saved.manifest, sources: saved.sources })
    expect(imported.contentDigest).toBe(saved.contentDigest)
    expect(imported.payloadDigest).toBe(saved.payloadDigest)
  })
})
