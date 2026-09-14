import { useCallback, useEffect, useRef, type PointerEvent } from 'react'

/** Pointer-following decoration stays outside React's semantic selection state. */
export function usePointerPosition() {
  const rootRef = useRef<HTMLDivElement>(null)
  const tooltipRef = useRef<HTMLDivElement | null>(null)
  const geometry = useRef<DOMRect>()
  const frame = useRef<number>()
  const position = useRef({ x: 82, y: 20 })
  const attachTooltip = useCallback((node: HTMLDivElement | null) => {
    tooltipRef.current = node
    if (node) {
      const { x, y } = position.current
      node.dataset['side'] = x > 56 ? 'left' : 'right'
      node.dataset['pointerX'] = String(Math.round(x))
      node.dataset['pointerY'] = String(Math.round(y))
    }
  }, [])
  const apply = () => {
    frame.current = undefined
    const { x, y } = position.current
    rootRef.current?.style.setProperty('--nxt-pointer-x', `${x}px`)
    rootRef.current?.style.setProperty('--nxt-pointer-y', `${y}px`)
    if (tooltipRef.current) {
      tooltipRef.current.dataset['side'] = x > 56 ? 'left' : 'right'
      tooltipRef.current.dataset['pointerX'] = String(Math.round(x))
      tooltipRef.current.dataset['pointerY'] = String(Math.round(y))
    }
  }
  useEffect(() => {
    const invalidate = () => {
      geometry.current = undefined
    }
    const observer = new ResizeObserver(invalidate)
    // Ancestor resizing can move a fixed-size ring without resizing the ring itself.
    for (let element: HTMLElement | null = rootRef.current; element; element = element.parentElement)
      observer.observe(element)
    window.addEventListener('scroll', invalidate, true)
    window.addEventListener('resize', invalidate)
    return () => {
      observer.disconnect()
      window.removeEventListener('scroll', invalidate, true)
      window.removeEventListener('resize', invalidate)
      if (frame.current !== undefined) cancelAnimationFrame(frame.current)
    }
  }, [])
  return {
    rootRef,
    tooltipRef: attachTooltip,
    onPointerEnter: () => {
      geometry.current = undefined
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      const rect = (geometry.current ??= event.currentTarget.getBoundingClientRect())
      position.current = { x: event.clientX - rect.left, y: event.clientY - rect.top }
      if (frame.current === undefined) frame.current = requestAnimationFrame(apply)
    },
    onFocus: () => {
      position.current = { x: 82, y: 20 }
      apply()
    },
  }
}
