import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { useGo } from '../model/nav.js'

/** The path shown at each history entry of this tab, by the router's entry index. */
const trail = new Map<number, string>()

/** The router's index of the history entry being shown. */
export const historyIndex = (): number | undefined => {
  const state: unknown = window.history.state
  return typeof state === 'object' && state !== null && 'idx' in state && typeof state.idx === 'number'
    ? state.idx
    : undefined
}

/** Records where each history entry points, so a back arrow can tell whether the entry before is its list. */
export function useHistoryTrail(): void {
  const location = useLocation()
  useEffect(() => {
    const index = historyIndex()
    if (index !== undefined) trail.set(index, location.pathname)
  }, [location])
}

/**
 * Goes back to `to`, the list a page was opened from. When the entry before this one is that list, it is a real
 * history step (the browser's own back button then agrees); otherwise (the page was opened from a link or a
 * notification) the list replaces this entry, so going back never leaves the app or lands somewhere unrelated.
 */
export function useBackTo(): (to: string) => void {
  const go = useGo()
  return (to) => {
    const index = historyIndex()
    if (index !== undefined && index > 0 && trail.get(index - 1) === to) window.history.back()
    else go(to, { replace: true })
  }
}
