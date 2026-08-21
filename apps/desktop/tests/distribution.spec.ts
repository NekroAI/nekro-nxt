import { describe, expect, it } from 'vitest'
import {
  DESKTOP_DISTRIBUTION,
  desktopDataRoot,
  desktopUserDataRoot,
  isAllowedExternalUrl,
  isSameApplicationOrigin,
  parseProductRelease,
  resolveProductReleasePath,
} from '../src/distribution.ts'

describe('Desktop product distribution', () => {
  it('keeps one stable product identity and one data root outside the installation', () => {
    expect(DESKTOP_DISTRIBUTION).toEqual({
      appId: 'io.github.nekroai.nekronxt',
      appUserDataName: 'NekroNxt',
      productName: 'NekroNxt',
    })
    expect(desktopDataRoot('/application-data/NekroNxt')).toBe('/application-data/NekroNxt/data')
    expect(desktopUserDataRoot('/application-data', undefined)).toBe('/application-data/NekroNxt')
    expect(desktopUserDataRoot('/application-data', '/isolated/NekroNxt')).toBe('/isolated/NekroNxt')
    expect(() => desktopUserDataRoot('/application-data', 'relative-data')).toThrow('绝对路径')
    expect(resolveProductReleasePath('file:///Applications/NekroNxt.app/Contents/Resources/app.asar/main.mjs')).toBe(
      '/Applications/NekroNxt.app/Contents/Resources/app.asar/product-release.json',
    )
  })

  it('accepts only a complete atomic product Release manifest', () => {
    expect(
      parseProductRelease({
        format: 'nxt.product-release',
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
