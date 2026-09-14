import { expect, test, type APIRequestContext } from '@playwright/test'
import { HostApiContracts } from '@nekro-nxt/contracts'

const settings = async (request: APIRequestContext) => {
  const response = await request.get('/api/llm/providers')
  expect(response.ok()).toBe(true)
  return HostApiContracts.llmProviders.parseResponse(await response.json())
}
const saveProvider = async (request: APIRequestContext, provider: string, custom: boolean) => {
  const before = await settings(request)
  const response = await request.post(`/api/llm/providers/${provider}`, {
    data: {
      expectedRevision: before.providers.find((entry) => entry.settingsNs === 'llm-pi-ai')!.settingsRevision,
      apiKey: 'synthetic-journey-key',
      ...(custom
        ? {
            displayName: '旅程测试网关',
            baseURL: 'https://gateway.example.test/v1',
            api: 'openai-completions',
            models: [{ id: 'synthetic-chat' }],
          }
        : {}),
    },
  })
  expect(response.ok(), await response.text()).toBe(true)
}

for (const theme of ['light', 'dark'] as const) {
  test(`provider removal previews effects, cancels and removes a custom route (${theme})`, async ({
    page,
    request,
  }) => {
    const failures: string[] = []
    page.on('pageerror', (error) => failures.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') failures.push(message.text())
    })
    const provider = `journey-removal-${theme}`
    await saveProvider(request, provider, true)
    await page.addInitScript((value) => localStorage.setItem('nekro-nxt.theme', value), theme)
    await page.goto('/settings')
    await page.getByRole('button', { name: /旅程测试网关/u }).click()
    await expect(page.getByRole('button', { name: /旅程测试网关/u })).toContainText('自定义接入')
    await page.getByRole('button', { name: '删除供应商', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '检查供应商移除影响' })
    await expect(dialog.getByText('synthetic-chat', { exact: true })).toBeVisible()
    await expect(dialog).toContainText('API 密钥保留在本机凭据存储')
    await expect(dialog).toContainText('没有智能体当前配置或活动频道上下文引用此供应商')
    await expect(dialog.getByRole('button', { name: '确认删除供应商' })).toBeEnabled()
    await page.screenshot({ animations: 'disabled', path: `.local/provider-removal-${theme}.png` })
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await expect(dialog).toBeHidden()
    expect((await settings(request)).providers.some((entry) => entry.provider === provider)).toBe(true)
    await page.getByRole('button', { name: '删除供应商', exact: true }).click()
    await dialog.getByRole('button', { name: '确认删除供应商' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('button', { name: /旅程测试网关/u })).toHaveCount(0)
    expect((await settings(request)).providers.some((entry) => entry.provider === provider)).toBe(false)
    await page.reload()
    await expect(page.getByRole('heading', { name: '供应商配置', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: /旅程测试网关/u })).toHaveCount(0)
    expect(failures).toEqual([])
  })
}

