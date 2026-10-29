import { chromium, expect, test, type Browser, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, type ViteDevServer } from 'vite'
import {
  AddLinkedAccountRequestSchema,
  CredentialsViewSchema,
  LinkedAccountsViewSchema,
  RemoveLinkedAccountRequestSchema,
  type LinkedAccountsView,
  RemoveCredentialRequestSchema,
  SetModelProviderAccessRequestSchema,
  UpdateCredentialRequestSchema,
  type CredentialsView,
} from '@nekro-nxt/contracts'
import {
  credentialsView,
  mapCredentialId,
  translateCredentialId,
  weatherCredentialId,
  weatherUses,
} from '../e2e/fixtures/credentials.js'
import { installSnapshotHealthRoutes } from '../e2e/fixtures/host-release.js'
import { addedAccountId, linkedAccountsView, octoAccountId, octoUses } from '../e2e/fixtures/linked-accounts.js'
import { productSnapshot, targetAgentId } from '../e2e/fixtures/product-quality.js'

// Fictional home and volume paths, assembled so no literal personal path appears in the source.
const USERS = '/Users'
const VOLUMES = '/Volumes'

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
    await page.route('**/api/commands', (request) => request.fulfill({ json: { commands: [], problems: [] } }))
    await page.route('**/api/llm/providers', (request) => request.fulfill({ json: providers }))
    await page.route('**/api/settings/model-fallback', (request) =>
      request.fulfill({ json: { unavailableCooldownMinutes: 10, quotaCooldownMinutes: 60 } }),
    )
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

  test('chooses where restore points go before an upgrade, or turns them off', async () => {
    const requests: unknown[] = []
    let settings = {
      mode: 'data',
      directory: null as string | null,
      locked: false,
      keep: 2,
      usage: { count: 2, bytes: 16 * 1024 * 1024 * 1024 },
    }
    const { page, errors } = await open('/settings/storage', {
      before: async (target) => {
        await target.route('**/api/settings/upgrade-backup', async (request) => {
          if (request.request().method() === 'PUT') {
            const body: unknown = request.request().postDataJSON()
            const text = (name: 'mode' | 'directory'): string | null => {
              if (body === null || typeof body !== 'object') return null
              const value: unknown = Object.entries(body).find(([key]) => key === name)?.[1]
              return typeof value === 'string' ? value : null
            }
            requests.push(body)
            settings = {
              ...settings,
              mode: text('mode') ?? '',
              directory: text('directory'),
              usage: { count: 0, bytes: 0 },
            }
          }
          await request.fulfill({ json: settings })
        })
      },
    })
    try {
      const row = page.getByText('升级前备份', { exact: true }).locator('..').locator('..')
      await expect(page.getByText('已保留 2 份，共 16.0 GB；保留最近 2 份')).toBeVisible()
      await page.getByRole('combobox', { name: '升级前备份' }).click()
      await page.getByRole('option', { name: '保存到其他位置' }).click()
      await page.getByRole('textbox', { name: '备份位置' }).fill('/mnt/example-backups')
      await page.getByRole('button', { name: '保存', exact: true }).click()
      await expect.poll(() => requests).toEqual([{ mode: 'directory', directory: '/mnt/example-backups' }])
      await page.getByRole('combobox', { name: '升级前备份' }).click()
      await page.getByRole('option', { name: '不备份' }).click()
      await expect(page.getByText('升级时不备份')).toBeVisible()
      expect(requests.at(-1)).toEqual({ mode: 'off' })
      await expect(row).toBeVisible()
      await page.screenshot({ path: '.local/browser-test-results/settings-upgrade-backup.png' })
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  test('moves the Desktop data directory from Settings → 存储 and shows what is left behind', async () => {
    const backup = { mode: 'data', directory: null, locked: false, keep: 2, usage: { count: 1, bytes: 2 * 1024 ** 3 } }
    const install = async (page: Page, status: Record<string, unknown>, choice: Record<string, unknown>) => {
      await page.route('**/api/settings/upgrade-backup', (request) => request.fulfill({ json: backup }))
      await page.addInitScript(
        ({ status, choice }) => {
          const calls: unknown[] = []
          Object.assign(window, {
            __storageCalls: calls,
            nekroDesktopStorage: {
              status: () => Promise.resolve({ supported: true, status }),
              sizes: () => Promise.resolve({ current: 3.4 * 1024 ** 3, oldDirectory: 3.1 * 1024 ** 3 }),
              chooseDirectory: () => Promise.resolve(choice),
              startMove: (target: string) => {
                calls.push(['start', target])
                return Promise.resolve(choice)
              },
              revealOldDirectory: () => {
                calls.push(['reveal'])
                return Promise.resolve()
              },
              dismissNotice: () => {
                calls.push(['dismiss'])
                return Promise.resolve()
              },
            },
          })
        },
        { status, choice },
      )
    }
    const current = `${USERS}/example/Library/Application Support/NekroNxt`
    const target = `${VOLUMES}/Example Disk/NekroNXT`
    for (const width of [1440, 375]) {
      const { page, errors } = await open('/settings/storage', {
        width,
        before: (target) =>
          install(
            target,
            { available: true, path: current },
            {
              kind: 'ready',
              target: `${VOLUMES}/Example Disk/NekroNXT`,
              method: 'copy',
              bytes: 3.4 * 1024 ** 3,
              estimatedSeconds: 95,
            },
          ),
      })
      try {
        await expect(page.getByRole('heading', { name: '存储', level: 1 })).toBeVisible()
        await expect(page.getByTestId('data-directory-path')).toHaveText(current)
        await expect(page.getByText('占用 3.4 GB')).toBeVisible()
        await expect(page.getByText('已保留 1 份，共 2.0 GB；保留最近 2 份')).toBeVisible()
        await page.screenshot({ path: `.local/browser-test-results/settings-storage-${width}.png`, fullPage: true })
        await page.getByRole('button', { name: '更改', exact: true }).click()
        const dialog = page.getByRole('dialog', { name: '更改数据目录' })
        await expect(dialog).toContainText(target)
        await expect(dialog).toContainText('复制到新位置并校验，原目录保留')
        await expect(dialog).toContainText('约 2 分钟')
        await expect(dialog).toContainText('迁移期间应用会重启，本机实例暂停。')
        // Let the dialog finish opening so the screenshot shows it, not its fade-in.
        await dialog.evaluate((element) =>
          Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished)),
        )
        await page.screenshot({ path: `.local/browser-test-results/settings-storage-move-${width}.png` })
        await dialog.getByRole('button', { name: '开始迁移' }).click()
        await expect
          .poll(() => page.evaluate((): unknown => Reflect.get(window, '__storageCalls')))
          .toEqual([['start', target]])
        expect(errors).toEqual([])
      } finally {
        await page.close()
      }
    }

    const after = await open('/settings/storage', {
      before: (page) =>
        install(
          page,
          { available: true, path: target, oldDirectory: { path: current, method: 'copy' } },
          {
            kind: 'rejected',
            target: `${USERS}/example/OneDrive/NXT`,
            problem: { code: 'sync', provider: 'onedrive' },
          },
        ),
    })
    try {
      await expect(
        after.page.getByText('原来的数据还在这里。确认新目录正常后，可以手动删除。', { exact: false }),
      ).toBeVisible()
      await expect(after.page.getByText('3.1 GB', { exact: false })).toBeVisible()
      await after.page.screenshot({
        path: '.local/browser-test-results/settings-storage-old-directory.png',
        fullPage: true,
      })
      await after.page.getByRole('button', { name: '在文件夹中显示' }).click()
      await after.page.getByRole('button', { name: '我已删除，不再提示' }).click()
      await after.page.getByRole('button', { name: '更改', exact: true }).click()
      await expect(after.page.getByText('这个文件夹由OneDrive同步，数据目录不能放在同步文件夹里。')).toBeVisible()
      await expect
        .poll(() => after.page.evaluate((): unknown => Reflect.get(window, '__storageCalls')))
        .toEqual([['reveal'], ['dismiss']])
      expect(after.errors).toEqual([])
    } finally {
      await after.page.close()
    }

    const locked = await open('/settings/storage', {
      before: (page) =>
        install(page, { available: false, lockedBy: 'environment', path: current }, { kind: 'cancelled' }),
    })
    try {
      await expect(locked.page.getByText('数据目录由环境变量指定')).toBeVisible()
      await expect(locked.page.getByRole('button', { name: '更改', exact: true })).toBeDisabled()
    } finally {
      await locked.page.close()
    }

    // Without the Desktop bridge (a browser, or a remote instance) only the backup settings show.
    const browserOnly = await open('/settings/storage', {
      before: async (page) => {
        await page.route('**/api/settings/upgrade-backup', (request) => request.fulfill({ json: backup }))
      },
    })
    try {
      await expect(browserOnly.page.getByRole('combobox', { name: '升级前备份' })).toBeVisible()
      await expect(browserOnly.page.getByText('数据目录', { exact: true })).toHaveCount(0)
    } finally {
      await browserOnly.page.close()
    }
  })

  test('lists sections one level deep, overviews providers and opens one in the main area', async () => {
    const { page, errors } = await open('/settings/models')
    try {
      const list = page.getByRole('complementary', { name: '设置' })
      // The section list never nests items: every entry opens its section the same way.
      await expect(list.getByRole('link')).toHaveCount(17)
      await expect(list.getByRole('link', { name: '聊天命令', exact: true })).toBeVisible()
      await expect(list.getByRole('link', { name: '日志保存' })).toBeVisible()
      await expect(page.getByRole('heading', { name: '模型', level: 1 })).toBeVisible()
      const overview = page.getByRole('table', { name: '模型供应商' })
      await expect(overview).toContainText('示例供应商甲')
      await expect(page).not.toHaveURL(/provider=/u)
      await overview.getByText('示例供应商乙', { exact: true }).click()
      await expect(page).toHaveURL(/provider=example-b/u)
      await expect(page.getByRole('heading', { name: '示例供应商乙' })).toBeVisible()
      // Technical identity stays out of the visible copy.
      await expect(page.getByText('llm-pi-ai', { exact: true })).toBeHidden()
      await page.getByRole('button', { name: '诊断信息' }).click()
      await expect(page.getByText('llm-pi-ai', { exact: true })).toBeVisible()
      await expect(page.getByRole('textbox', { name: '模型 ID' }).first()).toHaveValue(
        'example-flash-vision-preview-long',
      )
      await expect(page.getByText('100 万', { exact: true }).first()).toBeVisible()
      // A freshly added blank row waits until the user leaves it empty before complaining.
      await page.getByRole('button', { name: '添加模型' }).click()
      const blankId = page.getByRole('textbox', { name: '模型 ID' }).last()
      await expect(blankId).toHaveValue('')
      await expect(page.getByText('模型 ID 不能为空。')).toBeHidden()
      await blankId.focus()
      await blankId.blur()
      await expect(page.getByRole('alert').filter({ hasText: '模型 ID 不能为空。' })).toBeVisible()
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  test('keeps every section and provider reachable below 1100px', async () => {
    const { page, errors } = await open('/settings/models', { width: 1000 })
    try {
      await expect(page.getByRole('complementary', { name: '设置' })).toBeHidden()
      await page.getByRole('table', { name: '模型供应商' }).getByText('示例供应商乙', { exact: true }).click()
      await expect(page.getByRole('heading', { name: '示例供应商乙' })).toBeVisible()
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

  test('gives every section the same width and left edge', async () => {
    const { page, errors } = await open('/settings/notifications', { width: 1680 })
    try {
      const boxes: { left: number; width: number }[] = []
      for (const [section, heading] of [
        ['notifications', '通知'],
        ['adapters', '平台适配器'],
        ['appearance', '外观'],
        ['about', '关于'],
        ['models', '模型'],
      ] as const) {
        await page.goto(`${baseUrl}/settings/${section}`)
        const title = page.getByRole('heading', { name: heading, level: 1 })
        await expect(title).toBeVisible()
        const box = await title.evaluate((element) => {
          const column = element.closest('header')?.parentElement
          const rect = column?.getBoundingClientRect()
          return { left: Math.round(rect?.left ?? -1), width: Math.round(rect?.width ?? -1) }
        })
        boxes.push(box)
      }
      expect(new Set(boxes.map((box) => box.left)).size).toBe(1)
      expect(new Set(boxes.map((box) => box.width)).size).toBe(1)
      // Background a user needs once sits behind a help mark instead of under every row.
      await page.goto(`${baseUrl}/settings/notifications`)
      await expect(page.getByText('推送到安装了 Bark 的设备')).toBeHidden()
      await page.getByRole('button', { name: '说明：Bark' }).hover()
      await expect(page.getByText('推送到安装了 Bark 的设备')).toBeVisible()
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  test('keeps the provider list beside the open provider on a wide window', async () => {
    const { page, errors } = await open('/settings/models', { width: 1680 })
    try {
      const overview = page.getByRole('table', { name: '模型供应商' })
      await overview.getByText('示例供应商乙', { exact: true }).click()
      await expect(page).toHaveURL(/provider=example-b/u)
      await expect(page.getByRole('heading', { name: '示例供应商乙' })).toBeVisible()
      // The list stays, marks the open item and needs no way back.
      await expect(overview).toBeVisible()
      await expect(overview.getByRole('row', { selected: true })).toContainText('示例供应商乙')
      await expect(page.getByRole('button', { name: '全部供应商' })).toBeHidden()
      // Once the list has narrowed, the detail sits to its right.
      await expect
        .poll(async () => {
          const [listBox, titleBox] = await Promise.all([
            overview.boundingBox(),
            page.getByRole('heading', { name: '示例供应商乙' }).boundingBox(),
          ])
          return (titleBox?.x ?? 0) > (listBox?.x ?? 0) + (listBox?.width ?? 0)
        })
        .toBe(true)
      await overview.getByText('示例供应商甲', { exact: true }).click()
      await expect(page.getByRole('heading', { name: '示例供应商甲' })).toBeVisible()
      await expect(overview.getByRole('row', { selected: true })).toContainText('示例供应商甲')
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  test('closes the open provider on a wide window with the close button or Escape', async () => {
    const { page, errors } = await open('/settings/models', { width: 1680 })
    try {
      const overview = page.getByRole('table', { name: '模型供应商' })
      const close = page.getByRole('button', { name: '关闭', exact: true })
      await expect(close).toHaveCount(0)
      await overview.getByText('示例供应商乙', { exact: true }).click()
      await expect(page.getByRole('heading', { name: '示例供应商乙' })).toBeVisible()
      await expect(close).toBeVisible()
      await close.click()
      await expect(page).not.toHaveURL(/provider=/u)
      // The closing detail leaves the focus order at once and the opened row takes the focus back.
      await expect(overview.getByRole('row', { name: /示例供应商乙/u })).toBeFocused()
      await expect(page.getByRole('heading', { name: '示例供应商乙' })).toHaveCount(0)
      await expect(close).toHaveCount(0)

      // The browser's back button reopens it, Escape closes it again.
      await page.goBack()
      await expect(page.getByRole('heading', { name: '示例供应商乙' })).toBeVisible()
      await page.goForward()
      await expect(page).not.toHaveURL(/provider=/u)
      await overview.getByText('示例供应商甲', { exact: true }).click()
      await expect(page.getByRole('heading', { name: '示例供应商甲' })).toBeVisible()
      // Escape inside a field belongs to the field.
      const id = page.getByRole('textbox', { name: '模型 ID' }).first()
      await id.focus()
      await page.keyboard.press('Escape')
      await expect(page).toHaveURL(/provider=example-a/u)
      await page.getByRole('heading', { name: '示例供应商甲' }).click()
      await page.keyboard.press('Escape')
      await expect(page).not.toHaveURL(/provider=/u)
      await expect(overview.getByRole('row', { name: /示例供应商甲/u })).toBeFocused()
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  test('shows whether each provider passed its latest connection test', async () => {
    const minutesAgo = (minutes: number) => Date.now() - minutes * 60_000
    let tested = false
    const tests = () => ({
      ...providers,
      providers: [
        { ...provider('example-a', '示例供应商甲', true), lastTest: null },
        {
          ...provider('example-b', '示例供应商乙', true),
          lastTest: { at: minutesAgo(5), ok: true, model: 'example-pro' },
        },
        {
          ...provider('example-c', '示例供应商丙', true),
          lastTest: tested
            ? { at: Date.now(), ok: true, model: 'example-pro' }
            : { at: minutesAgo(12), ok: false, model: 'example-pro', message: '认证失败，请更新 API 密钥。' },
        },
        { ...provider('example-d', '示例供应商丁', true), active: false, lastTest: null },
      ],
    })
    let testRequest: unknown
    const { page, errors } = await open('/settings/models', {
      before: async (target) => {
        await target.route('**/api/llm/providers', (request) => request.fulfill({ json: tests() }))
        await target.route('**/api/llm/test-provider', (request) => {
          testRequest = request.request().postDataJSON()
          tested = true
          return request.fulfill({ json: { provider: 'example-c', model: 'example-flash-vision-preview-long' } })
        })
      },
    })
    try {
      const overview = page.getByRole('table', { name: '模型供应商' })
      // The list shows the result with its time on a second line, like the provider's kind beside its name.
      await expect(overview.getByRole('row', { name: /示例供应商甲/u })).toContainText('未测试')
      await expect(overview.getByRole('row', { name: /示例供应商乙/u })).toContainText('测试通过5 分钟前')
      await expect(overview.getByRole('row', { name: /示例供应商丙/u })).toContainText('测试失败12 分钟前')
      // Not registered yet: that comes before any test result.
      await expect(overview.getByRole('row', { name: /示例供应商丁/u })).toContainText('待启用')
      await expect(overview).not.toContainText('已启用')
      // The list keeps the reason out of the row; the provider page has it behind a help mark.
      await expect(overview).not.toContainText('认证失败')

      await overview.getByText('示例供应商丙', { exact: true }).click()
      const header = page.getByRole('heading', { name: '示例供应商丙' }).locator('xpath=..')
      await expect(header).toContainText('测试失败 · 12 分钟前')
      await expect(page.getByText('认证失败，请更新 API 密钥。')).toBeHidden()
      await page.getByRole('button', { name: '说明：失败原因' }).click()
      await expect(page.getByText('认证失败，请更新 API 密钥。')).toBeVisible()
      await page.keyboard.press('Escape')

      // A new test is read back from the Host and replaces the failure.
      await page.getByRole('button', { name: '测试连接' }).click()
      // The test asks the model picked from the list.
      await page.getByRole('menuitem').first().click()
      await expect(header).toContainText('测试通过 · 刚刚')
      await expect(page.getByRole('button', { name: '说明：失败原因' })).toHaveCount(0)
      expect(testRequest).toMatchObject({ provider: 'example-c', settingsNs: 'llm-pi-ai' })
      expect(JSON.stringify(testRequest)).not.toContain('apiKey')
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  test('returns a narrow window to the opened provider in the list', async () => {
    const many = {
      ...providers,
      providers: Array.from({ length: 30 }, (_, index) =>
        provider(`example-${index + 1}`, `示例供应商 ${String(index + 1).padStart(2, '0')}`, true),
      ),
    }
    const { page, errors } = await open('/settings/models', {
      width: 1000,
      before: async (target) => {
        await target.route('**/api/llm/providers', (request) => request.fulfill({ json: many }))
      },
    })
    try {
      const overview = page.getByRole('table', { name: '模型供应商' })
      const target = overview.getByText('示例供应商 27', { exact: true })
      await target.scrollIntoViewIfNeeded()
      await target.click()
      await expect(page.getByRole('heading', { name: '示例供应商 27' })).toBeVisible()
      await expect(overview).toBeHidden()
      await page.getByRole('button', { name: '全部供应商' }).click()
      await expect(page).not.toHaveURL(/provider=/u)
      await expect(target).toBeInViewport()
      await expect(overview.getByRole('row', { name: /示例供应商 27/u })).toBeFocused()
      // The browser's back button reopens it; the address alone opens it too.
      await page.goBack()
      await expect(page.getByRole('heading', { name: '示例供应商 27' })).toBeVisible()
      await page.goBack()
      await expect(target).toBeInViewport()
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  test('lists signed-in devices with last activity and revokes one or signs this browser out', async () => {
    const now = Date.now()
    let devices = [
      {
        id: 'nxt_device_01J9ZK3QXW0000000000000001',
        label: '浏览器 · Chrome · macOS',
        createdAt: now - 3 * 24 * 60 * 60 * 1000,
        lastUsedAt: now - 60 * 1000,
        current: true,
      },
      {
        id: 'nxt_device_01J9ZK3QXW0000000000000002',
        label: '示例的 Desktop',
        createdAt: now - 10 * 24 * 60 * 60 * 1000,
        lastUsedAt: now - 2 * 60 * 60 * 1000,
        current: false,
      },
    ]
    const calls: string[] = []
    const { page, errors } = await open('/settings/access', {
      before: async (target) => {
        // The management edge sets this cookie with every session; a direct local Host never does.
        await target.context().addCookies([{ name: 'nxt_csrf', value: 'fixture-csrf', url: baseUrl }])
        // The management edge owns this document. Vite's SPA fallback would otherwise redirect it to /live.
        await target.route('**/login', (request) =>
          request.fulfill({
            contentType: 'text/html',
            body: '<!doctype html><html lang="zh-CN"><head><title>虚构登录页</title></head><body><h1>登录</h1></body></html>',
          }),
        )
        await target.route('**/api/management/session', async (request) => {
          calls.push('logout')
          await request.fulfill({ json: { authenticated: false } })
        })
        await target.route('**/api/management/devices', (request) => request.fulfill({ json: { devices } }))
        await target.route('**/api/management/devices/*', async (request) => {
          calls.push(`revoke ${new URL(request.request().url()).pathname.split('/').at(-1)}`)
          devices = devices.filter((device) => !request.request().url().endsWith(device.id))
          await request.fulfill({ json: { revoked: true } })
        })
      },
    })
    try {
      await expect(page.getByRole('complementary', { name: '设置' }).getByRole('link')).toHaveCount(18)
      const table = page.getByRole('table', { name: '已登录设备' })
      await expect(table).toContainText('浏览器 · Chrome · macOS')
      await expect(table).toContainText('此设备')
      await expect(table).toContainText('示例的 Desktop')
      await expect(table).toContainText('1 分钟前')
      await page.screenshot({ path: '.local/browser-test-results/settings-access.png' })

      await table.getByRole('button', { name: '撤销' }).click()
      await page
        .getByRole('dialog', { name: '撤销「示例的 Desktop」的登录？' })
        .getByRole('button', { name: '撤销' })
        .click()
      await expect.poll(() => calls).toEqual(['revoke nxt_device_01J9ZK3QXW0000000000000002'])
      await expect(table).not.toContainText('示例的 Desktop')

      await table.getByRole('button', { name: '退出登录' }).click()
      await page.getByRole('dialog', { name: '退出这台设备的登录？' }).getByRole('button', { name: '退出登录' }).click()
      await expect.poll(() => calls).toContain('logout')
      await expect(page).toHaveURL(/\/login$/u)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  /** Stubs the credential routes over a mutable view and records every change request. */
  const credentialRoutes =
    (state: { view: CredentialsView; calls: { method: string; path: string; body: unknown }[] }) =>
    async (target: Page) => {
      await target.route('**/api/settings/credentials**', async (request) => {
        const method = request.request().method()
        const path = new URL(request.request().url()).pathname.replace('/api/settings/credentials', '')
        if (method === 'GET' && path === '') return request.fulfill({ json: state.view })
        if (method === 'GET' && path.endsWith('/uses')) {
          return request.fulfill({ json: { uses: path.includes(weatherCredentialId) ? weatherUses() : [] } })
        }
        const body: unknown = request.request().postDataJSON()
        state.calls.push({ method, path, body })
        if (method === 'POST' && path === '') {
          state.view = CredentialsViewSchema.parse({
            ...state.view,
            requests: [],
            credentials: [
              ...state.view.credentials,
              {
                ...state.view.credentials[0]!,
                id: mapCredentialId,
                name: '地图服务',
                description: '查询路线规划',
                domains: ['maps.example.com'],
                usedBy: { extensions: [], commandAgents: [] },
                lastUsedAt: null,
              },
            ],
          })
          return request.fulfill({ json: state.view })
        }
        if (method === 'POST' && path.endsWith('/remove')) {
          const confirmed = RemoveCredentialRequestSchema.parse(body).confirm
          const id = path.split('/')[1]
          const credential = state.view.credentials.find((candidate) => candidate.id === id)!
          if (!confirmed) return request.fulfill({ json: { removed: false, usedBy: credential.usedBy } })
          state.view = { ...state.view, credentials: state.view.credentials.filter((candidate) => candidate.id !== id) }
          return request.fulfill({ json: { removed: true, view: state.view } })
        }
        if (method === 'PATCH') {
          const id = path.split('/')[1]
          state.view = CredentialsViewSchema.parse({
            ...state.view,
            credentials: state.view.credentials.map((candidate) =>
              candidate.id === id ? { ...candidate, ...UpdateCredentialRequestSchema.parse(body) } : candidate,
            ),
          })
          return request.fulfill({ json: state.view })
        }
        if (method === 'PUT' && path.startsWith('/model-providers/')) {
          const provider = decodeURIComponent(path.split('/')[2] ?? '')
          state.view = {
            ...state.view,
            modelProviders: state.view.modelProviders.map((candidate) =>
              candidate.provider === provider
                ? { ...candidate, ...SetModelProviderAccessRequestSchema.parse(body) }
                : candidate,
            ),
          }
          return request.fulfill({ json: state.view })
        }
        if (method === 'DELETE') {
          state.view = { ...state.view, requests: [] }
          return request.fulfill({ json: state.view })
        }
        return request.fulfill({ json: state.view })
      })
    }

  test('lists credentials, opens the add form from an agent request and saves it for that request', async () => {
    const state = { view: credentialsView(), calls: [] as { method: string; path: string; body: unknown }[] }
    const { page, errors } = await open('/settings/credentials', { before: credentialRoutes(state) })
    try {
      const table = page.getByRole('table', { name: '凭据' })
      await expect(table).toContainText('天气服务')
      await expect(table).toContainText('api.weather.example.com')
      await expect(table).toContainText('程序可读 · TRANSLATE_API_KEY')
      await expect(table).toContainText('程序可读 · DEPLOY_TOKEN')
      await expect(table).toContainText('5 分钟前')
      const requests = page.getByRole('region', { name: '凭据申请' })
      await expect(requests).toContainText('资料员申请：查询路线规划')

      await requests.getByRole('button', { name: '添加', exact: true }).click()
      await expect(page).toHaveURL(/add=1/u)
      const dialog = page.getByRole('dialog', { name: '添加凭据' })
      await expect(dialog.getByRole('textbox', { name: '名称', exact: true })).toHaveValue('地图服务')
      await expect(dialog.getByRole('textbox', { name: '说明', exact: true })).toHaveValue('查询路线规划')
      await expect(dialog.getByRole('textbox', { name: '允许的域名', exact: true })).toHaveValue('maps.example.com')
      await expect(dialog.getByRole('radio', { name: '仅用于网络请求' })).toBeChecked()
      await dialog.getByRole('textbox', { name: '值', exact: true }).fill('fixture-map-key')
      await dialog.getByRole('button', { name: '添加', exact: true }).click()
      await expect.poll(() => state.calls.map(({ method, path }) => `${method} ${path}`)).toEqual(['POST '])
      expect(state.calls[0]!.body).toEqual({
        name: '地图服务',
        description: '查询路线规划',
        usage: 'request',
        domains: ['maps.example.com'],
        agentScope: { all: true },
        autoUse: true,
        value: 'fixture-map-key',
        requestId: 'req_fixture1',
      })
      // The new credential opens; the request it answered is gone.
      await expect(page).toHaveURL(new RegExp(`credential=${mapCredentialId}`, 'u'))
      await expect(page.getByRole('heading', { name: '地图服务' })).toBeVisible()
      await expect(page.getByRole('region', { name: '凭据申请' })).toHaveCount(0)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  test('keeps only the credential list beside an open credential', async () => {
    const state = { view: credentialsView(), calls: [] as { method: string; path: string; body: unknown }[] }
    const { page, errors } = await open('/settings/credentials', { width: 1680, before: credentialRoutes(state) })
    try {
      const table = page.getByRole('table', { name: '凭据' })
      const providers = page.getByRole('heading', { name: '模型供应商' })
      await expect(providers).toBeVisible()
      await table.getByText('天气服务', { exact: true }).click()
      await expect(page.getByRole('heading', { name: '天气服务' })).toBeVisible()
      // Page-wide groups wait until the credential closes; requests and the list stay.
      await expect(providers).toHaveCount(0)
      await expect(page.getByRole('heading', { name: '凭据申请' })).toBeVisible()
      await expect(table).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page).not.toHaveURL(/credential=/u)
      await expect(providers).toBeVisible()
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  test('opens a pre-filled add form straight from the link in a request notification', async () => {
    const state = { view: credentialsView(), calls: [] as { method: string; path: string; body: unknown }[] }
    const { page, errors } = await open(
      '/settings/credentials?add=1&name=%E7%BF%BB%E8%AF%91&purpose=%E7%BF%BB%E8%AF%91%E6%96%87%E6%A1%A3&usage=program&request=req_fixture2&domains=a.example.com,b.example.com',
      { before: credentialRoutes(state) },
    )
    try {
      const dialog = page.getByRole('dialog', { name: '添加凭据' })
      await expect(dialog.getByRole('textbox', { name: '名称', exact: true })).toHaveValue('翻译')
      await expect(dialog.getByRole('textbox', { name: '允许的域名', exact: true })).toHaveValue(
        'a.example.com, b.example.com',
      )
      await expect(dialog.getByRole('radio', { name: '允许程序读取' })).toBeChecked()
      await expect(dialog.getByText('智能体运行的程序可以读到原文。')).toBeVisible()
      await expect(dialog.getByRole('textbox', { name: '环境变量名', exact: true })).toBeVisible()
      // A value this short cannot be hidden from what the agent reads back.
      await dialog.getByRole('textbox', { name: '值', exact: true }).fill('short')
      await expect(dialog.getByText('少于 8 个字符，无法在智能体的上下文中隐藏。')).toBeVisible()
      await dialog.getByRole('radio', { name: '仅用于网络请求' }).click()
      await expect(dialog.getByText('智能体运行的程序可以读到原文。')).toHaveCount(0)
      await expect(dialog.getByRole('textbox', { name: '环境变量名', exact: true })).toHaveCount(0)
      // Who may use it stays collapsed until asked for.
      await expect(dialog.getByRole('radio', { name: '全部智能体' })).toBeHidden()
      await dialog.getByRole('button', { name: '高级' }).click()
      await expect(dialog.getByRole('radio', { name: '全部智能体' })).toBeChecked()
      await dialog.getByRole('button', { name: '取消' }).click()
      await expect(page).not.toHaveURL(/add=1/u)
      expect(state.calls).toEqual([])
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  test('switches automatic use and model access in place, revokes an approval and deletes after naming users', async () => {
    const state = { view: credentialsView(), calls: [] as { method: string; path: string; body: unknown }[] }
    const { page, errors } = await open('/settings/credentials', { before: credentialRoutes(state) })
    try {
      await page.getByRole('switch', { name: '天气服务 自动使用' }).click()
      await page.getByRole('switch', { name: '示例供应商甲 开放给智能体和扩展' }).click()
      await expect
        .poll(() => state.calls.map(({ method, path, body }) => [method, path, body]))
        .toEqual([
          ['PATCH', `/${weatherCredentialId}`, { autoUse: false }],
          ['PUT', '/model-providers/example-a', { open: false }],
        ])
      // The switch sits in the row but does not open it.
      await expect(page).not.toHaveURL(/credential=/u)

      await page.getByRole('table', { name: '凭据' }).getByText('翻译服务', { exact: true }).click()
      const approved = page.getByRole('region', { name: '已同意的智能体' })
      await approved.getByRole('button', { name: '撤销' }).click()
      await expect.poll(() => state.calls.at(-1)?.body).toEqual({ approvedAgentIds: [] })

      await page.getByRole('table', { name: '凭据' }).getByText('天气服务', { exact: true }).click()
      const uses = page.getByRole('table', { name: '使用记录' })
      await expect(uses).toContainText('扩展 · 群聊摘要')
      await expect(uses).toContainText('api.weather.example.com')
      await expect(uses).toContainText('命令')
      await expect(page.getByRole('region', { name: '使用方' })).toContainText('群聊摘要')

      await page.getByRole('button', { name: '删除', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '删除「天气服务」？' })
      await expect(dialog).toContainText('扩展「群聊摘要」')
      await dialog.getByRole('button', { name: '删除' }).click()
      await expect(dialog).toBeHidden()
      expect(state.calls.at(-1)).toEqual({
        method: 'POST',
        path: `/${weatherCredentialId}/remove`,
        body: { confirm: true },
      })
      await expect(page.getByRole('table', { name: '凭据' })).not.toContainText('天气服务')
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  test('edits a credential and saves only what changed', async () => {
    const state = { view: credentialsView(), calls: [] as { method: string; path: string; body: unknown }[] }
    const { page, errors } = await open(`/settings/credentials?credential=${translateCredentialId}`, {
      before: credentialRoutes(state),
    })
    try {
      await expect(page.getByRole('heading', { name: '翻译服务' })).toBeVisible()
      await page.getByRole('textbox', { name: '环境变量名' }).fill('translate_key')
      await expect(page.getByRole('textbox', { name: '环境变量名' })).toHaveValue('TRANSLATE_KEY')
      const bar = page.getByRole('region', { name: '未保存的修改' })
      await expect(bar).toContainText('环境变量名')
      await bar.getByRole('button', { name: '保存' }).click()
      await expect.poll(() => state.calls.length).toBe(1)
      expect(state.calls[0]).toMatchObject({
        method: 'PATCH',
        path: `/${translateCredentialId}`,
        body: { usage: 'program', envName: 'TRANSLATE_KEY', domains: [], agentScope: { agentIds: [targetAgentId] } },
      })
      await expect(bar).toBeHidden()
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  test('keeps GitHub out of the credentials page', async () => {
    const state = { view: credentialsView(), calls: [] as { method: string; path: string; body: unknown }[] }
    const { page, errors } = await open('/settings/credentials', {
      before: async (target) => {
        await credentialRoutes(state)(target)
        await target.route('**/api/snapshot', (request) =>
          request.fulfill({
            json: {
              ...productSnapshot,
              capabilityAvailability: {
                ...productSnapshot.capabilityAvailability,
                githubCli: { available: true, source: 'system', version: '2.90.0' },
              },
            },
          }),
        )
      },
    })
    try {
      await expect(page.getByRole('heading', { name: '模型供应商' })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'GitHub CLI' })).toHaveCount(0)
      await expect(page.getByRole('main')).not.toContainText(/GitHub|\bgh\b/u)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  /** Stubs the linked account routes over a mutable view and records every change request. */
  const linkedAccountRoutes =
    (state: { view: LinkedAccountsView; calls: { method: string; path: string; body: unknown }[] }) =>
    async (target: Page) => {
      await target.route('**/api/settings/linked-accounts**', async (request) => {
        const method = request.request().method()
        const path = new URL(request.request().url()).pathname.replace('/api/settings/linked-accounts', '')
        if (method === 'GET' && path === '') return request.fulfill({ json: state.view })
        if (method === 'GET' && path.endsWith('/uses')) {
          return request.fulfill({ json: { uses: path.includes(octoAccountId) ? octoUses() : [] } })
        }
        const body: unknown = request.request().postDataJSON()
        state.calls.push({ method, path, body })
        const github = state.view.platforms[0]!
        if (method === 'POST' && path === '') {
          const added = AddLinkedAccountRequestSchema.parse(body)
          if (added.method === 'token' && added.token === 'github_pat_rejected') {
            return request.fulfill({
              status: 400,
              json: { error: { code: 'linked-account-failed', message: 'GitHub 没有接受这个 token。' } },
            })
          }
          state.view = LinkedAccountsViewSchema.parse({
            ...state.view,
            platforms: [
              {
                ...github,
                accounts: [
                  ...github.accounts,
                  {
                    ...github.accounts[1]!,
                    id: addedAccountId,
                    login: added.method === 'gh-login' ? added.login : 'new-fixture',
                    source: added.method,
                  },
                ],
              },
            ],
          })
          return request.fulfill({ json: state.view })
        }
        if (method === 'POST' && path.endsWith('/remove')) {
          const confirmed = RemoveLinkedAccountRequestSchema.parse(body).confirm
          const id = path.split('/')[1]
          const account = github.accounts.find((candidate) => candidate.id === id)!
          if (!confirmed && account.grantedAgentIds.length > 0) {
            return request.fulfill({ json: { removed: false, grantedAgentIds: account.grantedAgentIds } })
          }
          state.view = {
            ...state.view,
            platforms: [{ ...github, accounts: github.accounts.filter((candidate) => candidate.id !== id) }],
          }
          return request.fulfill({ json: { removed: true, view: state.view } })
        }
        return request.fulfill({ json: state.view })
      })
    }

  test('lists linked accounts by platform with the GitHub CLI below them', async () => {
    const state = { view: linkedAccountsView(), calls: [] as { method: string; path: string; body: unknown }[] }
    const { page, errors } = await open('/settings/accounts', { before: linkedAccountRoutes(state) })
    try {
      await expect(page.getByRole('heading', { name: '关联账号', level: 1 })).toBeVisible()
      await expect(page.getByRole('link', { name: '关联账号', exact: true })).toHaveAttribute('aria-current', 'page')
      const table = page.getByRole('table', { name: 'GitHub 账号' })
      await expect(table).toContainText('octo-fixture')
      await expect(table).toContainText('repo、read:org')
      await expect(table).toContainText('资料员')
      await expect(table).toContainText('12 分钟前')
      await expect(table).toContainText('由 GitHub 上这个 token 的设置决定')
      await expect(table).toContainText('未使用')
      const cli = page.getByRole('region', { name: 'GitHub CLI' })
      await expect(cli).toContainText('2.90.0，来自这台设备')
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  test('shows one line and the link action for a platform without accounts', async () => {
    const state = {
      view: linkedAccountsView({ empty: true }),
      calls: [] as { method: string; path: string; body: unknown }[],
    }
    const { page, errors } = await open('/settings/accounts', { before: linkedAccountRoutes(state) })
    try {
      const github = page.getByRole('region', { name: 'GitHub', exact: true })
      await expect(github).toContainText('还没有关联账号。')
      await expect(github.getByRole('button', { name: '关联账号' })).toBeVisible()
      await expect(page.getByRole('table', { name: 'GitHub 账号' })).toHaveCount(0)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  test('links a GitHub account with a token or a login of the local gh, and opens it', async () => {
    const state = { view: linkedAccountsView(), calls: [] as { method: string; path: string; body: unknown }[] }
    const { page, errors } = await open('/settings/accounts', { before: linkedAccountRoutes(state) })
    try {
      const github = page.getByRole('region', { name: 'GitHub', exact: true })
      await github.getByRole('button', { name: '关联账号' }).click()
      const dialog = page.getByRole('dialog', { name: '关联 GitHub 账号' })
      await expect(dialog.getByRole('radio', { name: '填写 token' })).toBeChecked()
      await expect(dialog.getByRole('link', { name: '创建专用 token' })).toHaveAttribute(
        'href',
        'https://github.com/settings/personal-access-tokens/new',
      )
      const link = dialog.getByRole('button', { name: '关联', exact: true })
      await expect(link).toBeDisabled()
      await dialog.getByLabel('Token').fill('github_pat_rejected')
      await link.click()
      await expect(dialog).toContainText('GitHub 没有接受这个 token。')

      await dialog.getByRole('radio', { name: '本机 gh 已登录账号' }).click()
      await expect(dialog.getByRole('combobox', { name: 'gh 账号' })).toContainText('example-bot')
      await expect(dialog.getByText('授权的智能体会获得该账号在 gh 里的全部权限。')).toBeVisible()
      await dialog.getByRole('combobox', { name: 'gh 账号' }).click()
      await page.getByRole('option', { name: 'example-helper' }).click()
      await link.click()
      await expect(dialog).toBeHidden()
      expect(state.calls.map(({ method, path, body }) => [method, path, body])).toEqual([
        ['POST', '', { platform: 'github', method: 'token', token: 'github_pat_rejected' }],
        ['POST', '', { platform: 'github', method: 'gh-login', login: 'example-helper' }],
      ])
      await expect(page).toHaveURL(new RegExp(`account=${addedAccountId}`, 'u'))
      await expect(page.getByRole('heading', { name: 'example-helper' })).toBeVisible()
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  test('opens an account beside the list, hides the GitHub CLI and closes back', async () => {
    const state = { view: linkedAccountsView(), calls: [] as { method: string; path: string; body: unknown }[] }
    const { page, errors } = await open('/settings/accounts', { width: 1680, before: linkedAccountRoutes(state) })
    try {
      const table = page.getByRole('table', { name: 'GitHub 账号' })
      const cli = page.getByRole('heading', { name: 'GitHub CLI' })
      await expect(cli).toBeVisible()
      await table.getByText('octo-fixture', { exact: true }).click()
      await expect(page).toHaveURL(new RegExp(`account=${octoAccountId}`, 'u'))
      await expect(page.getByRole('heading', { name: 'octo-fixture' })).toBeVisible()
      await expect(cli).toHaveCount(0)
      await expect(table).toBeVisible()
      const account = page.getByRole('region', { name: '账号', exact: true })
      await expect(account).toContainText('填写的 token')
      await expect(account).toContainText('repo、read:org')
      const uses = page.getByRole('table', { name: '使用记录' })
      await expect(uses).toContainText('资料员')
      await expect(uses).toContainText('资料员的内置频道')

      // Granting lives on the agent; the name leads there.
      const granted = page.getByRole('region', { name: '已授权的智能体' })
      await expect(granted.getByRole('link', { name: '资料员' })).toHaveAttribute(
        'href',
        `/agents/${targetAgentId}#profile-capabilities`,
      )

      await page.getByRole('button', { name: '更换 token' }).click()
      const replace = page.getByRole('dialog', { name: '更换 octo-fixture 的 token' })
      await expect(replace).toContainText('需要属于同一个 GitHub 账号。')
      await replace.getByRole('button', { name: '取消' }).click()

      await page.getByRole('button', { name: '关闭' }).click()
      await expect(page).not.toHaveURL(/account=/u)
      await expect(cli).toBeVisible()
      expect(state.calls).toEqual([])
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  test('removes a granted account only after naming the agents it is granted to', async () => {
    const state = { view: linkedAccountsView(), calls: [] as { method: string; path: string; body: unknown }[] }
    const { page, errors } = await open(`/settings/accounts?account=${octoAccountId}`, {
      before: linkedAccountRoutes(state),
    })
    try {
      await page.getByRole('button', { name: '移除', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '移除「octo-fixture」？' })
      await expect(dialog).toContainText('以下智能体的命令会失去这个账号：')
      await expect(dialog).toContainText('资料员')
      await dialog.getByRole('button', { name: '移除' }).click()
      await expect(dialog).toBeHidden()
      expect(state.calls).toEqual([{ method: 'POST', path: `/${octoAccountId}/remove`, body: { confirm: true } }])
      await expect(page).not.toHaveURL(/account=/u)
      await expect(page.getByRole('table', { name: 'GitHub 账号' })).not.toContainText('octo-fixture')
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
      // Every adapter here is built in, so the table leaves out the source column (05 §9).
      await expect(table.getByRole('columnheader', { name: '来源' })).toHaveCount(0)
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
      await expect(dialog).toContainText('装好后默认关闭')
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

  test('clears sent feedback on account changes and discards a late response from the previous account', async () => {
    let account = 'alpha'
    let hold = false
    let reads = 0
    let release: (() => void) | undefined
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const { page, errors } = await open('/settings/feedback', {
      before: async (target) => {
        await target.route('**/api/community/status', (route) =>
          route.fulfill({
            json: {
              communityUrl: 'https://community.example.test',
              environment: 'development',
              features: ['feedback'],
              account: {
                id: `usr_${account}`,
                handle: account,
                displayName: account === 'alpha' ? '账号甲' : '账号乙',
                avatarUrl: null,
              },
              signedInAt: 1,
              updatesAvailable: 0,
            },
          }),
        )
        await target.route('**/api/community/feedback/settings', (route) =>
          route.fulfill({
            json: {
              enabled: false,
              supported: true,
              signedIn: true,
              communityUrl: 'https://community.example.test',
              communityUserId: `usr_${account}`,
              consentedAt: null,
            },
          }),
        )
        await target.route('**/api/community/feedback/last-sent', async (route) => {
          const captured = account
          reads += 1
          if (hold) await barrier
          await route.fulfill({
            json: {
              ref: 'FB-1',
              sentAt: 1,
              payload: {
                clientRequestId: 'fbd_fixture',
                kind: 'bug',
                target: 'nxt',
                title: `${captured} 的虚构反馈`,
                body: '这条说明只属于提交它的账号。',
                diagnostics: {},
                source: 'form',
                excerptSharedWithAuthor: false,
              },
            },
          })
        })
      },
    })
    try {
      await expect(page.getByText('账号甲', { exact: true })).toBeVisible()
      await page.getByRole('button', { name: '查看最近一次发送的内容', exact: true }).click()
      await expect(page.getByRole('dialog', { name: '最近一次发送的内容' })).toContainText('alpha 的虚构反馈')
      account = 'beta'
      await page.evaluate(() => window.dispatchEvent(new Event('focus')))
      await expect(page.getByText('账号乙', { exact: true })).toBeVisible()
      await expect(page.getByRole('dialog', { name: '最近一次发送的内容' })).toBeHidden()
      await expect(page.getByText('alpha 的虚构反馈', { exact: false })).toHaveCount(0)
      account = 'alpha'
      await page.evaluate(() => window.dispatchEvent(new Event('focus')))
      await expect(page.getByText('账号甲', { exact: true })).toBeVisible()
      hold = true
      await page.getByRole('button', { name: '查看最近一次发送的内容', exact: true }).click()
      await expect.poll(() => reads).toBe(2)
      account = 'beta'
      await page.evaluate(() => window.dispatchEvent(new Event('focus')))
      await expect(page.getByText('账号乙', { exact: true })).toBeVisible()
      const response = page.waitForResponse('**/api/community/feedback/last-sent')
      release?.()
      await (await response).finished()
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      )
      await expect(page.getByRole('dialog', { name: '最近一次发送的内容' })).toBeHidden()
      expect(errors).toEqual([])
    } finally {
      release?.()
      await page.close()
    }
  })
})
