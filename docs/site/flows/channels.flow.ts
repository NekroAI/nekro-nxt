// 频道与平台 → 触发与回复节奏, 管理员与聊天命令: a group on a synthetic OneBot account, answered by an agent on 智能响应.
import { createOneBotProtocolFixture } from '../../../packages/adapter-onebot-11/tests/protocol-fixture.js'
import { HostApiContracts } from '@nekro-nxt/contracts'
import { createAgent, expect, test } from './kit.js'

test('channels', async ({ page, request, docs }) => {
  const agentId = await createAgent(request, '小奈', '你是小奈，说话简短自然。')
  const protocol = await createOneBotProtocolFixture()
  try {
    const created = await request.post('/api/connections', {
      data: { adapterKey: 'onebot-11', alias: '小奈的 QQ', configuration: { endpoint: protocol.endpoint }, credentials: {} },
    })
    expect(created.ok()).toBe(true)
    const { connectionId } = HostApiContracts.createConnection.response.parse(await created.json())
    const snapshot = async () =>
      HostApiContracts.snapshot.parseResponse(await (await request.get('/api/snapshot')).json())
    await expect
      .poll(async () => (await snapshot()).connections.find((item) => item.id === connectionId)?.status.state)
      .toBe('connected')
    protocol.emit('20001', '示例群')
    await expect
      .poll(async () => (await snapshot()).channels.find((item) => item.connectionId === connectionId)?.id)
      .toBeDefined()
    const channel = (await snapshot()).channels.find((item) => item.connectionId === connectionId)!
    const bound = await request.post('/api/bindings', {
      data: { channelId: channel.id, agentId, triggerPolicy: 'smart' },
    })
    expect(bound.ok()).toBe(true)
    const text = (value: string) => page.getByText(value, { exact: true }).filter({ visible: true }).first()

    await page.goto(`/channels/${channel.id}`)
    const trigger = page.getByRole('combobox', { name: '示例群 的触发方式' })
    await expect(trigger).toBeVisible()
    await docs.shot('channels-who', [page.getByRole('heading', { name: '谁来回复' }), trigger, text('暂停回应')])

    await trigger.click()
    await expect(page.getByRole('option', { name: /仅观察/u })).toBeVisible()
    await docs.shot('channels-triggers', page.getByRole('listbox'))
    await page.keyboard.press('Escape')

    await page.getByRole('button', { name: '展开回复细节' }).click()
    await expect(page.getByRole('switch', { name: '提到名字时' })).toBeVisible()
    await docs.shot('channels-timing', [text('回复细节'), page.getByRole('button', { name: '收起回复细节' }), text('最多合并')])
    await docs.see()

    await docs.shot('channels-command-members', [
      page.getByRole('heading', { name: '命令授权成员' }),
      page.getByRole('button', { name: '添加成员' }),
    ])

    await page.goto(`/agents/${agentId}`)
    await expect(page.getByRole('textbox', { name: '别名', exact: true })).toBeVisible()
    await docs.see()

    await page.goto('/settings/chat')
    await docs.shot('channels-pacing', [text('连发间隔'), page.getByRole('radio', { name: '长' })])

    await page.goto('/settings/administrators')
    await expect(page.getByRole('button', { name: '生成认领码' })).toBeVisible()
    await docs.shot('channels-admins', [
      page.getByRole('heading', { level: 1 }),
      page.getByRole('button', { name: '添加管理员' }),
      text('还没有平台账号管理员'),
    ])
    await page.getByRole('button', { name: '添加管理员' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await docs.see()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: '生成认领码' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await docs.see()
    await page.keyboard.press('Escape')

    await page.goto('/settings/commands')
    await expect(text('/status')).toBeVisible()
    await docs.shot('channels-commands', [text('聊天命令'), text('/stop')])
  } finally {
    await protocol.stop()
  }
})
