import { useEffect, useRef, useState } from 'preact/hooks'
import type { Mode } from './types.js'

export type Control = { readonly label: string; readonly toggle: () => void } | null

const useReducedMotion = () => {
  const [reduced] = useState(
    () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  return reduced
}

/**
 * The time of a widget's animation. Everything it shows is a function of this time, so a GIF frame and the live page
 * show exactly the same picture. Live: plays once when it scrolls into view and stops on the finished picture; the
 * control pauses, resumes or replays, `seek` jumps and holds, `restart` plays again from the start. Posters take the time
 * they are given; with reduced motion it starts finished.
 */
export const useClock = (mode: Mode, total: number, animate: boolean, root: { current: HTMLElement | null }) => {
  const reduced = useReducedMotion()
  const still = mode.kind === 'poster' || !animate || reduced
  const [time, setTime] = useState(still ? total : 0)
  const [running, setRunning] = useState(false)
  const clock = useRef(time)
  const started = useRef(false)
  useEffect(() => {
    if (still || root.current === null) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting) || started.current) return
        started.current = true
        setRunning(true)
        observer.disconnect()
      },
      { threshold: 0.5 },
    )
    observer.observe(root.current)
    return () => observer.disconnect()
  }, [still, root])
  useEffect(() => {
    if (!running) return
    let frame = 0
    let last = performance.now()
    const tick = (now: number) => {
      clock.current = Math.min(total, clock.current + (now - last))
      last = now
      setTime(clock.current)
      if (clock.current >= total) setRunning(false)
      else frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [running, total])
  const seek = (at: number) => {
    started.current = true
    setRunning(false)
    clock.current = Math.min(Math.max(at, 0), total)
    setTime(clock.current)
  }
  const restart = () => {
    seek(still ? total : 0)
    if (!still) setRunning(true)
  }
  const control: Control = still
    ? null
    : {
        label: running ? '暂停' : time >= total ? '重播' : time > 0 ? '继续' : '播放',
        toggle: () => {
          started.current = true
          if (running) return setRunning(false)
          if (clock.current >= total) {
            clock.current = 0
            setTime(0)
          }
          setRunning(true)
        },
      }
  return { time: mode.kind === 'poster' ? mode.time : time, running, control, seek, restart }
}
