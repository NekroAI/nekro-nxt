// 运维 → 凭据与关联账号, 通知, 存储与清理: the settings pages as a fresh instance shows them.
import { expect, test } from './kit.js'

test('ops', async ({ page, docs }) => {
  const text = (value: string) => page.getByText(value, { exact: true }).filter({ visible: true }).first()

  await page.goto('/settings/credentials')
  await page.getByRole('button', { name: '添加凭据' }).first().click()
  const credential = page.getByRole('dialog')
  await expect(credential).toBeVisible()
  await credential.getByLabel('名称').fill('天气服务')
  await docs.shot('ops-credential-add', credential)
  await credential.getByRole('radio', { name: '允许程序读取' }).click()
  await docs.see()
  await page.keyboard.press('Escape')

  await page.goto('/settings/accounts')
  await expect(page.getByRole('button', { name: '关联账号' }).first()).toBeVisible()
  await page.getByRole('button', { name: '关联账号' }).first().click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await docs.shot('ops-linked-account', page.getByRole('dialog'))
  await page.keyboard.press('Escape')

  await page.goto('/settings/notifications')
  await expect(text('Bark')).toBeVisible()
  await docs.shot('ops-notifications', [page.getByRole('heading', { level: 1 }), text('扩展通知')])
  await page.getByRole('switch', { name: 'Bark' }).click()
  await expect(page.getByLabel('Device Key')).toBeVisible()
  await docs.see()

  await page.goto('/settings/storage')
  await expect(text('升级前备份')).toBeVisible()
  await docs.shot('ops-storage', [page.getByRole('heading', { level: 1 }), text('扩展下载上限')], { padding: 32 })

  await page.goto('/settings/logs')
  await expect(text('保留时间')).toBeVisible()
  await docs.see()
})
