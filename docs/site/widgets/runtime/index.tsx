/** @jsxImportSource preact */
// Entry of the widget runtime the docs bundle ships (scripts/docs-widgets.mjs builds it). The site imports it and calls
// mount() on each widget; the poster renderer calls it with a frozen state and time.
import { render } from 'preact'
import { Diagram } from './diagram.js'
import { STYLES } from './styles.js'
import { Tour } from './tour.js'
import type { Mode, Widget } from './types.js'

export type { Widget } from './types.js'

export { flowTimeline } from './diagram.js'

const Root = ({ widget, mode }: { widget: Widget; mode: Mode }) =>
  widget.kind === 'tour' ? (
    <Tour title={widget.title} data={widget.data} mode={mode} />
  ) : (
    <Diagram title={widget.title} data={widget.data} mode={mode} />
  )

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
