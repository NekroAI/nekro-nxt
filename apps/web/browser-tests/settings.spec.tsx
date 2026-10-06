import { chromium, expect, test, type Browser, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, type ViteDevServer } from 'vite'
import { installSnapshotHealthRoutes } from '../e2e/fixtures/host-release.js'
import { productSnapshot } from '../e2e/fixtures/product-quality.js'

const provider = (id: string, displayName: string, configured: boolean) => ({
  provider: id,
  displayName,
  settingsNs: 'llm-pi-ai',
  settingsPath: ['providers', id],
  settingsRevision: 1,
  declared: false,
  active: configured,
  configured,
  credential: { configured, writable: true },
  models: configured
    ? [
        { id: 'example-flash-vision-preview-long', name: 'Example Flash Vision Preview', contextWindow: 1_000_000 },
        { id: 'example-pro', name: 'Example Pro', contextWindow: 262_144 },
      ]
    : [],
  modelsCustomized: false,
  discoverable: true,
})

const providers = {
  writable: true,
  protocols: ['openai-completions'],
  providers: [provider('example-a', '示例供应商甲', true), provider('example-b', '示例供应商乙', true)],
}

const fakeDigest = 'a'.repeat(64)

/** Settings space journeys against a stubbed Host; nothing reaches a real service. */
test.describe('settings space', () => {
  test.describe.configure({ mode: 'default', timeout: 30_000 })
  let server: ViteDevServer
  let browser: Browser
  let baseUrl: string
  let cacheDirectory: string

  test.beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), 'nekro-settings-spec-'))
    server = await createServer({
      root: fileURLToPath(new URL('..', import.meta.url)),
      configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
      cacheDir: cacheDirectory,
      logLevel: 'silent',
      server: { host: '127.0.0.1', strictPort: false },
    })
    await server.listen()
    const address = server.httpServer?.address()
    if (!address || typeof address === 'string') throw new Error('Vite test server did not expose a TCP port.')
    baseUrl = `http://127.0.0.1:${address.port}`
    browser = await chromium.launch({ headless: true })
  })

  test.afterAll(async () => {
    await browser?.close()
    await server?.close()
    if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true })
  })

  const open = async (
    route: string,
    options: { readonly width?: number; readonly before?: (page: Page) => Promise<void> } = {},
  ): Promise<{ page: Page; errors: string[] }> => {
    const page = await browser.newPage({ viewport: { width: options.width ?? 1440, height: 900 } })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(String(error)))
    await page.route('**/api/**', (request) =>
      request.fulfill({ status: 501, json: { error: { code: 'unstubbed', message: 'unstubbed' } } }),
    )
    await page.route('**/api/attention', (request) => request.fulfill({ json: { revision: 'fixture', items: [] } }))
    await page.route('**/api/llm/providers', (request) => request.fulfill({ json: providers }))
    await page.route('**/api/dsh/plugins', (request) => request.fulfill({ json: { plugins: [] } }))
    await page.route('**/api/dsh/settings', (request) => request.fulfill({ json: { namespaces: [] } }))
    await installSnapshotHealthRoutes(page, productSnapshot)
    await page.route('**/api/snapshot', (request) => request.fulfill({ json: productSnapshot }))
    await page.route('**/api/events', (request) =>
      request.fulfill({ status: 200, contentType: 'text/event-stream', body: '' }),
    )
    await options.before?.(page)
    await page.goto(`${baseUrl}${route}`)
    return { page, errors }
  }

  test('lists configured providers under 模型 and edits the selected one in the main area', async () => {
    const { page, errors } = await open('/settings/models')
    try {
      const list = page.getByRole('complementary', { name: '设置' })
      await expect(list.getByRole('link', { name: /示例供应商甲 通用接入 · 2 个模型/u })).toBeVisible()
      await expect(page.getByRole('heading', { name: '模型', level: 1 })).toBeVisible()
      await expect(page.getByRole('heading', { name: '示例供应商甲', level: 2 })).toBeVisible()
      await list.getByRole('link', { name: /示例供应商乙/u }).click()
      await expect(page).toHaveURL(/provider=example-b/u)
      await expect(page.getByRole('heading', { name: '示例供应商乙', level: 2 })).toBeVisible()
      // Technical identity stays out of the visible copy.
      await expect(page.getByText('llm-pi-ai', { exact: true })).toBeHidden()
      await page.getByRole('button', { name: '诊断信息' }).click()
      await expect(page.getByText('llm-pi-ai', { exact: true })).toBeVisible()
      await expect(page.getByRole('textbox', { name: '模型 ID' }).first()).toHaveValue(
        'example-flash-vision-preview-long',
      )
      await expect(page.getByText('100 万', { exact: true }).first()).toBeVisible()
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  test('keeps every section and provider reachable below 1100px', async () => {
    const { page, errors } = await open('/settings/models', { width: 1000 })
    try {
      await expect(page.getByRole('complementary', { name: '设置' })).toBeHidden()
      await page.getByRole('combobox', { name: '模型供应商' }).click()
      await page.getByRole('option', { name: /示例供应商乙/u }).click()
      await expect(page.getByRole('heading', { name: '示例供应商乙', level: 2 })).toBeVisible()
      // The model table drops its secondary column instead of clipping the id.
      const table = page.getByRole('table', { name: '模型列表' })
      await expect(table.getByText('模型 ID', { exact: true })).toBeVisible()
      const id = table.getByRole('textbox', { name: '模型 ID' }).first()
      expect(await id.evaluate((input: HTMLInputElement) => input.scrollWidth <= input.clientWidth + 1)).toBe(true)
      await page.getByRole('combobox', { name: '设置分节' }).click()
      await page.getByRole('option', { name: '外观', exact: true }).click()
      await expect(page.getByRole('heading', { name: '外观', level: 1 })).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  test('switches interface density and keeps it after reload', async () => {
    const { page, errors } = await open('/settings/appearance')
    try {
      const density = page.getByRole('radiogroup', { name: '界面密度' })
      await expect(density.getByRole('radio', { name: '标准' })).toBeChecked()
      await density.getByRole('radio', { name: '紧凑' }).click()
      await expect(page.locator('html')).toHaveAttribute('data-density', 'compact')
      await page.reload()
      await expect(
        page.getByRole('radiogroup', { name: '界面密度' }).getByRole('radio', { name: '紧凑' }),
      ).toBeChecked()
      await expect(page.locator('html')).toHaveAttribute('data-density', 'compact')
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  test('shows adapter source and account count, and starts adding an account in wiring', async () => {
    const { page, errors } = await open('/settings/adapters')
    try {
      const table = page.getByRole('table', { name: '平台适配器' })
      await expect(table.getByText('示例群聊平台', { exact: true })).toBeVisible()
      await expect(table.getByText('内置', { exact: true }).first()).toBeVisible()
      await expect(table.getByText('由本机自动管理', { exact: true })).toBeVisible()
      await table.getByRole('button', { name: '添加账号' }).first().click()
      await expect(page).toHaveURL(/\/wiring\/new\?adapter=fixture-beta/u)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  test('installs a DSH plugin through a checked, disabled-by-default dialog', async () => {
    const commits: unknown[] = []
    const { page, errors } = await open('/settings/dsh', {
      before: async (page) => {
        await page.route('**/api/dsh/plugin-installs/inspect', (request) =>
          request.fulfill({
            json: {
              token: 'fixture-token',
              packageName: '@example/dsh-sample-plugin',
              packageVersion: '1.2.3',
              packageDigest: fakeDigest,
              lockfileDigest: fakeDigest,
              blockedBuilds: ['example-native-addon'],
              clientUiDetected: false,
              entries: [{ entryKey: 'main', moduleName: '@example/dsh-sample-plugin', suggestedScope: 'host' }],
            },
          }),
        )
        await page.route('**/api/dsh/plugin-installs', (request) => {
          commits.push(request.request().postDataJSON())
          return request.fulfill({ json: { packageId: 'dsp_fixture1' } })
        })
      },
    })
    try {
      await expect(page.getByText('当前没有已识别的 DSH 插件', { exact: true })).toBeVisible()
      await page.getByRole('button', { name: '安装插件' }).click()
      const dialog = page.getByRole('dialog', { name: '安装 DSH 插件' })
      await expect(dialog.getByRole('button', { name: '安装（不启用）' })).toBeDisabled()
      await dialog.getByLabel('npm 包与版本').fill('@example/dsh-sample-plugin@1.2.3')
      await dialog.getByRole('button', { name: '检查安装内容' }).click()
      await expect(dialog).toContainText('安装后不会自动启用')
      await dialog.getByRole('switch', { name: 'example-native-addon' }).click()
      await dialog.getByRole('button', { name: '安装（不启用）' }).click()
      await expect(dialog).toBeHidden()
      expect(commits).toHaveLength(1)
      expect(commits[0]).toMatchObject({ token: 'fixture-token', approvedBuilds: ['example-native-addon'] })
      await expect(page.getByText('插件已安装，当前未启用。', { exact: true })).toBeVisible()
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })
})
