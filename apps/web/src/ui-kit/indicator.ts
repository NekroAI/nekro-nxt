import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { flushSync } from 'react-dom'

export interface IndicatorGeometry {
  readonly visible: boolean
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface IndicatorState {
  readonly geometry: IndicatorGeometry
  /** False until the first measurement has painted; transitions stay off before that. */
  readonly ready: boolean
}

const hidden: IndicatorGeometry = { visible: false, x: 0, y: 0, width: 0, height: 0 }

/**
 * Tracks the selected descendant of a positioned container and returns its geometry in the container's
 * content coordinates (nested groups and scrolling included). Callers render one persistent indicator from it,
 * so the selection moves with a transform and the text it sits under is never covered or re-mounted.
 */
export function useIndicator(container: RefObject<HTMLElement | null>, selector: string, key: unknown): IndicatorState {
  const [geometry, setGeometry] = useState<IndicatorGeometry>(hidden)
  const [ready, setReady] = useState(false)
  const frame = useRef(0)

  useLayoutEffect(() => {
    const root = container.current
    if (!root) return
    const measure = () => {
      const target = root.querySelector<HTMLElement>(selector)
      const rect = target?.getBoundingClientRect()
      // A list that is not displayed (a collapsed pane or a closed drawer) measures as zero; wait until it shows, so
      // the indicator appears in place instead of flying in from the corner.
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        setGeometry((current) => (current.visible ? { ...current, visible: false } : current))
        return false
      }
      const box = root.getBoundingClientRect()
      const next = {
        visible: true,
        x: rect.left - box.left + root.scrollLeft - root.clientLeft,
        y: rect.top - box.top + root.scrollTop - root.clientTop,
        width: rect.width,
        height: rect.height,
      }
      setGeometry((current) =>
        current.visible &&
        Math.abs(current.x - next.x) < 0.5 &&
        Math.abs(current.y - next.y) < 0.5 &&
        Math.abs(current.width - next.width) < 0.5 &&
        Math.abs(current.height - next.height) < 0.5
          ? current
          : next,
      )
      return true
    }
    const settle = () => {
      if (ready || frame.current) return
      frame.current = requestAnimationFrame(() => (frame.current = requestAnimationFrame(() => setReady(true))))
    }
    // The first observation arrives right after layout and before paint, so measuring there places the indicator in
    // the same frame without forcing a synchronous layout while a new page commits.
    const observer = new ResizeObserver(() => {
      if (flushSync(measure)) settle()
    })
    observer.observe(root)
    const target = root.querySelector<HTMLElement>(selector)
    if (target) observer.observe(target)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame.current)
      frame.current = 0
    }
  }, [container, selector, key, ready])

  return { geometry, ready }
}
