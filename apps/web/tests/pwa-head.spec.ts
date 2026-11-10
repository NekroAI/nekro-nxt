import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const read = (relative: string) => readFile(new URL(relative, import.meta.url), 'utf8')

/** The value a theme block of tokens.css gives `name`; the light block comes first, the dark one second. */
const token = (css: string, theme: 'light' | 'dark', name: string): string => {
  const blocks = css.split("html[data-ui='next'][data-theme='dark']")
  const block = theme === 'light' ? blocks[0] : blocks[1]
  const value = new RegExp(`\\n\\s*${name}:\\s*([^;]+);`, 'u').exec(block ?? '')?.[1]
  if (!value) throw new Error(`tokens.css 没有 ${theme} 主题的 ${name}。`)
  return value.trim().toLowerCase()
}

describe('home screen app', () => {
  it('opens at the app root inside its own scope, on the colour the first page paints', async () => {
    const manifest: unknown = JSON.parse(await read('../public/site.webmanifest'))
    const tokens = await read('../src/ui-kit/tokens.css')

    expect(manifest).toMatchObject({
      id: '/',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      // Before any script runs the page has no theme attribute, so it paints the light tokens.
      background_color: token(tokens, 'light', '--bg'),
      theme_color: token(tokens, 'light', '--side'),
    })
  })

  it('reaches under the notch and starts the status bar on the top bar colour of the system scheme', async () => {
    const html = await read('../index.html')
    const tokens = await read('../src/ui-kit/tokens.css')

    const viewport = /<meta\s+name="viewport"\s+content="([^"]*)"/u.exec(html)?.[1] ?? ''
    expect(viewport.split(/,\s*/u)).toContain('viewport-fit=cover')
    const themeColors = [...html.matchAll(/<meta name="theme-color" content="([^"]+)"([^>]*)>/gu)].map((match) => ({
      color: match[1]?.toLowerCase(),
      media: /media="([^"]+)"/u.exec(match[2] ?? '')?.[1],
    }))
    expect(themeColors).toEqual([
      { color: token(tokens, 'light', '--side'), media: '(prefers-color-scheme: light)' },
      { color: token(tokens, 'dark', '--side'), media: '(prefers-color-scheme: dark)' },
    ])
    for (const name of ['mobile-web-app-capable', 'apple-mobile-web-app-capable'])
      expect(html).toContain(`<meta name="${name}" content="yes" />`)
    expect(html).toContain('<meta name="apple-mobile-web-app-status-bar-style" content="default" />')
  })

  it('lets Android resize the page for the keyboard and never locks zoom', async () => {
    const html = await read('../index.html')
    const viewport = /<meta\s+name="viewport"\s+content="([^"]*)"/u.exec(html)?.[1] ?? ''

    expect(viewport.split(/,\s*/u)).toContain('interactive-widget=resizes-content')
    expect(viewport).not.toMatch(/maximum-scale|user-scalable/u)
  })

  it('opens no long-press menu on controls, and keeps it on content, wherever selection is switched', async () => {
    const tokens = await read('../src/ui-kit/tokens.css')
    const blocks = [...tokens.matchAll(/\{([^{}]*)\}/gu)].map((match) => match[1] ?? '')
    const off = blocks.filter((block) => /user-select:\s*none/u.test(block))
    const on = blocks.filter((block) => /user-select:\s*text/u.test(block))
    expect(off.length).toBeGreaterThan(0)
    expect(on.length).toBeGreaterThan(0)
    for (const block of off) expect(block).toMatch(/-webkit-touch-callout:\s*none/u)
    for (const block of on) expect(block).toMatch(/-webkit-touch-callout:\s*default/u)
  })
})
