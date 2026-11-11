import { useLayoutEffect, useRef, type MouseEvent, type PointerEvent, type RefObject } from 'react'

interface Box {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

interface Press {
  readonly pointerId: number
  readonly startX: number
  readonly startY: number
  readonly origin: HTMLElement
  target: HTMLElement
  dragging: boolean
  cancelled: boolean
  /** How far the indicator still was from the pressed item when the drag began; shrinks with each move. */
  catchUp: number
}

/** A horizontal move this far turns a press into a drag; a vertical one cancels it. */
const DRAG_SLOP = 8
const CANCEL_SLOP = 10
/** How far outside the bar a dragging finger may go before the drag is abandoned. */
const LEAVE_DISTANCE = 36
/** A click this soon after a drag or a cancelled press belongs to that gesture. */
const CLICK_AFTER_GESTURE = 600

const ITEM = '[data-rail-item]'
const CURRENT = '[aria-current="page"]'

/**
 * The rail's selection indicator, moved by the pointer rather than by the route (05 §6.2, §11.2). A press moves it to
 * the pressed item at once; on a phone a horizontal drag carries it under the finger and the release picks the nearest
 * item. The route follows later and the indicator is already there, so a busy page render never holds it back.
 *
 * Item geometry is read when layout is already clean (a resize observation, or a press before anything changed) and
 * cached, so committing a new page never forces a synchronous layout here. The indicator is written directly and
 * animated by CSS transitions on `transform`, which the compositor runs while the main thread is busy.
 */
export function useRailSteering({
  nav,
  indicator,
  selectionKey,
  layoutKey,
  draggable,
  onRelease,
}: {
  readonly nav: RefObject<HTMLElement | null>
  readonly indicator: RefObject<HTMLElement | null>
  /** Changes whenever the route does, so the indicator settles on the current item. */
  readonly selectionKey: string
  /** Changes whenever the set of items does. */
  readonly layoutKey: string
  readonly draggable: boolean
  /** A drag ended on `item`: open its page. */
  readonly onRelease: (item: HTMLElement) => void
}) {
  const boxes = useRef(new Map<Element, Box>())
  const bounds = useRef<DOMRect | undefined>(undefined)
  const press = useRef<Press | undefined>(undefined)
  /** The item a tap or drag chose whose page has not committed yet. */
  const pending = useRef<HTMLElement | undefined>(undefined)
  const suppressUntil = useRef(0)
  const release = useRef(onRelease)
  release.current = onRelease

  const measure = () => {
    const root = nav.current
    if (!root) return
    const origin = root.getBoundingClientRect()
    bounds.current = origin
    const next = new Map<Element, Box>()
    for (const element of root.querySelectorAll(`${ITEM}, ${CURRENT}`)) {
      const rect = element.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) continue
      next.set(element, {
        x: rect.left - origin.left + root.scrollLeft - root.clientLeft,
        y: rect.top - origin.top + root.scrollTop - root.clientTop,
        width: rect.width,
        height: rect.height,
      })
    }
    boxes.current = next
  }
  const boxOf = (element: Element): Box | undefined => {
    if (!boxes.current.has(element)) measure()
    return boxes.current.get(element)
  }

