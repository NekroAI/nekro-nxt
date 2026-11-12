// Shared fixture for documentation flows: each flow drives a blank, built NekroNXT the way a reader would, takes the
// screenshots its page shows and records the interface text it saw, so the bundle can tell when a page went stale.
// Format and rules: docs/site/BUNDLE.md.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { HostApiContracts } from '@nekro-nxt/contracts'
import { test as base, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import sharp from 'sharp'
import {
  reserveJourneyPort,
  spawnJourneyServer,
  stopJourneyServer,
  waitForJourneyServerReady,
} from '../../../apps/web/e2e/fixtures/production-host.js'
import { saveProvider } from '../../../apps/web/e2e/fixtures/provider-settings.js'
import { startFakeModel } from './fake-model.js'

export { expect } from '@playwright/test'

const SHOTS_DIR = path.resolve(import.meta.dirname, '../../../.local/docs-shots')
const THEMES = ['light', 'dark'] as const
// Toasts belong to the step before, not to what the shot shows (CSS module names keep their prefix in builds).
const SHOT_STYLE = '[class^="_toasts_"] { visibility: hidden !important; }'

export interface DocsFlow {
  /**
   * Screenshot in both themes, shown in pages as `shot:<name>`: the whole viewport, or cropped to the box around the
   * given elements so the interface text stays readable in the page column.
   */
  shot(name: string, target?: Locator | readonly Locator[], options?: { padding?: number }): Promise<void>
  /** Records the text on screen without a screenshot, for 「」 words that only appear between shots. */
  see(): Promise<void>
}

const visibleText = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const texts = document.body.innerText.split('\n')
    for (const element of document.querySelectorAll('[aria-label], [title], [placeholder]'))
      for (const name of ['aria-label', 'title', 'placeholder'])
        texts.push(element.getAttribute(name) ?? '')
    return texts.map((text) => text.replace(/\s+/gu, ' ').trim()).filter((text) => text !== '')
  })

const setTheme = async (page: Page, theme: (typeof THEMES)[number]): Promise<void> => {
  await page.emulateMedia({ colorScheme: theme })
  await page.evaluate((value) => {
    document.documentElement.dataset['theme'] = value
    document.documentElement.classList.toggle('dark', value === 'dark')
  }, theme)
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

export const test = base.extend<{
  docs: DocsFlow
  flowServer: string
  modelReplies: readonly string[]
}>({
  // The built-in DeepSeek answers through a local fake model, in this order, the last one repeating; a flow sets them
  // with test.use({ modelReplies }).
  modelReplies: [['你好，我在。'], { option: true }],
  flowServer: async ({ modelReplies }, use) => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'nekro-docs-flow-'))
    const port = await reserveJourneyPort()
    const model = await startFakeModel(modelReplies)
    process.env['DEEPSEEK_BASE_URL'] = model.baseURL
    const server = spawnJourneyServer(port, dataRoot)
    const origin = `http://127.0.0.1:${port}`
    try {
      await waitForJourneyServerReady(origin, server)
      await use(origin)
    } finally {
      await stopJourneyServer(server)
      await model.close()
      await rm(dataRoot, { recursive: true, force: true })
    }
  },
  baseURL: async ({ flowServer }, use) => {
    await use(flowServer)
  },
  docs: async ({ page }, use, testInfo) => {
    const flow = path.basename(testInfo.file, '.flow.ts')
    const texts = new Set<string>()
    const shots: Record<string, { width: number; height: number }> = {}
    const see = async (): Promise<void> => {
      for (const text of await visibleText(page)) texts.add(text)
    }
    await mkdir(SHOTS_DIR, { recursive: true })
    await use({
      see,
      async shot(name, target, options) {
        if (name in shots) throw new Error(`截图 ${name} 拍了两次`)
        await see()
        const original = await page.evaluate(() => document.documentElement.dataset['theme'])
        const padding = options?.padding ?? 12
        const viewport = page.viewportSize() ?? { width: 0, height: 0 }
        let clip = { x: 0, y: 0, width: viewport.width, height: viewport.height }
        if (target !== undefined) {
          const targets: readonly Locator[] = 'boundingBox' in target ? [target] : target
          const boxes = []
          for (const element of targets) {
            const box = await element.boundingBox()
            if (box === null) throw new Error(`截图 ${name} 的元素不可见`)
            boxes.push(box)
          }
          const x = Math.max(0, Math.min(...boxes.map((box) => box.x)) - padding)
          const y = Math.max(0, Math.min(...boxes.map((box) => box.y)) - padding)
          clip = {
            x,
            y,
            width: Math.min(viewport.width, Math.max(...boxes.map((box) => box.x + box.width)) + padding) - x,
            height: Math.min(viewport.height, Math.max(...boxes.map((box) => box.y + box.height)) + padding) - y,
          }
        }
        for (const theme of THEMES) {
          await setTheme(page, theme)
          const image = await page.screenshot({ clip, animations: 'disabled', caret: 'hide', style: SHOT_STYLE })
          // Lossy WebP keeps interface text sharp at a tenth of the PNG's size.
          await sharp(image).webp({ quality: 88 }).toFile(path.join(SHOTS_DIR, `${name}.${theme}.webp`))
        }
        shots[name] = { width: Math.round(clip.width), height: Math.round(clip.height) }
        await setTheme(page, original === 'dark' ? 'dark' : 'light')
      },
    })
    const failed = testInfo.status !== testInfo.expectedStatus
    await writeFile(
      path.join(SHOTS_DIR, `${flow}.json`),
      `${JSON.stringify(
        {
          flow,
          status: failed ? 'failed' : 'passed',
          ...(failed ? { error: testInfo.error?.message?.split('\n')[0] ?? testInfo.status } : {}),
          shots,
          texts: [...texts],
        },
        null,
        2,
      )}\n`,
    )
  },
})

/** An agent on the built-in DeepSeek (answered by the fake model), for flows that start after 快速开始. */
export const createAgent = async (request: APIRequestContext, displayName: string, persona = ''): Promise<string> => {
  const saved = await saveProvider(request, 'deepseek-official', { apiKey: 'sk-docs-example' })
  if (!saved.ok()) throw new Error(`保存模型密钥失败：${await saved.text()}`)
  const created = await request.post('/api/agents', {
    data: { displayName, persona, model: { provider: 'deepseek-official', model: 'deepseek-flash' } },
  })
  if (!created.ok()) throw new Error(`创建智能体失败：${await created.text()}`)
  return HostApiContracts.createAgent.response.parse(await created.json()).agentId
}
