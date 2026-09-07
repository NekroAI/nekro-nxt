import { createUiPreferencesState, type UiPreferencesState } from './ui-preferences-model.js'
import { create } from 'zustand'
import { readInitialThemeChoice, THEME_STORAGE_KEY, type ThemeChoice } from './theme-preference.js'

export interface UiState extends UiPreferencesState {
  readonly theme: ThemeChoice
  readonly reducedMotion: boolean
  setTheme(theme: ThemeChoice): void
  setReducedMotion(enabled: boolean): void
}

export function createUiStateStore() {
  return create<UiState>((set, get, api) => ({
    ...createUiPreferencesState(set, get, api),
    theme: readInitialThemeChoice(),
    reducedMotion: typeof window !== 'undefined' && window.localStorage.getItem('nekro-nxt.reduced-motion') === 'true',
    setTheme: (theme) => {
      if (typeof window !== 'undefined') window.localStorage.setItem(THEME_STORAGE_KEY, theme)
      set({ theme })
    },
    setReducedMotion: (reducedMotion) => {
      if (typeof window !== 'undefined') window.localStorage.setItem('nekro-nxt.reduced-motion', String(reducedMotion))
      set({ reducedMotion })
    },
  }))
}
