import { HostApiContracts } from '@nekro-nxt/contracts'
import { expect, test } from '@playwright/test'

test('unavailable forwarded content renders as a rich notice in the production conversation', async ({
  page,
  request,
}) => {
  const failures: string[] = []
  page.on('pageerror', (error) => failures.push(error.message))
  const created = await request.post('/api/channels', { data: { displayName: '转发提示验收' } })
  expect(created.ok()).toBe(true)
  const { channelId } = HostApiContracts.createInternalChannel.response.parse(await created.json())
  const sent = await request.post(`/api/channels/${channelId}/messages`, {
    data: {
      clientEventId: 'fixture-unavailable-forward',
      parts: [{ type: 'text', text: '虚构转发记录' }],
    },
  })
  expect(sent.ok()).toBe(true)
  // Rich parts are adapter-owned inbound facts, not accepted by the administrator's send endpoint.
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
              adapterKey: 'qq-openclaw',
              kind: 'forward',
              summary: '转发的聊天记录（内容不可读取）',
              title: '转发的聊天记录',
            },
          ],
        })),
      },
    })
  })
  await page.goto(`/channels/${channelId}`)
  await expect(page.getByText('转发的聊天记录（内容不可读取）', { exact: true })).toBeVisible()
  await expect(page.getByText('你的QQ暂不支持查看[转发多条消息]，请期待后续版本。', { exact: true })).toHaveCount(0)
  expect(failures).toEqual([])
})
