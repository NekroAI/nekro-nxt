import { useEffect, useLayoutEffect, useRef, type MouseEvent, type PointerEvent } from 'react'

/** How long a finger rests on a row before its actions open. */
export const LONG_PRESS_MS = 450

/** How far the finger may drift during the hold; further is the start of a scroll. */
const LONG_PRESS_SLOP = 10

/** After a long press, the release that follows is not a tap; a click later than this is the next one. */
const RELEASE_WINDOW_MS = 400

export type LongPressHandlers = {
  readonly onPointerDown?: (event: PointerEvent<HTMLElement>) => void
  readonly onPointerMove?: (event: PointerEvent<HTMLElement>) => void
  readonly onPointerUp?: (event: PointerEvent<HTMLElement>) => void
  readonly onPointerCancel?: (event: PointerEvent<HTMLElement>) => void
  readonly onContextMenu?: (event: MouseEvent<HTMLElement>) => void
  readonly onClickCapture?: (event: MouseEvent<HTMLElement>) => void
}

/**
 * A finger held still on an element runs `onLongPress` with it; returning true says something opened, and the
 * device gives a short tick where it can. Only touch counts: a mouse keeps its own gestures. Moving the finger or a
 * scroll starting during the hold cancels it, the release after it never becomes a tap, and Android's long-press
 * menu for links does not open.
 */
export function useLongPress(onLongPress: (element: HTMLElement) => boolean, enabled: boolean): LongPressHandlers {
  const press = useRef<{ readonly id: number; readonly x: number; readonly y: number; readonly timer: number }>(
    undefined,
  )
  const fired = useRef(false)
  const touching = useRef(false)
  const latest = useRef(onLongPress)
  useLayoutEffect(() => {
    latest.current = onLongPress
  })
  const cancel = useRef(() => {
    if (press.current) window.clearTimeout(press.current.timer)
    press.current = undefined
    window.removeEventListener('scroll', cancel.current, true)
  })
  useEffect(() => {
    const stop = cancel.current
    return stop
  }, [])
  if (!enabled) return {}
  return {
    onPointerDown: (event) => {
      touching.current = event.pointerType === 'touch'
      fired.current = false
      cancel.current()
      if (!touching.current || !event.isPrimary) return
      const element = event.currentTarget
      const timer = window.setTimeout(() => {
        cancel.current()
        fired.current = true
        // The finger may lift over the sheet that just opened; wherever it lifts, the guard ends soon after.
        const release = () => window.setTimeout(() => (fired.current = false), RELEASE_WINDOW_MS)
        window.addEventListener('pointerup', release, { capture: true, once: true })
        if (!latest.current(element)) return
        try {
          navigator.vibrate?.(10)
        } catch {
          // A tick where the device has one; nothing otherwise.
        }
      }, LONG_PRESS_MS)
      press.current = { id: event.pointerId, x: event.clientX, y: event.clientY, timer }
      window.addEventListener('scroll', cancel.current, { capture: true, passive: true })
    },
    onPointerMove: (event) => {
      const active = press.current
      if (!active || active.id !== event.pointerId) return
      if (Math.hypot(event.clientX - active.x, event.clientY - active.y) > LONG_PRESS_SLOP) cancel.current()
    },
    onPointerUp: () => cancel.current(),
    onPointerCancel: () => cancel.current(),
    onContextMenu: (event) => {
      if (touching.current) event.preventDefault()
    },
    onClickCapture: (event) => {
      if (!fired.current) return
      fired.current = false
      event.preventDefault()
      event.stopPropagation()
    },
  }
}
