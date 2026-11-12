/** @jsxImportSource preact */
import { useEffect, useState } from 'preact/hooks'
import type { Mode, TourData } from './types.js'

const STEP_MS = 3200

/**
 * 截图导览: the screenshot with a numbered spot on each part the reader touches. Picking a step (in the list or on the
 * picture) dims everything else; 逐步播放 walks through the steps and comes back to the overview.
 */
export const Tour = ({ title, data, mode }: { title: string; data: TourData; mode: Mode }) => {
  const posterStep = mode.kind === 'poster' ? Number(/^step-(\d+)$/u.exec(mode.state)?.[1] ?? 0) - 1 : -1
  const [active, setActive] = useState<number>(posterStep)
  const [playing, setPlaying] = useState(false)
  const shown = mode.kind === 'poster' ? posterStep : active

  useEffect(() => {
    if (!playing) return
    const timer = setTimeout(() => {
      if (active + 1 >= data.steps.length) {
        setPlaying(false)
        setActive(-1)
      } else setActive(active + 1)
    }, active < 0 ? 300 : STEP_MS)
    return () => clearTimeout(timer)
  }, [playing, active, data.steps.length])

  const pick = (index: number) => {
    setPlaying(false)
    setActive(active === index ? -1 : index)
  }

  return (
    <figure class="card" style={{ margin: 0 }} aria-label={`截图导览：${title}`}>
      <div class="head">
        <p class="title">
          <span class="kind">截图导览</span>
          {title}
        </p>
        {mode.kind === 'live' ? (
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
        ) : null}
      </div>
      <div class="tour">
        <div class={`frame${shown >= 0 ? ' focused' : ''}`}>
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
          {data.steps.map((step, index) => (
            <button
              key={`pin-${index}`}
              type="button"
              class={`pin${shown === index ? ' on' : ''}`}
              tabIndex={-1}
              aria-hidden="true"
              style={{
                // Pins sit on the box's top-right corner, clear of the titles interfaces put on the left, kept inside.
                left: `${Math.min(Math.max((step.box.x + step.box.width) * 100, 2.5), 97.5)}%`,
                top: `${Math.min(Math.max(step.box.y * 100, 4), 96)}%`,
              }}
              onClick={() => pick(index)}
            >
              {index + 1}
            </button>
          ))}
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
    </figure>
  )
}
