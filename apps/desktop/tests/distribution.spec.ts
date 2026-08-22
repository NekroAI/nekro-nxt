import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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
import {
  MACOS_TRAFFIC_LIGHT_CLEARANCE,
  TITLE_BAR_HEIGHT,
  WINDOW_CONTROLS_OVERLAY_CLEARANCE,
  desktopTitleBarCss,
  desktopWindowChrome,
} from '../src/window-chrome.ts'

const readPngMetrics = (file: string): { width: number; height: number; pixelsPerMeter?: [number, number] } => {
  const png = readFileSync(file)
  expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  let width = 0
  let height = 0
  let pixelsPerMeter: [number, number] | undefined
  for (let offset = 8; offset + 12 <= png.length;) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('ascii', offset + 4, offset + 8)
    const data = offset + 8
    if (type === 'IHDR') {
      width = png.readUInt32BE(data)
      height = png.readUInt32BE(data + 4)
    } else if (type === 'pHYs' && length === 9 && png.readUInt8(data + 8) === 1) {
      pixelsPerMeter = [png.readUInt32BE(data), png.readUInt32BE(data + 4)]
    }
    offset += length + 12
  }
  return pixelsPerMeter === undefined ? { width, height } : { width, height, pixelsPerMeter }
}

describe('Desktop product distribution', () => {
  it('uses one custom title bar coordinate system with platform control clearances', () => {
    expect(desktopWindowChrome('darwin')).toMatchObject({
      autoHideMenuBar: true,
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 16 },
    })
    expect(desktopWindowChrome('win32')).toMatchObject({
      autoHideMenuBar: true,
      frame: false,
      titleBarStyle: 'hidden',
      titleBarOverlay: { height: TITLE_BAR_HEIGHT, color: '#00000000', symbolColor: '#FFFDF9' },
    })
    expect(desktopWindowChrome('linux')).toEqual(desktopWindowChrome('win32'))
    expect(desktopTitleBarCss('darwin')).toContain(`--nxt-window-controls-left:${MACOS_TRAFFIC_LIGHT_CLEARANCE}px`)
    expect(desktopTitleBarCss('win32')).toContain(`--nxt-window-controls-right:${WINDOW_CONTROLS_OVERLAY_CLEARANCE}px`)
    expect(desktopTitleBarCss('darwin')).toContain('!important')
  })

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

  it('ships complete branded build resources for stable and preview', () => {
    const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    for (const channel of ['stable', 'preview']) {
      const buildRoot = path.join(desktopRoot, 'resources', channel)
      for (const file of [
        'icon.icns',
        'icon.ico',
        'dmg-background.png',
        'installerIcon.ico',
        'uninstallerIcon.ico',
        'installerSidebar.bmp',
        'uninstallerSidebar.bmp',
        'installerHeader.bmp',
        'icons/16x16.png',
        'icons/512x512.png',
      ]) {
        expect(existsSync(path.join(buildRoot, file)), `${channel}/${file}`).toBe(true)
      }
      const ico = readFileSync(path.join(buildRoot, 'icon.ico'))
      expect(ico.readUInt16LE(4)).toBe(9)
      const dmgBackground = readPngMetrics(path.join(buildRoot, 'dmg-background.png'))
      expect(dmgBackground).toMatchObject({ width: 660, height: 420 })
      expect(dmgBackground.pixelsPerMeter?.[0]).toBeGreaterThanOrEqual(2834)
      expect(dmgBackground.pixelsPerMeter?.[0]).toBeLessThanOrEqual(2836)
      expect(dmgBackground.pixelsPerMeter?.[1]).toBeGreaterThanOrEqual(2834)
      expect(dmgBackground.pixelsPerMeter?.[1]).toBeLessThanOrEqual(2836)
      const sidebar = readFileSync(path.join(buildRoot, 'installerSidebar.bmp'))
      expect([sidebar.readInt32LE(18), sidebar.readInt32LE(22), sidebar.readUInt16LE(28)]).toEqual([164, 314, 24])
    }
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
        dshVersion: '0.1.1-rc.2',
      }),
    ).toMatchObject({ releaseId: '0.1.0+aaaaaaaaaaaa', dshVersion: '0.1.1-rc.2' })
    expect(() => parseProductRelease({ format: 'nxt.product-release', version: '0.1.0' })).toThrow()
  })

  it('keeps the BrowserWindow on its local Host origin', () => {
    expect(isSameApplicationOrigin('http://127.0.0.1:4962', 'http://127.0.0.1:4962/work/channels/demo')).toBe(true)
    expect(isSameApplicationOrigin('http://127.0.0.1:4962', 'http://127.0.0.1:4960/api/snapshot')).toBe(false)
    expect(isAllowedExternalUrl('https://example.invalid/guide')).toBe(true)
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false)
  })
})
