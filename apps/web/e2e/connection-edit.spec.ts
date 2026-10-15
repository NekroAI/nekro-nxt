import { HostApiContracts } from '@nekro-nxt/contracts'
import { expect, test } from '@playwright/test'
import { createOneBotProtocolFixture } from '../../../packages/adapter-onebot-11/tests/protocol-fixture.js'

for (const theme of ['light', 'dark'] as const) {
  test(`mobile accounts can be created and edited without losing history in ${theme}`, async ({
    page,
    request,
  }, testInfo) => {
    const first = await createOneBotProtocolFixture()
    const second = await createOneBotProtocolFixture()
    const different = await createOneBotProtocolFixture({ accountId: '92999' })
    let id: string | undefined
    const alias = `虚构连接编辑${theme}`
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const snapshot = async () =>
      HostApiContracts.snapshot.parseResponse(await (await request.get('/api/snapshot')).json())
    const connection = async () => (await snapshot()).connections.find((item) => item.id === id)
    const edit = async () => {
      await page.getByRole('button', { name: '编辑连接设置', exact: true }).click()
      await expect(page.getByRole('heading', { name: '编辑连接设置', exact: true })).toBeVisible()
    }
    try {
      await page.setViewportSize({ width: theme === 'light' ? 390 : 844, height: theme === 'light' ? 844 : 390 })
      await page.addInitScript((value) => localStorage.setItem('nekro-nxt.theme', value), theme)
      await page.goto('/wiring')
      await page.getByRole('button', { name: '添加平台账号', exact: true }).click()
      await page
        .getByRole('region', { name: '选择平台' })
        .getByRole('button', { name: /^OneBot 11/u })
        .click()
      await page.getByLabel('名称', { exact: true }).fill(alias)
      await page.getByLabel(/^WebSocket Endpoint/u).fill(first.endpoint)
      await page.getByLabel('Access Token', { exact: true }).fill('fictional-original')
      await page.getByRole('button', { name: '添加账号', exact: true }).click()
      await expect
        .poll(async () => (await snapshot()).connections.find((item) => item.alias === alias)?.status.state)
        .toBe('connected')
      id = (await snapshot()).connections.find((item) => item.alias === alias)!.id
      await expect(page.getByRole('button', { name: '返回接线列表' })).toBeVisible()
      first.emit(`synthetic-edit-${theme}`, '虚构历史频道')
      await expect
        .poll(async () => (await snapshot()).channels.filter((item) => item.connectionId === id).length)
        .toBe(1)
      const channelId = (await snapshot()).channels.find((item) => item.connectionId === id)!.id
      const history = HostApiContracts.listChannelMessages.parseResponse(
        await (await request.get(`/api/channels/${channelId}/messages`)).json(),
      )
      await edit()
      await expect(page.getByLabel('Access Token操作')).toContainText('保留原值')
      await expect(page.locator('input[type="password"]')).toHaveCount(0)
      await page.getByLabel(/^WebSocket Endpoint/u).fill(second.endpoint)
      await page.getByRole('button', { name: '保存设置', exact: true }).click()
      await expect.poll(() => second.authorizations.at(-1)).toBe('Bearer fictional-original')
      await expect.poll(async () => (await connection())?.status.state).toBe('connected')
      await edit()
      await page.getByLabel('Access Token操作').click()
      await page.getByRole('option', { name: '重新填写', exact: true }).click()
      await page.getByLabel('新的Access Token', { exact: true }).fill('fictional-updated')
      await page.getByRole('button', { name: '保存设置', exact: true }).click()
      await expect.poll(() => second.authorizations.at(-1)).toBe('Bearer fictional-updated')
      expect(JSON.stringify(await connection())).not.toContain('fictional-updated')
      expect((await connection())?.configuredSecrets).toEqual(['accessToken'])
      await edit()
      await page.getByLabel(/^WebSocket Endpoint/u).fill(different.endpoint)
      await page.getByRole('button', { name: '保存设置', exact: true }).click()
      await expect.poll(async () => (await connection())?.status.state).toBe('failed')
      await expect(page.getByText(/连接到了另一个账号/u).first()).toBeVisible()
      await page.screenshot({ path: testInfo.outputPath(`connection-error-${theme}.png`), animations: 'disabled' })
      await edit()
      await page.getByLabel(/^WebSocket Endpoint/u).fill(second.endpoint)
      await page.getByLabel('Access Token操作').click()
      await page.getByRole('option', { name: '清除', exact: true }).click()
      await expect(page.getByRole('link', { name: /服务状态/u })).toBeInViewport({ ratio: 1 })
      await page.screenshot({ path: testInfo.outputPath(`connection-edit-${theme}.png`), animations: 'disabled' })
      const handshakesBeforeClear = second.authorizations.length
      await page.getByRole('button', { name: '保存设置', exact: true }).click()
      // A previous connected snapshot can arrive before this save completes; wait for its new handshake first.
      await expect.poll(() => second.authorizations.length).toBeGreaterThan(handshakesBeforeClear)
      await expect.poll(() => second.authorizations.at(-1)).toBeUndefined()
      await expect.poll(async () => (await connection())?.status.state).toBe('connected')
      expect((await connection())?.configuredSecrets).toEqual([])
      expect((await snapshot()).channels.find((item) => item.connectionId === id)?.id).toBe(channelId)
      // The workspace event cursor advances when connections change; message facts stay the same.
      const after = HostApiContracts.listChannelMessages.parseResponse(
        await (await request.get(`/api/channels/${channelId}/messages`)).json(),
      )
      expect(after.messages).toEqual(history.messages)
      expect(after.hasMore).toBe(history.hasMore)
      await page.getByRole('button', { name: '返回接线列表' }).click()
      await expect(
        page.getByRole('region', { name: '平台账号', exact: true }).getByRole('button', { name: alias, exact: true }),
      ).toBeVisible()
      await page
        .getByRole('region', { name: '平台账号', exact: true })
        .getByRole('button', { name: alias, exact: true })
        .click()
      await expect(page.getByRole('button', { name: '编辑连接设置' })).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      const removed = id
      expect((await request.delete(`/api/connections/${removed}`, { data: { deleteChannelData: true } })).ok()).toBe(
        true,
      )
      id = undefined
      await page.goto(`/wiring/connections/${removed}`)
      await expect(page.getByRole('button', { name: '添加平台账号', exact: true })).toBeVisible()
      expect(errors).toEqual([])
    } finally {
      try {
        await page.goto('about:blank')
        id ??= (await snapshot()).connections.find((item) => item.alias === alias)?.id
        if (id)
          expect((await request.delete(`/api/connections/${id}`, { data: { deleteChannelData: true } })).ok()).toBe(
            true,
          )
      } finally {
        await Promise.all([first.stop(), second.stop(), different.stop()])
      }
    }
  })
}
