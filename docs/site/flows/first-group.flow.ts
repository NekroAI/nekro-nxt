// 开始使用 → 把她拉进第一个群: the QQ official bot form, then an account that has found a group and the wiring dialog.
// No real QQ: the account is a local synthetic OneBot peer, which the wiring board shows the same way.
import { createOneBotProtocolFixture } from '../../../packages/adapter-onebot-11/tests/protocol-fixture.js'
import { HostApiContracts } from '@nekro-nxt/contracts'
import { createAgent, expect, test } from './kit.js'

test('first-group', async ({ page, request, docs }) => {
  await createAgent(request, '小奈', '你是小奈，说话简短自然。')

  await page.goto('/wiring')
  await page.getByRole('button', { name: '添加平台账号' }).click()
  await page.getByRole('region', { name: '选择平台' }).getByRole('button', { name: /^QQ 官方机器人/u }).click()
  await page.getByLabel('名称', { exact: true }).fill('小奈的 QQ 机器人')
  await page.getByLabel(/^App ID/u).fill('102000000')
  await page.getByLabel(/^Client Secret/u).fill('fictional-client-secret')
  await docs.shot('first-group-qq-form', [
    page.getByRole('heading', { name: /QQ 官方机器人/u }).first(),
    page.getByRole('button', { name: '添加账号' }),
  ])

  const protocol = await createOneBotProtocolFixture()
  try {
    const created = await request.post('/api/connections', {
      data: {
        adapterKey: 'onebot-11',
        alias: '小奈的 QQ 机器人',
        configuration: { endpoint: protocol.endpoint },
        credentials: {},
      },
    })
    expect(created.ok()).toBe(true)
    const { connectionId } = HostApiContracts.createConnection.response.parse(await created.json())
    const snapshot = async () =>
      HostApiContracts.snapshot.parseResponse(await (await request.get('/api/snapshot')).json())
    await expect
      .poll(async () => (await snapshot()).connections.find((item) => item.id === connectionId)?.status.state)
      .toBe('connected')

    await page.goto(`/wiring/connections/${connectionId}`)
    await expect(page.getByText('还没有发现频道。从平台发一条消息后会出现在这里。')).toBeVisible()
    await docs.see()
    protocol.emit('20001', '示例群')
    await expect(page.getByText('示例群', { exact: true }).first()).toBeVisible()
    await docs.shot('first-group-account')

    await page.goto('/wiring')
    await expect(page.getByText('示例群', { exact: true }).first()).toBeVisible()

    await page.getByText('示例群', { exact: true }).first().click()
    await page.getByRole('combobox', { name: '示例群 的响应智能体' }).click()
    await page.getByRole('option', { name: /小奈/u }).first().click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('button', { name: '接线', exact: true })).toBeVisible()
    await docs.shot('first-group-bind', dialog)
    await dialog.getByRole('button', { name: '接线', exact: true }).click()
    await expect(page.getByText('何时回复', { exact: true })).toBeVisible()
    await docs.shot('first-group-wired')

    await page.getByRole('button', { name: '打开频道' }).click()
    await expect(page.getByRole('button', { name: '透视' })).toBeVisible()
    await docs.see()
  } finally {
    await protocol.stop()
  }
})