  const paint = (box: Box | undefined) => {
    const element = indicator.current
    if (!element) return
    if (!box) {
      element.style.opacity = '0'
      return
    }
    element.style.opacity = '1'
    element.style.width = `${box.width}px`
    element.style.height = `${box.height}px`
    element.style.transform = `translate(${box.x}px, ${box.y}px)`
    // Transitions start after the first placement has painted, so the indicator never grows in from the corner.
    if (element.dataset['ready'] === undefined && element.dataset['settling'] === undefined) {
      element.dataset['settling'] = ''
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          delete element.dataset['settling']
          element.dataset['ready'] = ''
        }),
      )
    }
  }

  const steer = (item: HTMLElement | undefined) => {
    const root = nav.current
    if (!root) return
    for (const element of root.querySelectorAll<HTMLElement>('[data-steer]'))
      if (element !== item) delete element.dataset['steer']
    const away = item !== undefined && item.getAttribute('aria-current') !== 'page'
    if (away) item.dataset['steer'] = ''
    if (away) root.dataset['steering'] = ''
    else delete root.dataset['steering']
  }

  const current = () => nav.current?.querySelector<HTMLElement>(CURRENT) ?? undefined
  const rest = () => {
    const target = pending.current ?? current()
    paint(target ? boxOf(target) : undefined)
  }

  // The route committed: settle on its item, unless a newer press or choice is still on its way.
  useLayoutEffect(() => {
    if (press.current) return
    const now = current()
    if (pending.current && pending.current !== now && pending.current.isConnected) return
    pending.current = undefined
    steer(undefined)
    rest()
  }, [selectionKey])

  useLayoutEffect(() => {
    const root = nav.current
    if (!root) return
    measure()
    if (!press.current) rest()
    // Observations arrive after layout, so measuring there costs nothing extra.
    const observer = new ResizeObserver(() => {
      // A bar taken out of the layout (the keyboard is up) keeps its indicator as it was, so coming back is still.
      if (root.getClientRects().length === 0) return
      measure()
      if (!press.current) rest()
    })
    observer.observe(root)
    for (const element of root.querySelectorAll(ITEM)) observer.observe(element)
    return () => observer.disconnect()
  }, [layoutKey])

  const items = () =>
    [...boxes.current.entries()]
      .filter((entry): entry is [HTMLElement, Box] => entry[0] instanceof HTMLElement && entry[0].matches(ITEM))
      .sort((a, b) => a[1].x - b[1].x)

  const endDrag = (event: PointerEvent<HTMLElement>) => {
    const root = nav.current
    delete root?.dataset['dragging']
    if (indicator.current) delete indicator.current.dataset['follow']
    if (root?.hasPointerCapture(event.pointerId)) root.releasePointerCapture(event.pointerId)
  }

  const cancel = (event: PointerEvent<HTMLElement>) => {
    const active = press.current
    if (!active) return
    if (active.dragging) endDrag(event)
    active.cancelled = true
    active.dragging = false
    steer(pending.current)
    rest()
  }

  return {
    onPointerDownCapture: (event: PointerEvent<HTMLElement>) => {
      if (!event.isPrimary || event.button !== 0) return
      const item = event.target instanceof Element ? event.target.closest<HTMLElement>(ITEM) : null
      if (!item || !nav.current?.contains(item)) return
      suppressUntil.current = 0
      press.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        origin: item,
        target: item,
        dragging: false,
        cancelled: false,
        catchUp: 0,
      }
      steer(item)
      if (item.dataset['railItem'] === 'link') {
        pending.current = undefined
        paint(boxOf(item))
      }
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      const active = press.current
      if (!active || active.cancelled || active.pointerId !== event.pointerId) return
      const dx = event.clientX - active.startX
      const dy = event.clientY - active.startY
      const origin = boxOf(active.origin)
      if (!origin) return
      if (!active.dragging) {
        if (Math.abs(dy) >= CANCEL_SLOP && Math.abs(dy) > Math.abs(dx)) return cancel(event)
        if (!draggable || Math.abs(dx) < DRAG_SLOP) return
        active.dragging = true
        const root = nav.current
        if (root) {
          root.dataset['dragging'] = ''
          root.setPointerCapture(event.pointerId)
        }
        if (indicator.current) {
          // Pick the indicator up where it is, even halfway through a slide, then close the gap over the next moves.
          const shown = new DOMMatrixReadOnly(getComputedStyle(indicator.current).transform)
          active.catchUp = shown.m41 - origin.x
          indicator.current.dataset['follow'] = ''
        }
      }
      const area = bounds.current
      if (
        area &&
        (event.clientY < area.top - LEAVE_DISTANCE ||
          event.clientY > area.bottom + LEAVE_DISTANCE ||
          event.clientX < area.left - LEAVE_DISTANCE ||
          event.clientX > area.right + LEAVE_DISTANCE)
      )
        return cancel(event)
      const list = items()
      const first = list[0]?.[1]
      const last = list.at(-1)?.[1]
      if (!first || !last) return
      active.catchUp = Math.abs(active.catchUp) < 0.5 ? 0 : active.catchUp * 0.6
      const x = Math.min(last.x, Math.max(first.x, origin.x + dx + active.catchUp))
      paint({ ...origin, x })
      const middle = x + origin.width / 2
      const distance = ([, box]: [HTMLElement, Box]) => Math.abs(box.x + box.width / 2 - middle)
      const [nearest] = list.reduce((best, entry) => (distance(entry) < distance(best) ? entry : best))
      if (nearest !== active.target) {
        active.target = nearest
        steer(nearest)
      }
    },
    onPointerUp: (event: PointerEvent<HTMLElement>) => {
      const active = press.current
      if (!active || active.pointerId !== event.pointerId) return
      press.current = undefined
      if (active.cancelled) {
        suppressUntil.current = performance.now() + CLICK_AFTER_GESTURE
        return
      }
      const target = active.target
      if (active.dragging) {
        endDrag(event)
        suppressUntil.current = performance.now() + CLICK_AFTER_GESTURE
        if (target.dataset['railItem'] === 'link' && target.getAttribute('aria-current') !== 'page') {
          pending.current = target
          steer(target)
          paint(boxOf(target))
        } else {
          steer(pending.current)
          rest()
        }
        if (target.getAttribute('aria-current') !== 'page') release.current(target)
        return
      }
      // A tap: the click that follows opens the page. A mouse released over another item gets no click.
      const over = event.target instanceof Element ? event.target.closest(ITEM) : null
      if (target.dataset['railItem'] === 'link' && over === target && target.getAttribute('aria-current') !== 'page') {
        pending.current = target
        return
      }
      steer(pending.current)
      rest()
    },
    onPointerCancel: (event: PointerEvent<HTMLElement>) => {
      if (press.current?.pointerId !== event.pointerId) return
      cancel(event)
      press.current = undefined
    },
    onClickCapture: (event: MouseEvent<HTMLElement>) => {
      // Keyboard activation (detail 0) is never part of a pointer gesture.
      if (event.detail === 0 || performance.now() >= suppressUntil.current) return
      suppressUntil.current = 0
      event.preventDefault()
      event.stopPropagation()
    },
    onDragStart: (event: MouseEvent<HTMLElement>) => {
      if (event.target instanceof Element && event.target.closest(ITEM)) event.preventDefault()
    },
  }
}
