import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { Tone } from '../../ui-kit/index.js'

type CrumbSetter = (crumb: readonly string[]) => void

/**
 * What a page puts in the phone's top bar (05 §6.2): its own title in place of the space name, the way back to the
 * list it was opened from, and an optional status line. Only plain data, so declaring it never re-renders the shell
 * unless something shown there changed; actions go through `PageBarActions`.
 */
export interface PageBar {
  readonly title: string
  /** The list this page was opened from; the top bar shows a back arrow to it. */
  readonly back?: { readonly to: string; readonly label: string }
  /** A short second line under the title, e.g. a conversation's state and responder. */
  readonly status?: { readonly label: string; readonly tone: Tone; readonly detail?: string }
  /** The page needs the whole height: the bottom bar steps aside while it shows (a conversation). */
  readonly immersive?: boolean
}

interface CrumbState {
  readonly crumb: readonly string[]
  readonly set: CrumbSetter
  readonly bar: PageBar | undefined
  readonly setBar: (bar: PageBar | undefined) => void
  readonly actions: HTMLElement | null
  readonly setActions: (element: HTMLElement | null) => void
}

const CrumbContext = createContext<CrumbState>({
  crumb: [],
  set: () => undefined,
  bar: undefined,
  setBar: () => undefined,
  actions: null,
  setActions: () => undefined,
})

export function CrumbProvider({ children }: { readonly children: ReactNode }) {
  const [crumb, set] = useState<readonly string[]>([])
  const [bar, setBar] = useState<PageBar | undefined>(undefined)
  const [actions, setActions] = useState<HTMLElement | null>(null)
  return (
    <CrumbContext.Provider value={{ crumb, set, bar, setBar, actions, setActions }}>{children}</CrumbContext.Provider>
  )
}

/** Each space declares the object it shows; the top bar renders it. */
export function useCrumb(...parts: readonly (string | undefined)[]): void {
  const { set } = useContext(CrumbContext)
  const key = parts.filter(Boolean).join('\u0000')
  useEffect(() => {
    set(key ? key.split('\u0000') : [])
  }, [key, set])
}

export const useCurrentCrumb = (): readonly string[] => useContext(CrumbContext).crumb

/**
 * Declares the page's phone top bar; `undefined` leaves the space name there. Set before paint, so the bar never
 * shows the previous page's title for a frame when a list opens one of its items.
 */
export function usePageBar(bar: PageBar | undefined): void {
  const { setBar } = useContext(CrumbContext)
  const latest = useRef(bar)
  latest.current = bar
  const key = bar === undefined ? '' : JSON.stringify(bar)
  useLayoutEffect(() => {
    setBar(latest.current)
  }, [key, setBar])
  useLayoutEffect(() => () => setBar(undefined), [setBar])
}

export const useCurrentPageBar = (): PageBar | undefined => useContext(CrumbContext).bar

/** Where the top bar takes a page's actions; the bar registers it while it shows a page's own title. */
export const usePageBarActionsSlot = (): ((element: HTMLElement | null) => void) => useContext(CrumbContext).setActions

/**
 * A page's own controls in the phone's top bar, rendered by the page (so they keep its state and handlers) into the
 * bar's action area. Renders nothing while the bar has no place for them.
 */
export function PageBarActions({ children }: { readonly children: ReactNode }) {
  const { actions } = useContext(CrumbContext)
  return actions ? createPortal(children, actions) : null
}
