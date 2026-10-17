import { HostApiContracts } from '@nekro-nxt/contracts'
import { expect, test } from '@playwright/test'
import { answering } from './fixtures/route.js'

for (const theme of ['light', 'dark'] as const) {
  for (const width of [1440, 390]) {
    test(`QQ quote preview stays distinct from current text at ${width}px in ${theme}`, async ({
      page,
      request,
    }, testInfo) => {
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
      await page.addInitScript((value) => localStorage.setItem('nekro-nxt.theme', value), theme)
      const created = await request.post('/api/channels', { data: { displayName: '引用预览验收' } })
      expect(created.ok()).toBe(true)
      const { channelId } = HostApiContracts.createInternalChannel.response.parse(await created.json())
      expect(
        (
          await request.post(`/api/channels/${channelId}/messages`, {
            data: {
              clientEventId: `fixture-quote-${theme}-${width}`,
              parts: [{ type: 'text', text: '虚构引用样本' }],
            },
          })
        ).ok(),
      ).toBe(true)
      // Adapter decoding, scoped indexes and SQLite facts are covered by the QQ integration tests.
      await page.route(
        `**/api/channels/${channelId}/messages**`,
        answering(async (route) => {
          const response = await route.fetch()
          const body = HostApiContracts.listChannelMessages.response.parse(await response.json())
          await route.fulfill({
            json: {
              ...body,
              messages: body.messages.map((message) => ({
                ...message,
                parts: [
                  { type: 'text', text: '当前消息：请查看这条引用。' },
                  {
                    type: 'rich',
                    adapterKey: 'qq-openclaw',
                    kind: 'quote-preview',
                    title: '引用消息',
                    summary: '原消息未记录，以下为平台提供的引用预览。',
                    extension: {
                      items: [
                        { sender: '虚构成员甲', text: '这是被引用的正文，与当前发言分开显示。' },
                        {
                          card: {
                            kind: 'card',
                            title: '虚构资料卡片',
                            summary: '虚构资料',
                            targetUrl: 'https://example.test/quote',
                          },
                        },
                        { fileAssetId: 'ast_quoteText', fileName: '引用资料.txt', fileMediaType: 'text/plain' },
                      ],
                    },
                  },
                ],
              })),
            },
          })
        }),
      )
      await page.route(`**/api/channels/${channelId}/assets/ast_quoteText`, (route) =>
        route.fulfill({
          contentType: 'text/plain; charset=utf-8',
          body: '引用附件中的虚构内容。',
        }),
      )
      await page.goto(`/channels/${channelId}`)
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
      await expect(page.locator('h1').filter({ hasText: '引用预览验收' })).toHaveCSS(
        'color',
        theme === 'dark' ? 'rgb(238, 242, 248)' : 'rgb(20, 36, 61)',
      )
      await expect(page.getByText('当前消息：请查看这条引用。', { exact: true })).toBeVisible()
      await expect(page.getByText('原消息未记录，以下为平台提供的引用预览。', { exact: true })).toBeVisible()
      await expect(page.getByText('这是被引用的正文，与当前发言分开显示。', { exact: true })).toBeVisible()
      await expect(page.getByRole('link', { name: '打开卡片：虚构资料卡片' })).toHaveAttribute(
        'href',
        'https://example.test/quote',
      )
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await page.screenshot({ path: testInfo.outputPath(`quote-${theme}-${width}.png`), animations: 'disabled' })
      await page.getByRole('button', { name: '引用资料.txt', exact: true }).click()
      await expect(page.getByRole('dialog').getByText('引用附件中的虚构内容。', { exact: true })).toBeVisible()
      await page.getByRole('button', { name: '关闭预览' }).click()
      await page.reload()
      await expect(page.getByText('引用消息', { exact: true })).toBeVisible()
      expect(errors).toEqual([])
    })
  }
}
