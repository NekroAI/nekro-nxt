import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'

export interface MeasuredSelectionBox {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface MeasuredSelectionState {
  readonly box: MeasuredSelectionBox | null
  readonly ready: boolean
  readonly animate: boolean
}

const unmeasuredTarget = Symbol('unmeasured-target')

const boxesMatch = (left: MeasuredSelectionBox | null, right: MeasuredSelectionBox): boolean =>
  left !== null &&
  Math.abs(left.x - right.x) < 0.01 &&
  Math.abs(left.y - right.y) < 0.01 &&
  Math.abs(left.width - right.width) < 0.01 &&
  Math.abs(left.height - right.height) < 0.01

export function resolveMeasuredSelection(
  current: MeasuredSelectionState,
  nextBox: MeasuredSelectionBox,
  options: { readonly hadValidGeometry: boolean; readonly targetChanged: boolean },
): MeasuredSelectionState {
  if (current.ready && boxesMatch(current.box, nextBox)) return current
  return {
    box: nextBox,
    ready: true,
    animate: options.hadValidGeometry && options.targetChanged && !boxesMatch(current.box, nextBox),
  }
}

interface MeasuredSelectionOptions {
  readonly rootRef: RefObject<HTMLElement>
  readonly activeKey?: unknown
  readonly candidateSelector: string
  readonly mutationAttributeFilter: readonly string[]
  readonly findAnchor: (root: HTMLElement) => HTMLElement | null
  readonly measure: (root: HTMLElement, anchor: HTMLElement) => MeasuredSelectionBox
}

/**
 * Keeps one measured indicator aligned with a selected DOM anchor.
 * Target identity changes animate; geometry changes for the same target snap into place.
 */
export function useMeasuredSelection({
  rootRef,
  activeKey,
  candidateSelector,
  mutationAttributeFilter,
  findAnchor,
  measure,
}: MeasuredSelectionOptions): MeasuredSelectionState {
  const hadValidGeometryRef = useRef(false)
  const targetRef = useRef<unknown>(unmeasuredTarget)
  const [selection, setSelection] = useState<MeasuredSelectionState>({ box: null, ready: false, animate: false })

  const readGeometry = useCallback(() => {
    const root = rootRef.current
    const anchor = root ? findAnchor(root) : null
    if (!root || !anchor) {
      setSelection((current) => (current.ready ? { box: current.box, ready: false, animate: false } : current))
      return
    }

    const nextTarget = activeKey ?? anchor
    const targetChanged = targetRef.current !== unmeasuredTarget && !Object.is(targetRef.current, nextTarget)
    const nextBox = measure(root, anchor)
    const hadValidGeometry = hadValidGeometryRef.current

    targetRef.current = nextTarget
    hadValidGeometryRef.current = true
    setSelection((current) => resolveMeasuredSelection(current, nextBox, { hadValidGeometry, targetChanged }))
  }, [activeKey, findAnchor, measure, rootRef])

  const readGeometryRef = useRef(readGeometry)
  readGeometryRef.current = readGeometry

  // A controlled selection change is measured during the same commit. This is what
  // makes the first interaction animate without waiting for ResizeObserver warm-up.
  useLayoutEffect(() => {
    readGeometry()
  }, [readGeometry])

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root || typeof ResizeObserver === 'undefined' || typeof MutationObserver === 'undefined') return

    const resizeObserver = new ResizeObserver(() => readGeometryRef.current())
    const observeCandidates = () => {
      resizeObserver.disconnect()
      resizeObserver.observe(root)
      for (const candidate of root.querySelectorAll<HTMLElement>(candidateSelector)) {
        resizeObserver.observe(candidate)
      }
    }
    const mutationObserver = new MutationObserver(() => {
      observeCandidates()
      readGeometryRef.current()
    })

    observeCandidates()
    mutationObserver.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [...mutationAttributeFilter],
    })
    readGeometryRef.current()

    return () => {
      mutationObserver.disconnect()
      resizeObserver.disconnect()
    }
  }, [candidateSelector, mutationAttributeFilter, rootRef])

  return selection
}
