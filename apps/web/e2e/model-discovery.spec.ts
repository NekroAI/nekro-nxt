import { expect, test } from '@playwright/test'
import { HostApiContracts } from '@nekro-nxt/contracts'
import { answering } from './fixtures/route.js'

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
  const switched = await request.post('/api/llm/subscriptions/openai', {
    data: { action: 'use-subscription', expectedRevision: openai.settingsRevision },
  })
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
    await expect(page.getByRole('button', { name: '全部加入', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '获取可用模型', exact: true })).toBeEnabled()
    await page.screenshot({ path: '.local/model-discovery-no-account.png', animations: 'disabled' })
    expect(failures).toEqual([])
  } finally {
    const impact = HostApiContracts.llmProviderRemovalImpact.parseResponse(
      await (await request.get('/api/llm/providers/openai/removal-impact')).json(),
    )
    const removed = await request.delete('/api/llm/providers/openai', {
      data: { expectedRevision: impact.expectedRevision },
    })
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
  await expect(page.getByRole('button', { name: '全部加入', exact: true })).toHaveCount(0)
  await expect(refresh).toBeEnabled()
  await refresh.click()
  await expect(page.getByRole('button', { name: 'synthetic-account-chat · 账号模型', exact: true })).toBeVisible()
  await page.screenshot({ path: '.local/model-discovery-retry.png', animations: 'disabled' })
  expect(failures).toEqual([])
})
