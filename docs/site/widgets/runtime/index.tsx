/** @jsxImportSource preact */
// Entry of the widget runtime the docs bundle ships (scripts/docs-widgets.mjs builds it). The site imports it and calls
// mount() on each widget; the poster renderer calls it with a frozen state and time.
import { render } from 'preact'
import { Chat, chatCycle } from './chat.js'
import { Diagram, flowTimeline } from './diagram.js'
import { Pipeline, pipelineTimeline } from './pipeline.js'
import { STYLES } from './styles.js'
import { Tour } from './tour.js'
import type { Mode, Widget } from './types.js'
import { Wizard } from './wizard.js'

export type { Widget } from './types.js'

const Root = ({ widget, mode }: { widget: Widget; mode: Mode }) => {
  switch (widget.kind) {
    case 'tour':
      return <Tour title={widget.title} data={widget.data} mode={mode} />
    case 'diagram':
      return <Diagram title={widget.title} data={widget.data} mode={mode} />
    case 'wizard':
      return <Wizard title={widget.title} data={widget.data} mode={mode} />
    case 'chat':
      return <Chat title={widget.title} data={widget.data} mode={mode} />
    case 'pipeline':
      return <Pipeline title={widget.title} data={widget.data} mode={mode} />
  }
}

/** How long the animation of a widget's overview runs, in ms, for its GIF; 0 when it does not move. */
export function animationLength(widget: Widget): number {
  if (widget.kind === 'diagram') return widget.data.type === 'flow' && widget.data.animate ? flowTimeline(widget.data.edges.length).total : 0
  if (widget.kind === 'chat') return chatCycle(widget.data).total
  if (widget.kind === 'pipeline') return pipelineTimeline(widget.data.stages.length).total
  return 0
}

/**
 * Renders a widget into `host` inside a shadow root, so page styles and widget styles stay apart. Returns a function that
 * removes it. Pass `poster` to freeze one state at one moment, for still images and animation frames.
 */
export function mount(
  host: HTMLElement,
  widget: Widget,
  poster?: { readonly state: string; readonly time: number },
): () => void {
  const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
  root.innerHTML = `<style>${STYLES}</style>`
  const container = document.createElement('div')
  root.append(container)
  render(<Root widget={widget} mode={poster === undefined ? { kind: 'live' } : { kind: 'poster', ...poster }} />, container)
  return () => {
    render(null, container)
    root.innerHTML = ''
  }
}
