import { useCallback, useLayoutEffect, useRef, useState } from 'react'

const BOTTOM_THRESHOLD = 80

const scrollMemory = new Map<string, { top: number; atBottom: boolean }>()

export const isNearBottom = (
  element: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>,
  threshold = BOTTOM_THRESHOLD,
): boolean => element.scrollHeight - element.scrollTop - element.clientHeight <= threshold

export const useStickToBottom = (key: string, enabled: boolean) => {
  const ref = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)
  const prependRef = useRef<{ key: string; height: number; top: number } | null>(null)
  const [away, setAway] = useState(false)

  const markPrepend = useCallback(() => {
    const element = ref.current
    if (!element) return
    prependRef.current = { key, height: element.scrollHeight, top: element.scrollTop }
  }, [key])

  const clearPrepend = useCallback(() => {
    prependRef.current = null
  }, [])

  const jumpToBottom = useCallback(
    (smooth = true) => {
      const element = ref.current
      if (!element) return
      followRef.current = true
      setAway(false)
      scrollMemory.set(key, { top: element.scrollHeight, atBottom: true })
      if (smooth) element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' })
      else element.scrollTop = element.scrollHeight
    },
    [key],
  )

  const onScroll = useCallback(() => {
    const element = ref.current
    if (!element) return
    const atBottom = isNearBottom(element)
    followRef.current = atBottom
    scrollMemory.set(key, { top: element.scrollTop, atBottom })
    setAway(!atBottom)
  }, [key])

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
        prependRef.current = null
        return
      }
      if (!followRef.current) return
      element.scrollTop = element.scrollHeight
    }
    apply()
    const observer = new ResizeObserver(apply)
    observer.observe(element)
    if (element.firstElementChild) observer.observe(element.firstElementChild)
    return () => observer.disconnect()
  }, [enabled, key])

  return { ref, away, onScroll, jumpToBottom, markPrepend, clearPrepend }
}
