import { expect, test } from '@playwright/test'
import { HostApiContracts } from '@nekro-nxt/contracts'
import { productSnapshot, targetAgentId } from './fixtures/product-quality.js'
import { installSnapshotHealthRoutes } from './fixtures/host-release.js'
import { installWorkspaceRoutes } from './fixtures/workspace.js'

for (const width of [375, 1440]) {
  test(`the agent's thinking level is a stepped slider over the levels its model offers (${width}px)`, async ({
    page,
  }) => {
    const failures: string[] = []
    page.on('pageerror', (error) => failures.push(error.message))
    await page.setViewportSize({ width, height: 900 })
    const snapshot = HostApiContracts.snapshot.parseResponse({
      ...productSnapshot,
      models: productSnapshot.models.map((model) =>
        model.id === 'deepseek-v4-flash'
          ? {
              ...model,
              reasoning: {
                efforts: [
                  { id: 'low', name: 'Low' },
                  { id: 'medium', name: 'Medium' },
                  { id: 'high', name: 'High' },
                  { id: 'max', name: 'Max' },
                ],
                defaultEffort: 'medium',
              },
            }
          : model,
      ),
    })
    await installSnapshotHealthRoutes(page, snapshot)
    await installWorkspaceRoutes(page, () => snapshot)
    await page.route('**/api/snapshot', (route) => route.fulfill({ json: snapshot }))
    let revised: unknown
    await page.route('**/api/agents/*/revision', async (route) => {
      revised = route.request().postDataJSON()
      await route.fulfill({ json: { currentRevisionId: 'arev_revisedeffort' } })
    })

    await page.goto(`/agents/${targetAgentId}`)
    const scale = page.getByRole('slider', { name: '思考强度' })
    await expect(scale).toBeVisible()
    // Unset means the model's own default, which the scale names.
    await expect(scale).toHaveAttribute('aria-valuetext', '默认')
    await expect(page.getByText('使用模型的默认强度（中）')).toBeVisible()
    await scale.focus()
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await expect(scale).toHaveAttribute('aria-valuetext', '高')
    await expect(page.getByText('复杂问题想得更深')).toBeVisible()
    // End reaches the deepest level; a label selects directly.
    await page.keyboard.press('End')
    await expect(scale).toHaveAttribute('aria-valuetext', '最高')
    await page.getByRole('button', { name: '高', exact: true }).click()
    await expect(scale).toHaveAttribute('aria-valuetext', '高')
    await page.screenshot({ path: `.local/agent-effort-${width}.png`, animations: 'disabled' })
    // The save bar collects the change with the other unsaved fields.
    await page
      .getByText('1 项未保存的修改')
      .locator('xpath=../..')
      .getByRole('button', { name: '保存', exact: true })
      .click()
    await expect.poll(() => revised).toMatchObject({ model: { reasoningEffort: 'high' } })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    expect(failures).toEqual([])
  })
}
