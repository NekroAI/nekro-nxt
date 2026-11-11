import { useLayoutEffect } from 'react'
import { NavigationType, useLocation, useNavigationType } from 'react-router-dom'
import { useGo } from '../model/nav.js'
import { historyIndex } from './back.js'

/*
 * On a phone the bottom bar switches between sibling tabs, as a native app's tab bar does (05 §6.2): a switch never
 * adds a history entry, and the history holds the current tab's first level plus the pages opened from it. Only
 * opening a page from a list, a link or a notification adds one.
 *
 * Every entry records where it sits in its tab (`Level`), kept in the entry's own history state so a reload or a step
 * back reads it again. A switch from a page opened inside its tab first steps back to where that run of pages began,
 * then replaces that entry with the new tab; the step back is taken off the router, so the page in between never
 * renders and no page transition plays.
 */

/** Where a history entry sits in its tab. */
interface Level {
  /** The tab's first path segment (`/agents`), or an extension page's own base (`/apps/hup_…`). */
  readonly tab: string
  /** How many entries back, within the same tab, the run of pages that leads here begins. */
  readonly depth: number
  /** Whether that run begins at the tab's first level; otherwise it was entered from a link, a notification or an address. */
  readonly rooted: boolean
}

const STATE_KEY = 'nxtLevel'

export const tabOf = (pathname: string): string => {
  const [, first = '', second = ''] = pathname.split('/')
  return first === 'apps' ? `/apps/${second}` : `/${first}`
}

const isTabRoot = (pathname: string): boolean => (pathname.replace(/\/+$/u, '') || '/') === tabOf(pathname)

const storedLevel = (state: unknown): Level | undefined => {
  if (typeof state !== 'object' || state === null || !(STATE_KEY in state)) return undefined
  const level: unknown = state[STATE_KEY]
  return typeof level === 'object' &&
    level !== null &&
    'tab' in level &&
    typeof level.tab === 'string' &&
    'depth' in level &&
    typeof level.depth === 'number' &&
    'rooted' in level &&
    typeof level.rooted === 'boolean'
    ? { tab: level.tab, depth: level.depth, rooted: level.rooted }
    : undefined
}

/** The level of the entry on screen, as last recorded. */
let shown: Level | undefined
/** The router's index of the entry `shown` was recorded for. */
let shownIndex: number | undefined
/** The bottom bar chose the next entry: it is its tab's first level, whatever its path (`/settings` redirects). */
let switching = false

/** Records each entry's level as it is shown. */
export function useTabHistory(): void {
  const location = useLocation()
  const type = useNavigationType()
  useLayoutEffect(() => {
    const state: unknown = window.history.state
    const stored = storedLevel(state)
    const tab = tabOf(location.pathname)
    const previous = shown
    let level: Level
    if (type === NavigationType.Pop && stored) level = stored
    else if ((switching && type !== NavigationType.Pop) || isTabRoot(location.pathname))
      level = { tab, depth: 0, rooted: true }
    else if (type === NavigationType.Push && previous?.tab === tab) level = { ...previous, depth: previous.depth + 1 }
    // A redirect or a page swapping its own address keeps its place.
    else if (type === NavigationType.Replace && previous?.tab === tab) level = previous
    else level = { tab, depth: 0, rooted: false }
    switching = false
    shown = level
    shownIndex = historyIndex()
    if (stored?.tab !== level.tab || stored.depth !== level.depth || stored.rooted !== level.rooted)
      window.history.replaceState({ ...(typeof state === 'object' ? state : {}), [STATE_KEY]: level }, '')
  }, [location.key])
}

/*
 * The address moves before the page it names is drawn (a page still loading holds the old one on screen), so the entry
 * at hand may not have its level yet. It is then worked out from the last recorded entry, as the record will be.
 */
const currentLevel = (): Level | undefined => {
  const stored = storedLevel(window.history.state)
  if (stored) return stored
  const index = historyIndex()
  if (!shown || index === undefined || shownIndex === undefined || index === shownIndex) return shown
  const { pathname } = window.location
  const tab = tabOf(pathname)
  if (isTabRoot(pathname)) return { tab, depth: 0, rooted: true }
  return index > shownIndex && shown.tab === tab
    ? { ...shown, depth: shown.depth + (index - shownIndex) }
    : { tab, depth: 0, rooted: false }
}

/** A switch waiting for its step back to land. */
let landing: { readonly index: number; href: string; land: (href: string) => void; readonly timer: number } | undefined

const finishLanding = () => {
  const pending = landing
  if (!pending) return
  landing = undefined
  window.clearTimeout(pending.timer)
  pending.land(pending.href)
}

if (typeof window !== 'undefined') {
  // Capturing on the window runs before the router's own listener, so the router never sees the step back.
  window.addEventListener(
    'popstate',
    (event) => {
      if (!landing) return
      if (historyIndex() !== landing.index) {
        // Someone else moved the history (a swipe back while waiting): theirs wins.
        window.clearTimeout(landing.timer)
        landing = undefined
        return
      }
      event.stopImmediatePropagation()
      finishLanding()
    },
    true,
  )
}

/** A step back this long without arriving is not coming; switch in place instead. */
const LANDING_TIMEOUT = 1000

/** Switches tabs from the phone's bottom bar without adding a history entry (see above). */
export function useSwitchTab(): (href: string) => void {
  const go = useGo()
  return (href) => {
    const land = (to: string) => {
      switching = true
      go(to, { replace: true })
    }
    if (landing) {
      landing.href = href
      return
    }
    const level = currentLevel()
    const index = historyIndex()
    const depth = level?.depth ?? 0
    if (level && depth > 0 && index !== undefined && index >= depth) {
      window.history.go(-depth)
      // Its own tab again, opened from the first level: that is simply going back to it.
      if (level.tab === tabOf(href) && level.rooted) return
      landing = { index: index - depth, href, land, timer: window.setTimeout(finishLanding, LANDING_TIMEOUT) }
      return
    }
    land(href)
  }
}
