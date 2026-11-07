import { expect, test } from '@playwright/test'
import { HostApiContracts } from '@nekro-nxt/contracts'
import { productSnapshot, targetAgentId, targetChannelId } from './fixtures/product-quality.js'
import { installSnapshotHealthRoutes } from './fixtures/host-release.js'
import { installWorkspaceRoutes } from './fixtures/workspace.js'

const snapshot = HostApiContracts.snapshot.parseResponse(productSnapshot)
const channelName = '资料员的内置频道'

for (const width of [375, 1440]) {
  test(`彻底清除 shows what it deletes, waits out running work and asks for the channel name (${width}px)`, async ({
    page,
  }, testInfo) => {
    const failures: string[] = []
    page.on('pageerror', (error) => failures.push(error.message))
    const purges: unknown[] = []
    let blocked = true
    await installSnapshotHealthRoutes(page, snapshot)
    await installWorkspaceRoutes(page, () => snapshot)
    await page.route('**/api/snapshot', (route) => route.fulfill({ json: snapshot }))
    await page.route(`**/api/channels/${targetChannelId}/history-purge`, (route) => {
      if (route.request().method() === 'GET') {
        return route.fulfill({
          json: HostApiContracts.previewChannelHistoryPurge.response.parse({
            messages: 428,
            conversations: 6,
            attachments: 17,
            ...(blocked ? { blockedReason: '还有消息正在发送，发完后再清除。' } : {}),
          }),
        })
      }
      purges.push(HostApiContracts.purgeChannelHistory.request.parse(route.request().postDataJSON()))
      return route.fulfill({ json: { messages: 428, conversations: 6, attachments: 15 } })
    })
    await page.setViewportSize({ width, height: 900 })
    await page.goto(`/channels/${targetChannelId}`)
    const toggle = page.getByRole('button', { name: '频道信息' })
    await expect(toggle).toBeVisible()
    if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click()
    const inspector = page.getByRole('complementary', { name: '频道信息' })
    await expect(inspector).toBeVisible()

    const row = inspector.getByText('删除全部聊天记录，智能体也查不到；频道和绑定保留。')
    await row.scrollIntoViewIfNeeded()
    await expect(row).toBeVisible()
    await expect(inspector.getByText('聊天记录保留；要连记录一起删，先彻底清除。')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath(`danger-zone-${width}.png`), animations: 'disabled' })

    await inspector.getByRole('button', { name: '清除', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: `彻底清除「${channelName}」的聊天记录？` })
    await expect(dialog.getByText('还有消息正在发送，发完后再清除。')).toBeVisible()
    await expect(dialog.getByRole('button', { name: '彻底清除', exact: true })).toBeDisabled()
    await expect(dialog.getByLabel(`输入“${channelName}”确认`)).toHaveCount(0)
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await expect(dialog).toHaveCount(0)

    blocked = false
    await inspector.getByRole('button', { name: '清除', exact: true }).click()
    await expect(dialog).toContainText('消息428 条')
    await expect(dialog).toContainText('对话6 段')
    await expect(dialog).toContainText('附件17 个')
    const confirm = dialog.getByRole('button', { name: '彻底清除', exact: true })
    const name = dialog.getByLabel(`输入“${channelName}”确认`)
    await name.fill('别的名字')
    await expect(confirm).toBeDisabled()
    await name.fill(channelName)
    await expect(confirm).toBeEnabled()
    await page.screenshot({ path: testInfo.outputPath(`confirm-${width}.png`), animations: 'disabled' })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await confirm.click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByText('已删除 428 条消息', { exact: true })).toBeVisible()
    expect(purges).toEqual([{ expectedBoundAgentId: targetAgentId }])
    expect(failures).toEqual([])
  })
}
