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

export const applyThemeChoice = (root: HTMLElement, theme: ThemeChoice): void => {
  root.dataset['theme'] = theme
  root.classList.toggle('dark', theme === 'dark')
}
