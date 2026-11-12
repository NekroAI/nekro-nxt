// 扩展: what a fresh instance shows without the community — dynamic creation settings, the workshop, adding an MCP
// service, DSH plugins and add-ons.
import { createAgent, expect, test } from './kit.js'

test('extensions', async ({ page, request, docs }) => {
  const agentId = await createAgent(request, '小奈', '你是小奈，说话简短自然。')
  const text = (value: string) => page.getByText(value, { exact: true }).filter({ visible: true }).first()

  await page.goto(`/agents/${agentId}`)
  await page.getByRole('switch', { name: '动态创造' }).click()
  await page.getByText('管理员确认', { exact: true }).click()
  await expect(text('谁可以让它改配置')).toBeVisible()
  await docs.shot('extensions-autonomy', [text('动态创造'), page.getByRole('switch', { name: '动态创造' }), text('谁可以让它改配置')])
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeHidden()

  await page.goto('/workshop')
  await expect(text('让智能体为你做新能力')).toBeVisible()
  await docs.shot('extensions-workshop', [text('让智能体为你做新能力'), text('可以创造的智能体'), page.getByRole('button', { name: '导入扩展' }).last()])

  await page.getByRole('button', { name: '添加 MCP 服务' }).first().click()
  const mcp = page.getByRole('dialog')
  await expect(mcp).toBeVisible()
  await mcp.getByLabel('名称').fill('团队知识库')
  await mcp.getByLabel('地址').fill('https://mcp.example.com/mcp')
  await docs.shot('extensions-mcp', mcp)
  await mcp.getByText('本机程序', { exact: true }).click()
  await docs.see()
  await page.keyboard.press('Escape')

  await page.goto('/workshop/updates')
  await expect(text('还没有和社区同步的扩展')).toBeVisible()
  await docs.see()

  await page.goto('/settings/dsh')
  await expect(page.getByRole('button', { name: '安装插件' })).toBeVisible()
  await docs.shot('extensions-dsh', [page.getByRole('heading', { level: 1 }), text('DeepSeek 网页搜索')])
  await page.getByRole('button', { name: '安装插件' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await docs.see()
  await page.keyboard.press('Escape')

  await page.goto('/settings/addons')
  await expect(text('语音识别')).toBeVisible()
  await docs.shot('extensions-addons', page.locator('main'))
  await page.goto('/settings/addons/speech')
  await expect(text('云端设置')).toBeVisible()
  await docs.shot('extensions-speech', [page.getByRole('heading', { name: '语音识别', level: 2 }), page.getByRole('region', { name: '云端设置' })])
})
