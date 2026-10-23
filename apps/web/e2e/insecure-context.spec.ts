import { expect, test } from '@playwright/test'
import { productSnapshot, targetAgentId } from './fixtures/product-quality.js'
import { installSnapshotHealthRoutes } from './fixtures/host-release.js'
import { installWorkspaceRoutes } from './fixtures/workspace.js'

test('a WebUI opened over plain HTTP on a LAN address works without crypto.randomUUID', async ({ page }) => {
  const failures: string[] = []
  page.on('pageerror', (error) => failures.push(error.message))
  // Browsers expose crypto.randomUUID only in secure contexts; http://<LAN-IP> is not one.
  await page.addInitScript(() => {
    Reflect.deleteProperty(Crypto.prototype, 'randomUUID')
  })
  await installSnapshotHealthRoutes(page, productSnapshot)
  await installWorkspaceRoutes(page, () => productSnapshot)
  await page.route('**/api/snapshot', (route) => route.fulfill({ json: productSnapshot }))

  await page.goto(`/agents/${targetAgentId}`)
  // The prompt editor that crashed the page in #56 mounts when the persona is edited.
  await page.getByRole('button', { name: '编辑设定' }).click()
  await expect(page.getByRole('textbox', { name: '设定' }).first()).toBeVisible()
  expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe('undefined')
  expect(failures).toEqual([])
})
