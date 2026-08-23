import { useEffect } from 'react'

const dirtyEntries = new Set<string>()

declare global {
  interface Window {
    __nxtHasUnsavedDrafts?: () => boolean
  }
}

if (typeof window !== 'undefined') window.__nxtHasUnsavedDrafts = () => dirtyEntries.size > 0

export const useUnsavedDraft = (key: string, dirty: boolean): void => {
  useEffect(() => {
    if (dirty) dirtyEntries.add(key)
    else dirtyEntries.delete(key)
    return () => {
      dirtyEntries.delete(key)
    }
  }, [dirty, key])
}
