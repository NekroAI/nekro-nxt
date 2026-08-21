import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  desktopDataRoot,
  desktopUserDataRoot,
  getDesktopDistribution,
  isAllowedExternalUrl,
  isSameApplicationOrigin,
  parseProductRelease,
  resolveProductReleasePath,
} from '../src/distribution.ts'

describe('Desktop product distribution', () => {
  it('uses a memory-safe NSIS per-user installation path lookup', () => {
    const require = createRequire(import.meta.url)
    const electronBuilderPackagePath = require.resolve('electron-builder/package.json')
    const electronBuilderRequire = createRequire(electronBuilderPackagePath)
    const appBuilderLibPackagePath = electronBuilderRequire.resolve('app-builder-lib/package.json')
    const multiUserTemplate = readFileSync(
      path.join(path.dirname(appBuilderLibPackagePath), 'templates/nsis/multiUser.nsh'),
      'utf8',
    )

    expect(multiUserTemplate).toContain('KERNEL32::lstrcpynW')
    expect(multiUserTemplate).not.toContain('*$2(&w${NSIS_MAX_STRLEN} .s)')
  })

  it('keeps one stable product identity and one data root outside the installation', () => {
    const stable = getDesktopDistribution('stable')
    const preview = getDesktopDistribution('preview')
    expect(stable).toMatchObject({
      appId: 'ai.nekro.nxt',
      appUserDataName: 'NekroNxt',
      productName: 'NekroNxt',
    })
    expect(preview).toMatchObject({
      appId: 'ai.nekro.nxt.preview',
      appUserDataName: 'NekroNxt Preview',
      productName: 'NekroNxt Preview',
    })
    expect(preview.nsisGuid).not.toBe(stable.nsisGuid)
    expect(desktopDataRoot('/application-data/NekroNxt')).toBe('/application-data/NekroNxt/data')
    expect(desktopUserDataRoot('/application-data', stable, undefined)).toBe('/application-data/NekroNxt')
    expect(desktopUserDataRoot('/application-data', preview, undefined)).toBe('/application-data/NekroNxt Preview')
    expect(desktopUserDataRoot('/application-data', stable, '/isolated/NekroNxt')).toBe('/isolated/NekroNxt')
    expect(() => desktopUserDataRoot('/application-data', stable, 'relative-data')).toThrow('绝对路径')
    expect(resolveProductReleasePath('file:///Applications/NekroNxt.app/Contents/Resources/app.asar/main.mjs')).toBe(
      '/Applications/NekroNxt.app/Contents/Resources/app.asar/product-release.json',
    )
  })

  it('accepts only a complete atomic product Release manifest', () => {
    expect(
      parseProductRelease({
        format: 'nxt.product-release',
        channel: 'stable',
        baseVersion: '0.1.0',
        version: '0.1.0',
        commit: 'a'.repeat(40),
        releaseId: '0.1.0+aaaaaaaaaaaa',
        dshVersion: '0.1.0-rc.6',
      }),
    ).toMatchObject({ releaseId: '0.1.0+aaaaaaaaaaaa', dshVersion: '0.1.0-rc.6' })
    expect(() => parseProductRelease({ format: 'nxt.product-release', version: '0.1.0' })).toThrow()
  })

  it('keeps the BrowserWindow on its local Host origin', () => {
    expect(isSameApplicationOrigin('http://127.0.0.1:4962', 'http://127.0.0.1:4962/work/channels/demo')).toBe(true)
    expect(isSameApplicationOrigin('http://127.0.0.1:4962', 'http://127.0.0.1:4960/api/snapshot')).toBe(false)
    expect(isAllowedExternalUrl('https://example.invalid/guide')).toBe(true)
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false)
  })
})