test('built-in removal blocks references, requires a fresh preview after conflict, and keeps its catalog entry', async ({
  page,
  request,
}) => {
  const failures: string[] = []
  page.on('pageerror', (error) => failures.push(error.message))
  await saveProvider(request, 'deepseek', false)
  const before = await settings(request)
  const model = before.providers.find((entry) => entry.provider === 'deepseek')!.models[0]!.id
  const created = await request.post('/api/agents', {
    data: { displayName: '供应商引用测试智能体', persona: '', model: { provider: 'deepseek', model } },
  })
  expect(created.ok(), await created.text()).toBe(true)
  const agent = HostApiContracts.createAgent.parseResponse(await created.json())
  try {
    await page.addInitScript(() => localStorage.setItem('nekro-nxt.theme', 'dark'))
    await page.goto('/settings')
    const providerButton = page.getByRole('button', { name: /DeepSeek 通用接入/u })
    await providerButton.click()
    await page.screenshot({ animations: 'disabled', path: '.local/provider-settings-heading.png' })
    await page.getByRole('button', { name: '移除配置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '检查供应商移除影响' })
    await expect(dialog).toContainText('供应商引用测试智能体')
    await expect(dialog.getByRole('button', { name: '确认移除配置' })).toBeDisabled()
    await page.screenshot({ animations: 'disabled', path: '.local/provider-removal-blocked.png' })
    const snapshot = HostApiContracts.snapshot.parseResponse(await (await request.get('/api/snapshot')).json())
    const revision = snapshot.agents.find((entry) => entry.id === agent.agentId)!.currentRevisionId
    const removedAgent = await request.delete(`/api/agents/${agent.agentId}`, {
      data: { expectedCurrentRevisionId: revision, confirmationName: '供应商引用测试智能体' },
    })
    expect(removedAgent.ok(), await removedAgent.text()).toBe(true)
    await dialog.getByRole('button', { name: '重新检查影响' }).click()
    await expect(dialog.getByRole('button', { name: '确认移除配置' })).toBeEnabled()
    const current = await settings(request)
    const changed = await request.post('/api/llm/providers/deepseek', {
      data: {
        expectedRevision: current.providers.find((entry) => entry.provider === 'deepseek')!.settingsRevision,
        baseURL: 'https://changed.example.test/v1',
      },
    })
    expect(changed.ok()).toBe(true)
    await dialog.getByRole('button', { name: '确认移除配置' }).click()
    await expect(dialog.getByRole('alert')).toContainText('供应商配置已变化')
    await expect(dialog.getByRole('button', { name: '确认移除配置' })).toBeDisabled()
    await dialog.getByRole('button', { name: '重新检查影响' }).click()
    await expect(dialog.getByRole('button', { name: '确认移除配置' })).toBeEnabled()
    await dialog.getByRole('button', { name: '确认移除配置' }).click()
    await expect(dialog).toBeHidden()
    await expect(providerButton).toHaveCount(0)
    expect((await settings(request)).providers.find((entry) => entry.provider === 'deepseek')).toMatchObject({
      configured: false,
      active: false,
    })
    await page.getByRole('button', { name: /DeepSeek 内置固定接入/u }).click()
    await page.getByRole('button', { name: '移除配置', exact: true }).click()
    await expect(dialog).toContainText('宿主固定装载')
    await expect(dialog.getByRole('button', { name: '确认移除配置' })).toBeDisabled()
    expect(failures).toEqual([])
  } finally {
    const snapshot = HostApiContracts.snapshot.parseResponse(await (await request.get('/api/snapshot')).json())
    const remaining = snapshot.agents.find((entry) => entry.id === agent.agentId)
    if (remaining)
      await request.delete(`/api/agents/${agent.agentId}`, {
        data: { expectedCurrentRevisionId: remaining.currentRevisionId, confirmationName: remaining.displayName },
      })
  }
})

for (const failReconciliation of [false, true]) {
  test(`reconciles a committed removal after losing its response (initial read fails: ${failReconciliation})`, async ({
    page,
    request,
  }) => {
    const provider = `journey-removal-unknown-${failReconciliation ? 'retry' : 'read'}`
    await saveProvider(request, provider, true)
    let committed = false
    let failedRead = false
    let deletes = 0
    await page.route(`**/api/llm/providers/${provider}`, async (route) => {
      if (route.request().method() !== 'DELETE') return route.continue()
      deletes += 1
      const result = await route.fetch()
      expect(result.ok(), await result.text()).toBe(true)
      committed = true
      await route.abort('failed')
    })
    await page.route('**/api/llm/providers', async (route) => {
      if (committed && failReconciliation && !failedRead) {
        failedRead = true
        await route.fulfill({
          status: 503,
          json: { error: { code: 'synthetic-read-failure', message: 'synthetic read failure' } },
        })
        return
      }
      await route.continue()
    })
    await page.goto('/settings')
    await page.getByRole('button', { name: /旅程测试网关/u }).click()
    await page.getByRole('button', { name: '删除供应商', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '检查供应商移除影响' })
    await dialog.getByRole('button', { name: '确认删除供应商' }).click()
    if (failReconciliation) {
      await expect(dialog.getByRole('alert')).toContainText('未能确认供应商是否已移除')
      await expect(dialog.getByRole('button', { name: '确认移除配置' })).toBeDisabled()
      await dialog.getByRole('button', { name: '重新检查影响' }).click()
    }
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('button', { name: /旅程测试网关/u })).toHaveCount(0)
    expect((await settings(request)).providers.some((entry) => entry.provider === provider)).toBe(false)
    expect(deletes).toBe(1)
  })
}
