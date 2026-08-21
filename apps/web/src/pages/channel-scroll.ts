import { useCallback, useLayoutEffect, useRef, useState } from 'react'

const BOTTOM_THRESHOLD = 80
const SCROLL_MEMORY_LIMIT = 100

const scrollMemory = new Map<string, { top: number; atBottom: boolean }>()

const rememberScroll = (key: string, value: { readonly top: number; readonly atBottom: boolean }): void => {
  scrollMemory.delete(key)
  scrollMemory.set(key, value)
  if (scrollMemory.size <= SCROLL_MEMORY_LIMIT) return
  const oldestKey = scrollMemory.keys().next().value
  if (oldestKey !== undefined) scrollMemory.delete(oldestKey)
}

export const isNearBottom = (
  element: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>,
  threshold = BOTTOM_THRESHOLD,
): boolean => element.scrollHeight - element.scrollTop - element.clientHeight <= threshold

export const useStickToBottom = (key: string, enabled: boolean) => {
  const ref = useRef<HTMLDivElement | null>(null)
  const followRef = useRef(true)
  const prependRef = useRef<{ key: string; height: number; top: number } | null>(null)
  const [away, setAway] = useState(false)

  const commitPosition = useCallback(
    (element: HTMLDivElement, atBottom: boolean) => {
      followRef.current = atBottom
      rememberScroll(key, { top: element.scrollTop, atBottom })
      setAway(!atBottom)
    },
    [key],
  )

  const markPrepend = useCallback(() => {
    const element = ref.current
    if (!element) return
    prependRef.current = { key, height: element.scrollHeight, top: element.scrollTop }
  }, [key])

  const clearPrepend = useCallback(() => {
    const element = ref.current
    const prepend = prependRef.current
    if (element && prepend?.key === key) {
      element.scrollTop = prepend.top + (element.scrollHeight - prepend.height)
      commitPosition(element, isNearBottom(element))
    }
    prependRef.current = null
  }, [commitPosition, key])

  const jumpToBottom = useCallback(() => {
    const element = ref.current
    if (!element) return
    element.scrollTop = element.scrollHeight
    commitPosition(element, true)
  }, [commitPosition])

  const onScroll = useCallback(() => {
    const element = ref.current
    if (!element) return
    commitPosition(element, isNearBottom(element))
  }, [commitPosition])

  const reconcileLayout = useCallback(() => {
    const element = ref.current
    if (!enabled || !element) return
    if (followRef.current) {
      element.scrollTop = element.scrollHeight
      commitPosition(element, true)
      return
    }
    commitPosition(element, isNearBottom(element))
  }, [commitPosition, enabled])

  useLayoutEffect(() => {
    if (!enabled) return
    const element = ref.current
    if (!element) return
    const remembered = scrollMemory.get(key)
    followRef.current = remembered?.atBottom ?? true
    setAway(Boolean(remembered && !remembered.atBottom))
    element.scrollTop = remembered && !remembered.atBottom ? remembered.top : element.scrollHeight
  }, [enabled, key])

  useLayoutEffect(() => {
    if (!enabled) return
    const element = ref.current
    if (!element) return
    const apply = (): void => {
      const prepend = prependRef.current
      if (prepend?.key === key) {
        element.scrollTop = prepend.top + (element.scrollHeight - prepend.height)
        return
      }
      if (followRef.current) {
        element.scrollTop = element.scrollHeight
        commitPosition(element, true)
        return
      }
      commitPosition(element, isNearBottom(element))
    }
    apply()
    const observer = new ResizeObserver(apply)
    observer.observe(element)
    if (element.firstElementChild) observer.observe(element.firstElementChild)
    return () => observer.disconnect()
  }, [commitPosition, enabled, key])

  return { ref, away, onScroll, jumpToBottom, markPrepend, clearPrepend, reconcileLayout }
}
