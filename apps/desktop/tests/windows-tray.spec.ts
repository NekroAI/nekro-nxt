import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  class FakeTray {
    readonly icon: string
    tooltip = ''
    menu: unknown
    listeners = new Map<string, () => void>()

    constructor(icon: string) {
      this.icon = icon
    }

    setToolTip(value: string): void {
      this.tooltip = value
    }

    setContextMenu(value: unknown): void {
      this.menu = value
    }

    on(event: string, listener: () => void): void {
      this.listeners.set(event, listener)
    }
  }

  return {
    Menu: { buildFromTemplate: (template: unknown) => template },
    Tray: FakeTray,
  }
})

import { createWindowsTray } from '../src/windows-tray.ts'

describe('Windows tray', () => {
  it('exposes only show and quit actions', () => {
    const show = vi.fn()
    const quit = vi.fn()
    const tray = createWindowsTray('preview', 'NekroNXT Preview', { show, quit }) as unknown as {
      readonly icon: string
      readonly tooltip: string
      readonly menu: readonly { label: string; click: () => void }[]
    }

    expect(tray.icon).toContain('/tray/preview.ico')
    expect(tray.tooltip).toBe('NekroNXT Preview')
    expect(tray.menu.map((item) => item.label)).toEqual(['显示窗口', '退出'])
    tray.menu[0]?.click()
    tray.menu[1]?.click()
    expect(show).toHaveBeenCalledOnce()
    expect(quit).toHaveBeenCalledOnce()
  })
})
