import { expect, test } from '@playwright/test'
import { HostApiContracts, type HostApiResponse } from '@nekro-nxt/contracts'
import { productSnapshot, targetAgentId, targetChannelId } from './fixtures/product-quality.js'
import { installSnapshotHealthRoutes } from './fixtures/host-release.js'
import { installWorkspaceRoutes } from './fixtures/workspace.js'

for (const theme of ['light', 'dark'] as const) {
  test(`ChatGPT provider starts, cancels and rejects denied login on the built host (${theme})`, async ({
    page,
    request,
  }) => {
    const failures: string[] = []
    page.on('pageerror', (error) => failures.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') failures.push(message.text())
    })
    await page.addInitScript((value) => {
      localStorage.setItem('nekro-nxt.theme', value)
      window.open = (url) => {
        document.documentElement.dataset['testAuthorizeUrl'] = String(url)
        return null
      }
    }, theme)
    const response = await request.get('/api/llm/providers')
    expect(response.ok(), await response.text()).toBe(true)
    const providers = HostApiContracts.llmProviders.parseResponse(await response.json())
    expect(providers.providers.find((provider) => provider.provider === 'chatgpt')).toMatchObject({
      configured: false,
      active: false,
    })
    await page.goto('/settings/models')
    await page.getByRole('button', { name: '添加供应商', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '添加模型供应商' })
    await dialog.getByRole('combobox').click()
    await page.getByRole('option', { name: 'ChatGPT', exact: true }).click()
    await dialog.getByRole('button', { name: '开始配置' }).click()
    await expect(page.getByRole('heading', { name: 'ChatGPT', exact: true })).toBeVisible()
    await expect(page.getByLabel('API 密钥', { exact: true })).toHaveCount(0)
    await page.screenshot({ path: `.local/chatgpt-unsigned-${theme}.png`, animations: 'disabled' })
    const signIn = page.getByRole('button', { name: 'Continue with ChatGPT', exact: true })
    await signIn.click()
    await expect(page.getByRole('button', { name: '取消登录', exact: true })).toBeVisible()
    const authorize = new URL((await page.locator('html').getAttribute('data-test-authorize-url')) ?? '')
    expect(authorize.origin).toBe('https://auth.openai.com')
    expect(authorize.searchParams.get('agent_name_hint')).toBe('NekroNXT')
    await page.getByRole('button', { name: '取消登录', exact: true }).click()
    await expect(signIn).toBeEnabled()
    const status = HostApiContracts.chatGptStatus.parseResponse(await (await request.get('/api/llm/chatgpt')).json())
    expect(status.login?.status).toBe('cancelled')
    await signIn.click()
    await expect(page.getByRole('button', { name: '取消登录', exact: true })).toBeVisible()
    const denied = new URL((await page.locator('html').getAttribute('data-test-authorize-url')) ?? '')
    const callback = new URL(denied.searchParams.get('redirect_uri')!)
    callback.search = new URLSearchParams({
      state: denied.searchParams.get('state')!,
      error: 'access_denied',
    }).toString()
    expect((await request.get(callback.toString())).status()).toBe(400)
    await expect(page.getByText('ChatGPT 登录已取消。', { exact: true })).toBeVisible()
    await page.screenshot({ path: `.local/chatgpt-denied-${theme}.png`, animations: 'disabled' })
    await page.reload()
    await expect(page.getByRole('heading', { name: 'ChatGPT', exact: true })).toBeVisible()
    await expect(signIn).toBeEnabled()
    expect(failures).toEqual([])
  })
}

