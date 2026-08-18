import { expect, test, type Page } from '@playwright/test'

const installRuntimeFailureGate = (page: Page): string[] => {
  const failures: string[] = []
  page.on('pageerror', (error) => failures.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(`console.error: ${message.text()}`)
  })
  return failures
}

test('production bundle keeps every primary route usable without runtime errors', async ({ page }) => {
  const failures = installRuntimeFailureGate(page)
  const routes = [
    ['/', '智能体'],
    ['/agents', '智能体'],
    ['/channels', '按智能体查看'],
    ['/connections', '连接'],
    ['/extensions', '扩展'],
    ['/creator', '创造'],
    ['/runtime', '运行'],
    ['/settings', '设置'],
  ] as const

  for (const [route, visibleText] of routes) {
    await page.goto(route)
    await expect(page.getByText(visibleText, { exact: true }).first()).toBeVisible()
    await expect(page.locator('#root')).not.toBeEmpty()
  }

  expect(failures, failures.join('\n')).toEqual([])
})

test('settings exposes the provider editor and survives real navigation', async ({ page }) => {
  const failures = installRuntimeFailureGate(page)
  await page.goto('/settings')

  await expect(page.getByRole('heading', { name: '模型供应商' })).toBeVisible()
  await page.getByRole('button', { name: /DeepSeek/u }).click()
  await expect(page.getByLabel('API 密钥')).toHaveAttribute('type', 'password')
  await expect(page.getByText(/不会.*回显/u)).toBeVisible()

  await page.getByRole('link', { name: '智能体' }).click()
  await expect(page.getByRole('heading', { name: '智能体', exact: true })).toBeVisible()
  await page.getByRole('link', { name: '设置' }).click()
  await expect(page.getByRole('heading', { name: '模型供应商' })).toBeVisible()

  expect(failures, failures.join('\n')).toEqual([])
})

test('settings saves a built-in provider credential without exposing it again', async ({ page }) => {
  const failures = installRuntimeFailureGate(page)
  await page.goto('/settings')

  await page.getByRole('button', { name: /DeepSeek/u }).click()
  const apiKey = page.getByLabel('API 密钥')
  await apiKey.fill('playwright-write-only-test-key')
  await page.getByRole('button', { name: '保存供应商', exact: true }).click()
  await expect(page.getByText('供应商配置已保存。API 密钥只写入本机凭据存储。', { exact: true })).toBeVisible()
  await expect(apiKey).toHaveValue('')

  await page.reload()
  await page.getByRole('button', { name: /DeepSeek/u }).click()
  await expect(page.getByText('API 密钥已保存', { exact: true })).toBeVisible()
  await expect(page.getByLabel('API 密钥')).toHaveValue('')
  expect(failures, failures.join('\n')).toEqual([])
})

test('adding a connection selects a platform before showing its fields', async ({ page }) => {
  const failures = installRuntimeFailureGate(page)
  await page.goto('/connections')

  await page
    .getByRole('button', { name: /网页聊天/u })
    .first()
    .click()
  await expect(page.getByText('网页聊天由当前设备管理，不需要配置账号凭据。')).toBeVisible()
  await expect(page.getByLabel('Client Secret')).toHaveCount(0)

  await page.getByRole('button', { name: '添加连接' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: '选择平台' })).toBeVisible()
  await expect(dialog.getByText('选择要连接的平台账号。')).toBeVisible()
  await dialog.getByLabel('平台').click()
  await expect(page.getByRole('option', { name: 'QQ 官方机器人' })).toBeVisible()
  await page.getByRole('option', { name: 'QQ 官方机器人' }).click()
  await expect(dialog.getByLabel('App ID')).toHaveCount(0)

  await dialog.getByRole('button', { name: '继续配置' }).click()
  await expect(dialog.getByRole('heading', { name: '配置QQ 官方机器人' })).toBeVisible()
  await expect(dialog.getByLabel('App ID')).toBeVisible()
  await expect(dialog.getByLabel('Client Secret')).toHaveAttribute('type', 'password')
  await expect(dialog.getByText('使用 Markdown')).toBeVisible()
  await expect(dialog.getByLabel('平台')).toHaveCount(0)
  expect(failures, failures.join('\n')).toEqual([])
})

test("an intelligent-agent can add another channel while replacing that channel's previous agent", async ({
  page,
  request,
}) => {
  const failures = installRuntimeFailureGate(page)
  const createAgent = async (displayName: string): Promise<{ agentId: string; channelId: string }> => {
    const response = await request.post('/api/agents', {
      data: {
        displayName,
        persona: '',
        model: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      },
    })
    expect(response.status()).toBe(201)
    return response.json() as Promise<{ agentId: string; channelId: string }>
  }
  const runId = Date.now().toString(36)
  const sourceName = `绑定来源-${runId}`
  const source = await createAgent(sourceName)
  const target = await createAgent(`绑定目标-${runId}`)

  await page.goto(`/agents/${target.agentId}`)
  await page.getByRole('tab', { name: '频道' }).click()
  await page.getByRole('button', { name: '绑定频道' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: '新增频道绑定' })).toBeVisible()
  await dialog.getByLabel('频道').click()
  await page.getByRole('option', { name: `网页聊天 · ${sourceName} 的网页频道`, exact: true }).click()
  await dialog.getByLabel('响应方式').click()
  await page.getByRole('option', { name: '仅观察' }).click()
  await dialog.getByRole('button', { name: '绑定频道' }).click()

  await expect(page.getByText('频道已绑定。')).toBeVisible()
  await expect(page.getByText(`${sourceName} 的网页频道`, { exact: true })).toBeVisible()
  const snapshot = (await (await request.get('/api/snapshot')).json()) as {
    agents: Array<{ id: string; channels: string[] }>
    channels: Array<{ id: string; bindings: Array<{ agentId: string; triggerPolicy: string }> }>
  }
  expect(snapshot.agents.find((agent) => agent.id === target.agentId)?.channels).toEqual(
    expect.arrayContaining([target.channelId, source.channelId]),
  )
  expect(snapshot.channels.find((channel) => channel.id === target.channelId)?.bindings).toEqual([
    expect.objectContaining({ agentId: target.agentId }),
  ])
  expect(snapshot.channels.find((channel) => channel.id === source.channelId)?.bindings).toEqual([
    expect.objectContaining({ agentId: target.agentId, triggerPolicy: 'observe-only' }),
  ])
  expect(failures, failures.join('\n')).toEqual([])
})
