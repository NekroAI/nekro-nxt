/** @jsxImportSource preact */
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import type { Box, Mode, TourData } from './types.js'

const STEP_MS = 3200
const MAX_ZOOM = 2.4
// Never past 1.5× the screenshot's own size: a wide page already shows it about as large as it was taken.
const MAX_SHOT_ZOOM = 1.5

/**
 * How far to zoom into a step's box and where to move the picture, as fractions of the frame: the box fills most of the
 * width at up to `limit` (2.4× at most), centred, or from its top when it is taller than the frame (a whole column); the picture never
 * leaves an empty edge. Interfaces are shot whole, so without this the parts a step points at are too small to read.
 */
export const focusOn = (box: Box | undefined, limit = MAX_ZOOM) => {
  if (box === undefined) return { scale: 1, x: 0, y: 0 }
  const scale = Math.min(Math.max(0.85 / box.width, 1), Math.max(limit, 1))
  const clamp = (offset: number) => Math.min(Math.max(offset, 1 - scale), 0)
  const tall = box.height * scale > 0.9
  return {
    scale,
    x: clamp(0.5 - scale * (box.x + box.width / 2)),
    y: clamp(tall ? 0.05 - scale * box.y : 0.5 - scale * (box.y + box.height / 2)),
  }
}

/**
 * 截图导览: the screenshot with a numbered spot on each part the reader touches, the steps below it. Picking a step (in
 * the list or on the picture) zooms into its part and dims the rest; 逐步播放 walks through the steps and comes back to
 * the overview; 看原图 shows the screenshot at full size.
 */
export const Tour = ({ title, data, mode }: { title: string; data: TourData; mode: Mode }) => {
  const posterStep = mode.kind === 'poster' ? Number(/^step-(\d+)$/u.exec(mode.state)?.[1] ?? 0) - 1 : -1
  const [active, setActive] = useState<number>(posterStep)
  const [playing, setPlaying] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const frame = useRef<HTMLDivElement>(null)
  const [frameWidth, setFrameWidth] = useState(0)
  useLayoutEffect(() => {
    const element = frame.current
    if (element === null) return
    const measure = () => setFrameWidth(element.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const shown = mode.kind === 'poster' ? posterStep : active
  const limit = frameWidth > 0 ? Math.min(MAX_ZOOM, (MAX_SHOT_ZOOM * data.shot.width) / frameWidth) : MAX_ZOOM
  const focus = focusOn(data.steps[shown]?.box, limit)

  useEffect(() => {
    if (!playing) return
    const timer = setTimeout(
      () => {
        if (active + 1 >= data.steps.length) {
          setPlaying(false)
          setActive(-1)
        } else setActive(active + 1)
      },
      active < 0 ? 300 : STEP_MS,
    )
    return () => clearTimeout(timer)
  }, [playing, active, data.steps.length])

  const pick = (index: number) => {
    setPlaying(false)
    setActive(active === index ? -1 : index)
  }
  // Where a point of the screenshot lands in the frame once zoomed, in percent.
  const place = (x: number, y: number) => ({
    left: `${(focus.scale * x + focus.x) * 100}%`,
    top: `${(focus.scale * y + focus.y) * 100}%`,
  })

  return (
    <figure class="card" style={{ margin: 0 }} aria-label={`截图导览：${title}`}>
      <div class="head">
        <p class="title">
          <span class="kind">截图导览</span>
          {title}
        </p>
        {mode.kind === 'live' ? (
          <div class="controls">
            <button type="button" class="control" onClick={() => dialog.current?.showModal()}>
              看原图
            </button>
            <button
              type="button"
              class="control"
              aria-pressed={playing}
              onClick={() => {
                if (playing) setPlaying(false)
                else {
                  setActive(-1)
                  setPlaying(true)
                }
              }}
            >
              {playing ? '停止' : '逐步播放'}
            </button>
          </div>
        ) : null}
      </div>
      <div class="tour">
        <div ref={frame} class={`frame${shown >= 0 ? ' focused' : ''}`}>
          <div
            class="zoom"
            style={{
              transform: `translate(${focus.x * 100}%, ${focus.y * 100}%) scale(${focus.scale})`,
              // Outlines stay the same thickness when zoomed.
              '--zoom': String(focus.scale),
            }}
          >
            <picture>
              <source media="(prefers-color-scheme: dark)" srcSet={data.shot.dark} />
              <img
                src={data.shot.light}
                alt={title}
                width={data.shot.width}
                height={data.shot.height}
                referrerPolicy="no-referrer"
              />
            </picture>
            {data.steps.map((step, index) => (
              <div
                key={`spot-${index}`}
                class={`spot${shown === index ? ' on' : ''}`}
                style={{
                  left: `${step.box.x * 100}%`,
                  top: `${step.box.y * 100}%`,
                  width: `${step.box.width * 100}%`,
                  height: `${step.box.height * 100}%`,
                }}
              />
            ))}
          </div>
          {data.steps.map((step, index) => {
            // Pins sit on the box's top-right corner, clear of the titles interfaces put on the left, kept inside.
            const at = place(step.box.x + step.box.width, step.box.y)
            return (
              <button
                key={`pin-${index}`}
                type="button"
                class={`pin${shown === index ? ' on' : ''}`}
                tabIndex={-1}
                aria-hidden="true"
                style={{
                  left: `clamp(14px, ${at.left}, calc(100% - 14px))`,
                  top: `clamp(14px, ${at.top}, calc(100% - 14px))`,
                }}
                onClick={() => pick(index)}
              >
                {index + 1}
              </button>
            )
          })}
        </div>
        <ol class="steps">
          {data.steps.map((step, index) => (
            <li key={index}>
              <button
                type="button"
                class={`step${shown === index ? ' on' : ''}`}
                aria-pressed={shown === index}
                onClick={() => pick(index)}
              >
                <span class="num">{index + 1}</span>
                <span>{step.text}</span>
              </button>
            </li>
          ))}
        </ol>
      </div>
      {mode.kind === 'live' ? (
        <dialog
          ref={dialog}
          class="full"
          aria-label={`${title}：原图`}
          onClick={(event) => {
            if (event.target === event.currentTarget) dialog.current?.close()
          }}
        >
          <button type="button" class="control close" onClick={() => dialog.current?.close()}>
            关闭
          </button>
          <picture>
            <source media="(prefers-color-scheme: dark)" srcSet={data.shot.dark} />
            <img src={data.shot.light} alt={title} style={{ width: `${data.shot.width}px` }} referrerPolicy="no-referrer" />
          </picture>
        </dialog>
      ) : null}
    </figure>
  )
}
