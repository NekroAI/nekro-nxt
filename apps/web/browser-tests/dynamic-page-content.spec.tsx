import { chromium, expect, test, type Browser } from '@playwright/test'
import { hasVisibleContent } from '../src/dynamic-page-content.ts'

/** The page check of agent-written extensions (#99), against real layout rather than a DOM shim. */
test.describe('dynamic page content check', () => {
  let browser: Browser
  test.beforeAll(async () => {
    browser = await chromium.launch()
  })
  test.afterAll(async () => {
    await browser.close()
  })

  test('counts text inside a hidden background host and ignores what is not laid out', async () => {
    const page = await browser.newPage()
    try {
      await page.setContent(`
        <div style="position: fixed; visibility: hidden">
          <section id="text"><div data-host-ui-content><p>一行字</p></div></section>
          <section id="blank"><div data-host-ui-content>   <p> </p></div></section>
          <section id="undisplayed"><div data-host-ui-content><p style="display: none">藏起来的字</p></div></section>
          <section id="media"><div data-host-ui-content><input aria-label="输入" /></div></section>
        </div>`)
      await page.addScriptTag({ content: `window.hasVisibleContent = ${hasVisibleContent.toString()}` })
      const results = await page.evaluate(() => {
        const check: unknown = Reflect.get(window, 'hasVisibleContent')
        if (typeof check !== 'function') throw new Error('check not installed')
        return ['text', 'blank', 'undisplayed', 'media'].map((id) => {
          const content = document.querySelector(`#${id} [data-host-ui-content]`)
          // The old check: innerText is empty for every text node under visibility: hidden.
          const visible: unknown = Reflect.apply(check, undefined, [content])
          return [id, visible === true, content instanceof HTMLElement && content.innerText.trim() !== ''] as const
        })
      })
      expect(results).toEqual([
        ['text', true, false],
        ['blank', false, false],
        ['undisplayed', false, false],
        ['media', true, false],
      ])
    } finally {
      await page.close()
    }
  })
})
