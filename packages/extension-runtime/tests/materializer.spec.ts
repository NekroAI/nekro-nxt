import { ExtensionIdSchema, ExtensionRevisionIdSchema } from '@nekro-nxt/contracts'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { materializeDynamicPackage, materializeImportedRevision, type DynamicPackageSnapshot } from '../src/index.js'

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
  it('rejects mixed or incomplete scopes', () => {
    expect(() => materialize({ clientCode: 'return {}', contributions: [adapter] })).toThrow('必须包含 Host Adapter')
    expect(() => materialize({ hostCode: 'return {}', contributions: [adapter, tool] })).toThrow('不能混装')
    expect(() => materialize({ hostCode: 'return {}', contributions: [tool, page] })).toThrow('不能贡献顶级页面')
    expect(() => materialize({ hostCode: 'return {}', contributions: [page] })).toThrow('页面 Revision 必须包含 Client')
    expect(() =>
      materialize({ hostCode: 'return {}', clientCss: { path: 'assets/panel.module.css', sha256: cssDigest } }),
    ).toThrow('Client CSS 需要同时提交 Client 源码')
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
    expect(ok.scope).toBe('host-ui')
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
