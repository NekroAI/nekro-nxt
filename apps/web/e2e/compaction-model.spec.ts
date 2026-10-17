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
    const model = page.getByRole('combobox', { name: '开新会话时的压缩模型', exact: true })
    await expect(model).toHaveText('跟随智能体的主模型')
    await expect(page.getByRole('combobox', { name: '压缩最多等待', exact: true })).toHaveText('3 分钟')
    await model.click()
    await page.getByRole('option', { name: '测试供应商 · 纯文本模型', exact: true }).click()
    await expect
      .poll(() => saved.at(-1))
      .toEqual({
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
