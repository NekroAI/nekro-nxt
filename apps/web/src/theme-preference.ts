import { postToAndroidShell } from './android-shell.js'

export type ThemeChoice = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'nekro-nxt.theme'

type ThemeStorage = Pick<Storage, 'getItem' | 'setItem'>

export const resolveThemeChoice = (storedTheme: string | null, prefersDark: boolean): ThemeChoice => {
  if (storedTheme === 'light' || storedTheme === 'dark') return storedTheme
  return prefersDark ? 'dark' : 'light'
}

export const initializeThemeChoice = (storage: ThemeStorage, prefersDark: boolean): ThemeChoice => {
  const storedTheme = storage.getItem(THEME_STORAGE_KEY)
  const theme = resolveThemeChoice(storedTheme, prefersDark)
  if (storedTheme !== theme) storage.setItem(THEME_STORAGE_KEY, theme)
  return theme
}

export const readInitialThemeChoice = (): ThemeChoice => {
  if (typeof window === 'undefined') return 'light'
  return initializeThemeChoice(window.localStorage, window.matchMedia('(prefers-color-scheme: dark)').matches)
}

/**
 * Colors the phone's status bar like the top bar. index.html starts with one value per system scheme; once the app
 * has chosen a theme, both carry that theme's color, so a choice against the system scheme wins.
 */
const syncThemeColor = (root: HTMLElement): void => {
  const color = root.ownerDocument.defaultView?.getComputedStyle(root).getPropertyValue('--side').trim()
  if (!color) return
  for (const meta of root.ownerDocument.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.content = color
  }
}

export const applyThemeChoice = (root: HTMLElement, theme: ThemeChoice): void => {
  root.dataset['theme'] = theme
  root.classList.toggle('dark', theme === 'dark')
  syncThemeColor(root)
  postToAndroidShell({ type: 'theme', theme })
  // The canvas the browser paints behind the page follows the chosen theme, not the system scheme.
  for (const meta of root.ownerDocument.querySelectorAll<HTMLMetaElement>('meta[name="color-scheme"]')) {
    meta.content = theme
  }
}
