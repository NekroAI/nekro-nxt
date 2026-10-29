import { chromium, expect, test, type Browser, type Page } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Fictional home and volume paths, assembled so no literal personal path appears in the source.
const USERS = '/Users'
const VOLUMES = '/Volumes'

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const viewUrl = pathToFileURL(path.join(desktopRoot, 'src', 'data-move-view.html')).href
let browser: Browser

test.beforeAll(async () => {
  browser = await chromium.launch({ headless: true })
})

test.afterAll(async () => browser.close())

const base = {
  method: 'copy',
  source: `${USERS}/example/Library/Application Support/NekroNxt`,
  target: `${VOLUMES}/Example Disk/NekroNXT`,
  diagnostics: `迁移记录：${USERS}/example/Library/Application Support/NekroNxt.data-move.json\n方式：复制并校验`,
  platform: 'darwin',
}

declare global {
  interface Window {
    __moveActions: string[]
    __pushMoveState: (state: unknown) => void
  }
}

/** Loads the packaged progress page with a fake preload bridge; the page itself is the shipped file. */
const open = async (state: Record<string, unknown>, theme: 'light' | 'dark' = 'light'): Promise<Page> => {
  const page = await browser.newPage({ viewport: { width: 720, height: 520 } })
  await page.addInitScript(
    ({ initial }) => {
      let listener: ((state: unknown) => void) | undefined
      window.__moveActions = []
      window.__pushMoveState = (next) => listener?.(next)
      Object.assign(window, {
        nxtDataMove: {
          snapshot: () => Promise.resolve(initial),
          action: (action: string) => {
            window.__moveActions.push(action)
            return Promise.resolve()
          },
          subscribe: (next: (state: unknown) => void) => {
            listener = next
            return () => undefined
          },
        },
      })
    },
    { initial: { ...base, theme, actions: [], ...state } },
  )
  await page.goto(viewUrl)
  return page
}

test('shows copy progress in bytes and switches title by step', async () => {
  for (const theme of ['light', 'dark'] as const) {
    const page = await open(
      {
        mode: 'moving',
        progress: {
          step: 'transferring',
          completedBytes: 1.2 * 1024 ** 3,
          totalBytes: 3.4 * 1024 ** 3,
          current: 'data/core.sqlite',
        },
      },
      theme,
    )
    try {
      await expect(page.getByRole('heading', { name: '正在复制数据' })).toBeVisible()
      await expect(page.getByText('1.2 GB / 3.4 GB')).toBeVisible()
      await expect(page.getByRole('status')).toContainText(`${base.source} → ${base.target}`)
      await expect(page.getByRole('button', { name: '打开 NekroNXT' })).toBeHidden()
      await page.screenshot({ path: `.local/browser-test-results/data-move-progress-${theme}.png` })
      await page.evaluate((state) => window.__pushMoveState(state), {
        ...base,
        theme,
        actions: [],
        mode: 'moving',
        progress: { step: 'verifying', completedBytes: 1, totalBytes: 1 },
      })
      await expect(page.getByRole('heading', { name: '正在校验数据' })).toBeVisible()
    } finally {
      await page.close()
    }
  }
})

test('a same-volume move shows the entry being moved instead of byte counts', async () => {
  const page = await open({
    method: 'move',
    mode: 'moving',
    progress: { step: 'transferring', completedBytes: 10, totalBytes: 40, current: 'data/workspaces' },
  })
  try {
    await expect(page.getByRole('heading', { name: '正在移动数据' })).toBeVisible()
    await expect(page.locator('#progress-label')).toHaveText('data/workspaces')
  } finally {
    await page.close()
  }
})

test('a failed move names the file and offers to open the app on the old directory', async () => {
  const page = await open({
    mode: 'failed',
    actions: ['open'],
    failure: { file: 'data/core.sqlite', message: '数据库检查未通过：integrity_check: row 3 missing from index' },
  })
  try {
    await expect(page.getByRole('heading', { name: '数据目录没有更改' })).toBeVisible()
    await expect(page.getByText(`数据仍在 ${base.source}，新目录里这次创建的文件已删除。`)).toBeVisible()
    await expect(
      page.getByText('data/core.sqlite：数据库检查未通过：integrity_check: row 3 missing from index'),
    ).toBeVisible()
    await expect(page.locator('#progress-section')).toBeHidden()
    await page.screenshot({ path: '.local/browser-test-results/data-move-failed.png' })
    await page.getByRole('button', { name: '打开 NekroNXT' }).click()
    await expect.poll(() => page.evaluate(() => window.__moveActions)).toEqual(['open'])
  } finally {
    await page.close()
  }
})

test('an interrupted move tells where the data is now', async () => {
  const page = await open({ mode: 'interrupted', actions: ['open'] })
  try {
    await expect(page.getByRole('heading', { name: '上次更改没有完成' })).toBeVisible()
    await expect(page.getByText(`数据已回到 ${base.source}。可以在“设置 → 存储”里重新更改。`)).toBeVisible()
    await expect(page.locator('#notice')).toBeHidden()
  } finally {
    await page.close()
  }
})
