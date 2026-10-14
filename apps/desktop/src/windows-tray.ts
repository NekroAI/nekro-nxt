import { Menu, Tray } from 'electron'
import { fileURLToPath } from 'node:url'
import type { WindowTrayActions } from './window-lifecycle.js'
import type { ProductRelease } from './distribution.js'

export const createWindowsTray = (
  channel: ProductRelease['channel'],
  productName: string,
  actions: WindowTrayActions,
): Tray => {
  const tray = new Tray(fileURLToPath(new URL(`./tray/${channel}.ico`, import.meta.url)))
  tray.setToolTip(productName)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示窗口', click: actions.show },
      { label: '退出', click: actions.quit },
    ]),
  )
  tray.on('double-click', actions.show)
  return tray
}
