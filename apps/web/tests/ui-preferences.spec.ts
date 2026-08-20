import { describe, expect, it } from 'vitest'
import { INSPECTOR_WIDTH, OBJECT_PANE_WIDTH, clampUiWidth, parseUiPreferences } from '../src/ui-preferences.js'

describe('UI preferences', () => {
  it('clamps widths and recovers individual invalid fields', () => {
    expect(clampUiWidth(120, OBJECT_PANE_WIDTH, 240)).toBe(200)
    expect(clampUiWidth(999, INSPECTOR_WIDTH, 360)).toBe(520)
    expect(
      parseUiPreferences({
        version: 1,
        layout: {
          objectPaneWidth: 280.4,
          objectPaneCollapsed: true,
          inspectorWidth: 'bad',
          inspectorCollapsed: true,
        },
        appearance: { reducedTransparency: true, contrast: 'more' },
      }),
    ).toEqual({
      version: 1,
      layout: { objectPaneWidth: 280, objectPaneCollapsed: true, inspectorWidth: 360, inspectorCollapsed: true },
      appearance: { reducedTransparency: true, contrast: 'more' },
    })
  })

  it('falls back safely for invalid JSON projections and unknown versions', () => {
    expect(parseUiPreferences(null).layout.objectPaneWidth).toBe(OBJECT_PANE_WIDTH.default)
    expect(parseUiPreferences({ version: 1, layout: {} }).layout.objectPaneCollapsed).toBe(false)
    expect(parseUiPreferences({ version: 2 }).appearance.contrast).toBe('system')
  })
})
