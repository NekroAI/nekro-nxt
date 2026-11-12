/** @jsxImportSource preact */
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import type { DiagramData, Mode } from './types.js'

type FlowData = Extract<DiagramData, { type: 'flow' }>

const NODE_MIN = 128
const NODE_MAX = 184
const COLUMN_GAP = 72
// A grid placed by hand keeps its columns on a phone with narrower boxes and gaps.
const COMPACT_NODE_MIN = 84
const COMPACT_COLUMN_GAP = 24

const rowWidth = (columns: number, node: number, gap: number) => columns * node + (columns - 1) * gap
const GAP = 6

/** The animation of a flow, as a function of time, so a GIF frame and the live page show exactly the same picture. */
export const flowTimeline = (edges: number) => {
  const lead = 500
  const perEdge = 1300
  const travel = 850
  const total = lead + edges * perEdge + 1800
  return {
    total,
    /** 0 before the dot leaves, 1 once it has arrived. */
    progress: (edge: number, time: number) => Math.min(Math.max((time - (lead + edge * perEdge)) / travel, 0), 1),
  }
}

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Where the line between two boxes leaves the first and meets the second, a few pixels off their borders; null while
 * the boxes have no size yet (the widget is mounted before its host is shown).
 */
const between = (from: Rect, to: Rect) => {
  if (from.width === 0 || to.width === 0) return null
  const a = { x: from.x + from.width / 2, y: from.y + from.height / 2 }
  const b = { x: to.x + to.width / 2, y: to.y + to.height / 2 }
  const dx = b.x - a.x
  const dy = b.y - a.y
  const reach = (rect: Rect) =>
    Math.min(
      dx === 0 ? Infinity : (rect.width / 2 + GAP) / Math.abs(dx),
      dy === 0 ? Infinity : (rect.height / 2 + GAP) / Math.abs(dy),
    )
  const start = reach(from)
  const end = 1 - reach(to)
  return {
    x1: a.x + dx * start,
    y1: a.y + dy * start,
    x2: a.x + dx * end,
    y2: a.y + dy * end,
  }
}

