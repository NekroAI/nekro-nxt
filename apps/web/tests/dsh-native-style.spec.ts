import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const cssPath = fileURLToPath(new URL('../src/dsh-extension-settings.module.css', import.meta.url))

describe('DSH native UI compatibility surface', () => {
  it('maps every token referenced by the enabled official bundles without private selector overrides', async () => {
    const [css, settingsBundle, primitivesBundle] = await Promise.all([
      readFile(cssPath, 'utf8'),
      readFile(require.resolve('@deepseek-ai/dsh-client-ui-settings-plugins/client'), 'utf8'),
      readFile(require.resolve('@deepseek-ai/dsh-client-ui-primitives'), 'utf8'),
    ])
    const referenced = new Set(`${settingsBundle}\n${primitivesBundle}`.match(/--dsw-[A-Za-z0-9_-]+/gu) ?? [])
    const mapped = new Set(css.match(/--dsw-[A-Za-z0-9_-]+/gu) ?? [])
    expect([...referenced].filter((token) => !mapped.has(token))).toEqual([])
    expect(css).not.toMatch(/(^|[},]\s*)body\b/mu)
    expect(css).not.toMatch(/\.[A-Za-z0-9]{6}_[A-Za-z][A-Za-z0-9_-]*\b/u)
  })
})
