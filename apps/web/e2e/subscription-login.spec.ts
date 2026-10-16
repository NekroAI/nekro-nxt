import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { HostApiContracts, type HostApiResponse } from '@nekro-nxt/contracts'

/** The production data root outlives a run; start each sign-in test from an unconfigured OpenAI route. */
async function resetOpenAi(request: APIRequestContext): Promise<void> {
  const providers = HostApiContracts.llmProviders.parseResponse(await (await request.get('/api/llm/providers')).json())
  const openai = providers.providers.find((provider) => provider.provider === 'openai')
  if (!openai?.configured) return
  const response = await request.delete('/api/llm/providers/openai', {
    data: { expectedRevision: openai.settingsRevision },
  })
  expect(response.ok(), await response.text()).toBe(true)
}

const openedUrl = async (page: Page): Promise<string> =>
  (await page.locator('html').getAttribute('data-test-opened-url')) ?? ''

for (const theme of ['light', 'dark'] as const) {
  test(`ChatGPT plan sign-in starts on the host, cancels and reports a denied grant (${theme})`, async ({
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
        document.documentElement.dataset['testOpenedUrl'] = String(url)
        return null
      }
    }, theme)
    await resetOpenAi(request)

    await page.goto('/settings/models')
    await page.getByRole('button', { name: '添加供应商', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '添加模型供应商' })
    await dialog.getByRole('combobox').click()
    await page.getByRole('option', { name: 'ChatGPT 套餐（登录账号）', exact: true }).click()
    await dialog.getByRole('button', { name: '开始配置' }).click()
    // The same OpenAI route as an API key, signed in with an account instead.
    await expect(page.getByRole('radio', { name: 'ChatGPT 套餐' })).toBeChecked()
    await expect(page.getByLabel('API 密钥', { exact: true })).toHaveCount(0)
    const signIn = page.getByRole('button', { name: 'Continue with ChatGPT', exact: true })
    await expect(signIn).toBeEnabled()
    await page.screenshot({ path: `.local/subscription-unsigned-${theme}.png`, animations: 'disabled' })

    await signIn.click()
    const cancel = page.getByRole('button', { name: '取消登录', exact: true })
    await expect(cancel).toBeVisible()
    await expect.poll(() => openedUrl(page)).toContain('https://auth.openai.com/')
    const first = new URL(await openedUrl(page))
    expect(first.searchParams.get('agent_name_hint')).toBe('NekroNXT')
    expect(first.searchParams.get('ext_agent_host_id')).toMatch(/^urn:uuid:/u)
    // The paste box is there from the start, for a browser that cannot reach the host's loopback.
    await expect(page.getByRole('button', { name: '提交', exact: true })).toBeVisible()
    await cancel.click()
    await expect(signIn).toBeEnabled()

    await signIn.click()
    await expect(cancel).toBeVisible()
    await expect.poll(async () => new URL((await openedUrl(page)) || 'http://x').search).not.toBe(first.search)
    const second = new URL(await openedUrl(page))
    const callback = new URL(second.searchParams.get('redirect_uri')!)
    callback.search = new URLSearchParams({
      state: second.searchParams.get('state')!,
      error: 'access_denied',
    }).toString()
    expect((await request.get(callback.toString())).status()).toBe(400)
    await expect(page.getByText('ChatGPT 登录已取消。', { exact: true })).toBeVisible()
    await expect(signIn).toBeEnabled()
    await page.screenshot({ path: `.local/subscription-denied-${theme}.png`, animations: 'disabled' })
    expect(failures).toEqual([])
  })
}

for (const width of [375, 1440]) {
  test(`ChatGPT accounts switch and sign out on the provider page (${width}px)`, async ({ page }) => {
    const failures: string[] = []
    page.on('pageerror', (error) => failures.push(error.message))
    await page.setViewportSize({ width, height: 900 })
    let status: HostApiResponse<'llmSubscriptionStatus'> = {
      provider: 'openai',
      label: 'ChatGPT',
      usageUrl: 'https://chatgpt.com/settings/usage',
      available: true,
      mode: 'subscription',
      activeAccountId: 'sample-one',
      accounts: [
        { id: 'sample-one', label: 'one@example.com', email: 'one@example.com', createdAt: 1 },
        { id: 'sample-two', label: 'two@example.com', email: 'two@example.com', createdAt: 2 },
      ],
      login: null,
    }
    const activeLabel = () => status.accounts.find((account) => account.id === status.activeAccountId)?.label ?? null
    await page.route('**/api/llm/providers', async (route) => {
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
                  subscription: { label: 'ChatGPT', active: true, accountLabel: activeLabel() },
                }
              : provider,
          ),
        },
      })
    })
    await page.route('**/api/llm/subscriptions/openai', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ json: status })
        return
      }
      const input = HostApiContracts.llmSubscriptionAction.parseRequest(route.request().postDataJSON())
      if (input.action === 'activate') status = { ...status, activeAccountId: input.accountId }
      if (input.action === 'remove')
        status = {
          ...status,
          activeAccountId: status.activeAccountId === input.accountId ? null : status.activeAccountId,
          accounts: status.accounts.filter((account) => account.id !== input.accountId),
        }
      await route.fulfill({ json: { status, ...(input.action === 'remove' ? { revocationConfirmed: false } : {}) } })
    })

    await page.goto('/settings/models?provider=openai')
    await expect(page.getByText('ChatGPT 账号：one@example.com')).toBeVisible()
    await page.getByRole('combobox', { name: '账号' }).click()
    await page.getByRole('option', { name: 'two@example.com', exact: true }).click()
    await page.getByRole('button', { name: '使用此账号' }).click()
    await expect(page.getByRole('combobox', { name: '账号' })).toContainText('two@example.com（正在使用）')
    await page.screenshot({ path: `.local/subscription-accounts-${width}.png`, animations: 'disabled' })

    await page.getByRole('button', { name: '退出此账号' }).click()
    await page.getByRole('dialog', { name: '退出此账号' }).getByRole('button', { name: '退出', exact: true }).click()
    await expect(page.getByText(/没能确认 ChatGPT 已撤销授权/u)).toBeVisible()
    await expect(page.getByText(/没有正在使用的账号/u)).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    expect(failures).toEqual([])
  })
}
