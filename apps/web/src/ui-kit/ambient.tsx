import { useEffect, useRef, type ReactNode } from 'react'
import styles from './ambient.module.css'

const motionOff = (): boolean =>
  document.documentElement.dataset['nxtMotion'] === 'off' ||
  (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)

/**
 * A GPU that draws WebGL. Without one the browser falls back to software rendering, where the scene would take most
 * of each frame and slow the page down; those devices keep the static glow.
 */
const webglAvailable = (): boolean => {
  try {
    const probe = document.createElement('canvas')
    const options = { failIfMajorPerformanceCaveat: true }
    return probe.getContext('webgl2', options) !== null || probe.getContext('webgl', options) !== null
  } catch {
    return false
  }
}

/**
 * Ambient moon-tide backdrop for low-frequency pages only (welcome, about, large empty states; 05 §2.2, §11.5). It
 * starts as a static glow, fades the live canvas in once the first frame is drawn, pauses when off screen or hidden,
 * and stays still under reduced motion. Content goes in `children` and always sits above the canvas.
 */
export function Ambient({ children, className }: { readonly children?: ReactNode; readonly className?: string }) {
  const root = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const element = root.current
    const surface = canvas.current
    if (!element || !surface || !webglAvailable()) return
    let disposed = false
    let frame = 0
    let visible = true
    let cleanup = () => {}

    void import('./ambient-scene.js').then(({ createAmbientScene }) => {
      if (disposed) return
      let scene: ReturnType<typeof createAmbientScene>
      try {
        scene = createAmbientScene(surface)
      } catch {
        return
      }
      scene.setColors()
      scene.resize()
      const started = performance.now()
      // A fixed moment of the flow for still frames, so reduced motion shows a composed picture.
      const stillAt = 18
      const draw = () => {
        frame = 0
        if (disposed) return
        scene.render(motionOff() ? stillAt : stillAt + (performance.now() - started) / 1000)
        if (!motionOff() && visible && document.visibilityState === 'visible') frame = requestAnimationFrame(draw)
      }
      const wake = () => {
        if (frame === 0) frame = requestAnimationFrame(draw)
      }
      draw()
      element.dataset['live'] = 'true'

      const resize = new ResizeObserver(() => {
        scene.resize()
        wake()
      })
      resize.observe(surface)
      const intersection = new IntersectionObserver(([entry]) => {
        visible = entry?.isIntersecting ?? true
        if (visible) wake()
      })
      intersection.observe(element)
      const theme = new MutationObserver(() => {
        scene.setColors()
        wake()
      })
      theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-nxt-motion'] })
      const onPointer = (event: PointerEvent) => {
        const box = element.getBoundingClientRect()
        scene.setPointer((event.clientX - box.left) / box.width, 1 - (event.clientY - box.top) / box.height)
      }
      element.addEventListener('pointermove', onPointer)
      document.addEventListener('visibilitychange', wake)

      cleanup = () => {
        cancelAnimationFrame(frame)
        resize.disconnect()
        intersection.disconnect()
        theme.disconnect()
        element.removeEventListener('pointermove', onPointer)
        document.removeEventListener('visibilitychange', wake)
        scene.dispose()
      }
    })

    return () => {
      disposed = true
      cleanup()
    }
  }, [])

  return (
    <div ref={root} className={[styles.ambient, className ?? ''].join(' ')}>
      <canvas ref={canvas} className={styles.canvas} aria-hidden="true" />
      <div className={styles.content}>{children}</div>
    </div>
  )
}
