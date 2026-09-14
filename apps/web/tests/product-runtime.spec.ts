import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createProductRuntime, ProductRuntimeProvider, useProductRuntime } from '../src/product-runtime.js'

describe('product runtime ownership', () => {
  it('shares one authoritative snapshot with HTTP and isolates runtime instances', () => {
    const first = createProductRuntime()
    const second = createProductRuntime()
    expect(first.host.getSnapshot()).toBe(first.store.getState())
    first.store.setState({ diagnosticNote: 'fixture update' })
    expect(first.host.getSnapshot().diagnosticNote).toBe('fixture update')
    expect(second.host.getSnapshot().diagnosticNote).not.toBe('fixture update')
  })

  it('injects the same isolated store into selectors and actions throughout the component tree', () => {
    const first = createProductRuntime()
    const second = createProductRuntime()
    first.store.setState({ diagnosticNote: 'first runtime' })
    second.store.setState({ diagnosticNote: 'second runtime' })
    function Read() {
      return useProductRuntime().store.getState().diagnosticNote
    }
    const render = (runtime: typeof first) =>
      renderToStaticMarkup(
        createElement(ProductRuntimeProvider, {
          runtime,
          children: createElement(Read),
        }),
      )
    expect(render(first)).toBe('first runtime')
    expect(render(second)).toBe('second runtime')
  })

  it('keeps UI preference updates out of the Host snapshot', () => {
    const runtime = createProductRuntime()
    const snapshot = runtime.host.getSnapshot()
    runtime.uiStore.setState({ theme: 'dark', reducedMotion: true })
    expect(runtime.host.getSnapshot()).toBe(snapshot)
    expect(snapshot).not.toHaveProperty('theme')
    expect(snapshot).not.toHaveProperty('reducedMotion')
  })
})
