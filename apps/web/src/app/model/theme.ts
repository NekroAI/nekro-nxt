import { applyThemeChoice, THEME_STORAGE_KEY, type ThemeChoice } from '../../theme-preference.js'

const prefersReducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** Applies a theme with a short color cross-fade (skipped under reduced motion). */
export function setTheme(theme: ThemeChoice): void {
  const root = document.documentElement
  if (!prefersReducedMotion()) {
    root.classList.add('theming')
    window.setTimeout(() => root.classList.remove('theming'), 420)
  }
  applyThemeChoice(root, theme)
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // Storage can be unavailable; the applied theme still holds for this session.
  }
}

export function toggleTheme(): void {
  setTheme(document.documentElement.dataset['theme'] === 'dark' ? 'light' : 'dark')
}
