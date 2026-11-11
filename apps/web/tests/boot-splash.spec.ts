import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { removeBootSplash, type SplashDocument, type SplashNode } from '../src/boot-splash.ts'

const read = (relative: string) => readFile(new URL(relative, import.meta.url), 'utf8')

/** The value a theme block of tokens.css gives `name`; the light block comes first, the dark one second. */
const token = (css: string, theme: 'light' | 'dark', name: string): string => {
  const blocks = css.split("html[data-ui='next'][data-theme='dark']")
  const block = theme === 'light' ? blocks[0] : blocks[1]
  const value = new RegExp(`\\n\\s*${name}:\\s*([^;]+);`, 'u').exec(block ?? '')?.[1]
  if (!value) throw new Error(`tokens.css 没有 ${theme} 主题的 ${name}。`)
  return value.trim().toLowerCase()
}

/** `#rrggbb` as the `rgb(r g b / 0.16)` the splash uses for its progress track. */
const track = (hex: string): string => {
  const channels = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16))
  return `rgb(${channels.join(' ')} / 0.16)`
}

describe('boot splash page', () => {
  it('repeats the tokens its colors come from', async () => {
    const html = await read('../index.html')
    const tokens = await read('../src/ui-kit/tokens.css')
    const style = /<style>([\s\S]*?)<\/style>/u.exec(html)?.[1]?.toLowerCase() ?? ''
    const rule = (selector: string) => {
      const start = style.indexOf(`\n      ${selector} {`)
      return style.slice(start, style.indexOf('}', start))
    }

    for (const [theme, selector] of [
      ['light', 'html'],
      ['dark', "html[data-theme='dark']"],
    ] as const) {
      const block = rule(selector)
      expect(block).toContain(`background: ${token(tokens, theme, '--bg')};`)
      expect(block).toContain(`--boot-focus: ${token(tokens, theme, '--focus')};`)
      expect(block).toContain(`--boot-focus-track: ${track(token(tokens, theme, '--focus'))};`)
      expect(block).toContain(`--boot-muted: ${token(tokens, theme, '--muted')};`)
    }
    expect(rule('#boot-splash')).toContain(`background: ${token(tokens, 'light', '--bg')};`)
    expect(rule("html[data-theme='dark'] #boot-splash")).toContain(`background: ${token(tokens, 'dark', '--bg')};`)
  })

  it('names the splash for screen readers and shows the slow-loading line after 12 seconds', async () => {
    const html = await read('../index.html')

    expect(html).toContain('<div id="boot-splash" role="status" aria-label="正在加载 NekroNXT">')
    expect(html).toContain('}, 12000)')
    expect(html).toContain('仍在加载，网络可能较慢')
    expect(html).toContain('重新加载')
  })

  describe('theme script', () => {
    const run = async (input: { stored?: string | Error; dark: boolean }) => {
      const html = await read('../index.html')
      const tokens = await read('../src/ui-kit/tokens.css')
      const script = /<head>[\s\S]*?<script>([\s\S]*?)<\/script>/u.exec(html)?.[1] ?? ''
      const attributes = new Map<string, string>()
      const classes = new Set<string>()
      const metas = [{ content: 'x' }, { content: 'y' }].map((meta) => ({
        content: meta.content,
        setAttribute(name: string, value: string) {
          if (name === 'content') this.content = value
        },
      }))
      const written: string[] = []
      const window = {
        localStorage: {
          getItem: () => {
            if (input.stored instanceof Error) throw input.stored
            return input.stored ?? null
          },
          setItem: (key: string) => written.push(key),
        },
        matchMedia: () => ({ matches: input.dark }),
      }
      const document = {
        documentElement: {
          setAttribute: (name: string, value: string) => attributes.set(name, value),
          classList: { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name) },
        },
        querySelectorAll: () => metas,
      }
      runInNewContext(script, { window, document })
      return {
        theme: attributes.get('data-theme'),
        dark: classes.has('dark'),
        colors: metas.map((meta) => meta.content),
        written,
        side: { light: token(tokens, 'light', '--side'), dark: token(tokens, 'dark', '--side') },
      }
    }

    it.each([
      ['a saved light theme over a dark system', { stored: 'light', dark: true }, 'light'],
      ['a saved dark theme over a light system', { stored: 'dark', dark: false }, 'dark'],
      ['no saved theme on a dark system', { dark: true }, 'dark'],
      ['no saved theme on a light system', { dark: false }, 'light'],
      ['storage that throws', { stored: new Error('denied'), dark: true }, 'dark'],
      ['an unknown saved value', { stored: 'sepia', dark: false }, 'light'],
    ] as const)('picks the theme for %s without saving anything', async (_name, input, expected) => {
      const result = await run(input)

      expect(result.theme).toBe(expected)
      expect(result.dark).toBe(expected === 'dark')
      expect(result.colors).toEqual([result.side[expected], result.side[expected]])
      expect(result.written).toEqual([])
    })
  })
})

describe('removeBootSplash', () => {
  afterEach(() => vi.useRealTimers())

  const splash = () => {
    const classes = new Set<string>()
    const listeners: Array<() => void> = []
    const node: SplashNode & { removed: number } = {
      removed: 0,
      classList: { contains: (name) => classes.has(name), add: (name) => void classes.add(name) },
      addEventListener: (_type, listener) => void listeners.push(listener),
      remove() {
        this.removed += 1
      },
    }
    const doc: SplashDocument = { getElementById: (id) => (id === 'boot-splash' ? node : null) }
    return { node, doc, classes, listeners }
  }

  it('fades the splash out, then removes it when the fade ends', () => {
    const { node, doc, classes, listeners } = splash()

    removeBootSplash(doc)

    expect(classes.has('boot-splash-leaving')).toBe(true)
    expect(node.removed).toBe(0)
    listeners.forEach((listener) => listener())
    expect(node.removed).toBe(1)
  })

  it('removes it anyway when no fade ever ends', () => {
    vi.useFakeTimers()
    const { node, doc } = splash()

    removeBootSplash(doc)
    vi.advanceTimersByTime(300)

    expect(node.removed).toBe(1)
  })

  it('does nothing without a splash and is safe to call again', () => {
    expect(() => removeBootSplash({ getElementById: () => null })).not.toThrow()
    const { node, doc, listeners } = splash()

    removeBootSplash(doc)
    removeBootSplash(doc)

    expect(listeners).toHaveLength(1)
    expect(node.removed).toBe(0)
  })
})
