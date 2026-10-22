import { expect, test } from '@playwright/test'
import { HostApiContracts } from '@nekro-nxt/contracts'
import { productSnapshot, targetAgentId, targetChannelId } from './fixtures/product-quality.js'
import { installSnapshotHealthRoutes } from './fixtures/host-release.js'
import { installWorkspaceRoutes } from './fixtures/workspace.js'

const snapshot = HostApiContracts.snapshot.parseResponse(productSnapshot)

test.beforeEach(async ({ page }) => {
  await installSnapshotHealthRoutes(page, snapshot)
  await installWorkspaceRoutes(page, () => snapshot)
  await page.route('**/api/snapshot', (route) => route.fulfill({ json: snapshot }))
})

for (const width of [375, 1440]) {
  test(`an agent lists fallback models for when its main model fails (${width}px)`, async ({ page }) => {
    const failures: string[] = []
    page.on('pageerror', (error) => failures.push(error.message))
    await page.setViewportSize({ width, height: 900 })
    let revised: unknown
    await page.route('**/api/agents/*/revision', async (route) => {
      revised = route.request().postDataJSON()
      await route.fulfill({ json: { currentRevisionId: 'arev_revisedfallback' } })
    })

    await page.goto(`/agents/${targetAgentId}`)
    await expect(page.getByText('主模型出错时照常报错')).toBeVisible()
    await page.getByRole('button', { name: '添加备用模型', exact: true }).click()
    await page.getByRole('combobox', { name: '备用 1的模型', exact: true }).click()
    await page.getByRole('option', { name: '测试供应商 · 纯文本模型', exact: true }).click()
    // The main model reads images and this one cannot.
    await expect(page.getByText('它看不了图片')).toBeVisible()
    await page.screenshot({ path: `.local/fallback-models-${width}.png`, animations: 'disabled' })
    await page
      .getByText('1 项未保存的修改')
      .locator('xpath=../..')
      .getByRole('button', { name: '保存', exact: true })
      .click()
    await expect
      .poll(() => revised)
      .toMatchObject({ fallbackModels: [{ provider: 'test-provider', model: 'text-model' }] })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    expect(failures).toEqual([])
  })
}

test('settings choose how long a failed model is passed over', async ({ page }) => {
  const saved: unknown[] = []
  await page.route('**/api/settings/model-fallback', async (route) => {
    if (route.request().method() === 'PUT') {
      const body: unknown = route.request().postDataJSON()
      saved.push(body)
      await route.fulfill({ json: body })
      return
    }
    await route.fulfill({ json: { unavailableCooldownMinutes: 10, quotaCooldownMinutes: 60 } })
  })
  await page.goto('/settings/models')
  const unavailable = page.getByRole('combobox', { name: '限流或出错后多久再试主模型', exact: true })
  await expect(unavailable).toHaveText('10 分钟')
  await expect(page.getByRole('combobox', { name: '额度用完后多久再试主模型', exact: true })).toHaveText('1 小时')
  await unavailable.click()
  await page.getByRole('option', { name: '30 分钟', exact: true }).click()
  await expect.poll(() => saved.at(-1)).toEqual({ unavailableCooldownMinutes: 30, quotaCooldownMinutes: 60 })
  await page.screenshot({ path: '.local/fallback-settings.png', animations: 'disabled', fullPage: true })
})

test('the conversation shows when it runs on a fallback model and why', async ({ page }) => {
  await page.route('**/api/channels/*/runtime', (route) =>
    route.fulfill({
      json: {
        cursor: { epoch: 'fixture', sequence: 0 },
        channelId: targetChannelId,
        agentId: targetAgentId,
        phase: 'idle',
        summary: '智能体当前空闲。',
        pendingInjectCount: 0,
        turns: [],
        modelFallback: {
          model: { provider: 'test-provider', model: 'text-model' },
          reason: 'quota',
          since: Date.now() - 60_000,
          retryMainAt: Date.now() - 1000,
        },
      },
    }),
  )
  await page.goto(`/channels/${targetChannelId}`)
  const chip = page.getByText('备用模型', { exact: true })
  await expect(chip).toBeVisible()
  await chip.hover()
  await expect(page.getByRole('tooltip')).toContainText('主模型额度用完，正在用「纯文本模型」；收到新消息时换回主模型')
  await page.screenshot({ path: '.local/fallback-chip.png', animations: 'disabled' })
})
