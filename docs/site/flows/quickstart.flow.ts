// 开始使用 → 快速开始: a blank instance, the built-in DeepSeek key, the first agent and its first reply.
import { expect, test } from './kit.js'

test.use({ modelReplies: ['你好！我是小奈，平时在群里陪大家聊天、帮忙查东西。有什么想聊的，直接在这里说就好。'] })

test('quickstart', async ({ page, docs }) => {
  await page.goto('/')
  await expect(page.getByRole('button', { name: '创建智能体' })).toBeVisible()
  await docs.shot('quickstart-welcome')

  await page.getByRole('link', { name: '设置' }).click()
  await page.getByRole('link', { name: '模型', exact: true }).click()
  await page.getByText('DeepSeek', { exact: true }).first().click()
  await page.getByLabel('API 密钥', { exact: true }).fill('sk-docs-example')
  await docs.shot('quickstart-model-key', [
    page.getByText('全部供应商', { exact: true }),
    page.getByRole('button', { name: '添加模型' }),
    page.getByRole('button', { name: '保存供应商' }),
  ])
  await page.getByRole('button', { name: '保存供应商' }).click()
  await expect(page.getByText('API 密钥已保存', { exact: true })).toBeVisible()

  await page.getByRole('link', { name: '概览' }).click()
  await page.getByRole('button', { name: '创建智能体' }).click()
  await page.getByLabel('名称', { exact: true }).fill('小奈')
  await docs.shot('quickstart-new-agent', [
    page.getByRole('button', { name: '模型', exact: true }).filter({ visible: true }).first(),
    page.getByLabel('名称', { exact: true }),
    page.getByRole('button', { name: '创建并开始对话' }),
  ])
  await page.getByRole('button', { name: '设定', exact: true }).click()
  await page.getByRole('textbox', { name: '设定' }).fill('你是小奈，说话简短自然，在群里陪大家聊天、帮忙查东西。')
  await docs.see()
  await page.getByRole('button', { name: '创建并开始对话' }).click()

  await page.getByLabel('消息', { exact: true }).fill('你好，介绍一下你自己')
  await page.keyboard.press('Enter')
  const reply = page.getByText('你好！我是小奈', { exact: false }).last()
  await expect(reply).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('空闲', { exact: true }).first()).toBeVisible()
  await docs.shot('quickstart-first-reply', [
    page.getByRole('heading', { name: '小奈 的内置频道' }).filter({ visible: true }).first(),
    page.getByRole('button', { name: '透视' }),
    page.getByText('你好，介绍一下你自己', { exact: true }).last(),
    reply,
    page.getByLabel('消息', { exact: true }),
    page.getByRole('button', { name: '透视' }).locator('xpath=following-sibling::*[1]'),
  ])

  await page.getByRole('button', { name: '透视' }).click()
  await docs.see()
  await page.getByRole('link', { name: '接线' }).click()
  await expect(page.getByRole('button', { name: /添加/u }).first()).toBeVisible()
  await docs.shot('quickstart-wiring', [
    page.getByRole('button', { name: '添加平台账号' }),
    page.getByText('平台账号', { exact: true }).filter({ visible: true }),
    page.getByText('小奈 的内置频道', { exact: true }).filter({ visible: true }),
  ])
})
