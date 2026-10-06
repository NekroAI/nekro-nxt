import { useCallback, useEffect } from 'react'
import { applyThemeChoice } from '../../theme-preference.js'
import { useProductRuntime, useUiStateStore } from '../../product-runtime.js'

const motionOff = (): boolean =>
  document.documentElement.dataset['nxtMotion'] === 'off' ||
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * Applies the theme and motion preferences from the UI store to the document. Theme changes cross-fade colors
 * briefly unless motion is reduced.
 */
export function useAppearanceEffects(): void {
  const theme = useUiStateStore((state) => state.theme)
  const reducedMotion = useUiStateStore((state) => state.reducedMotion)
  useEffect(() => {
    const root = document.documentElement
    root.dataset['reducedMotion'] = String(reducedMotion)
    root.dataset['nxtMotion'] = reducedMotion ? 'off' : 'on'
  }, [reducedMotion])
  useEffect(() => {
    const root = document.documentElement
    if (root.dataset['theme'] === theme) return
    let timer: number | undefined
    if (!motionOff()) {
      root.classList.add('theming')
      timer = window.setTimeout(() => root.classList.remove('theming'), 420)
    }
    applyThemeChoice(root, theme)
    return () => {
      if (timer !== undefined) window.clearTimeout(timer)
      root.classList.remove('theming')
    }
  }, [theme])
}

/** Command for the palette: flips between light and dark. */
export function useToggleTheme(): () => void {
  const ui = useProductRuntime().uiStore
  return useCallback(() => {
    const state = ui.getState()
    state.setTheme(state.theme === 'dark' ? 'light' : 'dark')
  }, [ui])
}
