import { describe, expect, it } from 'vitest'
import { initializeThemeChoice, resolveThemeChoice, THEME_STORAGE_KEY } from '../src/theme-preference.js'

describe('theme preference', () => {
  it('uses and persists the system theme on first launch', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    }

    expect(initializeThemeChoice(storage, true)).toBe('dark')
    expect(values.get(THEME_STORAGE_KEY)).toBe('dark')
  })

  it('keeps a saved user choice when the system theme changes', () => {
    expect(resolveThemeChoice('light', true)).toBe('light')
    expect(resolveThemeChoice('dark', false)).toBe('dark')
  })

  it('replaces an unsupported legacy value with the current system theme', () => {
    const values = new Map<string, string>([[THEME_STORAGE_KEY, 'system']])
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    }

    expect(initializeThemeChoice(storage, false)).toBe('light')
    expect(values.get(THEME_STORAGE_KEY)).toBe('light')
  })
})
