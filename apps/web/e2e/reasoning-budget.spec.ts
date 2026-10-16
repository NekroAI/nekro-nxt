import { AxeBuilder } from '@axe-core/playwright'
import { HostApiContracts } from '@nekro-nxt/contracts'
import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark']) {
  test(`${theme}: provider default and independent Chat budgets survive reload, reset and failed saves`, async ({
    page,
    request,
  }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })
    const agents: string[] = []
    const provider = 'deepseek-official'
    const providers = async () =>
      HostApiContracts.llmProviders.parseResponse(await (await request.get('/api/llm/providers')).json())
    const initial = (await providers()).providers.find((entry) => entry.provider === provider)!
    const model = initial.models[0]!.id
    const originalEffort = initial.reasoning?.defaultEffort ?? null
    try {
      await page.addInitScript((choice) => localStorage.setItem('nekro-nxt.theme', choice), theme)
      await page.goto(`/settings/models?provider=${provider}`)
      const select = page.getByRole('combobox', { name: '默认思考预算', exact: true })
      await select.click()
      await page.getByRole('option', { name: '高', exact: true }).click()
      await page.getByRole('button', { name: '保存供应商', exact: true }).click()
      await expect
        .poll(
          async () =>
            (await providers()).providers.find((entry) => entry.provider === provider)?.reasoning?.defaultEffort,
        )
        .toBe('high')
      await page.screenshot({
        path: testInfo.outputPath(`provider-${theme}.png`),
        fullPage: true,
        animations: 'disabled',
      })
      const channels: string[] = []
      for (const label of ['甲', '乙']) {
        const response = await request.post('/api/agents', {
          data: { displayName: `虚构预算智能体${label}`, persona: '', model: { provider, model } },
        })
        expect(response.ok(), await response.text()).toBe(true)
        const created = HostApiContracts.createAgent.parseResponse(await response.json())
        agents.push(created.agentId)
        channels.push(created.channelId)
      }
      const read = async (id: string) =>
        HostApiContracts.getChannelReasoning.parseResponse(
          await (await request.get(`/api/channels/${id}/reasoning`)).json(),
        )
      const first = channels[0]!
      await page.goto(`/channels/${first}`)
      await page.getByRole('button', { name: '思考预算：高', exact: true }).click()
      const slider = page.getByRole('slider', { name: '思考预算', exact: true })
      await expect(slider).toBeVisible()
      await expect(slider).toBeEnabled()
      const bounds = await slider.boundingBox()
      if (!bounds) throw new Error('Budget slider is not visible')
      await page.mouse.click(bounds.x + bounds.width / 3, bounds.y + bounds.height / 2)
      await expect.poll(async () => (await read(first)).effort).toBe('low')
      await expect(slider).toBeEnabled()
      await slider.focus()
      await slider.press('End')
      await expect.poll(async () => (await read(first)).effort).toBe('max')
      await expect(slider).toHaveAttribute('aria-valuetext', 'Ultra')
      await page.screenshot({ path: testInfo.outputPath(`chat-ultra-${theme}.png`), animations: 'disabled' })
      const accessibility = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze()
      expect(accessibility.violations.filter((issue) => ['critical', 'serious'].includes(issue.impact ?? ''))).toEqual(
        [],
      )
      await page.reload()
      await expect(page.getByRole('button', { name: '思考预算：Ultra', exact: true })).toBeVisible()
      await page.goto(`/channels/${channels[1]}`)
      await expect(page.getByRole('button', { name: '思考预算：高', exact: true })).toBeVisible()
      await page.goto(`/channels/${first}`)
      await page.getByRole('button', { name: '思考预算：Ultra', exact: true }).click()
      await page.getByRole('button', { name: '恢复默认思考预算', exact: true }).click()
      await expect.poll(async () => (await read(first)).effort).toBe(null)
      await expect(slider).toHaveAttribute('aria-valuetext', '高')
      await expect(slider).toBeEnabled()
      await page.route(`**/api/channels/${first}/reasoning`, async (route) => {
        if (route.request().method() === 'PUT')
          await route.fulfill({
            status: 409,
            json: { error: { code: 'reasoning-conflict', message: '思考预算已改变，请刷新后重试。' } },
          })
        else await route.continue()
      })
      await slider.press('End')
      await expect(page.getByText('思考预算已改变，请刷新后重试。', { exact: true })).toBeVisible()
      await expect(slider).toHaveAttribute('aria-valuetext', '高')
      expect((await read(first)).effort).toBe(null)
      await page.unrouteAll({ behavior: 'wait' })
      await page.getByRole('button', { name: '关闭详情', exact: true }).click()
      await page.getByRole('button', { name: '思考预算：高', exact: true }).click()
      await expect(slider).toBeVisible()
      await page.setViewportSize({ width: 390, height: 844 })
      await page.screenshot({ path: testInfo.outputPath(`chat-narrow-${theme}.png`), animations: 'disabled' })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      // The intentionally failed PUT is a handled network error.
      expect(errors.filter((message) => !message.includes('409'))).toEqual([])
    } finally {
      await page.unrouteAll({ behavior: 'wait' })
      await page.goto('about:blank')
      const snapshot = HostApiContracts.snapshot.parseResponse(await (await request.get('/api/snapshot')).json())
      for (const id of agents) {
        const agent = snapshot.agents.find((entry) => entry.id === id)
        if (agent)
          expect(
            (
              await request.delete(`/api/agents/${id}`, {
                data: {
                  expectedCurrentRevisionId: agent.currentRevisionId,
                  confirmationName: agent.displayName,
                  deleteAutoCreatedBuiltInChannels: true,
                },
              })
            ).ok(),
          ).toBe(true)
      }
      const current = (await providers()).providers.find((entry) => entry.provider === provider)!
      expect(
        (
          await request.post(`/api/llm/providers/${provider}`, {
            data: { expectedRevision: current.settingsRevision, reasoningEffort: originalEffort },
          })
        ).ok(),
      ).toBe(true)
    }
  })
}
