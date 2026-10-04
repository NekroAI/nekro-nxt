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
  /** Last scrollTop this hook wrote; the scroll event it causes is not a user decision to leave the bottom. */
  const writtenTopRef = useRef<number | null>(null)
  const [away, setAway] = useState(false)
  const write = (element: HTMLDivElement, top: number): void => {
    element.scrollTop = top
    writtenTopRef.current = element.scrollTop
  }

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
      write(element, prepend.top + (element.scrollHeight - prepend.height))
      commitPosition(element, isNearBottom(element))
    }
    prependRef.current = null
  }, [commitPosition, key])

  const jumpToBottom = useCallback(() => {
    const element = ref.current
    if (!element) return
    write(element, element.scrollHeight)
    commitPosition(element, true)
  }, [commitPosition])

  const onScroll = useCallback(() => {
    const element = ref.current
    if (!element) return
    // Content can grow (images, history) between our write and its scroll event; keep following in that case.
    const written = writtenTopRef.current
    writtenTopRef.current = null
    if (written !== null && Math.abs(element.scrollTop - written) < 1 && followRef.current) {
      const bottom = Math.max(0, element.scrollHeight - element.clientHeight)
      if (Math.abs(element.scrollTop - bottom) > 0.5) write(element, bottom)
      return
    }
    commitPosition(element, isNearBottom(element))
  }, [commitPosition])

  useLayoutEffect(() => {
    if (!enabled) return
    const element = ref.current
    if (!element) return
    const remembered = scrollMemory.get(key)
    followRef.current = remembered?.atBottom ?? true
    setAway(Boolean(remembered && !remembered.atBottom))
    write(element, remembered && !remembered.atBottom ? remembered.top : element.scrollHeight)
  }, [enabled, key])

  useLayoutEffect(() => {
    if (!enabled) return
    const element = ref.current
    if (!element) return
    const apply = (): void => {
      const prepend = prependRef.current
      if (prepend?.key === key) {
        write(element, prepend.top + (element.scrollHeight - prepend.height))
        return
      }
      if (followRef.current) {
        const bottom = Math.max(0, element.scrollHeight - element.clientHeight)
        if (Math.abs(element.scrollTop - bottom) > 0.5) write(element, bottom)
        commitPosition(element, true)
        return
      }
      commitPosition(element, isNearBottom(element))
    }
    apply()
    // One owner observes both the viewport (including Composer height changes) and
    // content (history/media). Composer must not establish a second scroll writer.
    const observer = new ResizeObserver(apply)
    observer.observe(element)
    if (element.firstElementChild) observer.observe(element.firstElementChild)
    return () => observer.disconnect()
  }, [commitPosition, enabled, key])

  return { ref, away, onScroll, jumpToBottom, markPrepend, clearPrepend }
}
