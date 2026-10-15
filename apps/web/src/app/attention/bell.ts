import { useSyncExternalStore } from 'react'

/**
 * The attention bell is where items are handled; other places (the overview summary) only open it, optionally
 * narrowed to one group of items.
 */
interface BellState {
  readonly open: boolean
  /** Key of the group to show item by item; absent shows every group. */
  readonly focus?: string | undefined
}

let state: BellState = { open: false }
const listeners = new Set<() => void>()

const set = (next: BellState) => {
  state = next
  for (const listener of listeners) listener()
}

export const bellStore = {
  get: (): BellState => state,
  subscribe: (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  setOpen: (open: boolean) => set(open ? { ...state, open } : { open: false }),
  clearFocus: () => set({ open: state.open }),
}

export const openBell = (focus?: string) => set({ open: true, focus })

export function useBell(): BellState {
  return useSyncExternalStore(bellStore.subscribe, bellStore.get, bellStore.get)
}
