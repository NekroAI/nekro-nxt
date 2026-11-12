/** @jsxImportSource preact */
import { useRef } from 'preact/hooks'
import { useClock } from './clock.js'
import type { Mode, PipelineData } from './types.js'

/** When the marker reaches each stage and how long it takes, as a function of time (see useClock). */
export const pipelineTimeline = (stages: number) => {
  const lead = 400
  const dwell = 2400
  const travel = 700
  const reach = (stage: number) => lead + stage * (dwell + travel)
  const total = reach(stages - 1) + dwell
  return {
    total,
    reach,
    /** The stage the marker is at or last left, and how far along the next link it is (0 while it stays). */
    at: (time: number) => {
      if (time < lead) return { stage: -1, travel: 0 }
      const stage = Math.min(Math.floor((time - lead) / (dwell + travel)), stages - 1)
      const moving = time - reach(stage) - dwell
      return { stage, travel: stage < stages - 1 && moving > 0 ? Math.min(moving / travel, 1) : 0 }
    },
  }
}

/**
 * 链路动画: a marker passes through the stages one by one, the panel below saying what happens at each. Play, pause,
 * step back and forth, or pick a stage to stop there. A poster `step-N` holds stage N; `overview` is the finished run.
 */
export const Pipeline = ({ title, data, mode }: { title: string; data: PipelineData; mode: Mode }) => {
  const root = useRef<HTMLElement>(null)
  const timeline = pipelineTimeline(data.stages.length)
  const posterStep = mode.kind === 'poster' ? Number(/^step-(\d+)$/u.exec(mode.state)?.[1] ?? 0) - 1 : -1
  const { time, control, seek } = useClock(mode, timeline.total, true, root)
  const shownTime = posterStep >= 0 ? timeline.reach(posterStep) + 1 : time
  const { stage, travel } = timeline.at(shownTime)
  const finished = posterStep < 0 && shownTime >= timeline.total
  const current = data.stages[Math.max(stage, 0)]
  const go = (index: number) => seek(timeline.reach(index) + 1)
  const track = useRef<HTMLOListElement>(null)

  return (
    <figure ref={root} class="card" style={{ margin: 0 }} aria-label={`链路动画：${title}`}>
      <div class="head">
        <p class="title">
          <span class="kind">链路动画</span>
          {title}
        </p>
        {mode.kind === 'live' ? (
          <div class="controls">
            <button type="button" class="control icon" aria-label="上一环" disabled={stage <= 0} onClick={() => go(stage - 1)}>
              ‹
            </button>
            {control === null ? null : (
              <button type="button" class="control" onClick={control.toggle}>
                {control.label}
              </button>
            )}
            <button
              type="button"
              class="control icon"
              aria-label="下一环"
              disabled={stage >= data.stages.length - 1}
              onClick={() => go(stage + 1)}
            >
              ›
            </button>
          </div>
        ) : null}
      </div>
      <ol ref={track} class="track" style={{ '--stages': String(data.stages.length) }}>
        {data.stages.map((item, index) => {
          const state = finished || index < stage ? 'passed' : index === stage ? 'here' : 'ahead'
          const link = index === stage ? travel : index < stage || finished ? 1 : 0
          return (
            <li key={index} class={`stop ${state}`}>
              <button
                type="button"
                class="stage"
                data-stage={index}
                aria-current={index === stage && !finished ? 'step' : undefined}
                onClick={() => go(index)}
                onKeyDown={(event) => {
                  const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
                  if (step === 0) return
                  // Arrows move along the track, taking the focus with them.
                  event.preventDefault()
                  const next = Math.min(Math.max(index + step, 0), data.stages.length - 1)
                  go(next)
                  track.current?.querySelectorAll<HTMLElement>('.stage')[next]?.focus()
                }}
              >
                <span class="num">{index + 1}</span>
                <b>{item.label}</b>
                {item.note === undefined ? null : <small>{item.note}</small>}
              </button>
              {index < data.stages.length - 1 ? (
                <span class="link" aria-hidden="true">
                  <span class="link-fill" style={{ '--fill': String(link) }} />
                  {link > 0 && link < 1 ? <span class="packet" style={{ '--at': String(link) }} /> : null}
                </span>
              ) : null}
            </li>
          )
        })}
      </ol>
      <div class="detail" aria-live="polite">
        {finished ? (
          <p>
            <b>全部 {data.stages.length} 环</b>
            {data.stages.map((item) => item.label).join(' → ')}。点任一环看它做什么。
          </p>
        ) : stage < 0 || current === undefined ? (
          <p class="muted">点任一环看它做什么。</p>
        ) : (
          <p>
            <b>
              {stage + 1}. {current.label}
            </b>
            {current.detail}
          </p>
        )}
      </div>
    </figure>
  )
}
