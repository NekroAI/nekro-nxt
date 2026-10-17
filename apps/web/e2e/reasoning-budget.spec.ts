import { AxeBuilder } from '@axe-core/playwright'
import { HostApiContracts } from '@nekro-nxt/contracts'
import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { writeFile } from 'node:fs/promises'

/** Capture real pixels alongside geometry; the saved frames are reviewed as a contact sheet. */
const recordDrag = async (page: Page, info: TestInfo, beforeRelease: () => Promise<void>) => {
  const slider = page.getByRole('slider', { name: '思考预算', exact: true })
  const control = slider.locator('..')
  const rail = await control.locator('[data-part="rail"]').boundingBox()
  const thumb = await control.locator('[data-part="thumb"]').boundingBox()
  const bounds = await slider.boundingBox()
  if (!rail || !thumb || !bounds) throw new Error('Budget slider geometry is unavailable')
  expect(thumb.height).toBeGreaterThan(rail.height)
  const cdp = await page.context().newCDPSession(page)
  const frames: { data: string; at: number }[] = []
  let capturing = true
  let acknowledgementError: unknown
  const onFrame = (frame: { data: string; sessionId: number }) => {
    if (!capturing) return
    frames.push({ data: frame.data, at: Date.now() })
    void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch((error: unknown) => {
      if (capturing) acknowledgementError = error
    })
  }
  cdp.on('Page.screencastFrame', onFrame)
  await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 })
  const samples = slider.evaluate(async (input) => {
    const control = input.parentElement!
    const read = () => {
      const thumb = control.querySelector('[data-part="thumb"]')!.getBoundingClientRect()
      const fillEdge = control.querySelector('[data-part="fill"]')!.getBoundingClientRect().right
      return {
        thumb: control.querySelector('[data-part="thumb"]')!.getBoundingClientRect().x,
        attached: fillEdge >= thumb.x - 2 && fillEdge <= thumb.right + 2,
        color: getComputedStyle(control.querySelector('[data-part="ultra"]')!).transform,
        particle: new DOMMatrix(getComputedStyle(control.querySelector('[data-part="particles"] i')!).transform).m41,
        labelOpacity: getComputedStyle(document.querySelector('[aria-label="思考预算"] strong') ?? control).opacity,
      }
    }
    const frames: ReturnType<typeof read>[] = []
    const started = performance.now()
    await new Promise<void>((resolve, reject) => {
      const sample = () => {
        try {
          frames.push(read())
          if (performance.now() - started < 850) requestAnimationFrame(sample)
          else resolve()
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      }
      requestAnimationFrame(sample)
    })
    return frames
  })
  try {
    await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2)
    await page.mouse.down()
    await page.mouse.move(bounds.x + bounds.width + 30, bounds.y + bounds.height / 2, { steps: 12 })
    await beforeRelease()
    await page.mouse.up()
    const observed = await samples
    expect(new Set(observed.map((frame) => frame.thumb)).size).toBeGreaterThan(3)
    expect(new Set(observed.map((frame) => frame.color)).size).toBeGreaterThan(3)
    expect(new Set(observed.map((frame) => frame.particle)).size).toBeGreaterThan(3)
    expect(observed.some((frame, index) => index > 0 && frame.particle < observed[index - 1]!.particle)).toBe(true)
    expect(observed.every((frame) => frame.labelOpacity === '1')).toBe(true)
    expect(observed.every((frame) => frame.attached)).toBe(true)
  } finally {
    capturing = false
    cdp.off('Page.screencastFrame', onFrame)
    await cdp.send('Page.stopScreencast')
    await cdp.detach()
    await Promise.all(
      frames.map((frame, index) =>
        writeFile(info.outputPath(`motion-${String(index).padStart(3, '0')}.png`), Buffer.from(frame.data, 'base64')),
      ),
    )
    await writeFile(
      info.outputPath('motion-frames.json'),
      JSON.stringify(frames.map(({ at }, index) => ({ index, at }))),
    )
  }
  expect(acknowledgementError).toBeUndefined()
}

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
      const savedBeforeDrag = (await read(first)).revision
      let dragCommits = 0
      const countCommit = (request: { method(): string; url(): string }) => {
        if (request.method() === 'PUT' && request.url().endsWith(`/api/channels/${first}/reasoning`)) dragCommits++
      }
      page.on('request', countCommit)
      await recordDrag(page, testInfo, async () => {
        expect((await read(first)).revision).toBe(savedBeforeDrag)
        expect(dragCommits).toBe(0)
      })
      await expect.poll(async () => (await read(first)).effort).toBe('max')
      expect(dragCommits).toBe(1)
      page.off('request', countCommit)
      await expect(slider).toHaveAttribute('aria-valuetext', 'Ultra')
      expect(
        await page
          .getByRole('dialog', { name: '思考预算', exact: true })
          .evaluate((panel) => panel.scrollWidth <= panel.clientWidth),
      ).toBe(true)
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
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await expect(slider).toBeEnabled()
      await slider.press('End')
      await expect.poll(async () => (await read(first)).effort).toBe('max')
      const particles = slider.locator('..').locator('[data-part="particles"]')
      await expect(particles).toBeHidden()
      await page.getByRole('button', { name: '恢复默认思考预算', exact: true }).click()
      await expect.poll(async () => (await read(first)).effort).toBe(null)
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      await page.addInitScript(() => localStorage.setItem('nekro-nxt.reduced-motion', 'true'))
      await page.reload()
      await page.getByRole('button', { name: '思考预算：高', exact: true }).click()
      await expect(slider).toBeEnabled()
      await slider.press('End')
      await expect.poll(async () => (await read(first)).effort).toBe('max')
      await expect(particles).toBeHidden()
      await page.getByRole('button', { name: '恢复默认思考预算', exact: true }).click()
      await expect.poll(async () => (await read(first)).effort).toBe(null)
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
