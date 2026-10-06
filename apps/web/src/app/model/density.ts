import { useSyncExternalStore } from 'react'

/** UI density (Decision 2026-10-06 §3): switches the size Tokens through `html[data-density]`. */
export type Density = 'comfortable' | 'compact'

const STORAGE_KEY = 'nekro-nxt.density'
const listeners = new Set<() => void>()

const read = (): Density => {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'compact' ? 'compact' : 'comfortable'
  } catch {
    return 'comfortable'
  }
}

let current: Density = typeof window === 'undefined' ? 'comfortable' : read()

const apply = (density: Density): void => {
  document.documentElement.dataset['density'] = density
}

/** The saved density; also applies it to the document. Call once at boot. */
export function readDensity(): Density {
  current = read()
  apply(current)
  return current
}

export function setDensity(density: Density): void {
  current = density
  apply(density)
  try {
    window.localStorage.setItem(STORAGE_KEY, density)
  } catch {
    // The choice still holds for this session.
  }
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Current density and its setter; every subscriber (palette, settings) updates together. */
export function useDensity(): readonly [Density, (density: Density) => void] {
  const density = useSyncExternalStore(
    subscribe,
    () => current,
    (): Density => 'comfortable',
  )
  return [density, setDensity]
}
