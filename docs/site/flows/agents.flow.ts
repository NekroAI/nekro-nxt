// 智能体 and 模型 → 选模型: one agent with a reply in its built-in channel, then its profile sections and the channel's
// information panel.
import { HostApiContracts } from '@nekro-nxt/contracts'
import { createAgent, expect, test } from './kit.js'

test.use({ modelReplies: ['好的青青，记住了。'] })

test('agents', async ({ page, request, docs }) => {
  const agentId = await createAgent(request, '小奈', '你是小奈，说话简短自然，在群里陪大家聊天、帮忙查东西。')
  const snapshot = HostApiContracts.snapshot.parseResponse(await (await request.get('/api/snapshot')).json())
  const channel = snapshot.channels.find((item) => item.displayName === '小奈 的内置频道')
  if (channel === undefined) throw new Error('没有找到内置频道')
  const text = (value: string) => page.getByText(value, { exact: true }).filter({ visible: true }).first()

  // The profile, section by section.
  await page.goto(`/agents/${agentId}`)
  const section = (name: string) => page.getByRole('region', { name, exact: true })
  const heading = (name: string) => section(name).getByRole('heading', { name, exact: true })
  await expect(page.getByRole('combobox', { name: '主模型' })).toBeVisible()
  await docs.shot('agents-model', [heading('模型'), page.getByRole('combobox', { name: '开新会话时压缩' })])
  await docs.shot('agents-sub-models', [
    page.getByRole('button', { name: '说明：子对话模型' }),
    text('子对话都用主模型'),
    page.getByRole('button', { name: '添加子对话模型' }),
  ])
  await docs.shot('agents-abilities', [heading('能力'), page.getByRole('button', { name: '手动调整' })])
  await docs.shot('agents-capability-switches', [
    text('子对话'),
    page.getByRole('switch', { name: '子对话' }),
    page.getByRole('switch', { name: '动态创造' }),
  ])
  await docs.shot('agents-schedules', section('定时任务'))
  await docs.shot('agents-persona', [heading('设定'), text('响应方式是智能响应时，消息里提到名称或这些别名也会叫醒它')])

  // The channel's information panel after one exchange.
  await page.goto(`/channels/${channel.id}`)
  await page.getByLabel('消息', { exact: true }).fill('我叫阿青，以后叫我青青就好')
  await page.keyboard.press('Enter')
  await expect(page.getByText('好的青青，记住了。').last()).toBeVisible({ timeout: 30_000 })
  await expect(text('当前会话')).toBeVisible()
  await docs.shot('agents-memory', [text('记忆'), text('读取与整理'), page.getByRole('button', { name: '压缩' })])

  await page.getByRole('button', { name: /读取与整理/u }).click()
  await expect(page.getByRole('combobox', { name: '未读消息上限' })).toBeVisible()
  await docs.shot('agents-reading', [
    page.getByRole('button', { name: /读取与整理/u }),
    page.getByRole('combobox', { name: '静默后整理' }),
  ])

  await docs.shot('agents-danger', [text('危险操作'), text('删除频道'), page.getByRole('button', { name: '删除' })])

  await page.getByRole('button', { name: '查看', exact: true }).click()
  const context = page.getByRole('dialog')
  await expect(context).toBeVisible()
  await docs.shot('agents-context-view', context)
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: '添加', exact: true }).first().click()
  const notes = page.getByRole('dialog')
  await expect(notes.getByRole('textbox', { name: '智能体笔记' })).toBeVisible()
  await docs.shot('agents-channel-notes', notes)
  await page.keyboard.press('Escape')

  for (const settings of ['/settings/models', '/settings/chat']) {
    await page.goto(settings)
    await expect(page.locator('main')).toContainText('设置')
    await page.waitForLoadState('networkidle')
    await docs.see()
  }

  await page.goto('/settings/conversations')
  await docs.shot('agents-retention', [text('结束后保留'), text('一直保留')])
})
