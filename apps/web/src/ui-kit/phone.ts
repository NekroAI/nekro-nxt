import { useSyncExternalStore } from 'react'

/** The phone layout (05 §6.2): the same breakpoint as every `max-width: 760px` rule in the stylesheets. */
export const PHONE_QUERY = '(max-width: 760px)'

const subscribe = (change: () => void) => {
  const query = window.matchMedia?.(PHONE_QUERY)
  query?.addEventListener('change', change)
  return () => query?.removeEventListener('change', change)
}

/** Whether the window is phone-wide right now; components that render differently on a phone read it. */
export const isPhone = (): boolean =>
  typeof window !== 'undefined' && (window.matchMedia?.(PHONE_QUERY).matches ?? false)

export function usePhone(): boolean {
  return useSyncExternalStore(subscribe, isPhone, () => false)
}

/*
 * iOS home-screen apps animate an edge swipe back themselves and then report it on the history step
 * (`hasUAVisualTransition`); a page transition on top of that would play the same move twice. The flag holds until
 * the next press or key, so it only ever describes the step that just happened.
 */
let browserAnimated = false
if (typeof window !== 'undefined') {
  window.addEventListener(
    'popstate',
    (event) => {
      browserAnimated = 'hasUAVisualTransition' in event && event.hasUAVisualTransition === true
    },
    true,
  )
  for (const type of ['pointerdown', 'keydown'] as const)
    window.addEventListener(type, () => (browserAnimated = false), true)
}

/** Whether the browser already animated the history step being shown. */
export const browserAnimatedStep = (): boolean => browserAnimated
