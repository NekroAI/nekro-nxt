import { expect, test, type Page } from '@playwright/test'
import { HostApiContracts, type HostApiResponse } from '@nekro-nxt/contracts'
import { answering } from './fixtures/route.js'
import { providerRevision, removeProvider, retryOnSettingsConflict } from './fixtures/provider-settings.js'

test('an unconfigured ChatGPT account reports discovery failure rather than offering the installed directory', async ({
  page,
  request,
}) => {
  const failures: string[] = []
  page.on('pageerror', (error) => failures.push(error.message))
  page.on('console', (message) => {
    if (
      message.type() === 'error' &&
      !message.text().startsWith('Failed to load resource: the server responded with a status of 400')
    )
      failures.push(message.text())
  })
  const initial = HostApiContracts.llmProviders.parseResponse(await (await request.get('/api/llm/providers')).json())
  const openai = initial.providers.find((provider) => provider.provider === 'openai')!
  expect(openai.configured).toBe(false)
  const switched = await retryOnSettingsConflict(async () =>
    request.post('/api/llm/subscriptions/openai', {
      data: { action: 'use-subscription', expectedRevision: await providerRevision(request, 'openai') },
    }),
  )
  expect(switched.ok(), await switched.text()).toBe(true)
  try {
    await page.goto('/settings/models?provider=openai')
    await expect(page.getByRole('radio', { name: 'ChatGPT 套餐' })).toBeChecked()
    await expect(page.getByRole('table', { name: '模型列表' })).toContainText('还没有模型')
    const response = page.waitForResponse((result) => result.url().endsWith('/api/llm/discover-models'))
    await page.getByRole('button', { name: '获取可用模型', exact: true }).click()
    const result = await response
    expect(result.request().postDataJSON()).toMatchObject({ provider: 'openai', api: 'openai-responses' })
    expect(result.status()).toBe(400)
    await expect(page.getByText('请先登录 ChatGPT。', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: /^全部加入/u })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '获取可用模型', exact: true })).toBeEnabled()
    await page.screenshot({ path: '.local/model-discovery-no-account.png', animations: 'disabled' })
    expect(failures).toEqual([])
  } finally {
    const removed = await removeProvider(request, 'openai')
    expect(removed.ok(), await removed.text()).toBe(true)
  }
})

test('a failed model refresh clears previous candidates and can be retried', async ({ page }) => {
  const failures: string[] = []
  page.on('pageerror', (error) => failures.push(error.message))
  page.on('console', (message) => {
    if (
      message.type() === 'error' &&
      !message.text().startsWith('Failed to load resource: the server responded with a status of 400')
    )
      failures.push(message.text())
  })
  await page.route(
    '**/api/llm/providers',
    answering(async (route) => {
      const real = HostApiContracts.llmProviders.parseResponse(await (await route.fetch()).json())
      await route.fulfill({
        json: {
          ...real,
          providers: real.providers.map((provider) =>
            provider.provider === 'openai'
              ? {
                  ...provider,
                  configured: true,
                  active: true,
                  api: 'openai-responses',
                  models: [],
                  subscription: { label: 'ChatGPT', active: true, accountLabel: null },
                }
              : provider,
          ),
        },
      })
    }),
  )
  let attempts = 0
  await page.route('**/api/llm/discover-models', async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({ provider: 'openai', api: 'openai-responses' })
    attempts++
    if (attempts === 2) {
      await route.fulfill({
        status: 400,
        json: { error: { code: 'model-discovery-failed', message: '没能读取账号模型，请重试。' } },
      })
    } else {
      await route.fulfill({ json: { models: [{ id: 'synthetic-account-chat', name: '账号模型' }] } })
    }
  })
  await page.goto('/settings/models?provider=openai')
  const refresh = page.getByRole('button', { name: '获取可用模型', exact: true })
  await refresh.click()
  await expect(page.getByRole('button', { name: 'synthetic-account-chat · 账号模型', exact: true })).toBeVisible()
  await refresh.click()
  await expect(page.getByText('没能读取账号模型，请重试。', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /^全部加入/u })).toHaveCount(0)
  await expect(refresh).toBeEnabled()
  await refresh.click()
  await expect(page.getByRole('button', { name: 'synthetic-account-chat · 账号模型', exact: true })).toBeVisible()
  await page.screenshot({ path: '.local/model-discovery-retry.png', animations: 'disabled' })
  expect(failures).toEqual([])
})

const relayModels = ['chat', 'vision', 'code'].flatMap((family) =>
  Array.from({ length: 500 }, (_, index) => ({
    id: `relay-${family}-${String(index).padStart(4, '0')}`,
    ...(family === 'vision' ? { inputModalities: ['text', 'image'] } : {}),
  })),
)

