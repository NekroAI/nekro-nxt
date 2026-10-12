import { HostApiContracts } from '@nekro-nxt/contracts'
import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark'] as const) {
  test(`forwarded images and fallback details remain usable in the ${theme} production conversation`, async ({
    page,
    request,
  }, testInfo) => {
    const failures: string[] = []
    const truncated = theme === 'dark'
    const summary = `合并转发消息（2 个节点${truncated ? '，部分内容未展开' : ''}）。`
    page.on('pageerror', (error) => failures.push(error.message))
    await page.setViewportSize({ width: theme === 'light' ? 1440 : 1100, height: 900 })
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
    await page.addInitScript((value) => localStorage.setItem('nekro-nxt.theme', value), theme)
    const created = await request.post('/api/channels', { data: { displayName: '转发图片验收' } })
    expect(created.ok()).toBe(true)
    const { channelId } = HostApiContracts.createInternalChannel.response.parse(await created.json())
    expect(
      (
        await request.post(`/api/channels/${channelId}/messages`, {
          data: {
            clientEventId: `fixture-forward-${theme}`,
            parts: [{ type: 'text', text: '虚构转发记录' }],
          },
        })
      ).ok(),
    ).toBe(true)

    // Adapter-owned inbound facts; WebSocket parsing and channel asset occurrences are covered in runtime.spec.ts.
    await page.route(`**/api/channels/${channelId}/messages**`, async (route) => {
      const response = await route.fetch()
      const body = HostApiContracts.listChannelMessages.response.parse(await response.json())
      await route.fulfill({
        json: {
          ...body,
          messages: body.messages.map((message) => ({
            ...message,
            parts: [
              {
                type: 'rich',
                adapterKey: 'onebot-11',
                kind: 'forward',
                summary,
                extension: {
                  truncated,
                  items: [
                    { sender: '虚构成员甲', text: '这里是转发图片与表情。' },
                    { sender: '虚构成员甲', imageAssetId: 'ast_forwardImage', imageName: '转发图片' },
                    { sender: '虚构成员甲', text: '表情（编号 14）' },
                    { sender: '虚构成员甲', text: '文件：资料.txt（未展开）' },
                    { text: '嵌套合并转发：' },
                    { sender: '虚构成员乙', text: '嵌套正文' },
                    { sender: '虚构成员乙', imageAssetId: 'ast_forwardSticker', imageName: '表情图片' },
                  ],
                },
              },
            ],
          })),
        },
      })
    })
    await page.route(`**/api/channels/${channelId}/assets/ast_forward*`, (route) =>
      route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="96" viewBox="0 0 240 96"><rect width="240" height="96" rx="12" fill="#256d85"/><circle cx="65" cy="48" r="28" fill="#f5d38a"/><path d="M120 68L153 24L189 68Z" fill="#d8eaf0"/></svg>',
      }),
    )
    await page.goto(`/channels/${channelId}`)
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await expect(page.getByText(summary, { exact: true })).toBeVisible()
    await expect(page.getByText('聊天记录 · 7 条', { exact: true })).toHaveCount(0)
    await expect(page.getByText('文件：资料.txt（未展开）', { exact: true })).toBeVisible()
    await expect(page.getByText('嵌套正文', { exact: true })).toBeVisible()
    const picture = page.getByRole('img', { name: '转发图片', exact: true })
    await expect(picture).toBeVisible()
    await expect(page.getByRole('img', { name: '表情图片', exact: true })).toBeVisible()
    await expect
      .poll(() =>
        picture.evaluate((image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0),
      )
      .toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`forward-${theme}.png`), animations: 'disabled' })
    await picture.click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page.getByRole('dialog').getByRole('link', { name: '下载' })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath(`preview-${theme}.png`), animations: 'disabled' })
    await page.getByRole('button', { name: '关闭预览' }).click()
    await page.reload()
    await expect(page.getByText('嵌套正文', { exact: true })).toBeVisible()
    expect(failures).toEqual([])
  })
}