const useReducedMotion = () => {
  const [reduced] = useState(
    () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  return reduced
}

/**
 * Live: plays once when it scrolls into view and stops on the finished picture; the button pauses, resumes or replays.
 * Posters take the time they are given.
 */
const useFlowClock = (mode: Mode, total: number, animate: boolean, root: { current: HTMLElement | null }) => {
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
  return { time: mode.kind === 'poster' ? mode.time : time, control }
}

const Flow = ({ data, mode, onControl }: { data: FlowData; mode: Mode; onControl: (control: Control) => void }) => {
  const canvas = useRef<HTMLDivElement>(null)
  const [rects, setRects] = useState<Map<string, Rect>>(new Map())
  const [width, setWidth] = useState(0)
  const [hot, setHot] = useState<string | null>(null)
  const timeline = flowTimeline(data.edges.length)
  const { time, control } = useFlowClock(mode, timeline.total, data.animate, canvas)
  // The header shows the button; it changes only with the label, and toggle reads the clock through refs.
  useEffect(() => onControl(control), [control?.label])

  const placed = data.nodes.every((node) => node.at !== undefined)
  // A chain that does not fit on one line turns back on the next, like reading a snake; too narrow for three boxes a
  // line, it runs straight down.
  const count = data.nodes.length
  const fit = width > 0 ? Math.max(1, Math.floor((width + COLUMN_GAP) / (NODE_MIN + COLUMN_GAP))) : count
  const perRow = count <= fit ? count : fit >= 3 ? fit : 1
  const vertical = !placed && perRow === 1
  const cells = data.nodes.map((node, index) => {
    if (placed && node.at) return { column: node.at[0] + 1, row: node.at[1] + 1 }
    const row = Math.floor(index / perRow)
    const position = index % perRow
    return { column: (row % 2 === 0 ? position : perRow - 1 - position) + 1, row: row + 1 }
  })
  const columns = Math.max(...cells.map((cell) => cell.column))
  const compact = placed && width > 0 && width < rowWidth(columns, NODE_MIN, COLUMN_GAP)
  const nodeMin = compact ? COMPACT_NODE_MIN : NODE_MIN

  useLayoutEffect(() => {
    const element = canvas.current
    if (element === null) return
    // offset* ignore transforms and are relative to the canvas, which is what the wires are drawn in.
    const measure = () => {
      setWidth(element.parentElement?.clientWidth ?? element.clientWidth)
      const next = new Map<string, Rect>()
      for (const child of element.querySelectorAll<HTMLElement>('[data-node]'))
        next.set(child.dataset['node'] ?? '', {
          x: child.offsetLeft,
          y: child.offsetTop,
          width: child.offsetWidth,
          height: child.offsetHeight,
        })
      setRects(next)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    if (element.parentElement) observer.observe(element.parentElement)
    return () => observer.disconnect()
  }, [perRow, compact])

  const progress = data.edges.map((_edge, index) => (data.animate ? timeline.progress(index, time) : 1))
  const incoming = new Set(data.edges.map((edge) => edge.to))
  const lit = new Set(data.nodes.filter((node) => !incoming.has(node.id)).map((node) => node.id))
  data.edges.forEach((edge, index) => {
    if (progress[index] === 1) lit.add(edge.to)
  })

  return (
    <div style={{ overflowX: placed ? 'auto' : 'visible' }}>
      <div
        ref={canvas}
        class={`canvas${vertical ? ' vertical' : ''}${compact ? ' compact' : ''}`}
        style={{
          gridTemplateColumns: vertical ? 'minmax(0, 320px)' : `repeat(${columns}, minmax(${nodeMin}px, ${NODE_MAX}px))`,
          columnGap: compact ? `${COMPACT_COLUMN_GAP}px` : undefined,
          justifyContent: 'center',
        }}
      >
        <svg class="wires" aria-hidden="true">
          {data.edges.map((edge, index) => {
            const from = rects.get(edge.from)
            const to = rects.get(edge.to)
            const line = from === undefined || to === undefined ? null : between(from, to)
            if (line === null) return null
            const done = progress[index] === 1
            const angle = Math.atan2(line.y2 - line.y1, line.x2 - line.x1)
            const arrow = [0, 2.5, -2.5]
              .map((turn, corner) => {
                const length = corner === 0 ? 0 : 9
                const a = angle + Math.PI + (corner === 0 ? 0 : turn / 6)
                return `${line.x2 + Math.cos(a) * length},${line.y2 + Math.sin(a) * length}`
              })
              .join(' ')
            const p = progress[index] ?? 1
            const isHot = hot !== null && (edge.from === hot || edge.to === hot)
            return (
              <g key={index}>
                <line class={`wire${done || isHot ? ' lit' : ''}`} {...line} />
                <polygon class={`head-arrow${done || isHot ? ' lit' : ''}`} points={arrow} />
                {p > 0 && p < 1 ? (
                  <circle class="dot" r={5} cx={line.x1 + (line.x2 - line.x1) * p} cy={line.y1 + (line.y2 - line.y1) * p} />
                ) : null}
              </g>
            )
          })}
        </svg>
        {data.edges.map((edge, index) => {
          const from = rects.get(edge.from)
          const to = rects.get(edge.to)
          const line = edge.label === undefined || from === undefined || to === undefined ? null : between(from, to)
          if (line === null) return null
          // Beside the line rather than on it, so a short arrow stays visible: above a level one, beside a steep one on
          // the side facing the middle, so it stays inside the picture.
          const level = Math.abs(line.x2 - line.x1) >= Math.abs(line.y2 - line.y1)
          const middle = (line.x1 + line.x2) / 2
          const side = middle > (canvas.current?.offsetWidth ?? 0) / 2 ? 'translate(calc(-100% - 8px), -50%)' : 'translate(8px, -50%)'
          return (
            <span
              key={`label-${index}`}
              class="wire-label"
              style={{
                left: `${(line.x1 + line.x2) / 2}px`,
                top: `${(line.y1 + line.y2) / 2}px`,
                transform: level ? 'translate(-50%, calc(-100% - 5px))' : side,
                opacity: progress[index] === 1 ? 1 : 0,
              }}
            >
              {edge.label}
            </span>
          )
        })}
        {data.nodes.map((node, index) => (
          <div
            key={node.id}
            data-node={node.id}
            class={`node${lit.has(node.id) ? ' lit' : ''}${hot === node.id ? ' hot' : ''}`}
            style={{ gridColumn: cells[index]?.column, gridRow: cells[index]?.row }}
            onMouseEnter={() => setHot(node.id)}
            onMouseLeave={() => setHot(null)}
          >
            <b>{node.label}</b>
            {node.note === undefined ? null : <small>{node.note}</small>}
          </div>
        ))}
      </div>
    </div>
  )
}

type Control = { readonly label: string; readonly toggle: () => void } | null

/** 图解: a flow (boxes and arrows, optionally animated), stacked layers, or columns compared side by side. */
export const Diagram = ({ title, data, mode }: { title: string; data: DiagramData; mode: Mode }) => {
  const [control, setControl] = useState<Control>(null)
  return (
    <figure class="card" style={{ margin: 0 }} aria-label={`图解：${title}`}>
      <div class="head">
        <p class="title">
          <span class="kind">图解</span>
          {title}
        </p>
        {mode.kind === 'live' && control !== null ? (
          <button type="button" class="control" onClick={control.toggle}>
            {control.label}
          </button>
        ) : null}
      </div>
      {data.type === 'flow' ? <Flow data={data} mode={mode} onControl={setControl} /> : null}
      {data.type === 'layers' ? (
        <div class="layers">
          {data.layers.map((layer, index) => (
            <div key={index} class="layer">
              <b>{layer.label}</b>
              {layer.note === undefined ? <span /> : <p>{layer.note}</p>}
              {layer.items.length === 0 ? null : (
                <div class="chips">
                  {layer.items.map((item) => (
                    <span key={item} class="chip">
                      {item}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      ) : null}
      {data.type === 'compare' ? (
        <div class="compare" style={{ '--columns': String(data.columns.length) }}>
          {data.columns.map((column, index) => (
            <div key={index} class={`column ${column.tone}`}>
              <b>{column.title}</b>
              <ul>
                {column.points.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : null}
    </figure>
  )
}
