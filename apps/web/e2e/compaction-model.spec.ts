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
  test(`settings choose the new-session compaction model and how long to wait (${width}px)`, async ({ page }) => {
    const failures: string[] = []
    page.on('pageerror', (error) => failures.push(error.message))
    await page.setViewportSize({ width, height: 900 })
    await page.route('**/api/settings/message-pacing', (route) => route.fulfill({ json: { pacing: 'normal' } }))
    const saved: unknown[] = []
    await page.route('**/api/settings/compaction', async (route) => {
      if (route.request().method() === 'PUT') {
        const body: unknown = route.request().postDataJSON()
        saved.push(body)
        await route.fulfill({ json: body })
        return
      }
      await route.fulfill({ json: { newSessionModel: { mode: 'main' }, timeoutSeconds: 180 } })
    })

    await page.goto('/settings/chat')
    await expect(page.getByRole('spinbutton', { name: '闲置压缩阈值（%）' })).toHaveValue('50')
    await expect(page.getByText('建议 30%–60%。数值越高，闲置后越少触发压缩。')).toBeVisible()
    const model = page.getByRole('combobox', { name: '开新会话时的压缩模型', exact: true })
    await expect(model).toHaveText('跟随智能体的主模型')
    await expect(page.getByRole('combobox', { name: '压缩最多等待', exact: true })).toHaveText('3 分钟')
    await model.click()
    await page.getByRole('option', { name: '测试供应商 · 纯文本模型', exact: true }).click()
    await expect
      .poll(() => saved.at(-1))
      .toEqual({
        idleThresholdPercent: 50,
        newSessionModel: { mode: 'custom', model: { provider: 'test-provider', model: 'text-model' } },
        timeoutSeconds: 180,
      })
    await page.getByRole('combobox', { name: '压缩最多等待', exact: true }).click()
    await page.getByRole('option', { name: '5 分钟', exact: true }).click()
    await expect.poll(() => saved.at(-1)).toMatchObject({ timeoutSeconds: 300 })
    await page.screenshot({ path: `.local/compaction-settings-${width}.png`, animations: 'disabled' })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    expect(failures).toEqual([])
  })

  test(`an agent can pick its own models for both compactions (${width}px)`, async ({ page }) => {
    const failures: string[] = []
    page.on('pageerror', (error) => failures.push(error.message))
    await page.setViewportSize({ width, height: 900 })
    let revised: unknown
    await page.route('**/api/agents/*/revision', async (route) => {
      revised = route.request().postDataJSON()
      await route.fulfill({ json: { currentRevisionId: 'arev_revisedcompact' } })
    })

    await page.goto(`/agents/${targetAgentId}`)
    const inSession = page.getByRole('combobox', { name: '会话内压缩', exact: true })
    const newSession = page.getByRole('combobox', { name: '开新会话时压缩', exact: true })
    await expect(inSession).toHaveText('跟随主模型')
    await expect(newSession).toHaveText('跟随默认（设置 → 聊天）')
    // Only a different model or thinking level costs the cache.
    await expect(page.getByText('和主模型或思考强度不同时，用不上模型的缓存。')).toHaveCount(0)
    await inSession.click()
    await page.getByRole('option', { name: 'DeepSeek · DeepSeek V4 Flash', exact: true }).click()
    await expect(page.getByText('和主模型或思考强度不同时，用不上模型的缓存。')).toHaveCount(0)
    await inSession.click()
    await page.getByRole('option', { name: '测试供应商 · 纯文本模型', exact: true }).click()
    await expect(page.getByText('和主模型或思考强度不同时，用不上模型的缓存。')).toBeVisible()
    await newSession.click()
    await page.getByRole('option', { name: '测试供应商 · 纯文本模型', exact: true }).click()
    await page.screenshot({ path: `.local/compaction-agent-${width}.png`, animations: 'disabled' })
    await page
      .getByText('1 项未保存的修改')
      .locator('xpath=../..')
      .getByRole('button', { name: '保存', exact: true })
      .click()
    await expect
      .poll(() => revised)
      .toMatchObject({
        compaction: {
          inSession: { mode: 'custom', model: { provider: 'test-provider', model: 'text-model' } },
          newSession: { mode: 'custom', model: { provider: 'test-provider', model: 'text-model' } },
        },
      })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    expect(failures).toEqual([])
  })
}

test('idle threshold persists through the real API, validates input and recovers from a failed save', async ({
  page,
  request,
}) => {
  // Real mutations must use the server's release identity rather than the synthetic snapshot's.
  await page.unroute('**/api/snapshot')
  await page.unroute('**/health/live')
  await page.unroute('**/health/ready')
  const failures: string[] = []
  page.on('pageerror', (error) => failures.push(error.message))
  const endpoint = '/api/settings/compaction'
  const original = HostApiContracts.getCompactionSettings.parseResponse(await (await request.get(endpoint)).json())
  try {
    await page.goto('/settings/chat')
    const threshold = page.getByRole('spinbutton', { name: '闲置压缩阈值（%）' })
    await expect(threshold).toHaveValue(String(original.idleThresholdPercent))
    const next = original.idleThresholdPercent === 60 ? 40 : 60
    await threshold.fill(String(next))
    const saved = page.waitForResponse(
      (response) => response.url().endsWith(endpoint) && response.request().method() === 'PUT',
    )
    await threshold.press('Enter')
    expect((await saved).ok()).toBe(true)
    await expect(threshold).toBeEnabled()
    expect(await (await request.get(endpoint)).json()).toEqual({ ...original, idleThresholdPercent: next })
    await page.reload()
    await expect(threshold).toHaveValue(String(next))

    const puts: unknown[] = []
    page.on('request', (req) => {
      if (req.url().endsWith(endpoint) && req.method() === 'PUT') puts.push(req.postDataJSON())
    })
    for (const invalid of ['', '0', '101', '49.5']) {
      await threshold.fill(invalid)
      await threshold.press('Enter')
      await expect(threshold).toHaveValue(String(next))
    }
    expect(puts).toHaveLength(0)

    let release: () => void = () => undefined
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route('**/api/settings/compaction', async (route) => {
      if (route.request().method() !== 'PUT') return route.continue()
      await pending
      await route.fulfill({ status: 503, json: { error: { code: 'test-save-failed', message: '测试保存失败' } } })
    })
    await threshold.fill('70')
    await threshold.press('Enter')
    await expect(threshold).toBeDisabled()
    await expect(page.getByRole('combobox', { name: '开新会话时的压缩模型', exact: true })).toBeDisabled()
    release()
    await expect(threshold).toBeEnabled()
    await expect(threshold).toHaveValue(String(next))
    expect(puts).toHaveLength(1)
    expect(await (await request.get(endpoint)).json()).toEqual({ ...original, idleThresholdPercent: next })
    expect(failures).toEqual([])
  } finally {
    expect((await request.put(endpoint, { data: original })).ok()).toBe(true)
  }
})

test('the conversation says when the agent is compacting before a new session', async ({ page }) => {
  await page.route('**/api/channels/*/runtime', (route) =>
    route.fulfill({
      json: {
        cursor: { epoch: 'fixture', sequence: 0 },
        channelId: targetChannelId,
        agentId: targetAgentId,
        phase: 'compacting',
        summary: '正在压缩上一段对话。',
        pendingInjectCount: 0,
        turns: [],
        compaction: { kind: 'new-session', startedAt: Date.now() - 12_000 },
      },
    }),
  )
  await page.goto(`/channels/${targetChannelId}`)
  await expect(page.getByText('正在压缩上一段对话，完成后开始新会话')).toBeVisible()
})