test('ChatGPT account controls, welcome, model list and revocation failure render in production', async ({ page }) => {
  const failures: string[] = []
  page.on('pageerror', (error) => failures.push(error.message))
  let status: HostApiResponse<'chatGptStatus'> = {
    activeId: 'synthetic-account-one',
    accounts: [
      { id: 'synthetic-account-one', label: '账号 1', email: 'sample@example.test', signedIn: true, planEnabled: true },
      { id: 'synthetic-account-two', label: '账号 2', email: 'sample@example.test', signedIn: true, planEnabled: true },
    ],
    models: [{ id: 'synthetic-chat', name: '示例模型' }],
    welcome: true,
    login: null,
  }
  await page.route('**/api/llm/chatgpt**', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: status })
      return
    }
    const input = HostApiContracts.chatGptAction.parseRequest(route.request().postDataJSON())
    if (input.action === 'acknowledge') status = { ...status, welcome: false }
    if (input.action === 'select') status = { ...status, activeId: input.accountId }
    if (input.action === 'logout')
      status = {
        ...status,
        activeId: null,
        models: [],
        accounts: status.accounts.map((account) =>
          account.id === input.accountId ? { ...account, signedIn: false, planEnabled: false } : account,
        ),
      }
    await route.fulfill({ json: { status, ...(input.action === 'logout' ? { revocationConfirmed: false } : {}) } })
  })
  await page.goto('/settings/models?provider=chatgpt')
  const welcome = page.getByRole('dialog', { name: '正在使用 ChatGPT 套餐' })
  await expect(welcome).toBeVisible()
  await welcome.getByRole('button', { name: '知道了' }).click()
  await expect(welcome).toBeHidden()
  await expect(page.getByText('示例模型', { exact: true })).toBeVisible()
  await page.getByRole('combobox', { name: 'ChatGPT 账号' }).click()
  await page.getByRole('option', { name: '账号 2 · sample@example.test', exact: true }).click()
  await page.getByRole('button', { name: '使用此账号' }).click()
  await expect(page.getByRole('combobox', { name: 'ChatGPT 账号' })).toContainText('正在使用')
  await page.screenshot({ path: '.local/chatgpt-connected.png', animations: 'disabled' })
  await page.getByRole('button', { name: '退出此账号' }).click()
  await expect(
    page.getByText('已退出本机账号，尚未确认 ChatGPT 已撤销授权。请在 ChatGPT 使用量设置中断开 NekroNXT。', {
      exact: true,
    }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: '管理 ChatGPT 使用量' })).toBeEnabled()
  expect(failures).toEqual([])
})

for (const width of [375, 760, 1440]) {
  test(`ChatGPT plan usage is visible beside the production composer (${width}px)`, async ({ page }) => {
    const failures: string[] = []
    page.on('pageerror', (error) => failures.push(error.message))
    await page.setViewportSize({ width, height: 900 })
    await page.addInitScript(() => {
      window.open = (url) => {
        document.documentElement.dataset['testUsageUrl'] = String(url)
        return null
      }
    })
    const snapshot = HostApiContracts.snapshot.parseResponse({
      ...productSnapshot,
      extensions: [],
      dynamic: [],
      authoringTasks: [],
      messages: [],
      agents: productSnapshot.agents.map((agent) =>
        agent.id === targetAgentId ? { ...agent, model: { provider: 'chatgpt', model: 'synthetic-chat' } } : agent,
      ),
      models: [
        ...productSnapshot.models,
        { provider: 'chatgpt', providerName: 'ChatGPT', id: 'synthetic-chat', name: '示例模型' },
      ],
    })
    await installSnapshotHealthRoutes(page, snapshot)
    await installWorkspaceRoutes(page, () => snapshot)
    await page.route('**/api/snapshot', (route) => route.fulfill({ json: snapshot }))
    await page.route('**/api/channels/*/runtime', (route) =>
      route.fulfill({
        json: {
          cursor: { epoch: 'fixture', sequence: 0 },
          channelId: targetChannelId,
          phase: 'idle',
          summary: '当前空闲',
          pendingInjectCount: 0,
          turns: [],
        },
      }),
    )
    await page.route('**/api/channels/*/messages?*', (route) =>
      route.fulfill({ json: { cursor: { epoch: 'fixture', sequence: 0 }, hasMore: false, messages: [] } }),
    )
    await page.goto(`/channels/${targetChannelId}`)
    const usage = page.getByRole('button', { name: '使用 ChatGPT 套餐 · 管理使用量', exact: true })
    await expect(usage).toBeInViewport()
    await usage.click()
    expect(await page.locator('html').getAttribute('data-test-usage-url')).toBe('https://chatgpt.com/settings/usage')
    await page.screenshot({ path: `.local/chatgpt-composer-${width}.png`, animations: 'disabled' })
    expect(failures).toEqual([])
  })
}
