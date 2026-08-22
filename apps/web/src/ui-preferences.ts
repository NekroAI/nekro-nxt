import { create } from 'zustand'

export const UI_PREFERENCES_KEY = 'nekro-nxt.ui-preferences'
export const OBJECT_PANE_WIDTH = { min: 200, default: 240, max: 304 } as const
export const INSPECTOR_WIDTH = { min: 320, default: 344, max: 520 } as const

export type ContrastChoice = 'system' | 'standard' | 'more'

export interface UiPreferencesSnapshot {
  readonly version: 1
  readonly layout: {
    readonly objectPaneWidth: number
    readonly inspectorWidth: number
    readonly inspectorCollapsed: boolean
  }
  readonly appearance: {
    readonly reducedTransparency: boolean
    readonly contrast: ContrastChoice
  }
}

const defaults: UiPreferencesSnapshot = {
  version: 1,
  layout: {
    objectPaneWidth: OBJECT_PANE_WIDTH.default,
    inspectorWidth: INSPECTOR_WIDTH.default,
    inspectorCollapsed: false,
  },
  appearance: { reducedTransparency: false, contrast: 'system' },
}

export const clampUiWidth = (
  value: unknown,
  range: { readonly min: number; readonly max: number },
  fallback: number,
): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(range.max, Math.max(range.min, Math.round(value)))
    : fallback

export const parseUiPreferences = (value: unknown): UiPreferencesSnapshot => {
  if (typeof value !== 'object' || value === null || (value as { version?: unknown }).version !== 1) return defaults
  const record = value as { layout?: Record<string, unknown>; appearance?: Record<string, unknown> }
  const layout = record.layout ?? {}
  const appearance = record.appearance ?? {}
  const contrast = appearance['contrast']
  return {
    version: 1,
    layout: {
      objectPaneWidth: clampUiWidth(layout['objectPaneWidth'], OBJECT_PANE_WIDTH, OBJECT_PANE_WIDTH.default),
      inspectorWidth: clampUiWidth(layout['inspectorWidth'], INSPECTOR_WIDTH, INSPECTOR_WIDTH.default),
      inspectorCollapsed: layout['inspectorCollapsed'] === true,
    },
    appearance: {
      reducedTransparency: appearance['reducedTransparency'] === true,
      contrast: contrast === 'standard' || contrast === 'more' ? contrast : 'system',
    },
  }
}

const readPreferences = (): UiPreferencesSnapshot => {
  if (typeof window === 'undefined') return defaults
  const stored = window.localStorage.getItem(UI_PREFERENCES_KEY)
  if (!stored) return defaults
  try {
    return parseUiPreferences(JSON.parse(stored))
  } catch {
    return defaults
  }
}

interface UiPreferencesState extends UiPreferencesSnapshot {
  setObjectPaneWidth(value: number): void
  setInspectorWidth(value: number): void
  setInspectorCollapsed(value: boolean): void
  setReducedTransparency(value: boolean): void
  setContrast(value: ContrastChoice): void
  resetLayout(): void
}

const persist = (state: UiPreferencesSnapshot): void => {
  if (typeof window !== 'undefined') window.localStorage.setItem(UI_PREFERENCES_KEY, JSON.stringify(state))
}

const snapshotFromState = (state: UiPreferencesState): UiPreferencesSnapshot => ({
  version: 1,
  layout: state.layout,
  appearance: state.appearance,
})

const initial = readPreferences()

export const useUiPreferences = create<UiPreferencesState>((set) => ({
  ...initial,
  setObjectPaneWidth: (value) =>
    set((state) => {
      const next = {
        ...state,
        layout: {
          ...state.layout,
          objectPaneWidth: clampUiWidth(value, OBJECT_PANE_WIDTH, OBJECT_PANE_WIDTH.default),
        },
      }
      persist(snapshotFromState(next))
      return next
    }),
  setInspectorWidth: (value) =>
    set((state) => {
      const next = {
        ...state,
        layout: {
          ...state.layout,
          inspectorWidth: clampUiWidth(value, INSPECTOR_WIDTH, INSPECTOR_WIDTH.default),
        },
      }
      persist(snapshotFromState(next))
      return next
    }),
  setInspectorCollapsed: (value) =>
    set((state) => {
      const next = { ...state, layout: { ...state.layout, inspectorCollapsed: value } }
      persist(snapshotFromState(next))
      return next
    }),
  setReducedTransparency: (value) =>
    set((state) => {
      const next = { ...state, appearance: { ...state.appearance, reducedTransparency: value } }
      persist(snapshotFromState(next))
      return next
    }),
  setContrast: (value) =>
    set((state) => {
      const next = { ...state, appearance: { ...state.appearance, contrast: value } }
      persist(snapshotFromState(next))
      return next
    }),
  resetLayout: () =>
    set((state) => {
      const next = { ...state, layout: defaults.layout }
      persist(snapshotFromState(next))
      return next
    }),
}))
