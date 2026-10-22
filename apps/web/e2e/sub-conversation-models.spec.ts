import { expect, test } from '@playwright/test'
import { HostApiContracts } from '@nekro-nxt/contracts'
import { productSnapshot, targetAgentId } from './fixtures/product-quality.js'
import { installSnapshotHealthRoutes } from './fixtures/host-release.js'
import { installWorkspaceRoutes } from './fixtures/workspace.js'

const withSubConversations = (enabled: boolean) =>
  HostApiContracts.snapshot.parseResponse({
    ...productSnapshot,
    agents: productSnapshot.agents.map((agent) =>
      agent.id === targetAgentId ? { ...agent, capabilities: { ...agent.capabilities, subagents: enabled } } : agent,
    ),
  })

for (const width of [375, 1440]) {
  test(`an agent offers its sub-conversations a cheaper model with what it is for (${width}px)`, async ({ page }) => {
    const snapshot = withSubConversations(true)
    await installSnapshotHealthRoutes(page, snapshot)
    await installWorkspaceRoutes(page, () => snapshot)
    await page.route('**/api/snapshot', (route) => route.fulfill({ json: snapshot }))
    const failures: string[] = []
    page.on('pageerror', (error) => failures.push(error.message))
    await page.setViewportSize({ width, height: 900 })
    let revised: unknown
    await page.route('**/api/agents/*/revision', async (route) => {
      revised = route.request().postDataJSON()
      await route.fulfill({ json: { currentRevisionId: 'arev_revisedsubmodels' } })
    })

    await page.goto(`/agents/${targetAgentId}`)
    await expect(page.getByText('子对话都用主模型')).toBeVisible()
    await page.getByRole('button', { name: '添加', exact: true }).click()
    const name = page.getByRole('textbox', { name: '模型 1的名称', exact: true })
    await name.fill('快速')
    await page.getByRole('combobox', { name: '快速的模型', exact: true }).click()
    await page.getByRole('option', { name: '测试供应商 · 纯文本模型', exact: true }).click()
    await page.getByRole('textbox', { name: '快速的用途', exact: true }).fill('适合翻聊天记录、整理资料')
    await page.getByRole('combobox', { name: '不指定时的子对话模型', exact: true }).click()
    await page.getByRole('option', { name: '快速', exact: true }).click()
    await page.screenshot({
      path: `.local/sub-conversation-models-${width}.png`,
      animations: 'disabled',
      fullPage: true,
    })
    await page
      .getByText('1 项未保存的修改')
      .locator('xpath=../..')
      .getByRole('button', { name: '保存', exact: true })
      .click()
    await expect
      .poll(() => revised)
      .toMatchObject({
        subConversationModels: {
          candidates: [
            {
              name: '快速',
              model: { provider: 'test-provider', model: 'text-model' },
              guidance: '适合翻聊天记录、整理资料',
            },
          ],
          default: '快速',
        },
      })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    expect(failures).toEqual([])
  })
}

test('sub-conversation models wait until sub-conversations are on', async ({ page }) => {
  const snapshot = withSubConversations(false)
  await installSnapshotHealthRoutes(page, snapshot)
  await installWorkspaceRoutes(page, () => snapshot)
  await page.route('**/api/snapshot', (route) => route.fulfill({ json: snapshot }))
  await page.goto(`/agents/${targetAgentId}`)
  await expect(page.getByText('先在「能力」中开启子对话')).toBeVisible()
  await expect(page.getByRole('button', { name: '添加', exact: true })).toBeDisabled()
})
