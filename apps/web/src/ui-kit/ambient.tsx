import { useEffect, useRef, type ReactNode } from 'react'
import styles from './ambient.module.css'

const motionOff = (): boolean =>
  document.documentElement.dataset['nxtMotion'] === 'off' ||
  (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)

/** Renderers that draw WebGL on the CPU; headless browsers use SwiftShader, and so do machines without a GPU driver. */
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|software|basic render/iu

/**
 * A GPU that draws WebGL. On a software renderer the scene would take most of every frame and slow the whole page
 * down; those devices keep the static glow. Browsers do not always count software rendering as a performance
 * caveat, so the renderer name is checked as well.
 */
const webglAvailable = (): boolean => {
  try {
    const probe = document.createElement('canvas')
    const options: WebGLContextAttributes = { failIfMajorPerformanceCaveat: true }
    const gl = probe.getContext('webgl2', options) ?? probe.getContext('webgl', options)
    if (gl === null) return false
    const info = gl.getExtension('WEBGL_debug_renderer_info')
    const renderer = info === null ? '' : String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL))
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return !SOFTWARE_RENDERER.test(renderer)
  } catch {
    return false
  }
}

/** Runs `start` once the page that just opened has settled, so loading the scene never stalls a space switch. */
const whenIdle = (start: () => void): (() => void) => {
  if (typeof window.requestIdleCallback === 'function') {
    const handle = window.requestIdleCallback(start, { timeout: 2000 })
    return () => window.cancelIdleCallback(handle)
  }
  const handle = window.setTimeout(start, 600)
  return () => window.clearTimeout(handle)
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

    const cancelStart = whenIdle(() => {
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
        theme.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['data-theme', 'data-nxt-motion'],
        })
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
    })

    return () => {
      disposed = true
      cancelStart()
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