/** A fictional relay provider with an empty model list whose discovery returns 1500 models. */
const stubRelay = async (page: Page, saved: unknown[]): Promise<void> => {
  let providers: HostApiResponse<'llmProviders'> | undefined
  const withRelay = (real: HostApiResponse<'llmProviders'>): HostApiResponse<'llmProviders'> => ({
    ...real,
    providers: [
      ...real.providers,
      {
        provider: 'synthetic-relay',
        displayName: '示例中转站',
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', 'synthetic-relay'],
        settingsRevision: 3,
        declared: true,
        active: true,
        configured: true,
        baseURL: 'https://relay.example.test/v1',
        api: 'openai-completions',
        credential: { configured: true, writable: true },
        models: [],
        modelsCustomized: false,
        discoverable: true,
      },
    ],
  })
  await page.route(
    '**/api/llm/providers',
    answering(async (route) => {
      providers ??= withRelay(HostApiContracts.llmProviders.parseResponse(await (await route.fetch()).json()))
      await route.fulfill({ json: providers })
    }),
  )
  await page.route('**/api/llm/discover-models', async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({ provider: 'synthetic-relay' })
    await route.fulfill({ json: { models: relayModels } })
  })
  await page.route('**/api/llm/providers/synthetic-relay', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    saved.push(route.request().postDataJSON())
    await route.fulfill({ json: providers })
  })
}

test('discovered models wait to be picked, and a long list can be searched and pruned in bulk', async ({ page }) => {
  const failures: string[] = []
  page.on('pageerror', (error) => failures.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(message.text())
  })
  const saved: unknown[] = []
  await stubRelay(page, saved)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/settings/models?provider=synthetic-relay')
  const table = page.getByRole('table', { name: '模型列表' })
  await expect(table).toContainText('还没有模型')

  await page.getByRole('button', { name: '获取可用模型', exact: true }).click()
  await expect(page.getByText('供应商提供、尚未加入的模型（1500）')).toBeVisible()
  await expect(table).toContainText('还没有模型')
  const candidates = page.getByRole('group', { name: '可加入的模型' })
  await expect(candidates.getByRole('button')).toHaveCount(200)
  await expect(page.getByText('只显示前 200 个，输入关键词缩小范围。')).toBeVisible()
  await expect(page.getByRole('button', { name: '全部加入（1500）' })).toBeEnabled()
  await expect(page.getByRole('button', { name: '加入所选（0）' })).toBeDisabled()

  const search = page.getByRole('searchbox', { name: '搜索可加入的模型' })
  await search.fill('vision-001')
  await expect(candidates.getByRole('button')).toHaveCount(10)
  await expect(page.getByText('只显示前 200 个，输入关键词缩小范围。')).toHaveCount(0)
  await candidates.getByRole('button', { name: 'relay-vision-0012 · 视觉' }).click()
  await candidates.getByRole('button', { name: 'relay-vision-0015 · 视觉' }).click()
  await expect(candidates.getByRole('button', { name: 'relay-vision-0012 · 视觉' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page.screenshot({ path: '.local/model-discovery-candidates-1440.png', animations: 'disabled' })
  await page.getByRole('button', { name: '加入所选（2）' }).click()
  await expect(page.getByText('已加入 2 个模型，保存后生效。')).toBeVisible()
  await expect(table.getByRole('textbox', { name: '模型 ID' })).toHaveCount(2)
  await expect(page.getByText('供应商提供、尚未加入的模型（1498）')).toBeVisible()

  await search.fill('code-04')
  await page.getByRole('button', { name: '全部加入（100）' }).click()
  await expect(page.getByText('已加入 100 个模型，保存后生效。')).toBeVisible()
  await expect(page.getByText('供应商提供、尚未加入的模型（1398）')).toBeVisible()
  await expect(page.getByText('102 个模型', { exact: true })).toBeVisible()

  await page.getByRole('searchbox', { name: '搜索模型列表' }).fill('code-045')
  await expect(page.getByText('匹配 10 个，共 102 个模型', { exact: true })).toBeVisible()
  await expect(table.getByRole('textbox', { name: '模型 ID' })).toHaveCount(10)
  await table.getByRole('checkbox', { name: '选择全部匹配的模型' }).check()
  await table.getByRole('checkbox', { name: '选择模型 relay-code-0451' }).uncheck()
  await expect(page.getByText('已选 9 个')).toBeVisible()
  await page.screenshot({ path: '.local/model-list-bulk-1440.png', animations: 'disabled' })
  await page.setViewportSize({ width: 375, height: 812 })
  await page.getByRole('searchbox', { name: '搜索模型列表' }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: '.local/model-list-bulk-375.png', animations: 'disabled' })
  await search.scrollIntoViewIfNeeded()
  await page.screenshot({ path: '.local/model-discovery-candidates-375.png', animations: 'disabled' })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByRole('button', { name: '删除所选' }).click()
  await expect(page.getByText('已删除 9 个模型，保存后生效。')).toBeVisible()
  await expect(table.getByRole('textbox', { name: '模型 ID' })).toHaveCount(1)
  await expect(page.getByText('匹配 1 个，共 93 个模型', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: '保存供应商' }).click()
  await expect.poll(() => saved.length).toBe(1)
  const models = HostApiContracts.llmSaveProvider.request.parse(saved[0]).models!.map((model) => model.id)
  expect(models).toHaveLength(93)
  expect(models.slice(0, 2)).toEqual(['relay-vision-0012', 'relay-vision-0015'])
  expect(models).toContain('relay-code-0451')
  expect(models).not.toContain('relay-code-0450')
  expect(failures).toEqual([])
})
