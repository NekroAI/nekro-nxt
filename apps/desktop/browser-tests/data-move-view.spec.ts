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
const open = async (
  state: Record<string, unknown>,
  theme: 'light' | 'dark' = 'light',
  prepare?: (page: Page) => Promise<void>,
): Promise<Page> => {
  const page = await browser.newPage({ viewport: { width: 720, height: 520 } })
  await prepare?.(page)
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

test('shows the steps, the database being checked and the elapsed time, and offers to cancel', async () => {
  const startedAt = new Date('2026-11-01T14:00:00+08:00').getTime()
  const page = await open(
    {
      mode: 'moving',
      startedAt,
      actions: ['cancel'],
      progress: { step: 'verifying', completedBytes: 1, totalBytes: 1, current: 'data/core.sqlite' },
    },
    'light',
    (page) => page.clock.install({ time: startedAt + 95_000 }),
  )
  try {
    await expect(page.getByRole('heading', { name: '正在校验数据' })).toBeVisible()
    await expect(page.locator('#steps [aria-current="step"]')).toHaveText('校验数据库')
    await expect(page.locator('#steps [data-state="done"]')).toHaveText(['复制数据'])
    await expect(page.locator('#progress-label')).toHaveText('正在检查 data/core.sqlite')
    await expect(page.locator('#elapsed')).toHaveText('已用时 1 分 35 秒')
    await expect(page.locator('#stall')).toBeHidden()
    await page.getByRole('button', { name: '取消更改' }).click()
    await expect.poll(() => page.evaluate(() => window.__moveActions)).toEqual(['cancel'])
    await expect(page.getByRole('button', { name: '取消更改' })).toBeDisabled()
  } finally {
    await page.close()
  }
})

test('explains a step with no progress for two minutes and what cancelling does', async () => {
  for (const theme of ['light', 'dark'] as const) {
    const startedAt = new Date('2026-11-01T14:00:00+08:00').getTime()
    const page = await open(
      {
        mode: 'moving',
        startedAt,
        actions: ['cancel'],
        progress: { step: 'verifying', completedBytes: 1, totalBytes: 1, current: 'data/core.sqlite' },
      },
      theme,
      (page) => page.clock.install({ time: startedAt }),
    )
    try {
      await expect(page.locator('#stall')).toBeHidden()
      await page.clock.fastForward('02:05')
      await expect(page.locator('#stall')).toHaveText(
        '已经 2 分钟没有新的进展。数据很多或数据库很大时，这一步需要较长时间，可以继续等待。原目录里的数据没有改动；点“取消更改”会删除新目录里这次复制的文件，继续使用原目录。',
      )
      await page.locator('summary').click()
      await expect(page.locator('#diagnostics')).toContainText('当前步骤：校验数据库（data/core.sqlite）')
      await expect(page.locator('#diagnostics')).toContainText('最后进展：')
      await page.screenshot({ path: `.local/browser-test-results/data-move-stalled-${theme}.png` })
    } finally {
      await page.close()
    }
  }
})

test('a step that can no longer be cancelled asks to wait instead', async () => {
  const page = await open(
    { mode: 'moving', progress: { step: 'rewriting', completedBytes: 1, totalBytes: 1 } },
    'light',
    (page) => page.clock.install({ time: new Date('2026-11-01T14:00:00+08:00').getTime() }),
  )
  try {
    await page.clock.fastForward('02:05')
    await expect(page.locator('#stall')).toContainText('请保持应用开启，这一步结束后会自动打开 NekroNXT')
    await expect(page.getByRole('button', { name: '取消更改' })).toBeHidden()
  } finally {
    await page.close()
  }
})

test('a cancelled move says the data stayed where it was', async () => {
  const page = await open({ mode: 'cancelled', actions: ['open'] })
  try {
    await expect(page.getByRole('heading', { name: '已取消更改' })).toBeVisible()
    await expect(page.getByText(`数据仍在 ${base.source}，新目录里这次创建的文件已删除。`)).toBeVisible()
    await expect(page.locator('#progress-section')).toBeHidden()
    await expect(page.getByRole('button', { name: '打开 NekroNXT' })).toBeVisible()
  } finally {
    await page.close()
  }
})
