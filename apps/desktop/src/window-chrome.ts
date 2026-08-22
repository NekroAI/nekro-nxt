import type { BrowserWindowConstructorOptions } from 'electron'

export const TITLE_BAR_HEIGHT = 48
export const MACOS_TRAFFIC_LIGHT_CLEARANCE = 84
export const WINDOW_CONTROLS_OVERLAY_CLEARANCE = 138

export const desktopWindowChrome = (
  platform: NodeJS.Platform,
): Pick<
  BrowserWindowConstructorOptions,
  'autoHideMenuBar' | 'frame' | 'titleBarOverlay' | 'titleBarStyle' | 'trafficLightPosition'
> => {
  if (platform === 'darwin') {
    return {
      autoHideMenuBar: true,
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 16 },
    }
  }
  return {
    autoHideMenuBar: true,
    frame: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      height: TITLE_BAR_HEIGHT,
      color: '#00000000',
      symbolColor: '#FFFDF9',
    },
  }
}

export const desktopTitleBarCss = (platform: NodeJS.Platform): string => {
  const left = platform === 'darwin' ? MACOS_TRAFFIC_LIGHT_CLEARANCE : 0
  const right = platform === 'darwin' ? 0 : WINDOW_CONTROLS_OVERLAY_CLEARANCE
  return `:root{--nxt-window-controls-left:${left}px!important;--nxt-window-controls-right:${right}px!important}`
}
