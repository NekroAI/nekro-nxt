import { describe, expect, it, vi } from 'vitest'

interface MenuItem {
  readonly label: string
  readonly click: () => void
}

const created = vi.hoisted((): { icon: string; tooltip: string; menu: readonly MenuItem[] }[] => [])

vi.mock('electron', () => {
  class FakeTray {
    readonly icon: string
    tooltip = ''
    menu: readonly MenuItem[] = []
    listeners = new Map<string, () => void>()

    constructor(icon: string) {
      this.icon = icon
      created.push(this)
    }

    setToolTip(value: string): void {
      this.tooltip = value
    }

    setContextMenu(value: readonly MenuItem[]): void {
      this.menu = value
    }

    on(event: string, listener: () => void): void {
      this.listeners.set(event, listener)
    }
  }

  return {
    Menu: { buildFromTemplate: (template: readonly MenuItem[]) => template },
    Tray: FakeTray,
  }
})

import { createWindowsTray } from '../src/windows-tray.ts'

describe('Windows tray', () => {
  it('exposes only show and quit actions', () => {
    const show = vi.fn()
    const quit = vi.fn()
    createWindowsTray('preview', 'NekroNXT Preview', { show, quit })
    const tray = created[0]
    if (!tray) throw new Error('Tray was not created')

    expect(tray.icon).toContain('/tray/preview.ico')
    expect(tray.tooltip).toBe('NekroNXT Preview')
    expect(tray.menu.map((item) => item.label)).toEqual(['显示窗口', '退出'])
    tray.menu[0]?.click()
    tray.menu[1]?.click()
    expect(show).toHaveBeenCalledOnce()
    expect(quit).toHaveBeenCalledOnce()
  })
})
